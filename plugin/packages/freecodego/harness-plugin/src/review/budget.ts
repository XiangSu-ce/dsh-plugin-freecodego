/**
 * The review budget: what a run is allowed to spend, and what it does when the
 * money runs out.
 *
 * The rule that shapes everything here
 * -----------------------------------
 * A budget is not a limit on the *work*; it is a limit on the *cost*, and the two
 * come apart exactly when a reviewer is mid-answer. Cutting a group off the
 * instant it reaches its ceiling throws away the findings it was about to submit
 * and reports a file as unreviewed when it was very nearly reviewed. So the
 * shipped contract is: a group that is already over its ceiling gets **one final
 * round to submit what it has**, and only then stops. That is why
 * {@link admitRound} returns `final` rather than a plain allow/deny — the caller
 * has to say so in the prompt, and a boolean would lose the fact.
 *
 * The second rule is about honesty. Once the whole-run ceiling is gone, no new
 * group is dispatched, the findings already produced are still published, and
 * the files that never ran are reported as `failed` with the budget as the
 * reason. A partially-completed review that says so is useful; one that looks
 * complete is not.
 *
 * State is immutable and passed in, matching this plugin's other judging code:
 * the engine owns the sequence of decisions, this module owns what each decision
 * means.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/budget
 */

/** The two ceilings one run is bounded by, in estimated tokens. */
export interface ReviewBudgetLimits {
  /** Ceiling for one group's accumulated prompt cost, before it is cut off. */
  readonly maxGroupTokens: number
  /** Ceiling over the whole run's accumulated cost, before no new group starts. */
  readonly maxTotalTokens: number
}

/** Shipped defaults, chosen to bound a review of an ordinary change set. */
export const DEFAULT_REVIEW_BUDGET: ReviewBudgetLimits = {
  maxGroupTokens: 200_000,
  maxTotalTokens: 1_500_000,
}

/** What a run has spent so far, and which groups are on their last round. */
export interface ReviewBudgetState {
  /** Accumulated cost across every group. */
  readonly spentTotal: number
  /** Accumulated cost per group id. */
  readonly groups: Readonly<Record<string, number>>
  /**
   * Groups that have already been told this is their final round.
   *
   * Without this the final-round allowance would be unlimited: each round would
   * be "the final one" and the ceiling would bound nothing.
   */
  readonly finalRoundGroups: readonly string[]
}

/** The decision about starting one more group. */
export type GroupAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** The decision about one more round within a group. */
export type RoundAdmission =
  | { readonly ok: true; readonly final: boolean }
  | { readonly ok: false; readonly reason: string }

/** A fresh run with nothing spent. */
export function createBudgetState(): ReviewBudgetState {
  return { spentTotal: 0, groups: {}, finalRoundGroups: [] }
}

/** Whether a new group may be started. */
export function admitGroup(state: ReviewBudgetState, limits: ReviewBudgetLimits): GroupAdmission {
  if (state.spentTotal >= limits.maxTotalTokens) {
    return {
      ok: false,
      reason: `run budget exhausted: ${state.spentTotal} of ${limits.maxTotalTokens} tokens spent, no further groups dispatched`,
    }
  }
  return { ok: true }
}

/**
 * Whether a group may take another round.
 *
 * `groupId` must be the group whose spend is being judged; a group over its own
 * ceiling is allowed exactly one final round, which the returned `final` flag
 * announces so the caller can tell the reviewer to submit.
 */
export function admitRound(
  state: ReviewBudgetState,
  groupId: string,
  limits: ReviewBudgetLimits,
): RoundAdmission {
  if (state.spentTotal >= limits.maxTotalTokens) {
    return { ok: false, reason: `run budget exhausted at ${state.spentTotal} of ${limits.maxTotalTokens} tokens` }
  }
  const groupSpent = state.groups[groupId] ?? 0
  if (groupSpent < limits.maxGroupTokens) return { ok: true, final: false }
  if (state.finalRoundGroups.includes(groupId)) {
    return {
      ok: false,
      reason: `group budget exhausted after its final round: ${groupSpent} of ${limits.maxGroupTokens} tokens`,
    }
  }
  return { ok: true, final: true }
}

/**
 * Record cost accrued by one group.
 *
 * Recording an over-ceiling amount is deliberate rather than an error: the spend
 * happened, and a state that refuses to hear about it would report a total that
 * disagrees with what the provider metered.
 */
export function recordSpend(state: ReviewBudgetState, groupId: string, tokens: number): ReviewBudgetState {
  const delta = Math.max(0, Math.trunc(tokens))
  return {
    spentTotal: state.spentTotal + delta,
    groups: { ...state.groups, [groupId]: (state.groups[groupId] ?? 0) + delta },
    finalRoundGroups: state.finalRoundGroups,
  }
}

/** Mark that a group has consumed its final round, changing nothing else. */
export function consumeFinalRound(state: ReviewBudgetState, groupId: string): ReviewBudgetState {
  return {
    ...state,
    finalRoundGroups: state.finalRoundGroups.includes(groupId)
      ? state.finalRoundGroups
      : [...state.finalRoundGroups, groupId],
  }
}

/** Whether the whole-run ceiling is gone, which a report states as `exhausted`. */
export function isBudgetExhausted(state: ReviewBudgetState, limits: ReviewBudgetLimits): boolean {
  return state.spentTotal >= limits.maxTotalTokens
}

/** The budget as a report renders it. */
export interface ReviewBudgetSummary {
  readonly maxGroupTokens: number
  readonly maxTotalTokens: number
  readonly spentTotal: number
  readonly exhausted: boolean
}

/** Summarize state and limits for a report. */
export function summarizeBudget(state: ReviewBudgetState, limits: ReviewBudgetLimits): ReviewBudgetSummary {
  return {
    maxGroupTokens: limits.maxGroupTokens,
    maxTotalTokens: limits.maxTotalTokens,
    spentTotal: state.spentTotal,
    exhausted: isBudgetExhausted(state, limits),
  }
}
