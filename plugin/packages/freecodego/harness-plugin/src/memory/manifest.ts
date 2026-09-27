/**
 * `MEMORY.md`: a bounded index of absolute pointers, in two scopes.
 *
 * Three decisions make this a module rather than a template string.
 *
 * **Paths are absolute.** A relative pointer has to be resolved against a scope
 * root, and which root that is depends on where the index was found — project,
 * user, or plugin cache. A model reading a relative pointer has to reconstruct
 * that reasoning before it can open anything, and when it reconstructs it wrong
 * it does not report a broken path; it reports having found nothing. An absolute
 * path removes the question.
 *
 * **Overflow drops whole lines and says how many.** Truncating a description
 * would leave the index claiming to describe a record it no longer describes —
 * the reader cannot tell a short summary from a cut-off one. Dropping the line
 * loses the pointer, which is visible, and the count makes it actionable. This is
 * the same discipline the skill map already follows in this plugin.
 *
 * **A record's scope is part of its pointer.** A session-scoped record is
 * reclaimed when the session ends, so a reader that cannot tell the two scopes
 * apart reads a list of paths without knowing which of them will still be there
 * next task. The scope is therefore rendered — a section of its own, plus the
 * session each row belongs to — rather than left as metadata the file happens not
 * to show.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/manifest
 */

import { deferredToolFetchHint } from '../deferred-tools.ts'

/** The index's file name inside the memory home. */
export const MEMORY_MANIFEST_FILENAME = 'MEMORY.md'

/** Default character budget for the whole index. */
export const DEFAULT_MANIFEST_BUDGET_CHARS = 8_000

/**
 * How long a record the index points at is kept.
 *
 * `project` is the durable layer: it lives in the workspace's memory home until
 * someone forgets it. `session` is the temporary layer: it lives inside one
 * session's directory under that home and is reclaimed when the session is
 * disposed, so a note about the task in hand cannot accumulate into the project's
 * permanent memory.
 */
export type MemoryScope = 'project' | 'session'

/** One record the index points at. */
export interface MemoryManifestEntry {
  /** Record name, which is how a reader refers to it. */
  readonly name: string
  /** Absolute path to the record file. */
  readonly path: string
  /** One-line description; never truncated. */
  readonly description: string
  /**
   * The layer this record belongs to. Absent means `project`.
   *
   * Optional rather than required so the default is stated once, here, instead of
   * at every call site — and so a caller that has only durable records cannot
   * accidentally declare one temporary by forgetting a field.
   */
  readonly scope?: MemoryScope
  /** The session a `session`-scoped record belongs to. */
  readonly sessionId?: string
}

/**
 * The heading the temporary section is rendered under.
 *
 * The sentence after the colon is the whole reason the section exists: a reader
 * that has to infer the lifetime of a pointer from its directory name will infer
 * it wrong, and will do so silently.
 */
export const MEMORY_SESSION_SECTION_HEADING = '## Session (reclaimed when the session ends)'

/** The rendered index and what had to be left out. */
export interface MemoryManifest {
  readonly markdown: string
  readonly included: number
  readonly omitted: number
  /** True when at least one entry was dropped for budget. */
  readonly truncated: boolean
}

/**
 * The sentence that reports what the budget left out.
 *
 * The pointer to `engineering_memory_search` carries the loading sentence, and
 * the reason is the route this text travels: the index is read from disk, so it
 * reaches its reader — the model included — without any `tool_search` result
 * behind it, and the sentence that result states for the descriptions it returns
 * never arrives. A bare name here is a pointer to a schema this session may never
 * have fetched, which is the one thing a list of pointers may not hold.
 */
function overflowNotice(omitted: number): string {
  return `\n${omitted} more record${omitted === 1 ? '' : 's'} did not fit this index; the files are still on disk at the paths above, and \`engineering_memory_search\` reaches the rest.${deferredToolFetchHint('engineering_memory_search')}\n`
}

/**
 * Render the pointer index under a character budget.
 *
 * The budget covers the *whole* index, the overflow notice included — the notice
 * used to be appended outside it, which broke the promise in the one case the
 * budget exists for. Its own length depends on how many entries were dropped,
 * which is only known after packing, so its worst case is reserved up front: the
 * count can never exceed the number of entries, so the reservation is exact. The
 * temporary section's heading is reserved on the same principle when there is a
 * session entry to render at all, since whether one *fits* is also only known
 * after packing.
 *
 * One budget cannot be met at all: one too small for the header alone. The header
 * is returned there regardless, because an index that says nothing would state
 * that there are no records — a wrong answer instead of a long one.
 * @param entries - the records to point at.
 * @param options - budget and clock.
 * @returns the markdown, plus how many entries were included and omitted.
 */
export function renderMemoryManifest(
  entries: readonly MemoryManifestEntry[],
  options: { readonly budgetChars?: number; readonly now?: number } = {},
): MemoryManifest {
  const budget = options.budgetChars ?? DEFAULT_MANIFEST_BUDGET_CHARS
  const now = options.now ?? Date.now()
  const header = [
    '# Memory index',
    '',
    'Pointers only; the content lives in the files these paths name.',
    `Generated ${new Date(now).toISOString()}.`,
    '',
    '## Project',
    '',
  ].join('\n')
  const sessionHeading = `\n${MEMORY_SESSION_SECTION_HEADING}\n`

  const sorted = sortEntries(entries)
  const candidates = sorted.map(entry => ({ entry, line: manifestLine(entry) }))
  const hasSession = sorted.some(entry => scopeOf(entry) === 'session')
  const everything = candidates.reduce(
    (total, candidate) => total + candidate.line.length + 1,
    header.length + (hasSession ? sessionHeading.length : 0),
  )
  const reserve = everything <= budget
    ? 0
    : overflowNotice(candidates.length).length + (hasSession ? sessionHeading.length : 0)
  const packing = budget - reserve

  // Two lists rather than one rendered string: the heading has to sit between
  // them, and a row that did not fit must not leave its heading behind claiming an
  // empty temporary scope.
  const project: string[] = []
  const session: string[] = []
  let used = header.length + (hasSession ? sessionHeading.length : 0)
  let omitted = 0
  for (const candidate of candidates) {
    if (used + candidate.line.length + 1 > packing) {
      omitted += 1
      continue
    }
    ;(scopeOf(candidate.entry) === 'session' ? session : project).push(candidate.line)
    used += candidate.line.length + 1
  }

  // Every block is built from lines that each carry their own terminator, so the
  // rendered length is exactly what was accounted for above — an index that is
  // longer than the budget it promises is the defect this renderer already had
  // once, when the notice was appended outside the count.
  const body = `${project.map(line => `${line}\n`).join('')}${session.length === 0 ? '' : `${sessionHeading}${session.map(line => `${line}\n`).join('')}`}`
  const tail = omitted === 0 ? '' : overflowNotice(omitted)
  return {
    markdown: `${header}${body}${tail}`,
    included: project.length + session.length,
    omitted,
    truncated: omitted > 0,
  }
}

/** The scope of an entry, with the documented default applied in one place. */
function scopeOf(entry: MemoryManifestEntry): MemoryScope {
  return entry.scope ?? 'project'
}

/**
 * One rendered row.
 *
 * A temporary row names its session, because the section it sits in is a category
 * and not an identity: two live sessions share one index, and a path under one
 * session's directory is not a promise about the other's.
 */
function manifestLine(entry: MemoryManifestEntry): string {
  const base = `- ${entry.name} — ${entry.description} — ${entry.path}`
  if (scopeOf(entry) !== 'session') return base
  return entry.sessionId === undefined || entry.sessionId === '' ? base : `${base} (session ${entry.sessionId})`
}

/**
 * Order entries deterministically.
 *
 * Stable order is not cosmetic: an index that reshuffles on every write makes
 * every regeneration a diff, which destroys the only cheap signal a reader has
 * that the memory actually changed.
 * @param entries - the entries to order.
 * @returns a new array, sorted by name.
 */
function sortEntries(entries: readonly MemoryManifestEntry[]): readonly MemoryManifestEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name))
}
