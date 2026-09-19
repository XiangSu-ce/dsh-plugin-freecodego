/**
 * Sectioned, differential context injection.
 *
 * Why
 * ---
 * Every request re-sends the whole prefix, so the cheapest way to spend fewer
 * tokens is to make sure the prefix stops *changing*. Our injection today
 * re-renders each block (memory recall, repo map, checkpoint, permissions) on
 * every session-start, and a block whose bytes move for an irrelevant reason —
 * a re-ordered list, a re-counted item — invalidates the prompt cache for
 * everything before it, not just itself.
 *
 * Codex solves this with a sectioned `WorldState`: each section has a
 * `snapshot()`, and the engine asks it for a fragment only when the snapshot
 * differs from the one the model already has. We adopt the same three-case
 * protocol, because the two non-obvious halves are what make it correct:
 *
 * 1. **Unchanged → send nothing.** The model still holds the previous text, so
 *    silence is the cheapest correct answer.
 * 2. **Removed → announce it.** `context_window_guidance.rs` in Codex sends
 *    "The previously provided context-window guidance no longer applies."
 *    Omitting a section is *not* how you retract it: a model that was told to
 *    prefer `pnpm` keeps preferring it if the instruction merely disappears.
 * 3. **Replaced → say so, then give the new text.** Ordered instructions can
 *    contradict each other; an explicit replacement notice removes the need for
 *    the model to guess which of two statements wins.
 *
 * Two more rules come from the same source:
 *
 * - **`unknown` is a real state.** After a resume, a compaction, or a process
 *   restart, we cannot know what the model actually saw. Treating that as
 *   "nothing was sent" would silently skip the replacement notice, so `unknown`
 *   is treated as *possibly containing the old text* and re-sends with a notice.
 * - **Dropped facts must be declared dropped.** Codex's `RetainedContext`
 *   carries `verified_answers_incomplete` purely so that "the user never
 *   approved this" can be told apart from "the approval record was evicted".
 *   A section bounded by a budget therefore reports `incomplete`, and the
 *   rendered fragment says so in the text the model reads.
 *
 * The engine is deliberately pure: it decides *what to send* and records what
 * was sent; it never touches an agent, a session, or the filesystem. That keeps
 * "the prefix is byte-stable across turns" testable as a plain assertion.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/context-fragments
 */

import { createHash } from 'node:crypto'

/**
 * What we believe the model already has for one section.
 *
 * - `known` — we sent `value` and nothing has happened since that could have
 *   dropped it.
 * - `absent` — we never sent this section in this context window.
 * - `unknown` — a resume/compaction/restart means we cannot tell. Treated as
 *   possibly-present, so a change re-sends with a notice rather than silently.
 */
export type PreviousSectionState =
  | { readonly kind: 'known'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' }

export interface ContextSection<T> {
  /** Stable identity; also the rendering order key, so ordering is deterministic. */
  readonly id: string
  /** Opening/closing markers the model sees, e.g. `['<memory>', '</memory>']`. */
  readonly markers: readonly [string, string]
  /** Render the section body for a first-time send. */
  readonly render: (value: T) => string
  /** Sent verbatim when this section changes while `previous` is known/unknown. */
  readonly replacementNotice?: string
  /** Sent verbatim when this section goes away and the model may still hold it. */
  readonly removalNotice?: string
}

/** One section's current value, plus whether it is complete. */
export interface SectionInput<T> {
  readonly section: ContextSection<T>
  /** The value now; `undefined`/empty string means "this section has nothing to say". */
  readonly value: T | undefined
  /**
   * True when the value was cut down to fit a budget. Rendered into the text so
   * a reader can distinguish "we looked and there is nothing" from "we stopped
   * looking" — the same reason Codex's retained context carries an
   * `incomplete` flag instead of relying on absence.
   */
  readonly incomplete?: boolean
  /** Override the engine's belief about what the model already holds. */
  readonly previous?: PreviousSectionState
}

export type FragmentKind = 'content' | 'replacement' | 'removal'

export interface RenderedContextFragment {
  readonly section: string
  readonly kind: FragmentKind
  /** Exactly the text to append, markers included. */
  readonly text: string
  /** Digest of this fragment, so a caller can assert prefix stability. */
  readonly digest: string
  /** True when the underlying value was bounded (see {@link SectionInput.incomplete}). */
  readonly incomplete: boolean
  /**
   * What the model now holds for this section, as the next turn will compare it.
   *
   * Carried on the fragment instead of recovered from `text`, because recovering
   * it means parsing the text back apart — and the parse only works for one of
   * the three kinds. A `replacement` is `notice + markers + body`, so any parse
   * keyed on the first and last newline captures the opening marker and the
   * body together; that value never compares equal to the plain body, so the
   * section was re-sent on every subsequent turn and the prefix never stopped
   * moving. This is the one piece of state the whole module exists to keep
   * honest, so it is computed where the text is built rather than reverse
   * engineered afterwards.
   */
  readonly snapshot: string
}

/**
 * Snapshot suffix that distinguishes a truncated send from a complete one.
 *
 * Without it, a section that was cut to fit a budget and later arrives whole
 * would compare equal and be treated as unchanged, leaving the model holding a
 * partial view it was told was all there was.
 */
const INCOMPLETE_SNAPSHOT_SUFFIX = '\u0000incomplete'

export function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Normalize a section value to its *snapshot* string.
 *
 * The snapshot is what "changed" is judged against, so it must be the exact
 * bytes that were sent. Callers whose value is an object should render first and
 * pass the rendered body here; rendering twice is how two callers drift.
 */
function normalizeSnapshot(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? ''
}

const INCOMPLETE_NOTE = '[This section was shortened to fit a context budget; it is a partial view.]'

/** Wrap one section body in its markers, appending the incompleteness note. */
function dress(section: ContextSection<unknown>, body: string, incomplete: boolean): string {
  const [open, close] = section.markers
  const content = incomplete ? `${body}\n\n${INCOMPLETE_NOTE}` : body
  return `${open}\n${content}\n${close}`
}

/**
 * Decide what to append for one section.
 *
 * Exported because the three-case table is the whole point of this module and is
 * worth testing directly, without constructing an engine.
 */
export function planFragment(input: SectionInput<never> | SectionInput<unknown>, previous: PreviousSectionState): RenderedContextFragment | undefined {
  const { section, value, incomplete = false } = input as SectionInput<unknown>
  const next = normalizeSnapshot(value)
  const snapshot = incomplete ? `${next}${INCOMPLETE_SNAPSHOT_SUFFIX}` : next
  const hadBefore = previous.kind === 'known' ? normalizeSnapshot(previous.value) !== '' : previous.kind === 'unknown'

  if (next === '') {
    // Nothing to say now. Stay silent only when the model cannot be holding an
    // older version; otherwise retract explicitly.
    if (!hadBefore) return undefined
    const text = section.removalNotice ?? `${section.id}: the previously provided content no longer applies.`
    return { section: section.id, kind: 'removal', text, digest: digestText(text), incomplete: false, snapshot: '' }
  }

  if (previous.kind === 'known' && normalizeSnapshot(previous.value) === snapshot) return undefined

  if (!hadBefore) {
    const text = dress(section, next, incomplete)
    return { section: section.id, kind: 'content', text, digest: digestText(text), incomplete, snapshot }
  }

  const notice = section.replacementNotice ?? `This ${section.id} section replaces all previously provided ${section.id} content.`
  const text = `${notice}\n${dress(section, next, incomplete)}`
  return { section: section.id, kind: 'replacement', text, digest: digestText(text), incomplete, snapshot }
}

/**
 * Per-context-window record of what each section last sent.
 *
 * One instance per session. `plan()` is pure with respect to the log — it
 * computes fragments from the recorded state; `commit()` records them. That
 * split matters: a caller that fails to append the fragments (a cancelled turn,
 * an aborted request) must not advance the log, or the model would be missing
 * text the engine believes it has.
 */
export class ContextFragmentLog {
  private readonly sent = new Map<string, string>()
  /** Sections whose real state is unknown (resume, compaction, restore). */
  private readonly unsure = new Set<string>()

  /** Mark every section unknown — used after a resume or a compaction. */
  markUnknown(): void {
    for (const id of this.sent.keys()) this.unsure.add(id)
  }

  /** Mark one section unknown, for a section whose source was rebuilt. */
  markSectionUnknown(id: string): void {
    this.unsure.add(id)
  }

  previousFor(id: string): PreviousSectionState {
    if (this.unsure.has(id)) return { kind: 'unknown' }
    const value = this.sent.get(id)
    return value === undefined ? { kind: 'absent' } : { kind: 'known', value }
  }

  /**
   * Fragment list for this turn, ordered by section id so the same inputs always
   * produce the same byte sequence — the property the cache depends on.
   */
  plan(inputs: readonly SectionInput<unknown>[]): readonly RenderedContextFragment[] {
    const ordered = [...inputs].sort((left, right) => left.section.id.localeCompare(right.section.id))
    const fragments: RenderedContextFragment[] = []
    for (const input of ordered) {
      const previous = input.previous ?? this.previousFor(input.section.id)
      const fragment = planFragment(input, previous)
      if (fragment !== undefined) fragments.push(fragment)
    }
    return fragments
  }

  /** Record fragments as sent. Call only after they were actually appended. */
  commit(fragments: readonly RenderedContextFragment[]): void {
    for (const fragment of fragments) {
      this.unsure.delete(fragment.section)
      if (fragment.kind === 'removal') this.sent.delete(fragment.section)
      else this.sent.set(fragment.section, fragment.snapshot)
    }
  }

  /** Digest of everything this log currently believes the model holds. */
  prefixDigest(): string {
    const entries = [...this.sent.entries()].sort(([left], [right]) => left.localeCompare(right))
    return digestText(entries.map(([id, body]) => `${id}\u0000${body}`).join('\u0001'))
  }

  /** Section ids the model currently holds, for diagnostics. */
  heldSections(): readonly string[] {
    return [...this.sent.keys()].sort()
  }
}

/** Join fragments into the single message body a caller appends to the turn. */
export function renderFragments(fragments: readonly RenderedContextFragment[]): string {
  return fragments.map(fragment => fragment.text).join('\n\n')
}
