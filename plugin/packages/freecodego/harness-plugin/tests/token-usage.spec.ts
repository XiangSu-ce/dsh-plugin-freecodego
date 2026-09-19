import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildLocalTokenUsageSnapshot } from '../src/token-usage.ts'

function event(type: string, time: number, data: unknown, seq: number): unknown {
  return { type, time, data, seq }
}

/** A context that lists one session carrying `events`. */
function sessionsContext(events: readonly unknown[]): { get(name: string): unknown } {
  return {
    get: name => name === 'sessions' ? { list: () => [{ id: 'isolated', header: { id: 'isolated', version: 0, createdAt: 0 }, events }] } : { list: async () => [] },
  }
}

/** One turn that reported usage, enough for the ledger to build a snapshot. */
const reportingTurn: readonly unknown[] = [
  event('turn/start', 1_000, { turn: 0 }, 0),
  event('assistant/message', 1_002, { turn: 0, step: 0, message: { source: { provider: 'freecodego', model: 'demo' }, content: [] }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11 } }, 1),
  event('turn/end', 1_004, { turn: 0, reason: { kind: 'completed' } }, 2),
]

/**
 * A home of this file's own.
 *
 * The ledger persists its fallback aggregation under
 * `$DSH_HOME/state/freecodego/local-token-usage-v1.json` on every successful
 * build, and that file is capped at 200 entries by recency. Without this override
 * a run of this file wrote into the developer's own cache — fixture routes
 * (`freecodego/demo`, `opencode/big-pickle`) and 1970 buckets where real usage had
 * been, with real entries evicted to make room for them — and the cache is the
 * dashboard's answer whenever a live walk comes back empty. The same idiom as
 * `agent-preset-drain.spec.ts`.
 */
let home = ''
let previousHome: string | undefined
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'freecodego-token-usage-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterAll(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('local token usage ledger', () => {
  it('keeps its fallback cache under the isolated home, not the developer\'s', async () => {
    await buildLocalTokenUsageSnapshot(sessionsContext(reportingTurn), { startAt: 0, endAt: Date.now() })
    // Asserted as a file that appears under this file's own home, so the isolation
    // is pinned rather than implied by the hooks above.
    await expect(readFile(join(home, 'state', 'freecodego', 'local-token-usage-v1.json'), 'utf8'))
      .resolves.toContain('"version":4')
  })

  it('replaces stream usage with final message usage and keeps retries', async () => {
    const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 17 }
    const retried = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 }
    const assistant = { source: { provider: 'freecodego', model: 'demo' }, content: [] }
    const events = [
      event('turn/start', 1_000, { turn: 0 }, 0),
      event('step/start', 1_001, { turn: 0, step: 0 }, 1),
      event('assistant/attempt', 1_002, { turn: 0, step: 0, stream: [{ type: 'chunk', time: 1_002, chunk: { type: 'usage', usage } }] }, 2),
      event('llm/retry', 1_003, { turn: 0, step: 0, retryId: 'r', provider: 'freecodego', mode: 'always', policyKey: 'test', retry: 0, delayMs: 0, failure: { message: 'retry', code: 'TEST' } }, 3),
      event('llm/retry-started', 1_004, { turn: 0, step: 0, retryId: 'r', retry: 0 }, 4),
      event('assistant/message', 1_005, { turn: 0, step: 0, message: assistant, usage: retried }, 5),
      event('step/end', 1_006, { turn: 0, step: 0 }, 6),
      event('turn/end', 1_007, { turn: 0, reason: { kind: 'completed' } }, 7),
    ]
    const snapshot = await buildLocalTokenUsageSnapshot({
      get: name => name === 'sessions' ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events }] } : { list: async () => [] },
    }, { startAt: 0, endAt: Date.now() })
    expect(snapshot.totals.reportedTotalTokens).toBe(22)
    expect(snapshot.totals.reportedAttempts).toBe(2)
    expect(snapshot.routes[0]?.provider).toBe('freecodego')
  })

  it('marks a completed turn without usage as unreported', async () => {
    const events = [
      event('turn/start', 1_000, { turn: 0 }, 0),
      event('step/start', 1_001, { turn: 0, step: 0 }, 1),
      event('step/end', 1_002, { turn: 0, step: 0 }, 2),
      event('turn/end', 1_003, { turn: 0, reason: { kind: 'completed' } }, 3),
    ]
    const snapshot = await buildLocalTokenUsageSnapshot({
      get: name => name === 'sessions' ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events }] } : { list: async () => [] },
    }, { startAt: 0, endAt: Date.now() })
    expect(snapshot.totals.reportedTotalTokens).toBe(0)
    expect(snapshot.totals.unreportedAttempts).toBe(1)
    expect(snapshot.matrix[0]?.status).toBe('unreported')
  })

  it('reads legacy nested usage and includes disjoint cache buckets', async () => {
    const assistant = {
      source: { provider: 'opencode', model: 'big-pickle' },
      content: [],
      stream: [],
      usage: { input_tokens: 286, output_tokens: 140, cache_read_tokens: 12_800 },
    }
    const events = [
      event('turn/start', 1_000, { turn: 0 }, 0),
      event('step/start', 1_001, { turn: 0, step: 0 }, 1),
      event('assistant/message', 1_002, { turn: 0, step: 0, message: assistant }, 2),
      event('step/end', 1_003, { turn: 0, step: 0 }, 3),
      event('turn/end', 1_004, { turn: 0, reason: { kind: 'completed' } }, 4),
    ]
    const snapshot = await buildLocalTokenUsageSnapshot({
      get: name => name === 'sessions' ? { list: () => [{ id: 'legacy', header: { id: 'legacy', version: 0, createdAt: 0 }, events }] } : { list: async () => [] },
    }, { startAt: 0, endAt: Date.now(), sessionId: 'legacy' })
    expect(snapshot.totals.reportedTotalTokens).toBe(13_226)
    expect(snapshot.routes[0]).toMatchObject({ provider: 'opencode', model: 'big-pickle', totalTokens: 13_226 })
    expect(snapshot.currentSession?.totalTokens).toBe(13_226)
  })
})

describe('matrix cell reporting status', () => {
  /** A turn with a token report. */
  const reported = (time: number, seq: number): unknown[] => [
    event('turn/start', time, { turn: seq }, seq),
    event('step/start', time + 1, { turn: seq, step: 0 }, seq + 1),
    event('assistant/message', time + 2, { turn: seq, step: 0, message: { source: { provider: 'freecodego', model: 'demo' }, content: [] }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11 } }, seq + 2),
    event('step/end', time + 3, { turn: seq, step: 0 }, seq + 3),
    event('turn/end', time + 4, { turn: seq, reason: { kind: 'completed' } }, seq + 4),
  ]
  /** A turn the provider answered nothing about, on the same route. */
  const unreported = (time: number, seq: number): unknown[] => [
    event('turn/start', time, { turn: seq }, seq),
    event('step/start', time + 1, { turn: seq, step: 0 }, seq + 1),
    event('assistant/message', time + 2, { turn: seq, step: 0, message: { source: { provider: 'freecodego', model: 'demo' }, content: [] } }, seq + 2),
    event('step/end', time + 3, { turn: seq, step: 0 }, seq + 3),
    event('turn/end', time + 4, { turn: seq, reason: { kind: 'completed' } }, seq + 4),
  ]
  const cellStatus = async (events: readonly unknown[]): Promise<string | undefined> => {
    const snapshot = await buildLocalTokenUsageSnapshot({
      get: name => name === 'sessions' ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events }] } : { list: async () => [] },
    }, { startAt: 0, endAt: Date.now() })
    return snapshot.matrix[0]?.status
  }

  it('does not depend on the order the two kinds of turn arrived in', async () => {
    // One day, one route, two turns: one carried token numbers and one did not.
    // The cell's label has to describe that mixture, not whichever turn happened
    // to land last — and "reported" cannot be true of a cell whose totals are
    // missing an attempt's worth of tokens.
    const numbersFirst = await cellStatus([...unreported(1_000, 0), ...reported(2_000, 1)])
    const numbersLast = await cellStatus([...reported(1_000, 0), ...unreported(2_000, 1)])
    expect(numbersLast).toBe('partial')
    expect(numbersFirst).toBe('partial')
  })

  it('keeps a cell that reported everything reported, and one that reported nothing unreported', async () => {
    expect(await cellStatus([...reported(1_000, 0), ...reported(2_000, 1)])).toBe('reported')
    expect(await cellStatus([...unreported(1_000, 0), ...unreported(2_000, 1)])).toBe('unreported')
  })
})

describe('prompt-cache waste in the local ledger', () => {
  /** One turn carrying a single assistant message with the given usage. */
  const turn = (time: number, usage: Record<string, number>, seq: number, model = 'demo'): unknown[] => [
    event('turn/start', time, { turn: seq / 10 }, seq),
    event('step/start', time + 1, { turn: seq / 10, step: 0 }, seq + 1),
    event('assistant/message', time + 2, { turn: seq / 10, step: 0, message: { source: { provider: 'freecodego', model }, content: [] }, usage }, seq + 2),
    event('step/end', time + 3, { turn: seq / 10, step: 0 }, seq + 3),
    event('turn/end', time + 4, { turn: seq / 10, reason: { kind: 'completed' } }, seq + 4),
  ]

  const host = (events: readonly unknown[]): unknown => ({
    get: (name: string) => name === 'sessions'
      ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events }] }
      : { list: async () => [] },
  })
  const snapshotFor = async (events: readonly unknown[]): Promise<Awaited<ReturnType<typeof buildLocalTokenUsageSnapshot>>> =>
    await buildLocalTokenUsageSnapshot(host(events) as never, { startAt: 0, endAt: Date.now() })

  it('attributes re-billed prefix tokens instead of leaving them as unexplained input', async () => {
    // Turn 2 reads 12k from cache but only covers 15k of turn 1's 20k prompt, so
    // 3k tokens that were already sent were billed again at the input rate.
    const events = [
      ...turn(1_000, { inputTokens: 20_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20_010 }, 0),
      ...turn(2_000, { inputTokens: 3_000, outputTokens: 10, cacheReadTokens: 12_000, cacheWriteTokens: 0, totalTokens: 15_010 }, 5),
    ]
    const waste = (await snapshotFor(events)).totals.cacheWaste
    expect(waste).toBeDefined()
    expect(waste?.missedTokens).toBe(3_000)
    expect(waste?.byCause).toEqual({ idleGap: 0, modelChanged: 0, prefixChanged: 1 })
    expect(waste?.comparedTurns).toBe(1)
    // No pricing reaches this module, so the token count is reported and the
    // dollar figure is absent rather than invented.
    expect(waste?.missedCostUsd).toBe(0)
    expect(waste?.pricedTurns).toBe(0)
    expect(waste?.worst[0]).toMatchObject({ model: 'freecodego/demo', missedTokens: 3_000, cause: 'prefix-changed' })
  })

  it('separates a model switch from a prefix change', async () => {
    // The second turn writes 12k to cache and reads none, so the cache is
    // observably in use — and every token of the first prompt was re-billed.
    const events = [
      ...turn(1_000, { inputTokens: 20_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20_010 }, 0, 'demo-a'),
      ...turn(2_000, { inputTokens: 3_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 12_000, totalTokens: 15_010 }, 5, 'demo-b'),
    ]
    const waste = (await snapshotFor(events)).totals.cacheWaste
    expect(waste?.byCause).toEqual({ idleGap: 0, modelChanged: 1, prefixChanged: 0 })
    expect(waste?.worst[0]).toMatchObject({ model: 'freecodego/demo-b', missedTokens: 15_000, cause: 'model-changed' })
  })

  it('labels a gap past the provider TTL as an idle-gap rather than a prefix change', async () => {
    const cold = { inputTokens: 20_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20_010 }
    const warm = { inputTokens: 3_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 12_000, totalTokens: 15_010 }
    const events = [
      ...turn(1_000, cold, 0),
      ...turn(1_000 + 10 * 60_000, warm, 5),
    ]
    const waste = (await snapshotFor(events)).totals.cacheWaste
    expect(waste?.byCause).toEqual({ idleGap: 1, modelChanged: 0, prefixChanged: 0 })
    expect(waste?.worst[0]?.cause).toBe('idle-gap')
  })

  it('reports absence, not zero waste, for a provider that never caches', async () => {
    // "We cannot see this provider's cache" and "it wasted nothing" are opposite
    // conclusions from the same silence, so the block must be missing entirely.
    const events = [
      ...turn(1_000, { inputTokens: 20_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20_010 }, 0),
      ...turn(2_000, { inputTokens: 21_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 21_010 }, 5),
    ]
    const snapshot = await snapshotFor(events)
    expect(snapshot.totals.cacheWaste).toBeUndefined()
    // The turn totals are still fully accounted for; only the attribution is absent.
    expect(snapshot.totals.reportedTotalTokens).toBe(41_020)
  })

  it('counts the cause breakdown over every miss, not only the capped list', async () => {
    // A busy range holds more misses than the block renders (200), and the
    // breakdown is displayed beside `missCount`, which covers all of them.
    const warm = { inputTokens: 40_000, outputTokens: 10, cacheReadTokens: 10_000, cacheWriteTokens: 0, totalTokens: 50_010 }
    const events: unknown[] = []
    for (let index = 0; index < 260; index += 1) events.push(...turn(1_000 + index * 100, warm, index * 10))
    const waste = (await snapshotFor(events)).totals.cacheWaste
    expect(waste?.missCount).toBe(259)
    const byCause = waste!.byCause
    expect(byCause.modelChanged + byCause.idleGap + byCause.prefixChanged).toBe(waste?.missCount)
    // The display list stays bounded while the totals describe the whole range.
    expect(waste?.worst).toHaveLength(5)
  })
})

describe('a turn that failed over between two routes', () => {
  // The one branch the meter's `routes` field exists for, and the one the ledger
  // splits: a turn whose attempts ran on two provider/model pairs. The split itself
  // is a documented approximation (the meter does not disclose per-route totals), but
  // what a *filter* does with it is not: a view that has been narrowed must not hand
  // a route a different number than the unfiltered view hands it, or the two panels
  // disagree about the same traffic and neither can be checked against the other.
  const ALPHA = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110 }
  const BETA = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 44 }
  const TURN_TOTAL = 154

  /**
   * One turn in two steps: alpha answered the first, beta the second — which is the
   * shape a mid-turn provider switch leaves, and the only shape that can carry two
   * routes. A retry inside one step cannot: `assistant/attempt`, the event that
   * carries a retried attempt's usage, names no provider, so the meter withholds
   * `routes` for the whole turn rather than guessing which provider paid.
   */
  const twoStep = (time: number, seq: number, first: Record<string, number>, second: Record<string, number>): unknown[] => [
    event('turn/start', time, { turn: 0 }, seq),
    event('step/start', time + 1, { turn: 0, step: 0 }, seq + 1),
    event('assistant/message', time + 2, { turn: 0, step: 0, message: { source: { provider: 'alpha', model: 'one' }, content: [] }, usage: first }, seq + 2),
    event('step/end', time + 3, { turn: 0, step: 0 }, seq + 3),
    event('step/start', time + 4, { turn: 0, step: 1 }, seq + 4),
    event('assistant/message', time + 5, { turn: 0, step: 1, message: { source: { provider: 'beta', model: 'two' }, content: [] }, usage: second }, seq + 5),
    event('step/end', time + 6, { turn: 0, step: 1 }, seq + 6),
    event('turn/end', time + 7, { turn: 0, reason: { kind: 'completed' } }, seq + 7),
  ]
  const failover = (time: number, seq: number): unknown[] => twoStep(time, seq, ALPHA, BETA)
  /**
   * The same failover, with a turn that does not halve evenly.
   *
   * `154 = 2 × 77`, so the fixture above produces the same snapshot whether the
   * split keeps the remainder or drops it — nothing in it can tell the two apart,
   * which is how the floor division stayed invisible. These numbers leave a
   * remainder in every field except `cacheWriteTokens`: the turn is 141 input / 15
   * output / 9 cache-read / 165 total, and the two routes can each be credited only
   * 70 / 7 / 4 / 82.
   */
  const SPLIT_ALPHA = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 111 }
  const SPLIT_BETA = { inputTokens: 41, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 0, totalTokens: 54 }
  const splitTurn = (time: number, seq: number): unknown[] => twoStep(time, seq, SPLIT_ALPHA, SPLIT_BETA)

  const snapshotOf = async (events: readonly unknown[], query: Record<string, unknown> = {}) => await buildLocalTokenUsageSnapshot({
    get: name => name === 'sessions'
      ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events }] }
      : { list: async () => [] },
  }, { startAt: 0, endAt: Date.now(), ...query })
  const snapshot = async (query: Record<string, unknown> = {}) => await snapshotOf(failover(1_000, 0), query)

  /** The route entry for one provider, or undefined when the view omits it. */
  const routeFor = (routes: readonly { provider: string }[], provider: string): unknown =>
    routes.find(route => route.provider === provider)

  it('splits the turn across both routes, conservatively', async () => {
    const all = await snapshot()
    // Both routes, in attempt order.
    expect(all.routes.map(route => route.provider)).toEqual(['alpha', 'beta'])
    // The floor-divided share: no route is credited more than the turn had, and the
    // routes together do not exceed it.
    expect(all.routes.map(route => route.totalTokens)).toEqual([77, 77])
    expect(all.routes.reduce((sum, route) => sum + route.totalTokens, 0)).toBeLessThanOrEqual(TURN_TOTAL)
    // Attempt-level facts stay whole and belong to the turn's first route.
    expect(all.routes.map(route => route.attempts)).toEqual([2, 0])
    // On this fixture the turn's total and the shares happen to be equal (154 is
    // even); the pin below uses a turn where they differ, which is the case that
    // decides what a total means.
    expect(all.totals.reportedTotalTokens).toBe(154)
  })

  it('reports the turn\'s own numbers on the turn-level surfaces, and shares on the route-level ones', async () => {
    // The meter billed this turn 165 tokens; two routes each get the floor-divided
    // 82, so the shares sum to 164. Every view has to pick one of the two, and the
    // pick is per surface, not per view: a total is the turn's, a route row is an
    // approximation. Reporting the shares as the total understated the bill by the
    // remainder — here a token in each of four fields, and in general up to
    // (routes − 1) per field per turn.
    const all = await snapshotOf(splitTurn(1_000, 0))
    expect(all.totals).toMatchObject({ reportedInputTokens: 141, reportedOutputTokens: 15, reportedCacheReadTokens: 9, reportedTotalTokens: 165 })
    expect(all.routes.map(route => route.totalTokens)).toEqual([82, 82])
    expect(all.routes.map(route => route.inputTokens)).toEqual([70, 70])
    expect(all.timeline.map(bucket => bucket.totalTokens)).toEqual([165])
    expect(all.timeline.map(bucket => bucket.inputTokens)).toEqual([141])
    // The session row describes the turn too, so it carries the turn's numbers.
    const session = await snapshotOf(splitTurn(1_000, 0), { sessionId: 's1' })
    expect(session.currentSession).toMatchObject({ totalTokens: 165, inputTokens: 141, attempts: 2 })
  })

  it('keeps a narrowed view conservative, since it has no whole turn to report', async () => {
    // A view filtered to one provider selected *part* of a two-route turn, so the
    // turn's own total is not its number to report: it stays the sum of the shares
    // it selected, which is what its route row says. Otherwise the filtered panel
    // would show 165 for 82 tokens of traffic — more than the unfiltered view hands
    // that same route.
    const alpha = await snapshotOf(splitTurn(1_000, 0), { provider: 'alpha' })
    const beta = await snapshotOf(splitTurn(1_000, 0), { provider: 'beta' })
    expect(alpha.totals.reportedTotalTokens).toBe(82)
    expect((routeFor(alpha.routes, 'alpha') as { totalTokens: number }).totalTokens).toBe(82)
    expect(beta.totals.reportedTotalTokens).toBe(82)
    // Conservative as a set: the narrowed views add up to the shares, not to the
    // turn — they never exceed it.
    expect(alpha.totals.reportedTotalTokens + beta.totals.reportedTotalTokens).toBeLessThan(165)
  })

  it('reconciles its own totals against its routes, timeline and matrix', async () => {
    // Fixtures are deliberately odd: on the even turn above a lossless split and a
    // lossy one are the same snapshot, so this pin would pass either way. Here the
    // remainder is real, and each pair of surfaces has to agree exactly.
    const all = await snapshotOf(splitTurn(1_000, 0))
    const total = (rows: readonly { readonly totalTokens?: number }[]): number => rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)
    // Every turn here reported numbers, so a cell without a total would be a cell
    // that lost one rather than a cell that had none.
    expect(all.matrix.every(cell => cell.totalTokens !== undefined)).toBe(true)
    // Turn-level surfaces agree with each other, exactly.
    expect(total(all.timeline)).toBe(all.totals.reportedTotalTokens)
    // Per-route surfaces agree with each other, exactly.
    expect(total(all.matrix)).toBe(total(all.routes))
    // And the route level is the conservative one — it may not claim the remainder.
    expect(total(all.routes)).toBe(164)
    expect(all.totals.reportedTotalTokens).toBe(165)
    expect(all.routes.reduce((sum, route) => sum + route.attempts, 0)).toBe(all.totals.reportedAttempts)
  })

  it('hands a route the same numbers whichever view it is read from', async () => {
    // Narrowing a view selects rows; it does not re-attribute them. Today the split
    // is recomputed against the surviving routes, so asking about one provider gives
    // it the *whole* turn — a number no unfiltered panel agrees with, and the two
    // providers' filtered views then add up to twice the traffic.
    const all = await snapshot()
    const alpha = await snapshot({ provider: 'alpha' })
    const beta = await snapshot({ provider: 'beta' })
    expect(routeFor(alpha.routes, 'alpha')).toEqual(routeFor(all.routes, 'alpha'))
    expect(routeFor(beta.routes, 'beta')).toEqual(routeFor(all.routes, 'beta'))
    expect(alpha.routes.map(route => route.provider)).toEqual(['alpha'])
    expect(beta.routes.map(route => route.provider)).toEqual(['beta'])
    // Conservative as a set too: two filtered views may not exceed the whole.
    expect(alpha.totals.reportedTotalTokens + beta.totals.reportedTotalTokens).toBeLessThanOrEqual(TURN_TOTAL)
  })

  it('files a cache observation under the turn, not under the filter', async () => {
    // Two failover turns whose combined prompt shrank while the cache was in use, so
    // the block renders a re-billed-prefix miss and names the model it happened on.
    // The observation is the turn's own prompt total, filed under the turn's first
    // route: a filter that renamed it would move the turn into the other route's
    // series, and the comparison that decides "model changed" reads those names.
    const events = [
      ...twoStep(1_000, 0, { inputTokens: 20_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20_010 }, { inputTokens: 4_000, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4_004 }),
      ...twoStep(2_000, 8, { inputTokens: 3_000, outputTokens: 10, cacheReadTokens: 12_000, cacheWriteTokens: 0, totalTokens: 15_010 }, { inputTokens: 1_000, outputTokens: 4, cacheReadTokens: 2_000, cacheWriteTokens: 0, totalTokens: 3_004 }),
    ]
    const all = await snapshotOf(events)
    const beta = await snapshotOf(events, { provider: 'beta' })
    expect(all.totals.cacheWaste?.worst[0]?.model).toBe('alpha/one')
    expect(beta.totals.cacheWaste?.worst[0]?.model).toBe('alpha/one')
  })
})

describe('default range end', () => {
  /** One completed turn carrying a single assistant message with `usage`. */
  const turn = (time: number, usage: Record<string, number>, seq: number): unknown[] => [
    event('turn/start', time, { turn: seq / 10 }, seq),
    event('step/start', time + 1, { turn: seq / 10, step: 0 }, seq + 1),
    event('assistant/message', time + 2, { turn: seq / 10, step: 0, message: { source: { provider: 'freecodego', model: 'demo' }, content: [] }, usage }, seq + 2),
    event('step/end', time + 3, { turn: seq / 10, step: 0 }, seq + 3),
    event('turn/end', time + 4, { turn: seq / 10, reason: { kind: 'completed' } }, seq + 4),
  ]

  it('ends an omitted endAt at now, not at the top of the hour', async () => {
    // An omitted `endAt` asks for "up to now". Rounding it down to the hour
    // boundary excluded every turn recorded since the hour began — exactly the
    // traffic someone watching this panel during a session is looking for — and
    // reported the narrowed range as if it were what was asked for.
    const clock = new Date()
    clock.setMinutes(5, 0, 0)
    const at = clock.getTime()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(at)
    try {
      const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 14 }
      const snapshot = await buildLocalTokenUsageSnapshot({
        get: name => name === 'sessions' ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events: turn(at - 60_000, usage, 0) }] } : { list: async () => [] },
      }, { startAt: at - 3 * 3_600_000 })
      expect(snapshot.range.endAt).toBe(at)
      expect(snapshot.totals.reportedTotalTokens).toBe(14)
      expect(snapshot.totals.unreportedAttempts).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('a filtered view of turns that name no provider', () => {
  // Every path that accumulates a turn has to apply the same filter. The derived
  // path filters route by route and the legacy loose path checks provider/model,
  // but the path for a turn with *no usage* took its route from `turnRoute()` and
  // applied no filter at all. `turnRoute()` answers `unknown/unknown` for a turn
  // that ends without an assistant message and without a request header — exactly
  // what an aborted or early-failed turn leaves — so a narrowed view could not tell
  // "this provider has no traffic" from "here is traffic we cannot attribute".
  const AT = 1_700_000_000_000
  const turn = (time: number, body: readonly unknown[]): unknown[] => [
    event('turn/start', time, { turn: 0 }, 0),
    ...body,
    event('turn/end', time + 5, { turn: 0, reason: { kind: 'completed' } }, 0),
  ]
  /** A turn that reported usage on agnes. */
  const reported = turn(AT, [
    event('step/start', AT + 1, { turn: 0, step: 0 }, 0),
    event('assistant/message', AT + 2, { turn: 0, step: 0, message: { source: { provider: 'agnes', model: 'swift' }, content: [] }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110 } }, 0),
  ])
  /** Stopped by the user after one step: attempts and a duration, no provider anywhere. */
  const aborted = turn(AT + 60_000, [event('step/start', AT + 60_001, { turn: 0, step: 0 }, 0)])
  /** Aborted too, but a request header names the provider before it stopped. */
  const abortedWithHeader = turn(AT + 120_000, [
    event('request/header', AT + 120_001, { header: { config: { provider: 'opencode', model: 'big-pickle' } } }, 0),
    event('step/start', AT + 120_002, { turn: 0, step: 0 }, 0),
  ])

  const view = async (query: Record<string, unknown> = {}): Promise<Awaited<ReturnType<typeof buildLocalTokenUsageSnapshot>>> =>
    await buildLocalTokenUsageSnapshot({
      get: name => name === 'sessions'
        ? { list: () => [{ id: 's1', header: { id: 's1', version: 0, createdAt: 0 }, events: [...reported, ...aborted, ...abortedWithHeader] }] }
        : { list: async () => [] },
    }, { startAt: 0, endAt: AT + 86_400_000, ...query })

  it('never carries a route the caller did not ask for, and counts no attempt from one', async () => {
    const agnes = await view({ provider: 'agnes' })
    expect(agnes.routes.map(route => route.provider)).toEqual(['agnes'])
    expect(agnes.totals.reportedAttempts).toBe(1)
    // The aborted turns belong to no view that was narrowed to a provider.
    expect(agnes.totals.unreportedAttempts).toBe(0)
    expect(agnes.timeline.reduce((sum, bucket) => sum + bucket.attempts, 0)).toBe(1)
    expect(agnes.matrix.map(cell => cell.provider)).toEqual(['agnes'])
  })

  it('answers empty for a provider that never ran', async () => {
    // The face of the same defect that is hardest to argue with: a filter for a
    // provider with no traffic returned rows, so the panel showed an "unknown"
    // provider as if it were the one asked about.
    const nothing = await view({ provider: 'never-ran' })
    expect(nothing.routes).toEqual([])
    expect(nothing.timeline).toEqual([])
    expect(nothing.matrix).toEqual([])
    expect(nothing.totals.unreportedAttempts).toBe(0)
  })

  it('keeps the unattributable turn where nothing is claimed about its provider', async () => {
    // The control for the two above: the `unknown/unknown` row is honest in an
    // unfiltered view — it is how a user learns hours were spent on attempts that
    // reported nothing — and a firmer filter must not delete it from there.
    const all = await view()
    const unknown = all.routes.find(route => route.provider === 'unknown')
    expect(unknown?.attempts).toBe(1)
    expect(unknown?.unreportedAttempts).toBe(1)
    expect(all.totals.unreportedAttempts).toBe(2)
  })

  it('recovers a closed session from durable storage through the declared handle', async () => {
    // The ledger's recovery path: a session the Host no longer holds live is read
    // once from storage (`list` then `open` → `read` → `close`) so a dashboard
    // opened after the fact still shows its usage. This path had no coverage at
    // all, which is how the adapter kept preferring a preview-only `inspect(id)`
    // that no pinned Harness line declares.
    const reads: [number | undefined, number | undefined][] = []
    let closes = 0
    const ctx = {
      get: (name: string) => name === 'sessions'
        ? { list: () => [] }
        : {
          list: async () => [{ id: 'restored', version: 0, createdAt: 0 }],
          open: async (id: string, access: string) => {
            expect([String(id), access]).toEqual(['restored', 'read'])
            return {
              read: async (offset?: number, length?: number) => {
                reads.push([offset, length])
                return reportingTurn
              },
              close: async () => { closes += 1 },
            }
          },
        },
    }
    const snapshot = await buildLocalTokenUsageSnapshot(ctx, { startAt: 0, endAt: Date.now() })
    expect(snapshot.routes[0]).toMatchObject({ provider: 'freecodego', model: 'demo' })
    // Offset 0 and no length: the whole log, and only that window is declared.
    expect(reads).toEqual([[0, undefined]])
    expect(closes).toBe(1)
  })

  it('keeps the ledger when one stored session cannot be read', async () => {
    // A corrupt or concurrently deleted record belongs to that session alone: the
    // others still land, and the caller never sees the failure.
    const closes: string[] = []
    const ctx = {
      get: (name: string) => name === 'sessions'
        ? { list: () => [] }
        : {
          list: async () => [
            { id: 'corrupt', version: 0, createdAt: 0 },
            { id: 'intact', version: 0, createdAt: 0 },
          ],
          open: async (id: string) => (String(id) === 'corrupt'
            ? { read: async () => { throw new Error('corrupt log') }, close: async () => { closes.push(String(id)) } }
            : { read: async () => reportingTurn, close: async () => { closes.push(String(id)) } }),
        },
    }
    const snapshot = await buildLocalTokenUsageSnapshot(ctx, { startAt: 0, endAt: Date.now() })
    expect(snapshot.routes[0]).toMatchObject({ provider: 'freecodego', model: 'demo' })
    // Both handles were closed — the failing one through the adapter's `finally`.
    expect(closes.sort()).toEqual(['corrupt', 'intact'])
  })

  it('keeps an aborted turn under the provider its request header names, and only there', async () => {
    // A header is evidence, so this turn is opencode's traffic: its own filter keeps
    // it, and the agnes filter above must not — which is what makes the check a
    // comparison against the range rather than a blanket drop of unknown turns.
    const opencode = await view({ provider: 'opencode' })
    expect(opencode.routes.map(route => route.provider)).toEqual(['opencode'])
    expect(opencode.routes[0]?.attempts).toBe(1)
    expect(opencode.routes[0]?.unreportedAttempts).toBe(1)
    expect(opencode.totals.reportedTotalTokens).toBe(0)
  })
})
