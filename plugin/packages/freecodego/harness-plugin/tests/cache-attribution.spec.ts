import { describe, expect, it } from 'vitest'
import {
  attributeCacheMisses,
  type CacheTurnObservation,
} from '../src/cache-attribution.ts'

const MINUTE = 60_000

function turn(overrides: Partial<CacheTurnObservation> = {}): CacheTurnObservation {
  return {
    sessionId: 's1',
    at: 1_000_000,
    model: 'deepseek-v4',
    promptTokens: 50_000,
    cacheReadTokens: 49_000,
    cacheWriteTokens: 0,
    paidTokens: 1_000,
    ...overrides,
  }
}

describe('cache miss attribution', () => {
  it('does not attribute a session\'s first turn', () => {
    const result = attributeCacheMisses([turn()])
    expect(result.misses).toEqual([])
    expect(result.totals.unattributableTurns).toBe(1)
    expect(result.totals.comparedTurns).toBe(0)
  })

  it('ignores movement at or below the noise floor', () => {
    // A cache breakpoint is applied per block, so a few hundred tokens move on
    // every provider; counting that would drown the real signal.
    const result = attributeCacheMisses([
      turn({ at: 0, cacheReadTokens: 49_000 }),
      turn({ at: MINUTE, promptTokens: 50_500, cacheReadTokens: 49_600 }),
    ])
    expect(result.misses).toEqual([])
    expect(result.totals.comparedTurns).toBe(1)
  })

  it('counts a priced turn even when that turn wasted nothing', () => {
    // "Priced" is a property of the provider answer, not of the outcome: counting
    // only turns with a non-zero differential reported a provider with known
    // pricing as unpriced whenever its cache happened to be fine.
    const result = attributeCacheMisses([
      turn({ at: 0 }),
      turn({ at: MINUTE, promptTokens: 50_000, cacheReadTokens: 49_000, paidTokens: 1_000, paidCostUsd: 0.01, cacheReadCostUsd: 0.0001 }),
    ])
    expect(result.misses).toEqual([])
    expect(result.totals.comparedTurns).toBe(1)
    expect(result.totals.pricedTurns).toBe(1)
  })

  it('leaves a turn unpriced when the caller supplied no cost', () => {
    const result = attributeCacheMisses([
      turn({ at: 0 }),
      turn({ at: MINUTE, promptTokens: 60_000, cacheReadTokens: 30_000 }),
    ])
    expect(result.misses).toHaveLength(1)
    expect(result.misses[0]?.missedCostUsd).toBe(0)
    expect(result.totals.pricedTurns).toBe(0)
  })

  it('counts the previous prompt bytes that were not read from cache', () => {
    const result = attributeCacheMisses([
      turn({ at: 0, promptTokens: 50_000, cacheReadTokens: 50_000 }),
      turn({ at: MINUTE, promptTokens: 50_000, cacheReadTokens: 10_000 }),
    ])
    expect(result.misses).toHaveLength(1)
    expect(result.misses[0]?.missedTokens).toBe(40_000)
    expect(result.misses[0]?.cause).toBe('prefix-changed')
    expect(result.misses[0]?.idleMs).toBe(MINUTE)
  })

  it('names an idle gap past the cache TTL as the cause', () => {
    const result = attributeCacheMisses([
      turn({ at: 0 }),
      turn({ at: 6 * MINUTE, cacheReadTokens: 10_000 }),
    ])
    expect(result.misses[0]?.cause).toBe('idle-gap')
  })

  it('names a model change as the cause even inside the TTL', () => {
    const result = attributeCacheMisses([
      turn({ at: 0 }),
      turn({ at: MINUTE, model: 'claude-4', cacheReadTokens: 10_000 }),
    ])
    expect(result.misses[0]?.cause).toBe('model-changed')
  })

  it('does not call a cache-blind provider wasteful', () => {
    // Neither turn reports cache activity, so there is nothing to attribute.
    const blind = attributeCacheMisses([
      turn({ at: 0, cacheReadTokens: 0, promptTokens: 50_000, paidTokens: 50_000 }),
      turn({ at: MINUTE, cacheReadTokens: 0, promptTokens: 50_000, paidTokens: 50_000 }),
    ])
    expect(blind.misses).toEqual([])
    expect(blind.totals.unattributableTurns).toBe(2)
  })

  it('treats a zero-cache turn as a total miss once the session has reported caching', () => {
    // A cache-read-only provider reports reads; a turn with none is a real miss,
    // not an unseen cache.
    const result = attributeCacheMisses([
      turn({ at: 0, cacheReadTokens: 50_000 }),
      turn({ at: MINUTE, cacheReadTokens: 0, promptTokens: 50_000, paidTokens: 50_000 }),
    ])
    expect(result.misses).toHaveLength(1)
    expect(result.misses[0]?.missedTokens).toBe(50_000)
  })

  it('prices a miss from the paid buckets and the cache-read rate', () => {
    const result = attributeCacheMisses([
      turn({ at: 0, promptTokens: 100_000, cacheReadTokens: 100_000 }),
      turn({
        at: MINUTE,
        promptTokens: 100_000,
        cacheReadTokens: 20_000,
        paidTokens: 80_000,
        // Input at $3/M and cache reads at $0.30/M, which is the real ratio.
        paidCostUsd: 0.24,
        cacheReadCostUsd: 0.006,
      }),
    ])
    const miss = result.misses[0]!
    expect(miss.missedTokens).toBe(80_000)
    // (0.24/80k - 0.006/20k) * 80k = 0.24 - 0.024 = 0.216
    expect(miss.missedCostUsd).toBeCloseTo(0.216, 6)
    expect(result.totals.missedCostUsd).toBeCloseTo(0.216, 6)
    expect(result.totals.pricedTurns).toBe(1)
  })

  it('contributes tokens without inventing a cost when pricing is unknown', () => {
    const result = attributeCacheMisses([
      turn({ at: 0 }),
      turn({ at: MINUTE, cacheReadTokens: 10_000 }),
    ])
    expect(result.totals.missedTokens).toBe(40_000)
    expect(result.totals.missedCostUsd).toBe(0)
    expect(result.totals.pricedTurns).toBe(0)
  })

  it('keeps sessions independent', () => {
    const result = attributeCacheMisses([
      turn({ sessionId: 'a', at: 0, cacheReadTokens: 50_000 }),
      turn({ sessionId: 'b', at: 10, cacheReadTokens: 50_000 }),
      turn({ sessionId: 'a', at: MINUTE, cacheReadTokens: 5_000 }),
      turn({ sessionId: 'b', at: MINUTE, cacheReadTokens: 5_000 }),
    ])
    expect(result.misses.map(miss => miss.sessionId)).toEqual(['a', 'b'])
    expect(result.totals.missCount).toBe(2)
  })

  it('caps returned misses without truncating the totals', () => {
    const turns = [turn({ at: 0, cacheReadTokens: 50_000 })]
    for (let index = 1; index <= 5; index += 1) turns.push(turn({ at: index * MINUTE, cacheReadTokens: 5_000 }))
    const result = attributeCacheMisses(turns, { maxMisses: 2 })
    expect(result.misses).toHaveLength(2)
    expect(result.totals.missCount).toBe(5)
    expect(result.totals.missedTokens).toBe(45_000 * 5)
    // The breakdown describes the whole range like the counts beside it do, so a
    // caller that renders both cannot print a split that does not add up to the
    // miss count. Counting it off the capped list did exactly that.
    const byCause = result.totals.byCause
    expect(byCause.modelChanged + byCause.idleGap + byCause.prefixChanged).toBe(result.totals.missCount)
    expect(byCause).toEqual({ idleGap: 0, modelChanged: 0, prefixChanged: 5 })
  })

  it('counts the cause breakdown over every miss, not just the returned ones', () => {
    // 260 turns re-billing their prompt: 259 misses, 200 of them returned.
    const turns = [turn({ at: 0, cacheReadTokens: 50_000 })]
    for (let index = 1; index <= 259; index += 1) turns.push(turn({ at: index * MINUTE, cacheReadTokens: 5_000 }))
    const result = attributeCacheMisses(turns, { maxMisses: 200 })
    expect(result.misses).toHaveLength(200)
    expect(result.totals.missCount).toBe(259)
    expect(result.totals.byCause.prefixChanged).toBe(259)
  })

  it('ranks the worst misses over the whole range, not over the returned tail', () => {
    // The miss that matters most is the earliest: 5M tokens re-billed at the top
    // of the session, then 210 ordinary 100k misses after it. `misses` keeps the
    // most recent 200, so a caller ranking that list reported the worst of the
    // tail beside a total that still counted the 5M — the panel read "wasted
    // 26,000,000 tokens" next to "worst: 100,000".
    const cacheReporting = { cacheReadTokens: 0, cacheWriteTokens: 1 }
    const turns = [turn({ at: 0, promptTokens: 5_000_000, ...cacheReporting })]
    for (let index = 1; index <= 211; index += 1) {
      turns.push(turn({ at: index * MINUTE, promptTokens: index === 1 ? 5_000_000 : 100_000, ...cacheReporting }))
    }
    const result = attributeCacheMisses(turns, { maxMisses: 200 })
    expect(result.totals.missCount).toBe(211)
    expect(result.misses).toHaveLength(200)
    // The red case: the 5M miss is not in the list a caller would have ranked.
    expect(result.misses.some(miss => miss.missedTokens === 5_000_000)).toBe(false)
    expect(result.totals.missedTokens).toBe(5_000_000 + 100_000 * 210)
    // Bounded by size rather than by recency, ordered the way it is rendered.
    expect(result.totals.worst.map(miss => miss.missedTokens)).toEqual([5_000_000, 100_000, 100_000, 100_000, 100_000])
    expect(attributeCacheMisses(turns, { maxWorst: 1 }).totals.worst).toHaveLength(1)
    expect(attributeCacheMisses(turns, { maxWorst: 0 }).totals.worst).toHaveLength(0)
  })

  it('separates an idle-gap miss from a prefix change in the totals', () => {
    const result = attributeCacheMisses([
      turn({ at: 0, cacheReadTokens: 50_000 }),
      turn({ at: 30 * MINUTE, cacheReadTokens: 5_000 }),
    ])
    expect(result.totals.missCount).toBe(1)
    expect(result.totals.byCause).toEqual({ idleGap: 1, modelChanged: 0, prefixChanged: 0 })
  })

  // Neither a cause sentence nor an aggregate hit rate is asserted here any
  // more. The token-usage dashboard renders both in its own words — a hit rate
  // is derived per bucket from the same observations, and each cause has its own
  // localized label — so the plugin-side renderers were a second way to say what
  // the surface already says. The `cause` field is what both sides read, and that
  // is what these cases check.
})
