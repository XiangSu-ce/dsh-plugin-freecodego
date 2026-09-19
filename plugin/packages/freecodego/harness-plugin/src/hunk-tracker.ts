/**
 * Hunk-level change tracking — which tool call changed which lines.
 *
 * The checkpoint store answers "what did the workspace look like before that
 * call", at file granularity. That is enough to throw a whole call away and
 * nothing finer, so two questions stay unanswerable: *which* call introduced the
 * line under discussion, and can one call's edit be reverted while the edits made
 * to the same file by other calls stay put. This module records the diff of every
 * file-mutating call as hunks attributed to that call, and reverts hunks
 * individually against the file's current text.
 *
 * Three decisions are the module
 * ------------------------------
 * **A hunk is the unit of attribution, not of intent.** One call that changes two
 * separated regions records two hunks, and both are reverted together by
 * {@link HunkTracker.revertCall} — because the call is what the model asked for,
 * while the hunk is what can be described precisely. Reverting a *single* hunk is
 * offered for the case where the second region was the good half. A call that
 * touched several *files* is reverted one file at a time, since a revert is
 * expressed against one file's text: {@link HunkTracker.revertCall} therefore takes
 * the file as part of the question rather than reverting "the call" against
 * whichever content it was handed.
 *
 * **A later edit supersedes the lines it replaced.** Offsets are maintained as
 * edits arrive (everything at or after the changed region shifts by the length
 * delta), so an earlier hunk keeps a usable offset. When a later edit *covers* an
 * earlier hunk's lines, that hunk is marked superseded and refuses to revert on
 * its own, naming the hunk that covered it: reverting it would splice its
 * pre-image into a region that no longer contains what it wrote, which produces a
 * file neither call ever asked for. Reverting the superseding call does restore
 * it, so the refusal names the way forward rather than just saying no.
 *
 * That supersede is one-way for the session: a covered hunk stays flagged even
 * after the call that covered it is reverted, because re-arming it would need the
 * reverse coordinate shift for a region whose pre-image is only partially known.
 * The intent it serves — get the older change back — is already met by reverting
 * the covering call, which restores exactly that state.
 *
 * **Revert verifies before it splices.** A hunk's post-image must still be at its
 * offset (or be found uniquely elsewhere, which covers the case where an edit
 * above it shifted it). When it is not — someone edited the file outside the
 * tracker — the refusal is `drifted` rather than a guess. For a pure deletion
 * there is no post-image to find, so the recorded neighbouring lines are what
 * verifies it, and a deletion that neither matches its offset nor its neighbours
 * is refused the same way. Relocating a deletion by content alone is impossible
 * in principle (an empty post-image matches everywhere), and this module says so
 * instead of picking one of the blank lines that look alike.
 *
 * Nothing here touches the filesystem: the journal holds the changed lines, the
 * caller reads and writes the file. That is also why there is no path-traversal
 * surface — a `file` is a map key, and the only thing a hostile one can do is
 * name a key that holds nothing.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hunk-tracker
 */

import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'

/** One contiguous region a diff replaced, in the post-edit line array. */
export interface LineChange {
  /** 0-based index in the *post-edit* lines where {@link LineChange.added} begins. */
  readonly offset: number
  /** Lines the region had before the edit. Empty for a pure insertion. */
  readonly removed: readonly string[]
  /** Lines the region has after the edit. Empty for a pure deletion. */
  readonly added: readonly string[]
}

/**
 * Work above this many cells degrades to one hunk covering the change.
 *
 * The table is `(before + 1) × (after + 1)` `Int32Array` cells, so the bound is
 * about memory rather than time. A whole-file rewrite of a 4000-line file is 16M
 * cells — 64 MB to describe a change that nobody is going to revert line by line.
 * The fallback is a coarser answer, never a wrong one: one hunk whose offset is
 * the end of the common prefix.
 */
const MAX_DIFF_CELLS = 4_000_000

/** Neighbouring lines kept per hunk, used to verify a pure deletion. */
const CONTEXT_LINES = 2

/** Argument names a file-mutating tool uses for the file it is about to write. */
const TARGET_KEY = /^(?:path|file|file_?path|filepath|target_?file|notebook_?path|absolute_?path)$/iu

/** Argument names that hold a list of targets. */
const TARGET_LIST_KEY = /^(?:files|edits|paths|changes)$/iu

/** Pre-images kept at once; the journal's own cap is per file. */
const MAX_TARGETS_PER_CALL = 8

/**
 * The workspace files a tool call's arguments name.
 *
 * Arguments come from the model, so the containment check is the point rather than
 * a detail: `../../id_rsa` and an absolute path both resolve outside the workspace,
 * and a pre-image read of either would put a credential's contents in a journal the
 * model can ask about later. Names that resolve outside are dropped, not clamped.
 */
export function hunkTargetPaths(args: unknown, cwd: string): readonly string[] {
  const root = resolve(cwd)
  const found: string[] = []
  const push = (raw: string): void => {
    if (found.length >= MAX_TARGETS_PER_CALL) return
    const trimmed = raw.trim()
    if (trimmed === '') return
    const candidate = resolve(root, trimmed)
    if (candidate !== root && !candidate.startsWith(root + sep)) return
    if (!found.includes(candidate)) found.push(candidate)
  }
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || found.length >= MAX_TARGETS_PER_CALL) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && TARGET_KEY.test(key)) {
        push(entry)
        continue
      }
      if (TARGET_LIST_KEY.test(key) || typeof entry === 'object') visit(entry, depth + 1)
    }
  }
  visit(args, 0)
  return found
}

/**
 * One file name, spelled the way the journal spells it.
 *
 * A caller names a file the way its own platform and habits do — `src\a.ts` on
 * Windows, `./src/a.ts` from a shell — while the journal stores exactly one form.
 * Normalizing at every entry and every query is what keeps a list filter and a
 * revert asking about the same hunk; when only some of them did it, a listing could
 * report nothing for a file whose hunk the revert then found.
 * @param file - the name as a caller gave it.
 * @returns the journal's form: forward slashes, no leading `./`.
 */
export function normalizeHunkFile(file: string): string {
  const slashed = file.trim().replace(/\\/gu, '/')
  return slashed.startsWith('./') ? slashed.slice(2) : slashed
}

function linesOf(text: string): readonly string[] {
  return text.split(/\r?\n/u)
}

/**
 * The line separator a file mostly uses, as a last resort.
 *
 * This is not how a revert decides its endings: a file's lines do not have to
 * agree with each other, so "the separator a file uses" is not a property a file
 * has. See {@link lineSeparators}, which reports what each line actually ends in.
 */
function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * What each line of `text` ends in — one entry per line, the last one empty.
 *
 * Index-aligned with {@link linesOf}, and that alignment is the point: an offset
 * is a line number, so a revert can replace a region of `lines` and still know the
 * exact bytes each surviving line stands for.
 *
 * The alternative — splitting into lines and joining them with one separator —
 * does not *preserve* a file's endings, it *replaces* them. One CRLF in an
 * otherwise-LF file (a Windows editor, a paste, a merge) is enough to make the
 * whole file CRLF on any revert, so undoing one line of a 500-line file rewrites
 * all 500 endings and the result reads as a whole-file diff. Every byte outside
 * the reverted region is meant to survive, and this is what lets it.
 */
function lineSeparators(text: string): readonly string[] {
  const separators: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    separators.push(index > start && text[index - 1] === '\r' ? '\r\n' : '\n')
    start = index + 1
  }
  separators.push('')
  return separators
}

/** The first of these that is a real separator, or `\n` when none of them is. */
function firstSeparator(...candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '') return candidate
  }
  return '\n'
}

/** How many leading/trailing lines two revisions share. */
function commonEdges(before: readonly string[], after: readonly string[]): { readonly prefix: number; readonly suffix: number } {
  const limit = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  return { prefix, suffix }
}

/**
 * The contiguous regions one revision changed.
 *
 * Longest-common-subsequence, because "which lines are the same line" is exactly
 * what a hunk boundary is: a cheaper heuristic that pairs the *i*-th line of one
 * revision with the *i*-th of the other reports a change for every line after an
 * insertion at the top. Regions separated by an unchanged line are separate
 * hunks; regions that merely touch are one.
 */
export function diffLines(before: readonly string[], after: readonly string[]): readonly LineChange[] {
  const { prefix, suffix } = commonEdges(before, after)
  const a = before.slice(prefix, before.length - suffix)
  const b = after.slice(prefix, after.length - suffix)
  if (a.length === 0 && b.length === 0) return []
  // One region is the whole answer when a side is empty, and the honest fallback
  // when the middle is too large to diff.
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_DIFF_CELLS) {
    return [{ offset: prefix, removed: a, added: b }]
  }

  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  // Row `a.length` and column `b.length` are the DP's base case — the longest
  // common subsequence of a string and "nothing left" is empty — and `?? 0` is
  // that case stated, not a guard against a stray index.
  const cell = (row: number, column: number): number => table[row * width + column] ?? 0
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const same = a[i] === b[j] ? cell(i + 1, j + 1) + 1 : 0
      table[i * width + j] = same > 0 ? same : Math.max(cell(i + 1, j), cell(i, j + 1))
    }
  }

  const changes: LineChange[] = []
  let removed: string[] = []
  let added: string[] = []
  let offset = -1
  let i = 0
  let j = 0
  const flush = (): void => {
    if (offset < 0) return
    changes.push({ offset: prefix + offset, removed, added })
    removed = []
    added = []
    offset = -1
  }
  while (i < a.length && j < b.length) {
    const left = a[i]
    const right = b[j]
    if (left === undefined || right === undefined) break
    if (left === right) {
      flush()
      i += 1
      j += 1
      continue
    }
    if (offset < 0) offset = j
    // Removals first, so a replacement reads as "these became those" and the
    // recorded offset is where the added lines begin in the new revision.
    if (cell(i + 1, j) >= cell(i, j + 1)) {
      removed.push(left)
      i += 1
    } else {
      added.push(right)
      j += 1
    }
  }
  while (i < a.length) {
    const left = a[i]
    if (left === undefined) break
    if (offset < 0) offset = j
    removed.push(left)
    i += 1
  }
  while (j < b.length) {
    const right = b[j]
    if (right === undefined) break
    if (offset < 0) offset = j
    added.push(right)
    j += 1
  }
  flush()
  return changes
}

/** One recorded region, attributed to the call that produced it. */
export interface Hunk {
  readonly id: string
  /** Workspace-relative, slash-separated as the caller named it. */
  readonly file: string
  readonly callId: string
  readonly at: number
  /** 0-based offset in the file's *current* lines where {@link Hunk.added} begins. */
  readonly offset: number
  readonly removed: readonly string[]
  readonly added: readonly string[]
  /** Up to {@link CONTEXT_LINES} lines before the region, for verifying a deletion. */
  readonly contextBefore: readonly string[]
  /** Up to {@link CONTEXT_LINES} lines after the region, for verifying a deletion. */
  readonly contextAfter: readonly string[]
  /**
   * What ended the last line this hunk removed, in the revision it removed it from.
   *
   * Recorded because a revert has to put that line back with the bytes it had, and
   * the file it is spliced into is not evidence of them: the call may well have
   * changed that very ending, and a file whose lines disagree about their endings
   * has no single separator to borrow. Absent for a pure insertion, which restores
   * no lines and so has no ending to restore.
   */
  readonly removedEol?: string
  /** The later hunk that covered this one's lines, when there is one. */
  readonly supersededBy?: string
  /**
   * Set once this hunk has been reverted, which is a one-way change.
   *
   * A revert is not idempotent by construction — it splices the pre-image back —
   * and the second application is not always detectable: a deletion at the end of
   * a file keeps only a preceding neighbour to check against, so its own
   * re-inserted line satisfied the anchor and the line was duplicated. Recording
   * that it happened is what makes the second attempt refuse instead.
   */
  readonly reverted?: boolean
}

/** Why one hunk could not be reverted. */
export type HunkRevertFailure =
  | { readonly ok: false; readonly reason: 'unknown-hunk'; readonly hunkId: string }
  | { readonly ok: false; readonly reason: 'superseded'; readonly hunkId: string; readonly by: string }
  | { readonly ok: false; readonly reason: 'already-reverted'; readonly hunkId: string }
  | { readonly ok: false; readonly reason: 'drifted'; readonly hunkId: string; readonly detail: string }

export type HunkRevertResult =
  | { readonly ok: true; readonly text: string; readonly relocated: boolean }
  | HunkRevertFailure

export type HunkCallRevertResult =
  | { readonly ok: true; readonly text: string; readonly hunks: number; readonly relocated: boolean }
  | { readonly ok: false; readonly failures: readonly HunkRevertFailure[] }

/** The journal's default bound, past which the oldest hunk is dropped. */
const DEFAULT_MAX_HUNKS = 500

interface MutableHunk {
  id: string
  file: string
  callId: string
  at: number
  offset: number
  removed: readonly string[]
  added: readonly string[]
  contextBefore: readonly string[]
  contextAfter: readonly string[]
  removedEol?: string
  supersededBy?: string
  reverted?: boolean
}

/**
 * An edit journal, one workspace at a time.
 *
 * Session-scoped, like the loop guard: it exists to explain the turn being
 * worked on. A restart loses the attribution, which is stated here because the
 * alternative — a second on-disk format duplicating what the checkpoint store
 * already persists — is a much larger claim than this module's purpose needs.
 */
export class HunkTracker {
  private readonly journal: MutableHunk[] = []
  private readonly maxHunks: number
  private dropped = 0

  constructor(options: { readonly maxHunks?: number } = {}) {
    this.maxHunks = options.maxHunks === undefined || options.maxHunks < 1 ? DEFAULT_MAX_HUNKS : Math.floor(options.maxHunks)
  }

  /** Hunks dropped because the journal is bounded. */
  get droppedCount(): number {
    return this.dropped
  }

  /**
   * Every hunk currently held, oldest first.
   * @param filter - optionally one file (in any platform's spelling) or one call.
   * @returns the matching hunks, oldest first.
   */
  hunks(filter: { readonly file?: string; readonly callId?: string } = {}): readonly Hunk[] {
    const file = filter.file === undefined ? undefined : normalizeHunkFile(filter.file)
    return this.journal
      .filter(hunk => (file === undefined || hunk.file === file)
        && (filter.callId === undefined || hunk.callId === filter.callId))
      .map(hunk => this.view(hunk))
  }

  /**
   * Record the diff of one call against one file.
   *
   * `before` and `after` are whole file contents, because that is what the caller
   * has and because a diff of two revisions needs nothing else. Offsets already
   * held for this file are shifted by this edit, and any hunk this edit covered is
   * marked superseded — both here, so that a hunk's offset is maintained by the
   * single code path that can invalidate it.
   */
  record(input: {
    readonly file: string
    readonly callId: string
    readonly before: string
    readonly after: string
    readonly at?: number
  }): readonly Hunk[] {
    const file = normalizeHunkFile(input.file)
    if (file === '' || input.before === input.after) return []
    const before = linesOf(input.before)
    const after = linesOf(input.after)
    const at = input.at ?? Date.now()
    const created: MutableHunk[] = []
    for (const change of diffLines(before, after)) {
      const id = randomUUID()
      created.push({
        id,
        file,
        callId: input.callId,
        at,
        offset: change.offset,
        removed: change.removed,
        added: change.added,
        contextBefore: after.slice(Math.max(0, change.offset - CONTEXT_LINES), change.offset),
        contextAfter: after.slice(change.offset + change.added.length, change.offset + change.added.length + CONTEXT_LINES),
      })
    }
    if (created.length === 0) return []

    // Every change is expressed twice: the diff reports its offset in the new
    // revision, while the journal's offsets are in the revision that revision
    // replaced. Converting back — subtracting the length delta of the changes
    // above it — is what lets one comparison answer "did this edit cover that
    // hunk" for every change of the call, not just the first one. The same
    // conversion locates the removed lines in the *old* revision, which is the
    // only place their ending is written down.
    const beforeSeparators = lineSeparators(input.before)
    const ranges: { pre: number; removed: number; added: number; id: string }[] = []
    let skew = 0
    for (const hunk of created) {
      const pre = hunk.offset - skew
      ranges.push({ pre, removed: hunk.removed.length, added: hunk.added.length, id: hunk.id })
      skew += hunk.added.length - hunk.removed.length
      if (hunk.removed.length > 0) {
        const separator = beforeSeparators[pre + hunk.removed.length - 1]
        if (separator !== undefined) hunk.removedEol = separator
      }
    }
    const next: MutableHunk[] = []
    for (const hunk of this.journal) {
      if (hunk.file !== file) {
        next.push(hunk)
        continue
      }
      const covering = ranges.find(range => range.removed > 0
        && range.pre < hunk.offset + hunk.added.length
        && hunk.offset < range.pre + range.removed)
      if (covering !== undefined) {
        // The lines it wrote are gone, so its own pre-image no longer has a place
        // to go. The hunk that covered it is named rather than guessed at.
        next.push({ ...hunk, supersededBy: covering.id })
        continue
      }
      const shift = ranges.reduce((total, range) => range.pre + range.removed <= hunk.offset
        ? total + (range.added - range.removed)
        : total, 0)
      next.push(shift === 0 ? hunk : { ...hunk, offset: hunk.offset + shift })
    }
    for (const hunk of created) next.push(hunk)

    this.journal.length = 0
    this.journal.push(...next)
    while (this.journal.length > this.maxHunks) {
      this.journal.shift()
      this.dropped += 1
    }
    return created.map(hunk => this.view(hunk))
  }

  /**
   * Revert one hunk against the file's current text.
   *
   * The returned text is what the caller should write; nothing is written here,
   * because a tracker that both decides and writes cannot be tested without a
   * filesystem and cannot be asked what it *would* do.
   *
   * One-shot: a hunk that has already been reverted is refused rather than applied
   * again. The alternative is not a harmless no-op — for a deletion the pre-image
   * is re-inserted, and a deletion with nothing after it in the file leaves no
   * neighbour that can tell the two states apart.
   */
  revert(hunkId: string, current: string): HunkRevertResult {
    const hunk = this.journal.find(entry => entry.id === hunkId)
    if (hunk === undefined) return { ok: false, reason: 'unknown-hunk', hunkId }
    if (hunk.supersededBy !== undefined) return { ok: false, reason: 'superseded', hunkId, by: hunk.supersededBy }
    if (hunk.reverted === true) return { ok: false, reason: 'already-reverted', hunkId }
    const lines = [...linesOf(current)]
    const placed = place(hunk, lines)
    if ('reason' in placed) return { ok: false, reason: 'drifted', hunkId, detail: placed.reason }
    const added = hunk.added.length
    const separators = lineSeparators(current)
    // What the lines this revert puts back should end in. The pre-image's own
    // separator is the only answer that restores the bytes — and the file being
    // spliced into cannot supply it, since the call may have changed exactly that
    // ending. So the recorded one comes first; the rest are for a hunk with no
    // removed lines and for a region that ended the file without a separator.
    const spelling = firstSeparator(
      hunk.removedEol,
      separators[placed.offset + added - 1],
      separators[placed.offset],
      eolOf(current),
    )
    // Rebuilt line by line rather than spliced and rejoined, so that a line the
    // revert does not touch keeps the exact bytes it had — separator included.
    const spelled: { text: string; separator: string }[] = []
    for (let index = 0; index <= lines.length; index += 1) {
      if (index === placed.offset) {
        for (const line of hunk.removed) spelled.push({ text: line, separator: spelling })
      }
      if (index === lines.length) break
      if (index < placed.offset || index >= placed.offset + added) {
        spelled.push({ text: lines[index] ?? '', separator: separators[index] ?? '' })
      }
    }
    // A line that kept no separator was the end of the file, and it is no longer:
    // without one, every line after it would run into it.
    for (const [index, entry] of spelled.entries()) {
      if (index < spelled.length - 1 && entry.separator === '') entry.separator = spelling
    }
    const last = spelled.at(-1)
    if (last !== undefined) last.separator = ''
    const text = spelled.map(entry => entry.text + entry.separator).join('')
    // A revert is an edit, so the other hunks of this file move like they would
    // have on a record: everything past the region shifts by the length delta. A
    // tracker that reverts without doing this hands out offsets that are already
    // wrong, and the second revert of a two-hunk call lands in the wrong place.
    const delta = hunk.removed.length - added
    if (delta !== 0) {
      for (const other of this.journal) {
        if (other.file === hunk.file && other.id !== hunk.id && other.offset >= placed.offset + added) other.offset += delta
      }
    }
    hunk.offset = placed.offset
    hunk.reverted = true
    return { ok: true, text, relocated: placed.relocated }
  }

  /**
   * Revert every hunk one call recorded in one file, or none of them.
   *
   * All-or-nothing on purpose: a call is what the model asked for, and half of one
   * is a state nobody requested and nobody can name afterwards. The failures come
   * back together so one response can say which hunks are in the way.
   *
   * The file is required rather than an optional filter, because the hunks are
   * reverted by splicing them into `current` — the text of exactly one file. A call
   * that touched two files has hunks whose lines are not in this file's text at all,
   * so a scope of "the whole call" makes every such revert fail on the *other*
   * file's hunks, and would splice the wrong file's pre-image in whenever the other
   * file's lines happened to occur here.
   *
   * "All-or-nothing" is enforced against the journal as well as against the text:
   * the pre-checks catch what is knowable before any splice, and a `drifted` hunk
   * is only discoverable by splicing the ones after it. So the journal is
   * snapshotted and restored on that failure — otherwise the hunks the pass already
   * reverted stay consumed by a revert the caller was told never happened, and the
   * retry after the file is fixed is refused with `already-reverted`.
   * @param input - the call, the file its hunks are in, and that file's current text.
   */
  revertCall(input: {
    readonly callId: string
    readonly file: string
    readonly current: string
  }): HunkCallRevertResult {
    const { callId, current } = input
    const file = normalizeHunkFile(input.file)
    const callHunks = this.journal.filter(hunk => hunk.callId === callId && hunk.file === file)
    if (callHunks.length === 0) return { ok: false, failures: [{ ok: false, reason: 'unknown-hunk', hunkId: `call:${callId}` }] }
    const failures: HunkRevertFailure[] = []
    for (const hunk of callHunks) {
      if (hunk.supersededBy !== undefined) failures.push({ ok: false, reason: 'superseded', hunkId: hunk.id, by: hunk.supersededBy })
      if (hunk.reverted === true) failures.push({ ok: false, reason: 'already-reverted', hunkId: hunk.id })
    }
    if (failures.length > 0) return { ok: false, failures }

    // Latest first: reverting a region below another leaves the earlier offsets
    // valid, which is what makes a multi-hunk call revertible in one pass.
    const ordered = [...callHunks].sort((left, right) => right.offset - left.offset)
    // Only `offset` and `reverted` change while a pass runs, so a shallow copy of
    // each hunk is a complete rollback of the journal.
    const snapshot = this.journal.map(hunk => ({ ...hunk }))
    let text = current
    let relocated = false
    for (const hunk of ordered) {
      const result = this.revert(hunk.id, text)
      if (!result.ok) {
        this.journal.length = 0
        this.journal.push(...snapshot)
        return { ok: false, failures: [result] }
      }
      text = result.text
      relocated = relocated || result.relocated
    }
    return { ok: true, text, hunks: callHunks.length, relocated }
  }

  /** Drop every hunk for one file, for a file that was deleted or replaced. */
  forget(file: string): number {
    const normalized = normalizeHunkFile(file)
    const kept = this.journal.filter(hunk => hunk.file !== normalized)
    const removed = this.journal.length - kept.length
    this.journal.length = 0
    this.journal.push(...kept)
    return removed
  }

  private view(hunk: MutableHunk): Hunk {
    return {
      id: hunk.id,
      file: hunk.file,
      callId: hunk.callId,
      at: hunk.at,
      offset: hunk.offset,
      removed: hunk.removed,
      added: hunk.added,
      contextBefore: hunk.contextBefore,
      contextAfter: hunk.contextAfter,
      ...(hunk.removedEol === undefined ? {} : { removedEol: hunk.removedEol }),
      ...(hunk.supersededBy === undefined ? {} : { supersededBy: hunk.supersededBy }),
      ...(hunk.reverted === true ? { reverted: true } : {}),
    }
  }
}

/**
 * Where a hunk's post-image sits in the given lines, or why it cannot be placed.
 *
 * Exact offset first, then a unique occurrence elsewhere, which is the case an
 * edit above it produces. Two occurrences are refused rather than resolved:
 * picking the first would splice a revert into a region that is only coincidentally
 * identical, and the caller has no way to tell that from the right one.
 */
function place(
  hunk: MutableHunk,
  lines: readonly string[],
): { readonly offset: number; readonly relocated: boolean } | { readonly reason: string } {
  const at = (offset: number): boolean => offset >= 0 && offset + hunk.added.length <= lines.length
    && hunk.added.every((line, index) => lines[offset + index] === line)

  if (hunk.added.length === 0) {
    // A deletion has no post-image to find, so its neighbours are the anchor. A
    // side with no neighbour — a deletion at the very start or very end — is a side
    // that cannot be checked, and the recorded offset is trusted for it.
    if (hunk.offset > lines.length) return { reason: 'the file is shorter than the recorded deletion' }
    const before = hunk.contextBefore.at(-1)
    const after = hunk.contextAfter[0]
    const anchored = hunk.offset <= lines.length
      && (before === undefined || lines[hunk.offset - 1] === before)
      && (after === undefined || lines[hunk.offset] === after)
    if (anchored) return { offset: hunk.offset, relocated: false }
    return { reason: 'its neighbouring lines are no longer where it was recorded' }
  }

  if (at(hunk.offset)) return { offset: hunk.offset, relocated: false }
  const matches: number[] = []
  for (let offset = 0; offset + hunk.added.length <= lines.length; offset += 1) {
    if (at(offset)) matches.push(offset)
  }
  if (matches.length === 1) return { offset: matches[0] ?? hunk.offset, relocated: true }
  if (matches.length > 1) return { reason: `its lines now appear ${String(matches.length)} times, so a revert would have to guess` }
  return { reason: 'its lines are no longer in the file' }
}
