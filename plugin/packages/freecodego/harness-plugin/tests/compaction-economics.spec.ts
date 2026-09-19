/**
 * Every reason code is a claim about *why* compaction did not run, so the tests
 * are one case per code plus the two margins that make the arithmetic ours
 * rather than the reference's: a first compaction is subsidised, a later one is
 * taxed, and a debt has to be cleared first.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_ECONOMICS,
  compactionEconomicsView,
  decideCompaction,
  describeCompactionDecision,
  estimateRemainingRequests,
  type CompactionEconomicsInput,
  type CompactionReason,
} from '../src/compaction-economics.ts'

/** A session that would clearly benefit, so a refusal has to be caused by the override. */
function input(overrides: Partial<CompactionEconomicsInput> = {}): CompactionEconomicsInput {
  return {
    // 90k archived down to 10k: an 80k saving per request.
    writeTokens: 10_000,
    archiveTokens: 90_000,
    memoTokens: 10_000,
    contextTokens: 60_000,
    contextWindowTokens: 200_000,
    completedBoundaryRequestCounts: [12, 14, 16],
    remainingBoundaries: 4,
    averageContextTokenIncrement: 2_000,
    priorCompactionCount: 0,
    carriedDebtTokens: 0,
    // A cache write costs 1.25× a read, so the incremental cost is 0.25.
    cacheWriteReadRatio: 1.25,
    economics: DEFAULT_COMPACTION_ECONOMICS,
    ...overrides,
  }
}

const reason = (overrides: Partial<CompactionEconomicsInput>): CompactionReason => decideCompaction(input(overrides)).reason

describe('compaction economics', () => {
  it('computes breakeven from the incremental cache cost, not the full ratio', () => {
    // 10k write × 0.25 incremental = 2.5k, over an 80k saving = 0.031 requests.
    const decision = decideCompaction(input())
    expect(decision.incrementalCacheCostRatio).toBeCloseTo(0.25)
    expect(decision.breakevenRequests).toBeCloseTo(0.03125)
    expect(decision.savingTokens).toBe(80_000)
  })

  it('compacts a first rewrite on a doubled horizon', () => {
    // 14 requests per boundary × 4 boundaries + 1 = 57, doubled to 114. The
    // window is wide enough here that its own bound does not cap the doubled
    // figure, so what is asserted is the subsidy itself.
    const decision = decideCompaction(input({ contextWindowTokens: 400_000 }))
    expect(decision.expectedRemainingRequests).toBe(57)
    expect(decision.effectiveHorizonRequests).toBe(114)
    expect(decision.reason).toBe('economic')
    expect(decision.compact).toBe(true)
  })

  it('compacts a window inside its reserve even when the arithmetic says no', () => {
    // The reserve is 16,384; 185k of 200k is inside it, and the alternative to
    // compacting is a failed request rather than a larger bill.
    const decision = decideCompaction(input({ contextTokens: 185_000 }))
    expect(decision.windowProtection).toBe(true)
    expect(decision.reason).toBe('window_protection')
    expect(decision.compact).toBe(true)
  })

  it('refuses when the summary is as large as what it replaces', () => {
    expect(reason({ memoTokens: 90_000 })).toBe('non_positive_saving')
    expect(reason({ memoTokens: 120_000 })).toBe('non_positive_saving')
    expect(decideCompaction(input({ memoTokens: 90_000 })).compact).toBe(false)
  })

  it('refuses when no boundary has completed, and says that rather than guessing', () => {
    expect(reason({ completedBoundaryRequestCounts: null })).toBe('horizon_unavailable')
    // An empty list is the same fact as no boundary: no evidence to estimate
    // from. Estimating one request from it would authorise a rewrite on nothing.
    expect(reason({ completedBoundaryRequestCounts: [] })).toBe('horizon_unavailable')
    expect(decideCompaction(input({ completedBoundaryRequestCounts: [] })).compact).toBe(false)
  })

  it('refuses when the model advertises no cache price ratio', () => {
    // A rewrite billed at a guessed multiplier is paid for the rest of the
    // session, so an unknown ratio is a refusal and not a default of 1.
    expect(reason({ cacheWriteReadRatio: null })).toBe('cache_ratio_unavailable')
    expect(decideCompaction(input({ cacheWriteReadRatio: null })).compact).toBe(false)
  })

  it('refuses when the horizon is shorter than the payback', () => {
    // One boundary left: 14 × 1 + 1 = 15 requests, doubled to 30 for a first
    // compaction, against a breakeven of 62.5 (a 20M write over an 80k saving at
    // a 0.25 incremental cache ratio).
    const decision = decideCompaction(input({ remainingBoundaries: 1, writeTokens: 20_000_000 }))
    expect(decision.breakevenRequests).toBeCloseTo(62.5)
    expect(decision.effectiveHorizonRequests).toBe(30)
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe('deferred_economic')
  })

  it('taxes a second rewrite with the margin', () => {
    // breakeven 8 requests (80k write × 0.25 / 80k saving is 0.25; scaled up so
    // the margin is what fails) against a horizon the margin cannot clear.
    const decision = decideCompaction(input({
      priorCompactionCount: 1,
      writeTokens: 8_000_000,
      remainingBoundaries: 1,
    }))
    // 14 requests expected, breakeven 25 → base economic already fails, which is
    // `deferred_economic`; the margin case needs a breakeven that clears the base
    // bar but not 1.5×. Distinct fixture below.
    expect(decision.reason).toBe('deferred_economic')

    const marginal = decideCompaction(input({
      priorCompactionCount: 1,
      remainingBoundaries: 1,
      // 15 expected requests; breakeven must be ≤ 15 but > 10.
      writeTokens: 3_840_000,
    }))
    expect(marginal.breakevenRequests).toBeCloseTo(12)
    expect(marginal.expectedRemainingRequests).toBe(15)
    expect(marginal.reason).toBe('deferred_subsequent_margin')
    expect(marginal.compact).toBe(false)
  })

  it('refuses a later compaction while the previous rewrite is still owed', () => {
    // A breakeven of 8 requests clears both the base bar (15) and the 1.5×
    // margin (12), so the only thing left that can refuse is the outstanding
    // debt: 8 + 1,000,000/80,000 = 20.5 requests, past the 15 available.
    const decision = decideCompaction(input({
      priorCompactionCount: 1,
      remainingBoundaries: 1,
      writeTokens: 2_560_000,
      carriedDebtTokens: 1_000_000,
    }))
    expect(decision.breakevenRequests).toBeCloseTo(8)
    expect(decision.combinedBreakevenRequests).toBeCloseTo(20.5)
    expect(decision.expectedRemainingRequests).toBe(15)
    expect(decision.reason).toBe('deferred_carried_debt')
    expect(decision.compact).toBe(false)
  })

  it('never lets the doubled first horizon outlast the window itself', () => {
    // The window bound is what the session can actually do; a first compaction
    // may not be authorised by a horizon the window cannot reach.
    const decision = decideCompaction(input({ contextTokens: 199_000, averageContextTokenIncrement: 1_000 }))
    expect(decision.windowRequestUpperBound).toBe(1)
    expect(decision.effectiveHorizonRequests).toBe(1)
  })
})

describe('remaining-request estimate', () => {
  const horizon = (overrides: Partial<Parameters<typeof estimateRemainingRequests>[0]> = {}) => estimateRemainingRequests({
    completedBoundaryRequestCounts: [10, 10, 10],
    remainingBoundaries: 3,
    scale: 1,
    standardDeviationK: 0,
    contextTokens: 0,
    contextWindowTokens: null,
    averageContextTokenIncrement: null,
    ...overrides,
  })

  it('projects from the mean when no variance is asked for', () => {
    expect(horizon().expectedRemainingRequests).toBe(31)
    expect(horizon().requestsPerBoundaryMean).toBe(10)
  })

  it('discounts a small sample instead of computing a variance from it', () => {
    // Two observations are not a standard deviation; the mean is halved instead,
    // which is the conservative reading of "we do not know yet".
    const estimate = horizon({ completedBoundaryRequestCounts: [10, 10], standardDeviationK: 1 })
    expect(estimate.requestsPerBoundaryLowerBound).toBe(5)
    expect(estimate.expectedRemainingRequests).toBe(16)
  })

  it('subtracts a real variance once there are enough samples', () => {
    const estimate = horizon({ completedBoundaryRequestCounts: [4, 10, 16], standardDeviationK: 1 })
    expect(estimate.requestsPerBoundaryMean).toBe(10)
    expect(estimate.requestsPerBoundaryLowerBound).toBe(4)
    expect(estimate.expectedRemainingRequests).toBe(13)
  })

  it('takes the smaller of the two bounds, because one assumes the other does not happen', () => {
    // 10 per boundary × 10 boundaries says 101 requests; the window says 2.
    const estimate = horizon({
      remainingBoundaries: 10, contextTokens: 100_000, contextWindowTokens: 110_000, averageContextTokenIncrement: 5_000,
    })
    expect(estimate.unboundedExpectedRemainingRequests).toBe(101)
    expect(estimate.windowRequestUpperBound).toBe(2)
    expect(estimate.expectedRemainingRequests).toBe(2)
  })

  it('reports no window bound when growth is flat, rather than dividing by zero', () => {
    expect(horizon({ contextWindowTokens: 100_000, averageContextTokenIncrement: 0 }).windowRequestUpperBound).toBeNull()
  })
})

describe('partial answers', () => {
  const view = (overrides: Partial<Parameters<typeof compactionEconomicsView>[0]> = {}) => compactionEconomicsView({
    writeTokens: 10_000,
    archiveTokens: 90_000,
    contextTokens: 60_000,
    contextWindowTokens: 200_000,
    completedBoundaryRequestCounts: [12, 14, 16],
    remainingBoundaries: 4,
    averageContextTokenIncrement: 2_000,
    priorCompactionCount: 0,
    carriedDebtTokens: 0,
    cacheWriteReadRatio: 1.25,
    memoTokens: 10_000,
    ...overrides,
  })

  it('answers in full when the caller knows the summary size', () => {
    const answer = view()
    expect(answer.available).toBe(true)
    expect(answer.decision?.compact).toBe(true)
    expect(answer.missing).toEqual([])
  })

  it('names the missing input instead of deciding on a guess', () => {
    const answer = view({ memoTokens: undefined })
    expect(answer.available).toBe(false)
    expect(answer.missing).toEqual(['memoTokens'])
    expect(answer.decision).toBeUndefined()
    expect(answer.note).toContain('memoTokens')
  })

  it('always reports the horizon and the window state, even when it cannot decide', () => {
    // These are measurable from what the plugin already holds, so an
    // unavailable cost comparison must not take them down with it.
    const answer = view({ memoTokens: undefined })
    expect(answer.expectedRemainingRequests).toBe(57)
    expect(answer.windowProtection).toBe(false)
    expect(answer.priorCompactionCount).toBe(0)
  })

  it('says the window is what forces a compaction while the cost side is unknown', () => {
    const answer = view({ memoTokens: undefined, contextTokens: 190_000 })
    expect(answer.windowProtection).toBe(true)
    expect(answer.note).toContain('regardless of cost')
  })
})

describe('compaction decision message', () => {
  it('states the payback and the horizon, so a refusal is checkable', () => {
    const decision = decideCompaction(input({ remainingBoundaries: 1, writeTokens: 3_840_000, priorCompactionCount: 1 }))
    const text = describeCompactionDecision(decision)
    expect(text).toContain('Do not compact yet')
    expect(text).toContain('1.5')
    expect(text).toContain('12')
  })

  it('names the reserve when the window is what forced it', () => {
    const decision = decideCompaction(input({ contextTokens: 190_000 }))
    expect(decision.windowProtection).toBe(true)
    expect(describeCompactionDecision(decision)).toContain('fittings'.replace('fittings', 'about fitting'))
  })

  it('returns a sentence for every reason code, never an empty string', () => {
    const reasons: readonly CompactionReason[] = [
      'economic', 'window_protection', 'deferred_economic', 'deferred_subsequent_margin',
      'deferred_carried_debt', 'horizon_unavailable', 'cache_ratio_unavailable', 'non_positive_saving',
    ]
    const seen = new Set<CompactionReason>()
    const overrides: readonly Partial<CompactionEconomicsInput>[] = [
      // economic
      {},
      // window_protection
      { contextTokens: 190_000 },
      // deferred_economic
      { remainingBoundaries: 1, writeTokens: 20_000_000 },
      // deferred_subsequent_margin
      { remainingBoundaries: 1, writeTokens: 3_840_000, priorCompactionCount: 1 },
      // deferred_carried_debt
      { remainingBoundaries: 1, writeTokens: 2_560_000, priorCompactionCount: 1, carriedDebtTokens: 1_000_000 },
      // horizon_unavailable
      { completedBoundaryRequestCounts: null },
      // cache_ratio_unavailable
      { cacheWriteReadRatio: null },
      // non_positive_saving
      { memoTokens: 90_000 },
    ]
    for (const override of overrides) {
      const decision = decideCompaction(input(override))
      seen.add(decision.reason)
      expect(describeCompactionDecision(decision).length).toBeGreaterThan(20)
    }
    // Every code the union names is reachable; a code no input produces is a
    // branch nobody can act on, which is the same as not having it.
    expect([...reasons].filter(code => !seen.has(code))).toEqual([])
  })
})
