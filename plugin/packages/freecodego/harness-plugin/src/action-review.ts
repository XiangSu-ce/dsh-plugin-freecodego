/**
 * Action review: the policy half of a Guardian-style reviewer.
 *
 * Why a *policy* module and not a reviewer
 * ----------------------------------------
 * Our `advisor.ts` reviews an answer that already exists. A Guardian reviews a
 * *pending action* — the thing that is about to touch the machine — and Codex's
 * implementation is mostly policy rather than prompting:
 *
 * - **Absence falls back to the user, never to allow.** `decide_approval` returns
 *   `Option<ReviewDecision>` with the comment *"`None` requests the existing user
 *   flow. No contributor is never an implicit allow."* That single choice is what
 *   makes an automated reviewer safe to enable: an unavailable, over-budget, or
 *   crashed reviewer degrades to the approval prompt the user already had.
 * - **The reviewer reads a delta, not the transcript.** A cursor
 *   (`parent_history_version`, `transcript_entry_count`) is only reusable while
 *   the history version still matches, so a compacted or rolled-back history
 *   forces a full re-read instead of silently reviewing the wrong slice.
 * - **The reviewer has its own budget.** `ExhaustedReviewBudget` and the input
 *   budget exist so the safety mechanism cannot become an unbounded cost: once
 *   the budget is gone, reviews stop and the user flow takes over.
 * - **Every piece of context is capped.** Per-entry, per-reason, and per-tool-
 *   result token limits, because a reviewer is judged on the action, not on the
 *   whole conversation that led to it.
 *
 * This module implements those four rules as pure state: what the reviewer would
 * be asked to look at, whether it is allowed to run, and what a missing verdict
 * means. The model call itself is injected, so this is testable without a
 * provider and so a deployment with no reviewer configured still behaves
 * correctly (it just always returns "ask the user").
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/action-review
 */

import { tokensFromChars } from './token-estimate.ts'

/** Per-section and per-entry token caps, in the spirit of Codex's constants. */
export const ACTION_REVIEW_LIMITS = {
  /** One approval reason (the "why were you asked" line). */
  reasonTokens: 512,
  /** The action's own rendered arguments. */
  actionTokens: 1_536,
  /** One transcript entry shown as evidence. */
  entryTokens: 512,
  /** One tool result the reviewer may read in full. */
  toolResultTokens: 2_048,
  /** Total review input, across every section. */
  totalTokens: 12_000,
} as const

/** Default per-session review budget: reviews, not tokens, is what exhausts first. */
export const DEFAULT_REVIEW_BUDGET = 40

/** Separator placed between transcript entries in the rendered review input. */
const ENTRY_SEPARATOR = '\n---\n'
const ENTRY_SEPARATOR_TOKENS = tokensFromChars(ENTRY_SEPARATOR.length)

export interface ActionReviewCursor {
  /** History generation this cursor was taken from; a bump invalidates it. */
  readonly historyVersion: number
  /**
   * High-water mark in the transcript's own index space: the position one past
   * the last entry the reviewer actually read.
   *
   * A position, not a count, because {@link ActionReviewRequest.transcript}
   * carries the entries' positions in the session snapshot — a windowed tail of
   * a long session starts in the hundreds while holding a couple of hundred
   * rows, and the two only coincide for the first window of a short session.
   */
  readonly entryCount: number
}

export interface ActionReviewRequest {
  readonly sessionId: string
  /** The action as the user would see it: a tool name and its arguments. */
  readonly action: { readonly tool: string; readonly summary: string; readonly argumentsText?: string }
  /** Why approval is being requested at all. */
  readonly reason: string
  /** Transcript entries, oldest first, with a monotonically increasing index. */
  readonly transcript: readonly { readonly index: number; readonly text: string }[]
  /** Current history generation, bumped by compaction or rollback. */
  readonly historyVersion: number
}

export interface ComposedReviewInput {
  readonly actionText: string
  readonly reasonText: string
  readonly transcriptText: string
  /**
   * Position one past the last entry *included* in this review, so the cursor
   * advances over evidence the reviewer actually read and no further.
   */
  readonly reviewedThrough: number
  readonly mode: 'full' | 'delta'
  readonly truncated: boolean
}

/** Approximate token count at the plugin's single density, the same one the spend probes use. */
export function approximateTokens(text: string): number {
  return tokensFromChars(text.length)
}

/** Cut text to a token budget, announcing the cut rather than pretending it fits. */
export function capToTokens(text: string, tokens: number): { readonly text: string; readonly truncated: boolean } {
  const limit = Math.max(1, tokens) * 4
  if (text.length <= limit) return { text, truncated: false }
  // The marker is part of what the reviewer reads, so it comes out of the budget:
  // a cap whose announcement overflows the cap is not a cap.
  const full = '\n[truncated to fit the review budget]'
  // A budget too small to hold the announcement still gets an ellipsis, and the
  // caller always has the `truncated` flag; the alternative is text that exceeds
  // the cap it was given.
  const marker = full.length < limit ? full : '…'
  const room = Math.max(0, limit - marker.length)
  return { text: `${text.slice(0, room)}${marker}`, truncated: true }
}

/**
 * Build what the reviewer is shown.
 *
 * A reusable cursor means only the entries the reviewer has not seen are sent;
 * anything else (a newer history version, a cursor past the end) degrades to a
 * full read, because reviewing a wrong slice is worse than paying for a right one.
 */
export function composeReviewInput(request: ActionReviewRequest, cursor?: ActionReviewCursor): ComposedReviewInput {
  // The cursor is compared in the transcript's index space. Testing it against
  // the window's *row count* instead declared every cursor stale once event
  // positions passed the window size — precisely the long sessions the delta
  // exists for — so the reviewer re-read the whole window on every prompt. A
  // cursor ahead of the newest entry is still refused: that means the transcript
  // moved underneath it, and reviewing the wrong slice is worse than paying for
  // a right one.
  const newestThrough = request.transcript.reduce((high, entry) => Math.max(high, entry.index + 1), 0)
  const reusable = cursor !== undefined && cursor.historyVersion === request.historyVersion
    && cursor.entryCount <= newestThrough
  const pending = reusable ? request.transcript.filter(entry => entry.index >= cursor.entryCount) : request.transcript
  const action = capToTokens(request.action.argumentsText === undefined
    ? request.action.summary
    : `${request.action.summary}\n${request.action.argumentsText}`, ACTION_REVIEW_LIMITS.actionTokens)
  const reason = capToTokens(request.reason, ACTION_REVIEW_LIMITS.reasonTokens)
  const entries: string[] = []
  // One past the last entry that actually made it into the input. The caps below
  // stop the loop partway through a long window, so the end of the *requested*
  // delta is not the same thing as the end of what the reviewer read.
  let includedThrough: number | undefined
  let used = approximateTokens(action.text) + approximateTokens(reason.text)
  let truncated = action.truncated || reason.truncated
  for (const entry of pending) {
    // The separator between entries is part of what the reviewer reads, so it is
    // charged against the budget too; ignoring it is how a cap ends up exceeded
    // by exactly the number of joins.
    const separator = entries.length === 0 ? 0 : ENTRY_SEPARATOR_TOKENS
    const capped = capToTokens(entry.text, Math.min(ACTION_REVIEW_LIMITS.entryTokens, Math.max(64, ACTION_REVIEW_LIMITS.totalTokens - used - separator)))
    if (used + separator + approximateTokens(capped.text) > ACTION_REVIEW_LIMITS.totalTokens) { truncated = true; break }
    entries.push(capped.text)
    includedThrough = entry.index + 1
    used += separator + approximateTokens(capped.text)
    if (capped.truncated) truncated = true
  }
  return {
    actionText: action.text,
    reasonText: reason.text,
    transcriptText: entries.join(ENTRY_SEPARATOR),
    // Advancing past entries the budget dropped marked them reviewed for good:
    // the next review's delta starts after the claimed point, so the tail of a
    // long window was never shown to the reviewer at all. Nothing included means
    // nothing reviewed — the cursor stays where it was (a delta) or sits at the
    // window's first entry (a full read that could not fit even one row).
    reviewedThrough: includedThrough ?? (reusable ? cursor.entryCount : pending[0]?.index ?? 0),
    mode: reusable ? 'delta' : 'full',
    truncated,
  }
}

export type ReviewOutcome =
  /** The reviewer cleared the action. */
  | { readonly kind: 'allow'; readonly rationale?: string }
  /** The reviewer refused it. */
  | { readonly kind: 'deny'; readonly rationale: string }
  /** No verdict — the user flow must run. Never treated as an allow. */
  | { readonly kind: 'ask-user'; readonly why: 'no-reviewer' | 'budget-exhausted' | 'reviewer-failed' }

export interface Reviewer {
  review(input: ComposedReviewInput, action: ActionReviewRequest['action']): Promise<ReviewOutcome>
}

export interface ActionReviewBudgetReport {
  readonly used: number
  readonly limit: number
  readonly exhausted: boolean
}

/**
 * Per-session review budget plus the cursor the reviewer left behind.
 *
 * Budget exhaustion is sticky for the session: a reviewer that ran out of budget
 * mid-session must not silently start allowing things after the next successful
 * call, and the caller is told so it can surface the fallback.
 */
export class ActionReviewState {
  private readonly used = new Map<string, number>()
  private readonly cursors = new Map<string, ActionReviewCursor>()

  constructor(private readonly limit: number = DEFAULT_REVIEW_BUDGET) {}

  budget(sessionId: string): ActionReviewBudgetReport {
    const used = this.used.get(sessionId) ?? 0
    return { used, limit: this.limit, exhausted: used >= this.limit }
  }

  cursor(sessionId: string): ActionReviewCursor | undefined {
    return this.cursors.get(sessionId)
  }

  /** Drop a cursor whose history generation no longer matches. */
  invalidate(sessionId: string): void {
    this.cursors.delete(sessionId)
  }

  /**
   * Release every per-session record for a conversation that is going away.
   *
   * Both maps are keyed by session id and neither is self-limiting, so without
   * this a long-lived Host keeps one budget counter and one cursor for every
   * conversation it has ever opened. `invalidate` is not a substitute: it drops a
   * cursor whose history generation moved, which is a different event and leaves
   * the budget counter behind.
   */
  forget(sessionId: string): void {
    this.used.delete(sessionId)
    this.cursors.delete(sessionId)
  }

  /**
   * Review one action.
   *
   * `reviewer === undefined` is the deployment with no reviewer configured; it
   * returns `ask-user`, which is the same answer as a reviewer that failed.
   */
  async review(
    request: ActionReviewRequest,
    reviewer: Reviewer | undefined,
    cacheKey: (sessionId: string) => string = sessionId => `freecodego-action-review:${sessionId}`,
  ): Promise<{ readonly outcome: ReviewOutcome; readonly input: ComposedReviewInput; readonly cacheKey: string }> {
    const input = composeReviewInput(request, this.cursors.get(request.sessionId))
    if (reviewer === undefined) return { outcome: { kind: 'ask-user', why: 'no-reviewer' }, input, cacheKey: cacheKey(request.sessionId) }
    if (this.budget(request.sessionId).exhausted) return { outcome: { kind: 'ask-user', why: 'budget-exhausted' }, input, cacheKey: cacheKey(request.sessionId) }
    let outcome: ReviewOutcome
    try {
      outcome = await reviewer.review(input, request.action)
    } catch {
      // A reviewer that threw is not a reviewer that approved.
      return { outcome: { kind: 'ask-user', why: 'reviewer-failed' }, input, cacheKey: cacheKey(request.sessionId) }
    }
    this.used.set(request.sessionId, (this.used.get(request.sessionId) ?? 0) + 1)
    if (outcome.kind !== 'ask-user') {
      this.cursors.set(request.sessionId, { historyVersion: request.historyVersion, entryCount: input.reviewedThrough })
    }
    return { outcome, input, cacheKey: cacheKey(request.sessionId) }
  }
}

/**
 * Human-readable line for a review outcome, for the approval prompt and the log.
 *
 * Stated for every outcome rather than only the two verdicts: `ask-user` is the
 * most common result by construction — it is what every failure, missing route,
 * and exhausted budget degrades to — and "why did I get a prompt for this" is
 * exactly the question that needs an answer.
 */
export function describeReviewOutcome(outcome: ReviewOutcome): string {
  if (outcome.kind === 'allow') return outcome.rationale === undefined ? 'automated review cleared this action' : `automated review cleared this action: ${outcome.rationale}`
  if (outcome.kind === 'deny') return `automated review refused this action: ${outcome.rationale}`
  const why = outcome.why === 'no-reviewer' ? 'no automated reviewer is configured'
    : outcome.why === 'budget-exhausted' ? 'this session\'s review budget is exhausted'
      : 'the automated reviewer did not return a verdict'
  return `asking the user, because ${why}`
}
