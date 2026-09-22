/**
 * Prompt-cache miss attribution.
 *
 * Why
 * ---
 * We already record what each turn cost (`token-usage.ts`) but not what each
 * turn *wasted*. Without that, "this model burns several times more tokens than
 * the same model in another CLI" stays an anecdote: the ledger shows a large
 * `input_tokens` number and cannot say whether it grew because the work grew, or
 * because the prefix changed and every cached token before it was re-billed at
 * full price.
 *
 * The model here is pi's `cache-stats.ts`, kept as pure functions:
 *
 * - The unit is one *turn* compared to the previous turn **in the same session**.
 * - `missedTokens = min(prevPrompt, prompt) - cacheRead` — the part of the
 *   previous prompt that was not read from cache this time. Anything at or below
 *   the noise floor is not counted: a cache breakpoint is applied per block, so
 *   a few hundred tokens of legitimate movement show up on every provider and
 *   would drown the real signal.
 * - A miss is *attributed*: the model changed, the request came back after the
 *   provider's cache TTL, or neither (the prefix itself moved). Those lead to
 *   different fixes, so the label is part of the result rather than a log line.
 * - A provider that never reports caching must not look like a 100% miss every
 *   turn. `reportedCache` is sticky per session: once any turn reports a cache
 *   read or write, later zero-cache turns count as real misses; before that,
 *   they are unattributable.
 *
 * Costs are only reported when the caller supplies them. A confidence-free
 * dollar figure is worse than none, so a turn with unknown pricing contributes
 * tokens but zero cost, and the snapshot says how many turns were priced.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/cache-attribution
 */

/** Provider cache TTL the idle-gap label assumes (Anthropic's default). */
export const CACHE_TTL_MS = 5 * 60_000

/** Per-turn movement at or below this is breakpoint granularity, not waste. */
export const NOISE_FLOOR_TOKENS = 1024

/** One request as the ledger observed it. */
export interface CacheTurnObservation {
  readonly sessionId: string
  /** Epoch ms the request was sent. */
  readonly at: number
  /** Provider-qualified model key; a change of model cannot reuse another's cache. */
  readonly model: string
  /** Total prompt size: input + cacheRead + cacheWrite. */
  readonly promptTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Tokens billed at the full input rate: uncached input + cache writes. */
  readonly paidTokens: number
  /** Dollars for the paid buckets this turn, when pricing is known. */
  readonly paidCostUsd?: number
  /** Dollars the same tokens would have cost as cache reads, when known. */
  readonly cacheReadCostUsd?: number
}

/** Why the provider did not read a prompt prefix from cache. */
export type CacheMissCause = 'idle-gap' | 'model-changed' | 'prefix-changed'

/** One turn's unattributed cache-miss, with its cause and cost. */
export interface CacheMiss {
  readonly sessionId: string
  readonly at: number
  readonly model: string
  /** Tokens that were in the previous prompt but not read from cache. */
  readonly missedTokens: number
  /** Extra dollars paid because those tokens were not cached; 0 when unpriceable. */
  readonly missedCostUsd: number
  /** Milliseconds since the previous request, which last refreshed the cache. */
  readonly idleMs: number
  readonly cause: CacheMissCause
}

/** Aggregate cache-miss figures over the scanned range. */
export interface CacheAttributionTotals {
  readonly missedTokens: number
  readonly missedCostUsd: number
  readonly missCount: number
  /** Turns compared against a predecessor (excluding each session's first). */
  readonly comparedTurns: number
  /** Turns skipped because no predecessor existed or the provider never caches. */
  readonly unattributableTurns: number
  /** Compared turns whose cost could be priced; the rest contribute tokens only. */
  readonly pricedTurns: number
  /**
   * Cause breakdown over **every** miss, not over the returned (capped) list.
   *
   * `maxMisses` bounds what a caller has to hold and render, but the totals it
   * sits beside describe the whole range. Deriving the breakdown from the capped
   * list made the two disagree on any range with more misses than the cap — the
   * panel then showed a per-cause split that did not add up to the miss count it
   * was rendered next to.
   */
  readonly byCause: { readonly idleGap: number; readonly modelChanged: number; readonly prefixChanged: number }
  /**
   * The largest misses in the scan, descending by tokens and then by time.
   *
   * Kept beside the totals for the same reason `byCause` is: `misses` is capped
   * to the *most recent* rows, so a caller sorting that list for a "worst
   * offenders" panel was shown the worst of the last `maxMisses` as if it were
   * the worst of the range — a 5M-token miss at the top of the window vanished
   * behind 200 ordinary ones, while the totals rendered beside it still counted
   * it. Unlike `misses` this list is bounded by size, not by recency.
   */
  readonly worst: readonly CacheMiss[]
}

/** How many entries {@link CacheAttributionTotals.worst} carries by default. */
export const DEFAULT_MAX_WORST = 5

/** Descending by tokens, then earliest first; one order for producer and reader. */
function bySeverity(left: CacheMiss, right: CacheMiss): number {
  return right.missedTokens - left.missedTokens || left.at - right.at
}

/** The scanned misses plus their totals. */
export interface CacheAttribution {
  readonly misses: readonly CacheMiss[]
  readonly totals: CacheAttributionTotals
}

/** Tunables for one cache-attribution scan. */
export interface CacheAttributionOptions {
  /** Provider cache TTL used by the idle-gap label (default {@link CACHE_TTL_MS}). */
  readonly ttlMs?: number
  /** Movement at or below this is ignored (default {@link NOISE_FLOOR_TOKENS}). */
  readonly noiseFloorTokens?: number
  /** Cap on returned misses; totals always cover every turn. */
  readonly maxMisses?: number
  /** Cap on {@link CacheAttributionTotals.worst} (default {@link DEFAULT_MAX_WORST}). */
  readonly maxWorst?: number
}

interface SessionScanState {
  readonly previous?: CacheTurnObservation
  /** Sticky: some turn in this session already reported cache activity. */
  reportedCache: boolean
}

function perToken(total: number | undefined, tokens: number): number {
  if (total === undefined || tokens <= 0) return 0
  return total / tokens
}

/**
 * Attribute cache misses across a ledger's turns.
 *
 * Turns are grouped by session and walked in time order; each session's first
 * turn can never be attributed (there is nothing to compare it to) and is
 * reported in `unattributableTurns` rather than silently dropped.
 * @param turns - the ledger turns to attribute.
 * @param options - the TTL, noise floor, and caps for the scan.
 * @returns the cache Attribution.
 */
export function attributeCacheMisses(
  turns: readonly CacheTurnObservation[],
  options: CacheAttributionOptions = {},
): CacheAttribution {
  const ttlMs = Math.max(1, options.ttlMs ?? CACHE_TTL_MS)
  const noiseFloor = Math.max(0, options.noiseFloorTokens ?? NOISE_FLOOR_TOKENS)
  const ordered = [...turns].sort((left, right) => left.at - right.at || left.sessionId.localeCompare(right.sessionId))
  const maxWorst = Math.max(0, Math.floor(options.maxWorst ?? DEFAULT_MAX_WORST))
  const sessions = new Map<string, SessionScanState>()
  const misses: CacheMiss[] = []
  /** Insertion-ordered by severity, kept at `maxWorst` so the scan stays bounded. */
  const worst: CacheMiss[] = []
  const byCause = { idleGap: 0, modelChanged: 0, prefixChanged: 0 }
  let comparedTurns = 0
  let unattributableTurns = 0
  let pricedTurns = 0

  for (const turn of ordered) {
    const state = sessions.get(turn.sessionId) ?? { reportedCache: false }
    const previous = state.previous
    const reportsCache = turn.cacheReadTokens + turn.cacheWriteTokens > 0
    const reportedBefore = state.reportedCache
    // Advance the sticky flag before deciding, so a provider is judged by what
    // it has *ever* reported in this session, not by this turn alone.
    state.reportedCache = reportedBefore || reportsCache
    sessions.set(turn.sessionId, { previous: turn, reportedCache: state.reportedCache })

    if (previous === undefined || turn.promptTokens <= 0) {
      unattributableTurns += 1
      continue
    }
    // A cache-read-only provider that has never reported anything is not
    // wasting anything; we simply cannot see its cache.
    if (!reportsCache && !reportedBefore) {
      unattributableTurns += 1
      continue
    }
    comparedTurns += 1

    // Whether the turn's cost was knowable is independent of whether this turn
    // turned out to waste anything, so it is decided before the noise floor
    // skips the turn. Counting only turns with a non-zero differential reported
    // a provider with known pricing as unpriced whenever its cache was fine.
    const paidPerToken = perToken(turn.paidCostUsd, turn.paidTokens)
    const readPerToken = perToken(turn.cacheReadCostUsd, turn.cacheReadTokens)
    if (paidPerToken > 0) pricedTurns += 1

    const missedTokens = Math.min(previous.promptTokens, turn.promptTokens) - turn.cacheReadTokens
    if (missedTokens <= noiseFloor) continue

    const missedCostUsd = paidPerToken > 0 ? Math.max(0, missedTokens * (paidPerToken - readPerToken)) : 0

    const idleMs = Math.max(0, turn.at - previous.at)
    const cause: CacheMissCause = turn.model !== previous.model ? 'model-changed' : idleMs > ttlMs ? 'idle-gap' : 'prefix-changed'
    if (cause === 'idle-gap') byCause.idleGap += 1
    else if (cause === 'model-changed') byCause.modelChanged += 1
    else byCause.prefixChanged += 1
    const miss: CacheMiss = { sessionId: turn.sessionId, at: turn.at, model: turn.model, missedTokens, missedCostUsd, idleMs, cause }
    misses.push(miss)
    if (maxWorst > 0) {
      if (worst.length < maxWorst) {
        worst.push(miss)
        worst.sort(bySeverity)
      } else if (bySeverity(miss, worst[worst.length - 1]!) < 0) {
        // The last entry is the smallest kept so far, so only a larger miss earns
        // a place; sorting on the way in keeps the list in its reported order.
        worst[worst.length - 1] = miss
        worst.sort(bySeverity)
      }
    }
  }

  const totals: CacheAttributionTotals = {
    missedTokens: misses.reduce((sum, miss) => sum + miss.missedTokens, 0),
    missedCostUsd: misses.reduce((sum, miss) => sum + miss.missedCostUsd, 0),
    missCount: misses.length,
    comparedTurns,
    unattributableTurns,
    pricedTurns,
    // Counted on the way in, before the returned list is capped below.
    byCause,
    worst,
  }
  const capped = options.maxMisses === undefined ? misses : misses.slice(-Math.max(0, options.maxMisses))
  return { misses: capped, totals }
}

