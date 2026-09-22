/**
 * The review comment: one finding, addressed to a file and a line range.
 *
 * Why validation refuses instead of repairing
 * -------------------------------------------
 * The plan reviewer in this plugin already settled this question for a user's
 * remark ("a comment with an impossible line range, or one with no text, is
 * refused instead of dropped"). The same rule is right here and for the same
 * reason: a reviewer — model or human — that believed it reported something must
 * not have that belief quietly discarded. So a malformed contribution comes back
 * as a refusal naming what was wrong, and the caller decides what to do with it.
 *
 * The one exception is deliberate and is OCR's own contract: `startLine` and
 * `endLine` of `0` mean **positioning failed**, not "line zero". A reviewer that
 * understood the problem but could not name the line has still found something
 * real — the skill ships an explicit procedure for applying those comments by
 * hand — so they are kept, marked, and never silently assigned a nearby line.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/comments
 */

/** How serious one finding is, in the order a report sorts by. */
export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/** What kind of problem one finding is, mirroring OCR's taxonomy. */
export const REVIEW_CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other',
] as const
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number]

/**
 * Where a comment is in its lifecycle.
 *
 * `filtered` is retained rather than deleted because the post-filter's whole
 * contract is that removing a *correct* finding is the expensive mistake; a run
 * that reports how many comments it dropped can be audited, and one that does
 * not cannot.
 */
export type ReviewCommentState = 'proposed' | 'kept' | 'filtered'

/** One review finding. */
export interface ReviewComment {
  /** Stable id, unique within a run; survives the filter and the relocation. */
  readonly id: string
  /** Repository-relative path, POSIX separators. */
  readonly path: string
  /** The finding itself. */
  readonly content: string
  /** First line in the new file, 1-based; `0` with `endLine === 0` means unpositioned. */
  readonly startLine: number
  /** Last line in the new file, inclusive; equal to `startLine` for one line. */
  readonly endLine: number
  readonly category: ReviewCategory
  readonly severity: ReviewSeverity
  /** An optional application-ready replacement for the flagged region. */
  readonly suggestionCode?: string
  /** The original code the finding quotes, when the reviewer supplied it. */
  readonly existingCode?: string
  /** The rule text that governed this file, so a reader can see the standard applied. */
  readonly ruleSource?: string
  /** Which reviewer produced it, when a run used more than one. */
  readonly reviewer?: string
  readonly state: ReviewCommentState
  /** Why the post-filter dropped it; present only when `state` is `filtered`. */
  readonly filteredReason?: string
}

/** A contribution before it is accepted, as it arrives from a reviewer. */
export interface ReviewCommentInput {
  readonly path: unknown
  readonly content: unknown
  readonly startLine?: unknown
  readonly endLine?: unknown
  readonly category?: unknown
  readonly severity?: unknown
  readonly suggestionCode?: unknown
  readonly existingCode?: unknown
  readonly ruleSource?: unknown
  readonly reviewer?: unknown
}

/** The outcome of validating one contribution. */
export type ReviewCommentVerdict =
  | { readonly ok: true; readonly comment: ReviewComment }
  | { readonly ok: false; readonly reason: string }

/** Maximum characters retained from one finding, so one verbose reviewer cannot flood a report. */
export const MAX_COMMENT_CHARS = 4_000

/**
 * Validate one contribution into a comment.
 *
 * `id` is supplied by the caller so that ids stay a property of the run (its
 * counter, its ordering) rather than of this function, which keeps the function
 * pure and its tests free of a fixture that has to guess an id format.
 */
export function validateReviewComment(input: ReviewCommentInput, id: string): ReviewCommentVerdict {
  const path = asNonEmptyString(input.path)
  if (path === undefined) return { ok: false, reason: 'path is required and must be a non-empty string' }

  const rawContent = asNonEmptyString(input.content)
  if (rawContent === undefined) return { ok: false, reason: 'content is required and must be a non-empty string' }
  const content = rawContent.length > MAX_COMMENT_CHARS ? `${rawContent.slice(0, MAX_COMMENT_CHARS)}…` : rawContent

  const startLine = asLine(input.startLine)
  const endLine = asLine(input.endLine)
  const positioned = startLine === 0 && endLine === 0
  if (!positioned) {
    if (startLine < 1) return { ok: false, reason: 'startLine must be a 1-based line, or 0 with endLine 0 for an unpositioned comment' }
    if (endLine < startLine) return { ok: false, reason: 'endLine must not precede startLine' }
  }

  return {
    ok: true,
    comment: {
      id,
      path: normalizePath(path),
      content,
      startLine,
      endLine,
      category: asCategory(input.category),
      severity: asSeverity(input.severity),
      // Conditional spreads rather than a helper: absent must stay absent, and
      // an optional field written as `undefined` is a present key with no value.
      ...withOptional('suggestionCode', asOptionalString(input.suggestionCode)),
      ...withOptional('existingCode', asOptionalString(input.existingCode)),
      ...withOptional('ruleSource', asOptionalString(input.ruleSource)),
      ...withOptional('reviewer', asOptionalString(input.reviewer)),
      state: 'proposed',
    },
  }
}

/** Sort key for a report: severity first, then path, then line. */
export function compareComments(left: ReviewComment, right: ReviewComment): number {
  const bySeverity = REVIEW_SEVERITIES.indexOf(left.severity) - REVIEW_SEVERITIES.indexOf(right.severity)
  if (bySeverity !== 0) return bySeverity
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return left.startLine - right.startLine
}

/** Whether a comment is addressed to a line the change actually added. */
export function isAddedLineComment(comment: ReviewComment): boolean {
  return comment.startLine > 0
}

/** Coerce an unknown to a line number, defaulting an absent value to 0 (unpositioned). */
function asLine(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.trunc(parsed)
}

/** Coerce an unknown to a known category, defaulting to `other`. */
function asCategory(value: unknown): ReviewCategory {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (REVIEW_CATEGORIES as readonly string[]).includes(text) ? (text as ReviewCategory) : 'other'
}

/** Coerce an unknown to a known severity, defaulting to `medium`. */
function asSeverity(value: unknown): ReviewSeverity {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (REVIEW_SEVERITIES as readonly string[]).includes(text) ? (text as ReviewSeverity) : 'medium'
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function asOptionalString(value: unknown): string | undefined {
  return asNonEmptyString(value)
}

/** Include a field only when it has a value, so absent stays absent rather than empty. */
function withOptional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V })
}

/** Normalize a path to POSIX separators without a leading `./`. */
function normalizePath(path: string): string {
  const out = path.replace(/\\/g, '/')
  return out.startsWith('./') ? out.slice(2) : out
}
