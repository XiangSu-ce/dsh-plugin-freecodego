/**
 * The post-filter: removing only what the diff *proves* wrong.
 *
 * Fail-open, and why that is the whole design
 * ------------------------------------------
 * A reviewer that read the codebase reports things the diff alone cannot confirm
 * ("this helper already exists", "the caller was not updated"). A fact-checker
 * that sees only the diff must therefore treat *absence of evidence* as approval.
 * Every ambiguous input here resolves to keep:
 *
 * - the model call fails → every comment is kept (`failedOpen`);
 * - the response is unreadable → every comment is kept (`failedOpen`);
 * - a comment has no verdict → it is kept;
 * - a verdict names an id that does not exist → it is ignored.
 *
 * The asymmetry is the upstream one and it is the correct one: keeping a wrong
 * comment costs seconds, while dropping a right one destroys a finding with no
 * record that it existed. So the filter can only ever remove a comment it has
 * been *told*, with a reason, is disproven — and the removal is recorded rather
 * than deleted, which is what makes the filter auditable at all.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/filter
 */

import { extractJsonValue, type ReviewModelPort } from './model.ts'
import { REVIEW_FILTER_SYSTEM } from './prompts.ts'
import type { ReviewComment } from './comments.ts'

/** One fact-checker verdict. */
export interface ReviewFilterVerdict {
  readonly id: string
  readonly approve: boolean
  /** Why the comment is disproven; required when `approve` is false. */
  readonly reason?: string
}

/** The outcome of a filter pass. */
export interface ReviewFilterOutcome {
  /** Comments that survived, with `state` set to `kept`. */
  readonly kept: readonly ReviewComment[]
  /** Comments the filter disproved, retained with `state` `filtered`. */
  readonly removed: readonly ReviewComment[]
  /** True when the pass could not run and every comment was kept. */
  readonly failedOpen: boolean
  /** Present when the pass failed open, naming the reason. */
  readonly reason?: string
  readonly spent: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Read verdicts out of a fact-checker response. */
export function parseFilterVerdicts(raw: unknown): ReviewFilterVerdict[] {
  const container = Array.isArray(raw)
    ? raw
    : (typeof raw === 'object' && raw !== null && Array.isArray((raw as { verdicts?: unknown }).verdicts)
        ? (raw as { verdicts: unknown[] }).verdicts
        : [])
  const out: ReviewFilterVerdict[] = []
  for (const entry of container) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : undefined
    if (id === undefined) continue
    const approve = record.approve === true
    const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
    // A removal with no stated evidence is not a removal; the prompt requires the
    // reason, and a verdict that omits it is treated as an approval rather than
    // silently dropping a finding on the strength of an unstated argument.
    if (!approve && reason === '') {
      out.push({ id, approve: true })
      continue
    }
    out.push(reason === '' ? { id, approve } : { id, approve, reason })
  }
  return out
}

/**
 * Apply verdicts to comments.
 *
 * A comment with no verdict is kept. That is not a default that could be
 * changed: it is the rule that makes an incomplete response safe.
 */
export function applyFilterVerdicts(
  comments: readonly ReviewComment[],
  verdicts: readonly ReviewFilterVerdict[],
): { readonly kept: ReviewComment[]; readonly removed: ReviewComment[] } {
  const byId = new Map<string, ReviewFilterVerdict>()
  for (const verdict of verdicts) byId.set(verdict.id, verdict)

  const kept: ReviewComment[] = []
  const removed: ReviewComment[] = []
  for (const comment of comments) {
    const verdict = byId.get(comment.id)
    if (verdict === undefined || verdict.approve) {
      kept.push({ ...comment, state: 'kept' })
      continue
    }
    removed.push({
      ...comment,
      state: 'filtered',
      filteredReason: verdict.reason ?? 'disproven by the diff',
    })
  }
  return { kept, removed }
}

/**
 * Run the post-filter over one batch's comments.
 *
 * Returns every comment unchanged, with `failedOpen` set, whenever the pass
 * cannot complete. The caller publishes both lists, so a run always reports how
 * many findings the filter dropped and never loses the record of one.
 */
export async function filterComments(
  model: ReviewModelPort,
  comments: readonly ReviewComment[],
  diffText: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReviewFilterOutcome> {
  const nothing = { inputTokens: 0, outputTokens: 0 }
  if (comments.length === 0) {
    return { kept: [], removed: [], failedOpen: false, spent: nothing }
  }

  let text: string
  let spent = nothing
  try {
    const result = await model.generate({
      system: REVIEW_FILTER_SYSTEM,
      user: renderFilterUser(comments, diffText),
      maxOutputTokens: 2_048,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    text = result.text
    spent = { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
  } catch (error) {
    const kept = comments.map(comment => ({ ...comment, state: 'kept' as const }))
    return {
      kept,
      removed: [],
      failedOpen: true,
      reason: `the filter call failed, every comment was kept: ${(error as Error).message}`,
      spent: nothing,
    }
  }

  const parsed = extractJsonValue(text)
  if (parsed === undefined) {
    const kept = comments.map(comment => ({ ...comment, state: 'kept' as const }))
    return {
      kept,
      removed: [],
      failedOpen: true,
      reason: 'the filter response held no readable verdicts, every comment was kept',
      spent,
    }
  }

  const applied = applyFilterVerdicts(comments, parseFilterVerdicts(parsed))
  return { ...applied, failedOpen: false, spent }
}

/** The user message handed to the fact-checker: the comments, then the diff. */
function renderFilterUser(comments: readonly ReviewComment[], diffText: string): string {
  const rendered = comments.map(comment => JSON.stringify({
    id: comment.id,
    path: comment.path,
    content: comment.content,
    start_line: comment.startLine,
    end_line: comment.endLine,
    severity: comment.severity,
    category: comment.category,
    ...(comment.existingCode === undefined ? {} : { existing_code: comment.existingCode }),
  }))
  return `<comments>\n${rendered.join('\n')}\n</comments>\n\n<diff>\n${diffText}\n</diff>`
}
