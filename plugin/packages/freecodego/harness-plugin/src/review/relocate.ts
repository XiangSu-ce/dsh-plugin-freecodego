/**
 * Relocation: putting a finding on the line it is actually about.
 *
 * The problem this solves
 * -----------------------
 * A reviewer — model or human — names a line from what it read, and what it read
 * may have been the file before the change, a partially-loaded view, or its own
 * reconstruction. A line number that lands in the wrong place is worse than no
 * line number at all: it annotates unrelated code, hides the real finding, and
 * cannot be corrected by the reader without re-deriving the whole thing.
 *
 * So relocation is **evidence-based or it declines**. Three sources of evidence
 * are used, strongest first:
 *
 * 1. **The line is inside a hunk of the new side** — the reviewer's coordinate
 *    system already agrees with git's. Accepted as-is.
 * 2. **The quoted original code appears exactly once among the added lines** —
 *    the reviewer mis-numbered, but told us what it saw, so the region is found
 *    by content. A snippet matching more than once relocates to nothing, because
 *    choosing one of several matches is a guess dressed up as a fact.
 * 3. **The line exists on the old side of a hunk** — the reviewer numbered
 *    against the pre-change file, which is a real and common mistake. The line is
 *    translated through the hunk, which fails for a line the change deleted:
 *    a deleted line has no position in the new file, and inventing one would put
 *    a finding on the code that replaced it.
 *
 * When none hold, the outcome is unpositioned (`0,0`) and says so. That is the
 * same state the contract already gives a reviewer that never named a line, so
 * nothing downstream needs a new case — and, crucially, no caller can mistake a
 * declined relocation for a successful one.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/relocate
 */

import type { DiffFile } from './diff.ts'
import type { ReviewComment } from './comments.ts'

/** Why a relocation produced the range it did. */
export type RelocationReason =
  /** The proposed range already lies within the diff's new side. */
  | 'within-diff'
  /** The quoted original code matched exactly one added region. */
  | 'matched-existing-code'
  /** The proposed line was on the old side and translated through a hunk. */
  | 'translated-from-old-side'
  /** No evidence supported the proposal, so it is reported unpositioned. */
  | 'not-found'
  /** The comment arrived unpositioned and stays that way. */
  | 'already-unpositioned'

/** One relocation result. */
export interface RelocationOutcome {
  readonly startLine: number
  readonly endLine: number
  /** Whether a position differs from the one proposed. */
  readonly relocated: boolean
  readonly reason: RelocationReason
}

/** One added line with the new-file number it occupies. */
interface AddedLine {
  readonly line: number
  readonly text: string
}

/**
 * Relocate one comment against one file's diff.
 *
 * Pure, and takes the diff rather than reading anything: relocation is a claim
 * about coordinates, and a function that also fetches files is a function whose
 * tests need a repository.
 */
export function relocateComment(comment: ReviewComment, file: DiffFile): RelocationOutcome {
  if (comment.startLine <= 0) {
    return { startLine: 0, endLine: 0, relocated: false, reason: 'already-unpositioned' }
  }

  if (isWithinNewSide(file, comment.startLine, Math.max(comment.startLine, comment.endLine))) {
    return {
      startLine: comment.startLine,
      endLine: Math.max(comment.startLine, comment.endLine),
      relocated: false,
      reason: 'within-diff',
    }
  }

  const byContent = relocateByExistingCode(comment, file)
  if (byContent !== undefined) return byContent

  const translated = relocateFromOldSide(comment, file)
  if (translated !== undefined) return translated

  return { startLine: 0, endLine: 0, relocated: true, reason: 'not-found' }
}

/** Whether a whole range lies inside the diff's new side. */
function isWithinNewSide(file: DiffFile, start: number, end: number): boolean {
  return newSideContains(file, start) && newSideContains(file, end)
}

function newSideContains(file: DiffFile, line: number): boolean {
  for (const hunk of file.hunks) {
    if (hunk.newLines === 0) continue
    if (line >= hunk.newStart && line < hunk.newStart + hunk.newLines) return true
  }
  return false
}

/** Relocate by finding the quoted original code among the added lines. */
function relocateByExistingCode(comment: ReviewComment, file: DiffFile): RelocationOutcome | undefined {
  const snippet = comment.existingCode
  if (snippet === undefined) return undefined

  const wanted = snippet.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (wanted.length === 0) return undefined

  const added = addedLines(file)
  const matches: number[] = []
  for (let start = 0; start + wanted.length <= added.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if ((added[start + offset] as AddedLine).text.trim() !== wanted[offset]) {
        matched = false
        break
      }
    }
    if (matched) matches.push(start)
  }

  if (matches.length !== 1) return undefined
  const first = added[matches[0] as number] as AddedLine
  const last = added[(matches[0] as number) + wanted.length - 1] as AddedLine
  return { startLine: first.line, endLine: last.line, relocated: true, reason: 'matched-existing-code' }
}

/** Translate a new-file line that was actually an old-file line. */
function relocateFromOldSide(comment: ReviewComment, file: DiffFile): RelocationOutcome | undefined {
  const start = translateOldToNew(file, comment.startLine)
  if (start === undefined) return undefined
  const proposedEnd = Math.max(comment.startLine, comment.endLine)
  const end = proposedEnd === comment.startLine ? start : translateOldToNew(file, proposedEnd) ?? start
  return { startLine: start, endLine: end, relocated: true, reason: 'translated-from-old-side' }
}

/**
 * Map an old-side line to its new-side line through the hunks.
 *
 * Walks the hunk body counting both sides, so an offset is never assumed: a
 * hunk's added lines shift the new side away from the old one, and arithmetic on
 * the header alone would be wrong by exactly the number of additions above the
 * line. Returns undefined for a line the change removed, which has no new-side
 * position at all.
 */
export function translateOldToNew(file: DiffFile, oldLine: number): number | undefined {
  for (const hunk of file.hunks) {
    if (hunk.oldLines === 0) continue
    if (oldLine < hunk.oldStart || oldLine >= hunk.oldStart + hunk.oldLines) continue
    let oldCursor = hunk.oldStart
    let newCursor = hunk.newStart
    for (const entry of hunk.lines) {
      if (entry.kind === ' ') {
        if (oldCursor === oldLine) return newCursor
        oldCursor += 1
        newCursor += 1
        continue
      }
      if (entry.kind === '-') {
        if (oldCursor === oldLine) return undefined
        oldCursor += 1
        continue
      }
      newCursor += 1
    }
  }
  return undefined
}

/** Every added line of the file, in new-file order. */
function addedLines(file: DiffFile): AddedLine[] {
  const out: AddedLine[] = []
  for (const hunk of file.hunks) {
    let line = hunk.newStart
    for (const entry of hunk.lines) {
      if (entry.kind === '+') {
        out.push({ line, text: entry.text })
        line += 1
      } else if (entry.kind === ' ') {
        line += 1
      }
    }
  }
  return out
}

/**
 * Apply one relocation to a comment.
 *
 * Returns the same object when nothing moved, so a caller can compare identity
 * rather than re-checking the range. The comment model deliberately has no field
 * holding the reviewer's original proposal: the *relocation* is what a report
 * publishes, and a second coordinate in the model would invite a renderer to
 * print the wrong one. A caller that wants the audit trail keeps the pre-image
 * its own side, which is the only place that knows a relocation happened.
 */
export function applyRelocation(comment: ReviewComment, outcome: RelocationOutcome): ReviewComment {
  if (!outcome.relocated) return comment
  return { ...comment, startLine: outcome.startLine, endLine: outcome.endLine }
}
