import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { harnessHomeDirectory } from './data-home.ts'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { attributeCacheMisses, type CacheTurnObservation } from './cache-attribution.ts'
import { readPersistedEvents, type SessionEventsPersistence } from './session-storage-utils.ts'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type {
  LocalTokenUsageCacheWaste,
  LocalTokenUsageFailure,
  LocalTokenUsageMatrixCell,
  LocalTokenUsageQuery,
  LocalTokenUsageRoute,
  LocalTokenUsageSnapshot,
  TokenUsageRange,
} from './types.ts'

interface SessionSource {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface MutableRoute {
  provider: string
  model: string
  attempts: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  reportedAttempts: number
  partialAttempts: number
  unreportedAttempts: number
  retries: number
  retryDelayMs: number
  turns: number
  /** Wall-clock duration in ms of completed turns attributed to this route. */
  latencies: number[]
}

interface MutableBucket {
  startAt: number
  endAt: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  attempts: number
  unreportedAttempts: number
}

interface MutableSession {
  sessionId: string
  attempts: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export type { LocalTokenUsageQuery }

// v4 adds retry/latency/failure aggregations; older cached snapshots lack the
// new required fields, so they must be regenerated rather than served.
const CACHE_VERSION = 4

function normalizeQuery(query: LocalTokenUsageQuery = {}): Required<Pick<TokenUsageRange, 'startAt' | 'endAt' | 'granularity' | 'timezone'>> & Omit<TokenUsageRange, 'startAt' | 'endAt' | 'granularity' | 'timezone'> {
  const now = Date.now()
  // An omitted `endAt` means "up to now", not "up to the top of the hour". It
  // used to be floored to the hour boundary, which dropped every turn recorded
  // since the hour began out of the range and the totals with it — the range the
  // caller got back said so, but a caller that omitted the field asked for the
  // present. Coarsening the on-disk key is the cache's own business and happens
  // below; it must not narrow the range the ledger actually reports on.
  const endAt = Number.isSafeInteger(query.endAt) ? query.endAt! : now
  const startAt = Number.isSafeInteger(query.startAt) ? query.startAt! : endAt - 30 * 24 * 60 * 60_000
  if (startAt < 0 || endAt < startAt) throw new Error('token usage range is invalid')
  if (query.provider !== undefined && (query.provider.trim() === '' || query.provider.length > 128)) throw new Error('token usage provider filter is invalid')
  if (query.model !== undefined && (query.model.trim() === '' || query.model.length > 256)) throw new Error('token usage model filter is invalid')
  if (query.sessionId !== undefined && (query.sessionId.trim() === '' || query.sessionId.length > 256)) throw new Error('token usage session filter is invalid')
  return {
    startAt,
    endAt,
    granularity: query.granularity === 'hour' ? 'hour' : 'day',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(query.provider === undefined ? {} : { provider: query.provider.trim() }),
    ...(query.model === undefined ? {} : { model: query.model.trim() }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId.trim() }),
  }
}

function bucketBounds(time: number, granularity: 'hour' | 'day'): { startAt: number; endAt: number } {
  const date = new Date(time)
  if (granularity === 'hour') date.setMinutes(0, 0, 0)
  else date.setHours(0, 0, 0, 0)
  const startAt = date.getTime()
  if (granularity === 'hour') return { startAt, endAt: startAt + 60 * 60_000 }
  date.setDate(date.getDate() + 1)
  return { startAt, endAt: date.getTime() }
}

function dateKey(time: number): string {
  const date = new Date(time)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function attemptCount(events: readonly SessionEvent[]): number {
  return events.filter(event => event.type === 'step/start' || event.type === 'llm/retry').length
}

/** Failed request attempts recorded in one turn: one per llm/retry event,
 * plus the accumulated provider/transport backoff wait. Defensive data access
 * keeps legacy sessions without the retry augmentation readable. */
function retryFacts(events: readonly SessionEvent[]): { count: number; delayMs: number } {
  let count = 0
  let delayMs = 0
  for (const event of events) {
    if (event.type !== 'llm/retry') continue
    const data = event.data as { delayMs?: unknown }
    count += 1
    if (typeof data.delayMs === 'number' && Number.isFinite(data.delayMs) && data.delayMs > 0) delayMs += data.delayMs
  }
  return { count, delayMs }
}

function failureCode(event: SessionEvent): { provider: string; code: string } | undefined {
  if (event.type !== 'llm/retry') return undefined
  const data = event.data as { provider?: unknown; failure?: { code?: unknown } }
  if (typeof data.provider !== 'string' || data.provider === '') return undefined
  if (typeof data.failure?.code !== 'string' || data.failure.code === '') return undefined
  return { provider: data.provider, code: data.failure.code }
}

/** Nearest-rank percentile over an ascending-sorted sample. */
function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]!
}

function latencyPercentiles(values: readonly number[]): { p50?: number; p95?: number } {
  if (values.length === 0) return {}
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
}

function isWithin(time: number, range: TokenUsageRange): boolean {
  return time >= range.startAt && time <= range.endAt
}

/**
 * Reduce per-turn cache observations to the block the dashboard renders.
 *
 * Returns `undefined` — not a zeroed block — when no two turns in the range
 * could be compared, because "this provider does not report caching" and "this
 * range wasted nothing" are opposite conclusions drawn from the same silence.
 * Cost stays 0 when pricing is unknown; the token counts are still true, so the
 * block is useful without a dollar figure rather than being withheld.
 */
function summarizeCacheWaste(turns: readonly CacheTurnObservation[]): LocalTokenUsageCacheWaste | undefined {
  if (turns.length < 2) return undefined
  const attribution = attributeCacheMisses(turns, { maxMisses: 200 })
  if (attribution.totals.comparedTurns === 0) return undefined
  // The breakdown comes from the totals, not from `attribution.misses`: that list
  // is capped for rendering, and this block's other counts cover the whole range,
  // so counting the causes off the capped list displayed a split that did not add
  // up to the miss count printed beside it.
  const byCause = attribution.totals.byCause
  return {
    missedTokens: attribution.totals.missedTokens,
    missedCostUsd: attribution.totals.missedCostUsd,
    missCount: attribution.totals.missCount,
    comparedTurns: attribution.totals.comparedTurns,
    unattributableTurns: attribution.totals.unattributableTurns,
    pricedTurns: attribution.totals.pricedTurns,
    byCause,
    // From the totals for the same reason `byCause` is: `attribution.misses`
    // holds the *most recent* 200 misses, so sorting it for a "largest misses"
    // list showed the worst of that tail as the worst of the range while the
    // total tokens beside it counted every miss.
    worst: attribution.totals.worst.map(miss => ({ at: miss.at, model: miss.model, missedTokens: miss.missedTokens, missedCostUsd: miss.missedCostUsd, cause: miss.cause })),
  }
}

function routeKey(provider: string, model: string): string { return `${provider}\u0000${model}` }

/**
 * Fold one turn's reporting quality into the cell it belongs to.
 *
 * A cell is `reported` only when *every* attempt behind it produced token
 * numbers, `unreported` only when none did, and `partial` for the mixture. Two
 * writers touch a cell — the reported path and the unreported one — and each
 * used to decide the label alone, so the same day's data read `reported` when
 * the numbered turn came last and `unreported` when it came first. Order is not
 * information a dashboard may depend on, and `reported` is the one label that
 * has to stay honest: it is the claim that the totals beside it are complete.
 *
 * @param previous - the label already on the cell, if any.
 * @param turn - the label this turn contributes.
 * @returns the merged label.
 */
function mergeMatrixStatus(previous: LocalTokenUsageMatrixCell['status'] | undefined, turn: LocalTokenUsageMatrixCell['status']): LocalTokenUsageMatrixCell['status'] {
  if (previous === undefined || previous === turn) return turn
  return 'partial'
}

function turnRoute(events: readonly SessionEvent[]): { provider: string; model: string } {
  const assistant = events.findLast(event => event.type === 'assistant/message')
  if (assistant?.type === 'assistant/message' && assistant.data.message.source.provider !== '' && assistant.data.message.source.model !== '') {
    return { provider: assistant.data.message.source.provider, model: assistant.data.message.source.model }
  }
  const header = events.findLast(event => event.type === 'request/header')
  if (header?.type === 'request/header') return { provider: header.data.header.config.provider, model: header.data.header.config.model }
  return { provider: 'unknown', model: 'unknown' }
}

/** Compatibility reader for older persisted turns that predate the strict
 * token-meter lifecycle envelope. It only accepts non-negative finite counts
 * and never estimates missing buckets. */
function looseTurnUsage(events: readonly SessionEvent[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; provider: string; model: string } | undefined {
  const record = (input: unknown): Record<string, unknown> | undefined => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
  const value = (input: unknown, ...keys: string[]): number | undefined => {
    const row = record(input)
    if (row === undefined) return undefined
    for (const key of keys) {
      const candidate = row[key]
      const number = typeof candidate === 'number' ? candidate : typeof candidate === 'string' && candidate.trim() !== '' ? Number(candidate) : Number.NaN
      if (Number.isFinite(number) && Number.isSafeInteger(number) && number >= 0) return number
    }
    return undefined
  }
  const normalize = (input: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | undefined => {
    const row = record(input)
    if (row === undefined) return undefined
    const promptDetails = record(row.prompt_tokens_details) ?? record(row.promptTokensDetails)
    const promptInput = value(row, 'prompt_tokens', 'promptTokens')
    const rawInput = value(row, 'inputTokens', 'input_tokens') ?? promptInput
    const outputTokens = value(row, 'outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens')
    if (rawInput === undefined || outputTokens === undefined) return undefined
    const cacheReadTokens = value(row, 'cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens') ?? value(promptDetails, 'cached_tokens', 'cachedTokens') ?? 0
    const cacheWriteTokens = value(row, 'cacheWriteTokens', 'cache_write_tokens', 'cache_creation_tokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0
    // OpenAI prompt_tokens already includes cached input; Harness inputTokens does not.
    const inputTokens = promptInput === undefined ? rawInput : Math.max(0, rawInput - cacheReadTokens)
    const totalTokens = value(row, 'totalTokens', 'total_tokens') ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
  }
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | undefined
  let provider = ''
  let model = ''
  for (const event of events) {
    if (event.type === 'assistant/message') {
      // Legacy events with a truncated payload must be skipped, not crash the
      // whole ledger: one malformed historical turn previously aborted the
      // snapshot with a TypeError on the missing message/source objects.
      const message = record(event.data?.message)
      if (message === undefined) continue
      const source = record(message.source)
      provider = typeof source?.provider === 'string' ? source.provider : provider
      model = typeof source?.model === 'string' ? source.model : model
      const candidate = normalize(event.data?.usage ?? message.usage)
      if (candidate !== undefined) usage = candidate
    }
  }
  if (usage === undefined || usage.totalTokens <= 0) return undefined
  return { ...usage, provider: provider || 'unknown', model: model || 'unknown' }
}

const CACHE_MAX_ENTRIES = 200
let cacheWriteChain: Promise<void> = Promise.resolve()

async function readCache(key: string): Promise<LocalTokenUsageSnapshot | undefined> {
  try {
    const raw = await fs.readFile(path.join(harnessHomeDirectory(), 'state', 'freecodego', 'local-token-usage-v1.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: Record<string, unknown> }
    if (parsed.version !== CACHE_VERSION) return undefined
    const entry = parsed.entries?.[key]
    // The entry is handed back to the caller as a snapshot, so a truncated or
    // hand-edited file must not be able to serve one: `undefined` is the honest
    // answer for a value this reader cannot vouch for.
    if (entry === null || typeof entry !== 'object') return undefined
    const candidate = entry as LocalTokenUsageSnapshot
    if (typeof candidate.generatedAt !== 'number' || !Number.isFinite(candidate.generatedAt)) return undefined
    if (candidate.range === null || typeof candidate.range !== 'object' || typeof candidate.range.endAt !== 'number') return undefined
    if (!Array.isArray(candidate.routes) || !Array.isArray(candidate.timeline)) return undefined
    return candidate
  } catch { return undefined }
}

async function persistCache(key: string, value: LocalTokenUsageSnapshot): Promise<void> {
  const file = path.join(harnessHomeDirectory(), 'state', 'freecodego', 'local-token-usage-v1.json')
  try {
    let entries: Record<string, LocalTokenUsageSnapshot> = {}
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: unknown; entries?: unknown }
      if (parsed.version === CACHE_VERSION && parsed.entries !== null && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) entries = parsed.entries as Record<string, LocalTokenUsageSnapshot>
    } catch { /* first write or corrupt cache */ }
    entries[key] = value
    const capped = Object.entries(entries).sort((a, b) => (b[1]?.generatedAt ?? 0) - (a[1]?.generatedAt ?? 0)).slice(0, CACHE_MAX_ENTRIES)
    entries = Object.fromEntries(capped)
    // 0600: per-user token accounting is not a shared document.
    await writeFileAtomic(file, JSON.stringify({ version: CACHE_VERSION, entries }), { mode: 0o600, dirMode: 0o700 })
  } catch { /* cache is an optimization; never fail the Remote */ }
}

function writeCache(key: string, value: LocalTokenUsageSnapshot): Promise<void> {
  // Serialize read-modify-write across concurrent Remote calls; each write is
  // an upsert of `key` capped to the newest CACHE_MAX_ENTRIES by generatedAt.
  const next = cacheWriteChain.then(() => persistCache(key, value)).then(() => undefined, () => undefined)
  cacheWriteChain = next
  return next
}

async function collectSources(ctx: { get(name: string): unknown }, selectedSession?: string): Promise<SessionSource[]> {
  const sources = new Map<string, SessionSource>()
  const live = ctx.get('sessions') as { list?: () => readonly { readonly id: unknown; readonly header: SessionHeader; readonly events?: readonly SessionEvent[]; readonly snapshotEvents?: () => readonly SessionEvent[] }[] } | undefined
  for (const session of live?.list?.() ?? []) {
    const id = String(session.id)
    if (selectedSession !== undefined && id !== selectedSession) continue
    sources.set(id, { meta: session.header, events: session.snapshotEvents?.() ?? session.events ?? [] })
  }
  const persistence = ctx.get('sessionPersistence') as SessionEventsPersistence & {
    list?: () => Promise<readonly (SessionHeader | { readonly header: SessionHeader })[]>
  } | undefined
  if (persistence?.list === undefined || persistence.open === undefined) return [...sources.values()]
  let headers: readonly (SessionHeader | { readonly header: SessionHeader })[]
  try { headers = await persistence.list() } catch { return [...sources.values()] }
  for (const listed of headers) {
    const header = 'header' in listed ? listed.header : listed
    const id = String(header.id)
    if (sources.has(id) || (selectedSession !== undefined && id !== selectedSession)) continue
    try {
      // The listed header is the durable one, and the log is read through the
      // declared handle (`open` → `read` → `close`) by the same adapter the
      // deletion path uses. A preview-only `inspect(id)` used to be preferred here
      // whenever it existed — no pinned Harness line declares it (it was removed
      // before 0.1.3), so the branch was dead while making this the second copy of
      // the protocol.
      const { events } = await readPersistedEvents(persistence, SessionId(id))
      sources.set(id, { meta: header, events })
    } catch { /* one corrupt/deleted session must not block the ledger */ }
  }
  return [...sources.values()]
}

/** Total this plugin's own session ledgers into one local usage snapshot.
 * @param ctx - the context carrying the session storage this reads.
 * @param query - the local window and grouping to total.
 * @returns the local token-usage snapshot.
 */
export async function buildLocalTokenUsageSnapshot(ctx: { get(name: string): unknown }, query: LocalTokenUsageQuery = {}): Promise<LocalTokenUsageSnapshot> {
  const range = normalizeQuery(query)
  // This cache is a *fallback* store, not a hit path: `cached` is consulted only
  // when a fresh walk came back empty, so that one transient persistence failure
  // cannot leave the caller looking at an empty dashboard. Two consequences, and
  // both are deliberate here. A coarse key cannot serve stale data, because it is
  // never used in place of a live walk; and rounding both bounds to the hour keeps
  // one entry per query shape per hour, so a caller that omits `endAt` (whose
  // range moves with the clock) still reuses its own fallback entry instead of
  // writing a unique key — and evicting everyone else's — on every request.
  const hourBucket = (time: number): number => Math.floor(time / 3_600_000) * 3_600_000
  const cacheKey = JSON.stringify({ ...range, startAt: hourBucket(range.startAt), endAt: hourBucket(range.endAt) })
  const cached = await readCache(cacheKey)
  const routes = new Map<string, MutableRoute>()
  const buckets = new Map<number, MutableBucket>()
  const matrix = new Map<string, LocalTokenUsageMatrixCell>()
  const sessions = new Map<string, MutableSession>()
  let reportedInputTokens = 0
  let reportedOutputTokens = 0
  let reportedCacheReadTokens = 0
  let reportedCacheWriteTokens = 0
  let reportedTotalTokens = 0
  let reportedAttempts = 0
  let unreportedAttempts = 0
  let partialAttempts = 0
  let retryCount = 0
  let retryDelayMs = 0
  const turnLatencies: number[] = []
  const failures = new Map<string, LocalTokenUsageFailure>()

  /**
   * Whether a route belongs to the view the caller narrowed to.
   *
   * One definition for the three paths that accumulate a turn, because each used
   * to carry its own copy of the rule: the derived path filtered, the legacy loose
   * path filtered, and the unattributed path applied no filter at all. Every path
   * that drops the check leaks — a turn that ends without an assistant message and
   * without a request header (an aborted or early-failed turn) has no route to
   * compare, so `provider=agnes` listed an `unknown/unknown` row, a turn that named
   * another provider through its request header was counted under this one, and a
   * provider that never ran was not the empty view it should have been.
   */
  const matchesRange = (provider: string, model: string): boolean =>
    (range.provider === undefined || provider === range.provider) && (range.model === undefined || model === range.model)

  /**
   * Whether the view covers whole turns rather than a subset of their routes.
   *
   * The two questions a view can ask are different, and the difference decides
   * what its turn-level numbers are: "all traffic" has a turn-level truth, while
   * "this provider's traffic" in a turn that also ran on another provider does
   * not — the meter never said how the turn's tokens split between them.
   */
  const widened = range.provider === undefined && range.model === undefined

  const addUnreported = (time: number, attempts: number, provider = 'unknown', model = 'unknown', sessionId?: string, retries = { count: 0, delayMs: 0 }, turnLatencyMs?: number): void => {
    if (attempts <= 0) return
    unreportedAttempts += attempts
    const key = routeKey(provider, model)
    const route = routes.get(key) ?? { provider, model, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reportedAttempts: 0, partialAttempts: 0, unreportedAttempts: 0, retries: 0, retryDelayMs: 0, turns: 0, latencies: [] }
    route.attempts += attempts
    route.unreportedAttempts += attempts
    route.retries += retries.count
    route.retryDelayMs += retries.delayMs
    if (turnLatencyMs !== undefined) {
      route.turns += 1
      route.latencies.push(turnLatencyMs)
    }
    routes.set(key, route)
    retryCount += retries.count
    retryDelayMs += retries.delayMs
    if (turnLatencyMs !== undefined) turnLatencies.push(turnLatencyMs)
    const bounds = bucketBounds(time, range.granularity)
    const bucket = buckets.get(bounds.startAt) ?? { ...bounds, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, attempts: 0, unreportedAttempts: 0 }
    bucket.attempts += attempts
    bucket.unreportedAttempts += attempts
    buckets.set(bounds.startAt, bucket)
    const matrixBounds = bucketBounds(time, range.granularity)
    const matrixKey = `${matrixBounds.startAt}\u0000${key}`
    const previous = matrix.get(matrixKey)
    matrix.set(matrixKey, { date: dateKey(time), startAt: matrixBounds.startAt, provider, model, ...(previous?.totalTokens === undefined ? {} : { totalTokens: previous.totalTokens }), attempts: (previous?.attempts ?? 0) + attempts, status: mergeMatrixStatus(previous?.status, 'unreported') })
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId) ?? { sessionId, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
      session.attempts += attempts
      sessions.set(sessionId, session)
    }
  }

  // One entry per reported turn, for cache-miss attribution after the walk.
  const cacheTurns: CacheTurnObservation[] = []
  for (const source of await collectSources(ctx, range.sessionId)) {
    const sessionId = String(source.meta.id)
    const events = source.events
    let turnStart: SessionEvent | undefined
    let turnEvents: SessionEvent[] = []
    for (const event of events) {
      if (event.type === 'turn/start') { turnStart = event; turnEvents = [event]; continue }
      if (turnStart === undefined) continue
      turnEvents.push(event)
      if (event.type !== 'turn/end') continue
      const time = turnStart.time
      const attempts = attemptCount(turnEvents)
      if (isWithin(time, range)) {
        const retries = retryFacts(turnEvents)
        const turnLatencyMs = Math.max(0, event.time - time)
        // Failure codes are provider-keyed facts carried by each retry event;
        // they are aggregated independently of turn token attribution (a
        // failover turn may retry on a provider that never produced usage).
        for (const retryEvent of turnEvents) {
          const failure = failureCode(retryEvent)
          if (failure === undefined) continue
          if (range.provider !== undefined && failure.provider !== range.provider) continue
          const failureKey = `${failure.provider}\u0000${failure.code}`
          failures.set(failureKey, { provider: failure.provider, code: failure.code, count: (failures.get(failureKey)?.count ?? 0) + 1 })
        }
        const usage = deriveTurnTokenUsage(turnEvents)
        if (usage === undefined) {
          const loose = looseTurnUsage(turnEvents)
          if (loose !== undefined) {
            if (!matchesRange(loose.provider, loose.model)) {
              turnStart = undefined; turnEvents = []; continue
            }
            const route = routeKey(loose.provider, loose.model)
            const current = routes.get(route) ?? { provider: loose.provider, model: loose.model, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reportedAttempts: 0, partialAttempts: 0, unreportedAttempts: 0, retries: 0, retryDelayMs: 0, turns: 0, latencies: [] }
            cacheTurns.push({
              sessionId,
              at: time,
              model: `${loose.provider}/${loose.model}`,
              promptTokens: loose.inputTokens + loose.cacheReadTokens + loose.cacheWriteTokens,
              cacheReadTokens: loose.cacheReadTokens,
              cacheWriteTokens: loose.cacheWriteTokens,
              paidTokens: loose.inputTokens + loose.cacheWriteTokens,
            })
            current.attempts += attempts; current.reportedAttempts += attempts; current.inputTokens += loose.inputTokens; current.outputTokens += loose.outputTokens; current.cacheReadTokens += loose.cacheReadTokens; current.cacheWriteTokens += loose.cacheWriteTokens; current.totalTokens += loose.totalTokens; routes.set(route, current)
            current.retries += retries.count; current.retryDelayMs += retries.delayMs; current.turns += 1; current.latencies.push(turnLatencyMs)
            retryCount += retries.count; retryDelayMs += retries.delayMs; turnLatencies.push(turnLatencyMs)
            reportedInputTokens += loose.inputTokens; reportedOutputTokens += loose.outputTokens; reportedCacheReadTokens += loose.cacheReadTokens; reportedCacheWriteTokens += loose.cacheWriteTokens; reportedTotalTokens += loose.totalTokens; reportedAttempts += attempts
            const bounds = bucketBounds(time, range.granularity); const bucket = buckets.get(bounds.startAt) ?? { ...bounds, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, attempts: 0, unreportedAttempts: 0 }; bucket.inputTokens += loose.inputTokens; bucket.outputTokens += loose.outputTokens; bucket.cacheReadTokens += loose.cacheReadTokens; bucket.cacheWriteTokens += loose.cacheWriteTokens; bucket.totalTokens += loose.totalTokens; bucket.attempts += attempts; buckets.set(bounds.startAt, bucket)
            const matrixKey = `${bounds.startAt}\u0000${route}`; const previous = matrix.get(matrixKey); matrix.set(matrixKey, { date: dateKey(time), startAt: bounds.startAt, provider: loose.provider, model: loose.model, totalTokens: (previous?.totalTokens ?? 0) + loose.totalTokens, attempts: (previous?.attempts ?? 0) + attempts, status: mergeMatrixStatus(previous?.status, 'reported') })
            const session = sessions.get(sessionId) ?? { sessionId, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
            session.attempts += attempts; session.inputTokens += loose.inputTokens; session.outputTokens += loose.outputTokens; session.cacheReadTokens += loose.cacheReadTokens; session.cacheWriteTokens += loose.cacheWriteTokens; session.totalTokens += loose.totalTokens; sessions.set(sessionId, session)
          } else {
            const route = turnRoute(turnEvents)
            // Included only when the view asked for it: an unattributable turn cannot
            // be shown to belong to the provider or model a caller narrowed to, and
            // the two paths above drop such a turn rather than guess.
            if (matchesRange(route.provider, route.model)) {
              addUnreported(time, attempts, route.provider, route.model, sessionId, retries, turnLatencyMs)
            }
          }
        } else if (usage.totalTokens > 0 || attempts > 0) {
          const fallbackRoute = turnEvents.findLast(event => event.type === 'assistant/message')
          const fallbackSource = fallbackRoute?.type === 'assistant/message' ? fallbackRoute.data.message.source : undefined
          const routesForTurn = usage.routes?.length
            ? usage.routes
            : fallbackSource !== undefined && fallbackSource.provider !== '' && fallbackSource.model !== ''
              ? [{ provider: fallbackSource.provider, model: fallbackSource.model }]
              : [{ provider: 'unknown', model: 'unknown' }]
          const attributedRoutes = routesForTurn.filter(route => matchesRange(route.provider, route.model))
          if (attributedRoutes.length === 0) {
            turnStart = undefined; turnEvents = []; continue
          }
          // The meter does not disclose per-route token splits; every route of a
          // multi-route turn receives a floor-divided share of the turn totals. The
          // share is the *turn's*, taken from the routes the meter reported: a caller
          // asking about one provider does not make the turn single-route. Dividing
          // by the surviving routes instead credits the filtered view with the whole
          // turn — more than the unfiltered view gives that same route, so the two
          // panels disagree about the same traffic and their figures add up to twice
          // the tokens either of them describes.
          const routeShare = routesForTurn.length
          const split = (amount: number): number => Math.floor(amount / routeShare)
          // Turn-level surfaces take the turn's own numbers, because the floor
          // division drops a remainder: a 155-token turn over two routes reported 154
          // in the totals, the timeline and the session row — up to (routes − 1)
          // tokens per field per turn, and the header number is the one a user checks
          // against the bill. A narrowed view keeps the conservative sum of the shares
          // it selected instead: it has no turn-level truth to report, and its totals
          // have to agree with the route row it shows beside them.
          const turnLevel = (amount: number): number => widened ? amount : split(amount) * attributedRoutes.length
          const cacheRead = usage.cacheReadTokens ?? 0
          const cacheWrite = usage.cacheWriteTokens ?? 0
          const partial = usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined
          // The turn's own first route names the observation, for the same reason the
          // share does: this is a turn-level total, and a filter that renamed it would
          // also change which turns look like a model switch to the miss attribution.
          const leadRoute = routesForTurn[0]!
          cacheTurns.push({
            sessionId,
            at: time,
            model: `${leadRoute.provider}/${leadRoute.model}`,
            promptTokens: Math.max(0, usage.uncachedInputTokens) + cacheRead + cacheWrite,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            paidTokens: Math.max(0, usage.uncachedInputTokens) + cacheWrite,
          })
          const bucketBoundsValue = bucketBounds(time, range.granularity)
          // Attempts are turn-level facts: they stay whole and are attributed to
          // the turn's first route (bucket, session, and totals included) so per-route
          // request counts reconcile instead of multiplying by the route count. The
          // iteration walks every reported route and skips the ones this view did not
          // select, so that skipping cannot promote a later route into the first one.
          for (const [routeIndex, primary] of routesForTurn.entries()) {
            if (!matchesRange(primary.provider, primary.model)) continue
            const attemptShare = routeIndex === 0 ? attempts : 0
            const key = routeKey(primary.provider, primary.model)
            const route = routes.get(key) ?? { provider: primary.provider, model: primary.model, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reportedAttempts: 0, partialAttempts: 0, unreportedAttempts: 0, retries: 0, retryDelayMs: 0, turns: 0, latencies: [] }
            route.attempts += attemptShare
            route.inputTokens += split(usage.uncachedInputTokens)
            route.outputTokens += split(usage.outputTokens)
            route.cacheReadTokens += split(cacheRead)
            route.cacheWriteTokens += split(cacheWrite)
            route.totalTokens += split(usage.totalTokens)
            route.reportedAttempts += attemptShare
            if (partial) route.partialAttempts += attemptShare
            // Retries and turn latency follow attempts: whole turn-level facts
            // attributed to the first route so per-route sums reconcile.
            if (routeIndex === 0) {
              route.retries += retries.count
              route.retryDelayMs += retries.delayMs
              route.turns += 1
              route.latencies.push(turnLatencyMs)
              retryCount += retries.count
              retryDelayMs += retries.delayMs
              turnLatencies.push(turnLatencyMs)
            }
            routes.set(key, route)
            reportedAttempts += attemptShare
            const attemptsBucket = buckets.get(bucketBoundsValue.startAt) ?? { ...bucketBoundsValue, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, attempts: 0, unreportedAttempts: 0 }
            attemptsBucket.attempts += attemptShare
            buckets.set(attemptsBucket.startAt, attemptsBucket)
            const matrixKey = `${bucketBoundsValue.startAt}\u0000${key}`
            const previous = matrix.get(matrixKey)
            matrix.set(matrixKey, { date: dateKey(time), startAt: bucketBoundsValue.startAt, provider: primary.provider, model: primary.model, totalTokens: (previous?.totalTokens ?? 0) + split(usage.totalTokens), attempts: (previous?.attempts ?? 0) + attemptShare, status: mergeMatrixStatus(previous?.status, partial ? 'partial' : 'reported') })
            const attemptsSession = sessions.get(sessionId) ?? { sessionId, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
            attemptsSession.attempts += attemptShare
            sessions.set(sessionId, attemptsSession)
          }
          // Turn-level accounting, added once per turn rather than once per route.
          reportedInputTokens += turnLevel(usage.uncachedInputTokens)
          reportedOutputTokens += turnLevel(usage.outputTokens)
          reportedCacheReadTokens += turnLevel(cacheRead)
          reportedCacheWriteTokens += turnLevel(cacheWrite)
          reportedTotalTokens += turnLevel(usage.totalTokens)
          const bucket = buckets.get(bucketBoundsValue.startAt) ?? { ...bucketBoundsValue, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, attempts: 0, unreportedAttempts: 0 }
          bucket.inputTokens += turnLevel(usage.uncachedInputTokens)
          bucket.outputTokens += turnLevel(usage.outputTokens)
          bucket.cacheReadTokens += turnLevel(cacheRead)
          bucket.cacheWriteTokens += turnLevel(cacheWrite)
          bucket.totalTokens += turnLevel(usage.totalTokens)
          buckets.set(bucket.startAt, bucket)
          const session = sessions.get(sessionId) ?? { sessionId, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
          session.inputTokens += turnLevel(usage.uncachedInputTokens)
          session.outputTokens += turnLevel(usage.outputTokens)
          session.cacheReadTokens += turnLevel(cacheRead)
          session.cacheWriteTokens += turnLevel(cacheWrite)
          session.totalTokens += turnLevel(usage.totalTokens)
          sessions.set(sessionId, session)
          if (partial) partialAttempts += attempts
        }
      }
      turnStart = undefined
      turnEvents = []
    }
  }

  const currentSession = range.sessionId === undefined ? undefined : sessions.get(range.sessionId)
  const totalLatency = latencyPercentiles(turnLatencies)
  // Prompt-cache waste. Observations are turn-level totals rather than the
  // per-route floor-divided shares used above: a miss is a property of the whole
  // request prefix, so splitting it across routes would understate every one.
  const cacheWaste = summarizeCacheWaste(cacheTurns)
  const routeViews = [...routes.values()].sort((a, b) => b.totalTokens - a.totalTokens).map((route) => {
    const latency = latencyPercentiles(route.latencies)
    const view: LocalTokenUsageRoute = {
      provider: route.provider,
      model: route.model,
      attempts: route.attempts,
      inputTokens: route.inputTokens,
      outputTokens: route.outputTokens,
      cacheReadTokens: route.cacheReadTokens,
      cacheWriteTokens: route.cacheWriteTokens,
      totalTokens: route.totalTokens,
      reportedAttempts: route.reportedAttempts,
      partialAttempts: route.partialAttempts,
      unreportedAttempts: route.unreportedAttempts,
      retries: route.retries,
      retryDelayMs: route.retryDelayMs,
      turns: route.turns,
      ...(latency.p50 === undefined ? {} : { turnLatencyMsP50: latency.p50 }),
      ...(latency.p95 === undefined ? {} : { turnLatencyMsP95: latency.p95 }),
    }
    return view
  })
  const snapshot: LocalTokenUsageSnapshot = {
    source: 'harness-local', generatedAt: Date.now(), range,
    totals: {
      reportedInputTokens,
      reportedOutputTokens,
      reportedCacheReadTokens,
      reportedCacheWriteTokens,
      reportedTotalTokens,
      reportedAttempts,
      unreportedAttempts,
      partialAttempts,
      retryCount,
      retryDelayMs,
      ...(totalLatency.p50 === undefined ? {} : { turnLatencyMsP50: totalLatency.p50 }),
      ...(totalLatency.p95 === undefined ? {} : { turnLatencyMsP95: totalLatency.p95 }),
      failures: [...failures.values()].sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider) || a.code.localeCompare(b.code)).slice(0, 12),
      ...(cacheWaste === undefined ? {} : { cacheWaste }),
    },
    routes: routeViews,
    timeline: [...buckets.values()].sort((a, b) => a.startAt - b.startAt),
    matrix: [...matrix.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    ...(currentSession === undefined ? {} : { currentSession }),
  }
  // An empty recomputation (transient persistence failure upstream) must not
  // overwrite the last good cached aggregation: the caller would permanently
  // see an empty dashboard after one blip. Keep the cache and fall back to it.
  if (snapshot.timeline.length === 0 && snapshot.routes.length === 0 && cached !== undefined) return cached
  await writeCache(cacheKey, snapshot)
  return snapshot
}
