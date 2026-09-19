/**
 * The economics of compacting: whether rewriting the prefix pays for itself.
 *
 * Why this exists
 * ---------------
 * `context-budget.ts` records the measured failure — **compaction never runs in
 * practice**. The threshold the engine watches (a fraction of the window) is
 * answered long before the saving is worth its cost, so the common case is a
 * session that ends still carrying every token it ever read. The engine's
 * question is "is the window full?", and that is the wrong question: compacting
 * *rewrites the reusable request prefix*, which is billed as a cache **write**
 * for the whole remaining conversation, to save tokens on future requests that
 * may never come.
 *
 * So the decision is arithmetic, and this module is the arithmetic:
 *
 *     breakevenRequests = writeTokens × (cacheWriteReadRatio − 1) / savingTokens
 *
 * Compact when the requests you still expect to make outnumber the requests it
 * takes to pay the rewrite back. Everything else here exists to make that
 * comparison honest:
 *
 * - **The horizon is estimated, not assumed.** `estimateRemainingRequests`
 *   projects how many requests are left from how many requests the previous
 *   boundaries actually took, with a lower bound rather than a mean once there
 *   is enough variance to compute one, and a deliberate half-scale discount on
 *   small samples — a guess from two data points should not authorise a rewrite.
 * - **The first compaction is subsidised, later ones are taxed.** The first
 *   rewrite happens once and buys the rest of the session, so its horizon is
 *   doubled; after that a margin of 1.5× is required, because by then the cost
 *   has been paid and the reason to compact again is weaker.
 * - **Debt is carried.** A rewrite whose saving never materialised leaves a
 *   deficit that the next decision has to clear before it may run again.
 * - **A window at the reserve line overrides the arithmetic.** When the next
 *   request would fail outright, cost is no longer the question.
 * - **A refusal to compact is a result, not a silence.** Every path returns a
 *   reason, and the reasons are distinct: "the horizon cannot be estimated" and
 *   "this genuinely does not pay" call for different follow-ups.
 *
 * The ratio inputs come from pricing, and pricing is not always known. When it
 * is not, the answer is `cache_ratio_unavailable` rather than a compact with an
 * invented multiplier — a wrong rewrite is worse than a missed one because it is
 * billed for the rest of the session.
 *
 * @module @deepseek-ai/dsh-freecodego/harness-plugin/compaction-economics
 */

/** The tunables, all injected so a decision can be replayed in a test. */
export interface CompactionEconomics {
  /** Multiplier on the estimated horizon, for a caller that wants to be braver. */
  readonly remainingRequestScale: number
  /** Standard deviations subtracted from the mean request count; 0 keeps the mean. */
  readonly remainingRequestStddevK: number
  /** Room kept free at the top of the window, in tokens, before a hard compact. */
  readonly windowReserveTokens: number
  /** The first compaction's horizon multiplier; a rewrite is a one-off cost. */
  readonly firstCompactionRequestScale: number
  /** How much the horizon must exceed breakeven after the first compaction. */
  readonly subsequentCompactionMargin: number
}

/** The defaults, chosen to defer rather than to compact. */
export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
  remainingRequestScale: 1,
  remainingRequestStddevK: 0,
  windowReserveTokens: 16_384,
  firstCompactionRequestScale: 2,
  subsequentCompactionMargin: 1.5,
})

/**
 * Why the decision came out the way it did.
 *
 * One code per *distinct* follow-up. Two codes that would be acted on the same
 * way are one code, and a code that cannot be acted on at all is a bug in this
 * list: `deferred_subsequent_margin` means "wait for more request evidence",
 * `deferred_carried_debt` means "the last rewrite still owes its own cost", and
 * `cache_ratio_unavailable` means the seat is misconfigured rather than patient.
 */
export type CompactionReason =
  | 'economic'
  | 'window_protection'
  | 'deferred_economic'
  | 'deferred_subsequent_margin'
  | 'deferred_carried_debt'
  | 'horizon_unavailable'
  | 'cache_ratio_unavailable'
  | 'non_positive_saving'

/** Below this many observations a variance is not a variance. */
const MINIMUM_VARIANCE_SAMPLES = 3
/** What a small sample's mean is worth: half. */
const SMALL_SAMPLE_SCALE = 0.5

/** How many requests the session has left, and where every figure came from. */
export interface RequestHorizonEstimate {
  readonly completedBoundaryRequestCounts: readonly number[]
  readonly requestsPerBoundaryMean: number
  readonly requestsPerBoundaryLowerBound: number
  readonly unboundedExpectedRemainingRequests: number
  readonly averageContextTokenIncrement: number | null
  /** How many requests fit before the window fills, when that can be computed. */
  readonly windowRequestUpperBound: number | null
  readonly expectedRemainingRequests: number
}

/**
 * Project how many requests are left.
 *
 * Two bounds are computed and the smaller wins, because they fail in opposite
 * directions: the request-count projection assumes the session continues at the
 * pace of its own history, and the window projection assumes nobody compacts —
 * which is exactly the case this decision is about. A session that grows faster
 * than its history suggests is caught by the window bound, and a session whose
 * window is unknown falls back to the request-count bound alone.
 *
 * @param input - the observed boundary request counts and the window's state.
 * @returns the estimate, with every intermediate figure carried out for a reader.
 */
export function estimateRemainingRequests(input: {
  readonly completedBoundaryRequestCounts: readonly number[]
  readonly remainingBoundaries: number
  readonly scale: number
  readonly standardDeviationK: number
  readonly contextTokens: number
  readonly contextWindowTokens: number | null
  readonly averageContextTokenIncrement: number | null
}): RequestHorizonEstimate {
  const samples = input.completedBoundaryRequestCounts.length
  const mean = input.completedBoundaryRequestCounts.reduce((total, count) => total + count, 0) / Math.max(1, samples)
  let lowerBound = mean
  if (input.standardDeviationK !== 0) {
    if (samples < MINIMUM_VARIANCE_SAMPLES) {
      // A standard deviation from one or two observations is noise, so the
      // discount is applied to the mean instead of pretending to a variance.
      lowerBound *= SMALL_SAMPLE_SCALE
    } else {
      const variance = input.completedBoundaryRequestCounts
        .reduce((total, count) => total + (count - mean) ** 2, 0) / (samples - 1)
      lowerBound = Math.max(0, mean - input.standardDeviationK * Math.sqrt(variance))
    }
  }
  const unboundedExpectedRemainingRequests = 1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale)
  const windowRequestUpperBound = input.contextWindowTokens === null ||
    input.averageContextTokenIncrement === null ||
    input.averageContextTokenIncrement <= 0
    ? null
    : Math.max(0, Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement))
  return {
    completedBoundaryRequestCounts: [...input.completedBoundaryRequestCounts],
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryLowerBound: lowerBound,
    unboundedExpectedRemainingRequests,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    windowRequestUpperBound,
    expectedRemainingRequests: windowRequestUpperBound === null
      ? unboundedExpectedRemainingRequests
      : Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
  }
}

/** Everything the decision reads, named so a caller cannot pass a wrong number silently. */
export interface CompactionEconomicsInput {
  /** Tokens the rewrite itself costs to write: the compacted prefix. */
  readonly writeTokens: number
  /** Tokens the history occupies today, and would stop costing per request. */
  readonly archiveTokens: number
  /** Tokens the summary costs to carry on every future request. */
  readonly memoTokens: number
  readonly contextTokens: number
  readonly contextWindowTokens: number | null
  /** Requests per completed boundary, or `null` when no boundary has completed. */
  readonly completedBoundaryRequestCounts: readonly number[] | null
  /** How many boundaries the session still expects to cross. */
  readonly remainingBoundaries: number
  readonly averageContextTokenIncrement: number | null
  readonly priorCompactionCount: number
  /** Cost the previous rewrite has not yet earned back. */
  readonly carriedDebtTokens: number
  readonly cacheWriteReadRatio: number | null
  readonly economics: CompactionEconomics
}

/** The decision, with every intermediate figure so a report can explain it. */
export interface CompactionEconomicsDecision {
  readonly writeTokens: number
  readonly archiveTokens: number
  readonly memoTokens: number
  readonly contextTokens: number
  readonly savingTokens: number
  readonly cacheWriteReadRatio: number | null
  readonly incrementalCacheCostRatio: number | null
  readonly breakevenRequests: number | null
  readonly combinedBreakevenRequests: number | null
  readonly effectiveHorizonRequests: number | null
  readonly priorCompactionCount: number
  readonly carriedDebtTokens: number
  readonly expectedRemainingRequests: number | null
  readonly windowRequestUpperBound: number | null
  /** Room kept free at the top of the window; a decision says which line it used. */
  readonly windowReserveTokens: number
  /** The margin a second rewrite had to clear; carried so a message can quote it. */
  readonly subsequentCompactionMargin: number
  readonly windowProtection: boolean
  readonly compact: boolean
  readonly reason: CompactionReason
}

/**
 * Decide whether to compact.
 *
 * Order is the whole design: a window at the reserve line compacts regardless of
 * cost (the alternative is a failed request), then the arithmetic decides, and
 * every remaining path names why it did not.
 *
 * @param input - the cost model, the horizon inputs, and the tunables.
 * @returns the decision and every figure it rests on.
 */
export function decideCompaction(input: CompactionEconomicsInput): CompactionEconomicsDecision {
  // An empty sample list is "no evidence", the same fact as `null`: it is the
  // shape a caller produces when a boundary completed but nothing was counted,
  // and estimating from it would authorise a rewrite on a single request.
  const samples = input.completedBoundaryRequestCounts
  const horizon = samples === null || samples.length === 0
    ? null
    : estimateRemainingRequests({
      completedBoundaryRequestCounts: samples,
      remainingBoundaries: input.remainingBoundaries,
      scale: input.economics.remainingRequestScale,
      standardDeviationK: input.economics.remainingRequestStddevK,
      contextTokens: input.contextTokens,
      contextWindowTokens: input.contextWindowTokens,
      averageContextTokenIncrement: input.averageContextTokenIncrement,
    })
  const savingTokens = input.archiveTokens - input.memoTokens
  const incrementalCacheCostRatio = input.cacheWriteReadRatio === null
    ? null
    : Math.max(0, input.cacheWriteReadRatio - 1)
  const breakevenRequests = savingTokens > 0 && incrementalCacheCostRatio !== null
    ? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
    : null
  // Debt is added to the same numerator because it is the same kind of cost: the
  // outstanding part of a rewrite that has not yet been amortised.
  const combinedBreakevenRequests = savingTokens > 0 && incrementalCacheCostRatio !== null
    ? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
    : null
  const firstCompaction = input.priorCompactionCount === 0
  const effectiveHorizonRequests = horizon === null
    ? null
    : firstCompaction
      // A one-off rewrite buys the rest of the session, so a first compaction may
      // run on a horizon twice as short — but never on a promise the window
      // itself cannot keep.
      ? Math.min(
        horizon.expectedRemainingRequests * input.economics.firstCompactionRequestScale,
        horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
      )
      : horizon.expectedRemainingRequests
  const windowProtection = input.contextWindowTokens !== null &&
    input.contextTokens >= input.contextWindowTokens - input.economics.windowReserveTokens
  const baseEconomic = horizon !== null && horizon.expectedRemainingRequests > 0 &&
    breakevenRequests !== null && breakevenRequests <= horizon.expectedRemainingRequests
  const firstEconomic = firstCompaction && effectiveHorizonRequests !== null && effectiveHorizonRequests > 0 &&
    breakevenRequests !== null && breakevenRequests <= effectiveHorizonRequests
  const subsequentMarginOpen = !firstCompaction && horizon !== null && breakevenRequests !== null &&
    breakevenRequests * input.economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests
  const carriedDebtGateOpen = !firstCompaction && horizon !== null && combinedBreakevenRequests !== null &&
    combinedBreakevenRequests <= horizon.expectedRemainingRequests
  const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen
  const compressible = savingTokens > 0
  return {
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens: input.memoTokens,
    contextTokens: input.contextTokens,
    savingTokens,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    incrementalCacheCostRatio,
    breakevenRequests,
    combinedBreakevenRequests,
    effectiveHorizonRequests,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    expectedRemainingRequests: horizon?.expectedRemainingRequests ?? null,
    windowRequestUpperBound: horizon?.windowRequestUpperBound ?? null,
    windowReserveTokens: input.economics.windowReserveTokens,
    subsequentCompactionMargin: input.economics.subsequentCompactionMargin,
    windowProtection,
    compact: compressible && (windowProtection || economic),
    // A refusal is a result: every branch names a *distinct* follow-up, so
    // "we did not compact" is never an unexplained silence.
    reason: !compressible
      ? 'non_positive_saving'
      : windowProtection
        ? 'window_protection'
        : economic
          ? 'economic'
          : horizon === null
            ? 'horizon_unavailable'
            : breakevenRequests === null
              ? 'cache_ratio_unavailable'
              : !firstCompaction && baseEconomic && !subsequentMarginOpen
                ? 'deferred_subsequent_margin'
                : !firstCompaction && baseEconomic && !carriedDebtGateOpen
                  ? 'deferred_carried_debt'
                  : 'deferred_economic',
  }
}

/** The cost side of the comparison, which only a caller that knows the engine can supply. */
export interface CompactionCostSide {
  /** Tokens the rewritten prefix costs to write. */
  readonly writeTokens: number
  /** Tokens the summary is carried at on every future request. */
  readonly memoTokens: number
}

/**
 * What a caller gets back when it may not be able to answer the whole question.
 *
 * The two halves are separated deliberately. The horizon and the window state
 * are measurable from what the plugin already has, so they are always reported;
 * the cost side needs the compaction engine's own numbers, and inventing them
 * would produce a decision that reads as authoritative and is not. An
 * unavailable decision is therefore a partial answer with a reason, never a
 * fabricated one — the same rule the budget bands follow for an unadvertised
 * window.
 */
export interface CompactionEconomicsView {
  /** Whether the full comparison could be computed. */
  readonly available: boolean
  /** Inputs that were missing, named so the caller knows what to supply. */
  readonly missing: readonly string[]
  /** Requests per completed boundary, lower bound; `null` when unestimable. */
  readonly requestsPerBoundaryLowerBound: number | null
  readonly expectedRemainingRequests: number | null
  readonly windowRequestUpperBound: number | null
  /** True when the next request would fail without a compaction, cost aside. */
  readonly windowProtection: boolean
  readonly priorCompactionCount: number
  readonly decision?: CompactionEconomicsDecision
  /** One sentence, always present, that a model or a user can act on. */
  readonly note: string
}

/**
 * Answer as much of the compaction question as the available inputs support.
 *
 * @param input - the horizon inputs, the window's state, and the cost side when
 *   the caller knows it.
 * @returns the horizon figures plus a full decision only when every input the
 *   decision needs was supplied.
 */
export function compactionEconomicsView(input: {
  readonly writeTokens: number
  readonly archiveTokens: number
  readonly contextTokens: number
  readonly contextWindowTokens: number | null
  readonly completedBoundaryRequestCounts: readonly number[] | null
  readonly remainingBoundaries: number
  readonly averageContextTokenIncrement: number | null
  readonly priorCompactionCount: number
  readonly carriedDebtTokens: number
  readonly cacheWriteReadRatio: number | null
  readonly economics?: CompactionEconomics
  /**
   * The summary's size, which only the engine that will write it knows.
   *
   * `| undefined` is spelled out deliberately: ".absent" and ".present but
   * unknown" are the same answer here, and a caller assembling this object from
   * optional fields must be able to pass either without a cast.
   */
  readonly memoTokens?: number | undefined
}): CompactionEconomicsView {
  const samples = input.completedBoundaryRequestCounts
  const horizon = samples === null || samples.length === 0
    ? null
    : estimateRemainingRequests({
      completedBoundaryRequestCounts: samples,
      remainingBoundaries: input.remainingBoundaries,
      scale: (input.economics ?? DEFAULT_COMPACTION_ECONOMICS).remainingRequestScale,
      standardDeviationK: (input.economics ?? DEFAULT_COMPACTION_ECONOMICS).remainingRequestStddevK,
      contextTokens: input.contextTokens,
      contextWindowTokens: input.contextWindowTokens,
      averageContextTokenIncrement: input.averageContextTokenIncrement,
    })
  const reserve = (input.economics ?? DEFAULT_COMPACTION_ECONOMICS).windowReserveTokens
  const windowProtection = input.contextWindowTokens !== null && input.contextTokens >= input.contextWindowTokens - reserve
  const memoTokens = input.memoTokens
  const cacheWriteReadRatio = input.cacheWriteReadRatio
  const missing: string[] = []
  if (memoTokens === undefined) missing.push('memoTokens')
  if (input.writeTokens <= 0) missing.push('writeTokens')
  if (cacheWriteReadRatio === null) missing.push('cacheWriteReadRatio')
  const base = {
    requestsPerBoundaryLowerBound: horizon?.requestsPerBoundaryLowerBound ?? null,
    expectedRemainingRequests: horizon?.expectedRemainingRequests ?? null,
    windowRequestUpperBound: horizon?.windowRequestUpperBound ?? null,
    windowProtection,
    priorCompactionCount: input.priorCompactionCount,
  }
  if (memoTokens === undefined || input.writeTokens <= 0 || cacheWriteReadRatio === null) {
    return {
      available: false,
      missing,
      ...base,
      note: windowProtection
        ? `The window is inside its reserve, so the next request will fail without a compaction regardless of cost; the cost comparison itself is unavailable because ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unknown.`
        : `Whether compacting pays for itself cannot be computed: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unknown to this process, and a rewrite billed on guessed numbers is paid for on every later request.`,
    }
  }
  const decision = decideCompaction({
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens,
    contextTokens: input.contextTokens,
    contextWindowTokens: input.contextWindowTokens,
    completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
    remainingBoundaries: input.remainingBoundaries,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    cacheWriteReadRatio,
    economics: input.economics ?? DEFAULT_COMPACTION_ECONOMICS,
  })
  return { available: true, missing: [], ...base, decision, note: describeCompactionDecision(decision) }
}

/** Tens-of-thousands separators, for figures a reader compares at a glance. */
const num = (value: number): string => Math.round(value).toLocaleString('en-US')

/**
 * One sentence a model or a user can act on.
 *
 * Written as the decision's own reason rather than as advice, because the caller
 * knows more than this module does about what to do next — except in the two
 * cases where it does not: a depleted window and an unconfigured cache ratio.
 *
 * @param decision - the result of {@link decideCompaction}.
 * @returns the sentence, never empty.
 */
export function describeCompactionDecision(decision: CompactionEconomicsDecision): string {
  const saving = `Compacting would save ${num(decision.savingTokens)} tokens per request (${num(decision.archiveTokens)} archived, ${num(decision.memoTokens)} summarised).`
  switch (decision.reason) {
    case 'window_protection':
      return `Compact: the window is inside its reserve, so this is about fitting rather than about cost. ${saving}`
    case 'economic':
      return `Compact: the rewrite pays for itself in ${decision.breakevenRequests === null ? 'fewer' : num(decision.breakevenRequests)} requests and the session expects about ${decision.expectedRemainingRequests === null ? 'more' : num(decision.expectedRemainingRequests)}. ${saving}`
    case 'non_positive_saving':
      return `Do not compact: the summary would be at least as large as the history it replaces (${num(decision.archiveTokens)} archived, ${num(decision.memoTokens)} summarised).`
    case 'horizon_unavailable':
      return `Do not compact: this session has not completed a compaction boundary, so how many requests remain cannot be estimated and the rewrite cannot be shown to pay for itself. ${saving}`
    case 'cache_ratio_unavailable':
      return 'Do not compact: the routed model advertises no cache write/read price ratio, so the cost of rewriting the prefix cannot be computed. A rewrite made on a guessed multiplier is billed for the rest of the session.'
    case 'deferred_subsequent_margin':
      return `Do not compact yet: the saving still pays, but the margin a second rewrite has to clear does not (${num(decision.breakevenRequests ?? 0)} × ${decision.subsequentCompactionMargin} against about ${decision.expectedRemainingRequests === null ? 0 : num(decision.expectedRemainingRequests)} expected requests). ${saving}`
    case 'deferred_carried_debt':
      return `Do not compact yet: the previous rewrite has not paid itself back yet (${num(decision.carriedDebtTokens)} tokens outstanding). ${saving}`
    case 'deferred_economic':
      return `Do not compact: ${saving} That is ${decision.breakevenRequests === null ? 'more than' : `${num(decision.breakevenRequests)} requests`} of payback against about ${decision.expectedRemainingRequests === null ? 0 : num(decision.expectedRemainingRequests)} expected, so it costs more than it saves.`
  }
}
