import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { GatewayUsageSnapshot, LocalTokenUsageQuery, LocalTokenUsageSnapshot } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { getStackedSegmentVisualLayout } from './stacked-bar-visuals.ts'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import css from './settings-tab.module.css'

/** Dashboard-local aliases; the rest of the file uses these short names. */
type LocalSnapshot = LocalTokenUsageSnapshot
type GatewaySnapshot = GatewayUsageSnapshot

type UsageRow = { model: string; provider: string; requests: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; reported: boolean }
/** One trend bucket: daily for multi-day windows, hourly for "today".
 *  Slices carry the per-model split the heatmap tooltip shows. */
type UsageSlice = { model: string; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; requests: number }
type UsagePoint = { key: string; label: string; startAt: number; tokens: number; requests: number; cost: number; slices: UsageSlice[] }
type Copy = Readonly<{
  // One member per line and no separators: the repository's member-delimiter
  // style is `none` for a multiline literal, which a packed line cannot express.
  title: string
  gateway: string
  local: string
  balance: string
  refreshBalance: string
  sessionCost: string
  today: string
  seven: string
  thirty: string
  rangeDays: (days: number) => string
  trend: string
  daily: string
  details: string
  requests: string
  input: string
  output: string
  cache: string
  total: string
  cost: string
  status: string
  reported: string
  unreported: string
  loading: string
  refresh: string
  noData: string
  loadError: string
  fewer: string
  more: string
  signedOut: string
  window: string
  account: string
  allModels: string
  model: string
  modelPillsMore: (count: number) => string
  balanceOk: string
  balanceLow: string
  balanceDanger: string
  cacheHit: string
  cacheMiss: string
  others: string
  axisTitle: string
  axisTitleHour: string
  unknown: string
  /** Rollup tokens/requests/cost the gateway feed reports without a model. */
  unattributed: string
  cacheWasteTitle: string
  cacheWasteHint: string
  cacheWasteClean: string
  cacheWasteTokens: string
  cacheWasteMisses: string
  cacheWasteCompared: string
  cacheWasteIdle: string
  cacheWasteModel: string
  cacheWastePrefix: string
  cacheWasteWorst: string
  cacheWasteUnpriced: string
  cacheWasteNotReported: string
}>

const GATEWAY_WINDOW_MAX = 90
const LOCAL_WINDOW_MAX = 365
/** Stacked trend series: the top models by tokens plus one "others" rollup,
 *  the cap the reference credit-trend chart uses so the legend stays legible. */
const MAX_STACK_SERIES = 5
/** Floor for a stacked segment, so a small model never collapses to a
 *  hairline between two large ones. Short bars scale it down (see
 *  `segmentFloorOf`) rather than clipping their top segments away. */
const MIN_SEGMENT = 5
/** How many model pills the header offers before the row is capped. */
const MODEL_PILL_LIMIT = 8
const OTHER_SERIES_COLOR = 'var(--fcg-text-tertiary)'
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Number(value)) ? Number(value) : 0
const get = (row: Record<string, unknown>, ...keys: string[]): number => { for (const key of keys) if (row[key] !== undefined) return num(row[key]); return 0 }
const compact = (value: number, language: 'zh' | 'en'): string => Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
/** Full-precision axis/tooltip numbers, the way the reference console shows
 *  exact counts (5,733,911,722) rather than rounded compounds. */
const full = (value: number): string => Math.round(value).toLocaleString('en-US')
const money = (value: number): string => `$${value >= 1 ? value.toFixed(2) : value >= 0.01 ? value.toFixed(3) : value > 0 ? value.toFixed(4) : '0.00'}`
const visibleModel = (model: string): string => model.replace(/^logfare\//i, '')
const visibleProvider = (provider: string): string => provider.toLowerCase() === 'logfare' ? 'logfare' : provider

/** Signature hue per model family: tooltip dots, filter pills and the
 *  model table all tint with the vendor color. Unknown families hash to a
 *  stable hue so distinct models never visually collapse into one. */
const BRAND_RULES: readonly (readonly [RegExp, string])[] = [
  [/deepseek|freecodego/i, '#4D6BFE'],
  [/gpt|openai|o[1345](-|\b)|davinci|codex/i, '#10A37F'],
  [/claude|anthropic/i, '#D97757'],
  [/gemini|gemma|google|palm\b/i, '#4285F4'],
  [/glm|zhipu|chatglm/i, '#6E56CF'],
  [/qwen|qwq|tongyi|wanx/i, '#7C3AED'],
  [/llama|meta-|llava/i, '#0866FF'],
  [/mistral|mixtral|magistral|ministral/i, '#FA500F'],
  [/kimi|moonshot/i, '#16AA77'],
  [/ernie|wenxin/i, '#2932E1'],
  [/doubao|skylark|seed-|byteix/i, '#0F7BFF'],
  [/hunyuan/i, '#0052D9'],
  [/grok|xai\b/i, '#9CA3AF'],
  [/groq/i, '#F55036'],
  [/sonar|perplexity/i, '#20808D'],
  [/sensenova|internlm|step-/i, '#00B3A6'],
  [/copilot|github/i, '#57606A'],
]
export function brandColor(...labels: readonly string[]): string {
  const haystack = labels.filter(label => label !== '').join(' ')
  for (const [pattern, color] of BRAND_RULES) if (pattern.test(haystack)) return color
  let hash = 0
  for (const character of haystack) hash = (hash * 31 + character.charCodeAt(0)) % 360
  return haystack === '' ? 'var(--fcg-text-tertiary)' : `hsl(${hash} 62% 52%)`
}

/** Two brand hues closer than this read as the same colour at bar width, so
 *  the later series is nudged to a free hue instead. Without it a window
 *  holding DeepSeek and Gemini renders as one wall of brand blue. */
const MIN_HUE_GAP = 32
/** Step the second, third … model of one vendor walks away from its shared
 *  brand hue, so two DeepSeek models stay one family without being one colour. */
const SIBLING_HUE_STEP = 26

const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360

function hueGap(left: number, right: number): number {
  const raw = Math.abs(left - right) % 360
  return Math.min(raw, 360 - raw)
}

/** Hue in degrees of a hex colour, or undefined for the hashed `hsl()` and
 *  theme-var fallbacks — those already arrive distinct, so they are left as-is. */
function hueOf(color: string): number | undefined {
  const match = /^#([\da-f]{6})$/i.exec(color.trim())
  if (match === null) return undefined
  const value = Number.parseInt(match[1]!, 16)
  const red = ((value >> 16) & 0xff) / 255
  const green = ((value >> 8) & 0xff) / 255
  const blue = (value & 0xff) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  if (max === min) return 0
  const span = max - min
  const raw = max === red ? (green - blue) / span + (green < blue ? 6 : 0) : max === green ? (blue - red) / span + 2 : (red - green) / span + 4
  return raw * 60
}

/** The same colour at a new hue, keeping the brand's own saturation and
 *  lightness so a nudged vendor still reads as a member of its palette. */
function withHue(color: string, hue: number): string {
  const match = /^#([\da-f]{6})$/i.exec(color.trim())
  if (match === null) return color
  const value = Number.parseInt(match[1]!, 16)
  const red = ((value >> 16) & 0xff) / 255
  const green = ((value >> 8) & 0xff) / 255
  const blue = (value & 0xff) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  const span = max - min
  const saturation = span === 0 ? 0 : span / (1 - Math.abs(2 * lightness - 1))
  return `hsl(${Math.round(wrapHue(hue))} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%)`
}

/** First free hue around `from`, searched in widening steps so a collision stays
 *  as close to the vendor's own colour as the palette allows. */
function freeHue(from: number, claimed: readonly number[]): number {
  for (const delta of [40, -40, 80, -80, 120, -120, 160, -160]) {
    const candidate = wrapHue(from + delta)
    if (claimed.every(hue => hueGap(hue, candidate) >= MIN_HUE_GAP)) return candidate
  }
  return wrapHue(from)
}

/** Provider-aware palette for the stacked trend. Every model starts from its
 *  vendor's brand colour — DeepSeek blue, OpenAI green, Anthropic clay — and
 *  the row's provider is passed in beside the model id so a route that does not
 *  name its vendor still lands on the right hue. Two corrections keep the chart
 *  readable: models sharing a vendor step away from the shared hue, and a brand
 *  whose hue collides with one already claimed in this window (DeepSeek and
 *  Gemini are both blue) is nudged to a free hue instead of repeating it. */
export function seriesPalette(names: readonly string[], providerOf: (model: string) => string): ReadonlyMap<string, string> {
  const palette = new Map<string, string>()
  const claimed: number[] = []
  const seen = new Map<string, number>()
  for (const name of names) {
    const base = brandColor(name, providerOf(name))
    const step = seen.get(base) ?? 0
    seen.set(base, step + 1)
    const baseHue = hueOf(base)
    if (baseHue === undefined) {
      palette.set(name, base)
      continue
    }
    const hue = step > 0
      ? wrapHue(baseHue + step * SIBLING_HUE_STEP)
      : claimed.some(claimedHue => hueGap(claimedHue, baseHue) < MIN_HUE_GAP)
        ? freeHue(baseHue, claimed)
        : baseHue
    claimed.push(hue)
    palette.set(name, hue === baseHue ? base : withHue(base, hue))
  }
  return palette
}
const dateKey = (time: number): string => { const value = new Date(time); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` }
const hourKey = (time: number): string => `${dateKey(time)} ${String(new Date(time).getHours()).padStart(2, '0')}:00`
const bucketKey = (time: number, hourly: boolean): string => hourly ? hourKey(time) : dateKey(time)
const midnight = (offsetDays = 0): number => { const value = new Date(); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() - offsetDays); return value.getTime() }
const localRangeStart = (days: number, now = new Date()): number => { const start = new Date(now); start.setHours(0, 0, 0, 0); if (days > 1) start.setDate(start.getDate() - (days - 1)); return start.getTime() }

/** Parse a gateway timeline/turn row's timestamp, tolerating missing values. */
export function parseGatewayTime(row: Record<string, unknown>): number {
  // The charges ledger persists camelCase timestamps while dashboard rows are
  // snake_case; both spellings must resolve or settled money disappears.
  const text = typeof row.date === 'string' ? row.date : typeof row.bucket_start === 'string' ? row.bucket_start : typeof row.bucket === 'string' ? row.bucket : typeof row.completed_at === 'string' ? row.completed_at : typeof row.started_at === 'string' ? row.started_at : typeof row.created_at === 'string' ? row.created_at : typeof row.createdAt === 'string' ? row.createdAt : typeof row.settledAt === 'string' ? row.settledAt : ''
  // A bare calendar date is a *day*, not an instant. `Date.parse` reads it as
  // UTC midnight, while every consumer of this value buckets by local date
  // (`dateKey`) and labels the slot from the same local calendar — so for any
  // user west of UTC the gateway's whole daily rollup landed on the previous
  // day's cell, and on the one-day window it landed in the previous day's hour
  // bucket, leaving the "today" card empty. Reading it as local midnight keeps
  // the day the feed named the day the chart shows, in every zone.
  const calendar = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text.trim())
  if (calendar !== null) {
    return new Date(Number(calendar[1]), Number(calendar[2]) - 1, Number(calendar[3])).getTime()
  }
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : Number.NaN
}

/** Slice accumulator shared by both sources so local/gateway timelines stay
 *  exactly the same shape: per-bucket totals + per-model breakdown. */
class PointBuilder {
  private readonly map = new Map<string, UsagePoint>()
  constructor(private readonly hourlyField: boolean, private readonly unknownLabel = 'unknown-model') {}
  admit(time: number, model: string, tokens: number, requests: number, cost: number, split?: Partial<Pick<UsageSlice, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>>): void {
    if (!Number.isFinite(time)) return
    const key = bucketKey(time, this.hourlyField)
    const current = this.map.get(key) ?? { key, label: this.hourlyField ? key.slice(11) : key.slice(5).replace('-', '/'), startAt: time, tokens: 0, requests: 0, cost: 0, slices: [] }
    current.tokens += tokens
    current.requests += requests
    current.cost += cost
    const name = model === '' ? this.unknownLabel : model
    let slice = current.slices.find(item => item.model === name)
    if (slice === undefined) { slice = { model: name, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 }; current.slices.push(slice) }
    slice.tokens += tokens
    slice.requests += requests
    slice.cost += cost
    slice.input += split?.input ?? 0
    slice.output += split?.output ?? 0
    slice.cacheRead += split?.cacheRead ?? 0
    slice.cacheWrite += split?.cacheWrite ?? 0
    this.map.set(key, current)
  }
  /**
   * Fold the backend's own bucket totals over whatever per-model rows landed.
   *
   * The gateway endpoint ships two different things: a complete daily rollup
   * (computed from settled summaries plus the raw rows they have not absorbed)
   * and a per-request sample capped at the newest few hundred rows. Only the
   * totals are complete, so each bucket is lifted to them, and the part no
   * model row accounts for is named explicitly — a rolled-up day genuinely has
   * no model left to name, and `0 tokens` next to a 4.7M-token chart is worse
   * than saying so.
   * @param totals - authoritative buckets keyed the way `admit` keys them.
   * @param label - the row the remainder is reported under.
   */
  reconcileTotals(totals: ReadonlyMap<string, { readonly time: number; readonly tokens: number; readonly requests: number; readonly cost: number }>, label: string): void {
    for (const [key, total] of totals) {
      const point = this.map.get(key) ?? { key, label: this.hourlyField ? key.slice(11) : key.slice(5).replace('-', '/'), startAt: total.time, tokens: 0, requests: 0, cost: 0, slices: [] }
      const attributed = point.slices.reduce((sum, slice) => sum + slice.tokens, 0)
      const remainder = Math.max(0, total.tokens - attributed)
      if (remainder > 0) {
        point.slices.push({
          model: label,
          tokens: remainder,
          requests: Math.max(0, total.requests - point.requests),
          cost: Math.max(0, total.cost - point.cost),
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })
      }
      point.tokens = Math.max(point.tokens, total.tokens)
      point.requests = Math.max(point.requests, total.requests)
      point.cost = Math.max(point.cost, total.cost)
      this.map.set(key, point)
    }
  }

  get size(): number { return this.map.size }
  get hasCost(): boolean { return [...this.map.values()].some(point => point.cost > 0) }
  get hasTokens(): boolean { return [...this.map.values()].some(point => point.tokens > 0) }
  /** Sorted buckets with slices trimmed to a top-N model list, mirroring the
   *  reference tooltip that names a handful of models plus an "others" row. */
  build(topModels: number, text: Pick<Copy, 'others' | 'unknown'>): UsagePoint[] {
    for (const point of this.map.values()) {
      const ordered = point.slices.sort((a, b) => b.tokens - a.tokens)
      if (ordered.length <= topModels) continue
      const keep = ordered.slice(0, topModels - 1)
      const rest = ordered.slice(topModels - 1)
      keep.push({ model: text.others, tokens: rest.reduce((sum, item) => sum + item.tokens, 0), input: rest.reduce((sum, item) => sum + item.input, 0), output: rest.reduce((sum, item) => sum + item.output, 0), cacheRead: rest.reduce((sum, item) => sum + item.cacheRead, 0), cacheWrite: rest.reduce((sum, item) => sum + item.cacheWrite, 0), cost: rest.reduce((sum, item) => sum + item.cost, 0), requests: rest.reduce((sum, item) => sum + item.requests, 0) })
      point.slices = keep
    }
    return [...this.map.values()].sort((a, b) => a.key.localeCompare(b.key))
  }
}

/** Zero-fill the selected window so empty days/hours still occupy their slot:
 *  the contribution-grid look — every day gets a cell, and the axis always
 *  spans the full range instead of collapsing to the days that have data. */
function fillWindow(points: UsagePoint[], days: number, hourly: boolean): UsagePoint[] {
  const byKey = new Map(points.map(point => [point.key, point]))
  const empty = (key: string, startAt: number): UsagePoint => ({ key, label: hourly ? key.slice(11) : key.slice(5).replace('-', '/'), startAt, tokens: 0, requests: 0, cost: 0, slices: [] })
  const result: UsagePoint[] = []
  if (hourly) {
    const base = new Date()
    base.setHours(0, 0, 0, 0)
    // Step hours via setHours for the same reason the daily loop steps dates:
    // a fixed 3_600_000ms stride double-books the repeated wall-clock hour on
    // DST fall-back days.
    for (let hour = 0; hour < 24; hour += 1) {
      const cursor = new Date(base)
      cursor.setHours(hour, 0, 0, 0)
      const time = cursor.getTime()
      const key = hourKey(time)
      result.push(byKey.get(key) ?? empty(key, time))
    }
    return result
  }
  // Daily windows: zero-fill every day from window start through today, then
  // append any data bucket that fell outside the computed span so nothing
  // admitted is lost (clock/timezone edges). Sorted output regardless.
  // Advance by calendar dates, not fixed milliseconds: a 24h step lands on the
  // same wall-clock date across a DST fall-back, pushing the same bucket key
  // twice (duplicated React keys and double-counted window cards).
  const spanEnd = dateKey(Date.now())
  for (const day = new Date(midnight(days - 1)); dateKey(day.getTime()) <= spanEnd; day.setDate(day.getDate() + 1)) {
    const time = day.getTime()
    const key = dateKey(time)
    result.push(byKey.get(key) ?? empty(key, time))
  }
  for (const point of points) if (!result.some(slot => slot.key === point.key)) result.push(point)
  return result.sort((a, b) => a.key.localeCompare(b.key))
}

/** Aggregate gateway usage into trend buckets with per-model slices.
 *  Per-turn records are the primary source: they are the only rows carrying
 *  the cache hit/miss split the tooltip needs. Turn rows frequently
 *  omit the display name (route_key like "logfare/gpt-5.6-terra-high" or an
 *  empty model), so `resolveModel` backfills names from the models endpoint
 *  and normalizes route keys; anything still nameless becomes "unknown".
 *  The daily timeline is the fallback (totals only), with the settled charges
 *  ledger reconciling cost when the trend reports none. */
/** One authoritative bucket from the gateway rollup. */
export interface GatewayRollupBucket { readonly time: number; readonly tokens: number; readonly requests: number; readonly cost: number }

/**
 * The window's complete bucket totals, taken from the endpoint's own rollup.
 *
 * `/agent/usage` returns `daily_trend` (settled per-day summaries plus the raw
 * rows those summaries have not absorbed) and `/dashboard/trend` returns the
 * same shape for the selected range. Only one of the two is read: they describe
 * the same days, so summing both would double every token. `daily_trend` wins
 * because it arrives with the per-request sample the model table pairs with.
 * @param gateway - the gateway snapshot as the Host delivered it.
 * @param hourly - `true` for the single-day window, which buckets by hour.
 * @returns buckets keyed the way {@link PointBuilder.admit} keys them.
 */
export function gatewayRollup(gateway: GatewaySnapshot, hourly: boolean): ReadonlyMap<string, GatewayRollupBucket> {
  const rows = (gateway.dailyTrend ?? []).length > 0 ? gateway.dailyTrend! : gateway.timeline ?? []
  const buckets = new Map<string, GatewayRollupBucket>()
  for (const value of rows) {
    const row = object(value)
    if (!row) continue
    const time = parseGatewayTime(row)
    if (!Number.isFinite(time)) continue
    const key = bucketKey(time, hourly)
    const current = buckets.get(key) ?? { time, tokens: 0, requests: 0, cost: 0 }
    // The daily rollup carries no `total_tokens` — the endpoint reports the
    // split and leaves the sum to the caller, which is why reading only
    // `total_tokens` showed a 4.7M-token month as "0 tokens".
    const split = get(row, 'total_input_tokens', 'input_tokens') + get(row, 'total_output_tokens', 'output_tokens') + get(row, 'total_cache_tokens', 'cache_creation_tokens') + get(row, 'cache_read_tokens')
    buckets.set(key, {
      time: current.time,
      tokens: current.tokens + (get(row, 'total_tokens', 'tokens') || split),
      requests: current.requests + get(row, 'total_requests', 'requests'),
      cost: current.cost + get(row, 'total_actual_cost', 'actual_cost', 'total_cost', 'cost'),
    })
  }
  return buckets
}

export function gatewayPoints(gateway: GatewaySnapshot, days: number, text: Pick<Copy, 'others' | 'unknown' | 'unattributed'>): UsagePoint[] {
  const hourly = days === 1
  const builder = new PointBuilder(hourly, text.unknown)
  // Name tables from the window-scoped models endpoint: id→name and
  // route_key→name, so turn rows without a model label still group under the
  // right model pill instead of collapsing into one unknown bucket.
  const byId = new Map<string, string>()
  for (const value of gateway.models ?? []) {
    const row = object(value)
    if (!row) continue
    const name = typeof row.model === 'string' ? row.model : typeof row.id === 'string' ? row.id : ''
    if (name === '') continue
    if (typeof row.id === 'string') byId.set(row.id, name)
    if (typeof row.route_key === 'string') byId.set(row.route_key, name)
    byId.set(name, name)
  }
  const resolveModel = (row: Record<string, unknown>): string => {
    for (const key of ['model', 'model_name', 'modelName'] as const) if (typeof row[key] === 'string' && (row[key]).trim() !== '') return byId.get(row[key]) ?? (row[key])
    const route = typeof row.route_key === 'string' ? row.route_key : typeof row.routeKey === 'string' ? row.routeKey : ''
    if (route !== '') {
      const direct = byId.get(route)
      if (direct !== undefined) return direct
      // Route keys look like "logfare/gpt-5.6-terra-high": strip the vendor
      // prefix and size/date suffixes to recover the catalog name.
      const tail = route.includes('/') ? route.slice(route.lastIndexOf('/') + 1) : route
      const stripped = tail.replace(/-(high|low|medium|thinking)$/i, '')
      return byId.get(stripped) ?? byId.get(tail) ?? tail
    }
    return ''
  }
  const rollup = gatewayRollup(gateway, hourly)
  const turns = (gateway.turns ?? []).filter(value => object(value) !== undefined)
  if (turns.length > 0) {
    for (const value of turns) {
      const row = object(value)
      if (!row) continue
      builder.admit(parseGatewayTime(row), resolveModel(row), get(row, 'total_tokens', 'tokens'), 1, get(row, 'actual_cost', 'cost'), { input: get(row, 'input_tokens'), output: get(row, 'output_tokens'), cacheRead: get(row, 'cache_read_tokens'), cacheWrite: get(row, 'cache_creation_tokens') })
    }
    if (!builder.hasCost) {
      for (const value of gateway.charges ?? []) {
        const row = object(value)
        if (!row) continue
        const cost = get(row, 'amountUSD', 'amount_usd', 'amount', 'actual_cost', 'cost')
        const time = parseGatewayTime(row)
        if (cost > 0 && Number.isFinite(time)) builder.admit(time, resolveModel(row), 0, 0, cost)
      }
    }
    // The turn sample is bounded, so it totals less than the window. The rollup
    // restores the real figures and names what the sample never covered.
    builder.reconcileTotals(rollup, text.unattributed)
    return fillWindow(builder.build(6, text), days, hourly)
  }
  // No per-turn sample at all: the rollup alone still fills the chart and every
  // window card, under one row that says the model was not reported.
  builder.reconcileTotals(rollup, text.unattributed)
  // Settlement-ledger reconciliation: some deployments report zeroed or empty
  // trend buckets while the charges ledger carries the real money path. Merging
  // only fires when the rollup lacks cost entirely, so healthy endpoints never
  // double count.
  if (!builder.hasCost) {
    for (const value of gateway.charges ?? []) {
      const row = object(value)
      if (!row) continue
      const cost = get(row, 'amountUSD', 'amount_usd', 'amount', 'actual_cost', 'cost')
      const time = parseGatewayTime(row)
      if (cost > 0 && Number.isFinite(time)) builder.admit(time, resolveModel(row), 0, builder.size === 0 ? 1 : 0, cost)
    }
  }
  return fillWindow(builder.build(6, text), days, hourly)
}

/** Zero-filled local trend across the snapshot's own window with per-model
 *  slices derived from the matrix (token splits come from the timeline). */
function localPoints(local: LocalSnapshot, text: Pick<Copy, 'others' | 'unknown'>): UsagePoint[] {
  const hourly = local.range.granularity === 'hour'
  // Timeline carries the per-bucket input/output/cache split; the matrix
  // refines it per model. Both are keyed by the same bucket key.
  const splitByBucket = new Map(local.timeline.map(item => [bucketKey(item.startAt, hourly), item]))
  const builder = new PointBuilder(hourly, text.unknown)
  for (const item of local.timeline) {
    builder.admit(item.startAt, '', item.totalTokens, item.attempts, 0, { input: item.inputTokens, output: item.outputTokens, cacheRead: item.cacheReadTokens, cacheWrite: item.cacheWriteTokens })
  }
  const matrix = new Map<string, UsageSlice[]>()
  for (const cell of local.matrix ?? []) {
    const key = bucketKey(cell.startAt, hourly)
    const list = matrix.get(key) ?? []
    const tokens = cell.totalTokens ?? 0
    if (tokens <= 0 && cell.attempts <= 0) continue
    const bucketSplit = splitByBucket.get(key)
    const share = bucketSplit !== undefined && bucketSplit.totalTokens > 0 ? tokens / bucketSplit.totalTokens : 1
    list.push({ model: cell.model, tokens, requests: cell.attempts, input: (bucketSplit?.inputTokens ?? 0) * share, output: (bucketSplit?.outputTokens ?? 0) * share, cacheRead: (bucketSplit?.cacheReadTokens ?? 0) * share, cacheWrite: (bucketSplit?.cacheWriteTokens ?? 0) * share, cost: 0 })
    matrix.set(key, list)
  }
  if (matrix.size > 0) {
    // Rebuild the plain builder output with per-model slices from the matrix.
    const rebuilt = new PointBuilder(hourly, text.unknown)
    const withModel = new Set(matrix.keys())
    for (const point of builder.build(Number.POSITIVE_INFINITY, text)) {
      const slices = matrix.get(point.key)
      if (slices === undefined) {
        if (withModel.has(point.key)) continue
        rebuilt.admit(point.startAt, '', point.tokens, point.requests, point.cost)
        continue
      }
      for (const slice of slices) rebuilt.admit(point.startAt, slice.model, slice.tokens, slice.requests, 0, slice)
    }
    return fillWindow(rebuilt.build(6, text), effectiveLocalDays(local), hourly)
  }
  return fillWindow(builder.build(6, text), effectiveLocalDays(local), hourly)
}

/** Day count the local snapshot covers (1 for hour granularity, else the span). */
function effectiveLocalDays(local: LocalSnapshot): number {
  if (local.range.granularity === 'hour') return 1
  return Math.max(1, Math.round((new Date(local.range.endAt).setHours(0, 0, 0, 0) - new Date(local.range.startAt).setHours(0, 0, 0, 0)) / 86_400_000) + 1)
}

/** Copy for both languages; keys stay identical so lookups never miss. */
function copy(language: 'zh' | 'en'): Copy {
  return language === 'zh' ? {
    title: 'Token 消耗', gateway: 'FreeCodeGo 网关账单', local: '本地 Harness 用量', balance: '账户余额', refreshBalance: '刷新余额', sessionCost: '本会话消耗',
    today: '今天', seven: '近 7 天', thirty: '近 30 天', rangeDays: days => `近 ${days} 天`,
    trend: '历史消耗趋势', daily: '每日消耗', details: '模型明细', requests: '请求', input: '输入', output: '输出', cache: '缓存读取', total: '总计', cost: '实际扣费', status: '状态',
    reported: '已上报', unreported: '未上报', loading: '读取中…', refresh: '刷新', noData: '暂无数据', loadError: '用量数据读取失败', fewer: '少', more: '多',
    signedOut: '登录 FreeCodeGo 账号后可查看网关账单与余额', window: '时间窗口', account: '账户范围', allModels: '全部', model: '模型', modelPillsMore: count => `另有 ${count} 个模型未显示为筛选胶囊（按消耗排行仅显示前 8 个）`, balanceOk: '余额充足', balanceLow: '余额偏低', balanceDanger: '余额告急',
    cacheHit: '输入（命中缓存）', cacheMiss: '输入（未命中缓存）', others: '其他模型', axisTitle: '每日消耗', axisTitleHour: '每小时消耗', unknown: '未知模型', unattributed: '未标注模型',
    cacheWasteTitle: '缓存失效归因', cacheWasteHint: '每一轮与同一会话的上一轮比较：上一轮已在 prompt 里、这一轮却没有从缓存读回的 token，就是被按全价重新计费的量。',
    cacheWasteClean: '本区间内没有超过断点粒度的缓存失效。', cacheWasteTokens: '重计费 token', cacheWasteMisses: '失效次数', cacheWasteCompared: '可比轮次',
    cacheWasteIdle: '空闲超过缓存 TTL', cacheWasteModel: '中途切换了模型', cacheWastePrefix: '请求前缀发生变化', cacheWasteWorst: '最严重的几次',
    cacheWasteUnpriced: '本区间没有价格信息，因此只统计 token，不编造金额。', cacheWasteNotReported: '当前模型不上报缓存字段，无法归因（“看不到”不等于“没有浪费”）。',
  } : {
    title: 'Token usage', gateway: 'FreeCodeGo gateway billing', local: 'Local Harness usage', balance: 'Account balance', refreshBalance: 'Refresh balance', sessionCost: 'This session',
    today: 'Today', seven: '7 days', thirty: '30 days', rangeDays: days => `${days} days`,
    trend: 'Usage trend', daily: 'Daily usage', details: 'Model details', requests: 'Requests', input: 'Input', output: 'Output', cache: 'Cache read', total: 'Total', cost: 'Actual cost', status: 'Status',
    reported: 'Reported', unreported: 'Unreported', loading: 'Loading…', refresh: 'Refresh', noData: 'No data', loadError: 'Failed to load usage data', fewer: 'Less', more: 'More',
    signedOut: 'Sign in to your FreeCodeGo account to view gateway billing and balance', window: 'Window', account: 'Account scope', allModels: 'All', model: 'Model', modelPillsMore: count => `${count} more models have no filter pill (the top 8 by usage are shown)`, balanceOk: 'Healthy', balanceLow: 'Low', balanceDanger: 'Critical',
    cacheHit: 'Input (cache hit)', cacheMiss: 'Input (cache miss)', others: 'Other models', axisTitle: 'Daily usage', axisTitleHour: 'Hourly usage', unknown: 'Unknown model', unattributed: 'Model not attributed',
    cacheWasteTitle: 'Why the cache missed', cacheWasteHint: 'Each turn is compared against the previous turn of the same session: tokens that were already in the prompt but were not read back from cache were re-billed at full price.',
    cacheWasteClean: 'No cache miss in this range exceeded the breakpoint noise floor.', cacheWasteTokens: 're-billed tokens', cacheWasteMisses: 'misses', cacheWasteCompared: 'comparable turns',
    cacheWasteIdle: 'idle past the cache TTL', cacheWasteModel: 'model switched mid-session', cacheWastePrefix: 'request prefix changed', cacheWasteWorst: 'Largest misses',
    cacheWasteUnpriced: 'No pricing in this range, so only tokens are counted — no dollar figure is invented.', cacheWasteNotReported: 'The current model reports no cache fields, so this cannot be attributed ("cannot see" is not "wasted nothing").',
  }
}

export type AccountBalance = { status: string; user?: { readonly balance: number } }
type SessionUsage = NonNullable<LocalSnapshot['currentSession']>

/** The remote-backed face this section is registered with. */
export interface TokenUsageDashboardInjected {
  readonly tokenUsageLocal: (query?: LocalTokenUsageQuery) => Promise<RemoteResult<LocalSnapshot>>
  readonly tokenUsageGateway: (days: number) => Promise<RemoteResult<GatewaySnapshot>>
  // `| undefined` is explicit because this package compiles with
  // `exactOptionalPropertyTypes`: a `?` seat is not the same type as one that
  // admits `undefined`, and the composed props hand these over as
  // `T | undefined`. The cast at the registration site was hiding exactly this.
  readonly tokenUsageCurrentSession?: ((sessionId: string) => Promise<RemoteResult<LocalSnapshot | undefined>>) | undefined
  readonly accountStatus?: (() => Promise<RemoteResult<AccountBalance>>) | undefined
  readonly sessionId?: string | undefined
  readonly language: 'zh' | 'en'
}

/**
 * Component props: exactly the face the registration injects.
 *
 * This component used to declare its props as an object literal at the
 * parameter, and the registration had to erase the type with
 * `as unknown as never` to make it fit — which silenced the check for *every*
 * prop, not only the missing ones. Removing the cast surfaced a real defect it
 * had been hiding: the component guards `sessionId === undefined` at the call
 * site, but declared the seat as `string`.
 *
 * The type is the inject face rather than the full `PropsRuntime<…>` because
 * this section reads none of the shell kit. A parameter type that is a
 * *supertype* of the composed props is assignable at the registration with no
 * cast, which is the property that matters here.
 */
export type TokenUsageDashboardProps = InjectFace<TokenUsageDashboardInjected>

export function TokenUsageDashboard({ tokenUsageLocal, tokenUsageGateway, tokenUsageCurrentSession, accountStatus, sessionId, language }: TokenUsageDashboardProps): ReactNode {
  const text = copy(language)
  const [source, setSource] = useState<'gateway' | 'local'>('gateway')
  const [days, setDays] = useState(30)
  const [local, setLocal] = useState<LocalSnapshot>()
  const [gateway, setGateway] = useState<GatewaySnapshot>()
  const [session, setSession] = useState<SessionUsage>()
  const [balance, setBalance] = useState<AccountBalance>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Bumped by the panel's own refresh control. Both snapshot effects depend on
  // it, so the ledger (or the gateway) and the current session are re-read
  // without switching windows to force it.
  const [refresh, setRefresh] = useState(0)
  const [modelFilter, setModelFilter] = useState('all')
  const [balanceTick, setBalanceTick] = useState(0)
  const maxDays = source === 'gateway' ? GATEWAY_WINDOW_MAX : LOCAL_WINDOW_MAX
  const effectiveDays = Math.min(days, maxDays)
  const isLocal = source === 'local'

  useEffect(() => {
    if (accountStatus === undefined) return
    let active = true
    void accountStatus().then((result) => { if (active && result.ok) setBalance(result.value) }).catch(() => undefined)
    return () => { active = false }
  }, [accountStatus, balanceTick])

  useEffect(() => {
    if (tokenUsageCurrentSession === undefined || sessionId === undefined || sessionId === '') return
    let active = true
    void tokenUsageCurrentSession(sessionId).then((result) => {
      if (active && result.ok && result.value?.currentSession !== undefined) setSession(result.value.currentSession)
    }).catch(() => undefined)
    return () => { active = false }
  }, [tokenUsageCurrentSession, sessionId, refresh])

  // Per-window snapshot cache: switching timeline pills re-renders instantly
  // from the cached window (stale-while-revalidate) instead of staring at an
  // empty chart while the gateway round-trips.
  const cacheRef = useRef(new Map<string, { local?: LocalSnapshot; gateway?: GatewaySnapshot }>())

  useEffect(() => {
    let active = true
    const cached = cacheRef.current.get(`${isLocal ? 'local' : 'gateway'}:${effectiveDays}`)
    const hasData = isLocal ? cached?.local !== undefined : cached?.gateway !== undefined
    // Stale-while-revalidate is per window: the seat takes this window's own
    // cached snapshot on a hit, and a miss clears it instead of leaving the
    // previous window's series rendered under the new window's label. Reading
    // the cache only to decide `busy` (without seeding or clearing) made every
    // range switch show the old window's totals until the fetch landed, and —
    // the worse half — a cache hit render the window that *replaced* it.
    if (isLocal) setLocal(cached?.local)
    else setGateway(cached?.gateway)
    if (!hasData) {
      setBusy(true)
      setError(undefined)
    }
    const fail = (reason: unknown): void => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }
    const query = { startAt: localRangeStart(effectiveDays), endAt: Date.now(), granularity: effectiveDays === 1 ? 'hour' as const : 'day' as const }
    const work = isLocal ? tokenUsageLocal(query).then((result) => { if (result.ok) { cacheRef.current.set(`local:${effectiveDays}`, { ...cacheRef.current.get(`local:${effectiveDays}`), local: result.value }); setLocal(result.value) } else if (!hasData) setError(result.error.message) })
      : tokenUsageGateway(effectiveDays).then((result) => { if (result.ok) { cacheRef.current.set(`gateway:${effectiveDays}`, { ...cacheRef.current.get(`gateway:${effectiveDays}`), gateway: result.value }); setGateway(result.value) } else if (!hasData) setError(result.error.message) })
    void work.catch(fail).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [isLocal, effectiveDays, refresh, tokenUsageLocal, tokenUsageGateway])

  const rows: UsageRow[] = useMemo(() => {
    if (isLocal) {
      return (local?.routes ?? []).map(row => ({ model: row.model, provider: row.provider, requests: row.attempts, tokens: row.totalTokens, input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens, cost: 0, reported: row.totalTokens > 0 })).sort((a, b) => b.tokens - a.tokens)
    }
    const modelled = (gateway?.models ?? []).flatMap((value) => {
      const row = object(value)
      if (!row) return []
      // The per-model rollup keeps a row per model, and a request that arrived
      // without one lands in a blank-named row. Rendering that raw would put an
      // empty cell in the table beside the unattributed remainder, so it takes
      // the same localized label the chart slices use.
      const model = typeof row.model === 'string' && row.model.trim() !== '' ? row.model : typeof row.id === 'string' && row.id.trim() !== '' ? row.id : text.unknown
      const provider = typeof row.provider === 'string' ? row.provider : typeof row.platform === 'string' ? row.platform : 'FreeCodeGo'
      return [{ model, provider, requests: get(row, 'requests', 'total_requests'), tokens: get(row, 'total_tokens', 'tokens'), input: get(row, 'input_tokens', 'total_input_tokens'), output: get(row, 'output_tokens', 'total_output_tokens'), cacheRead: get(row, 'cache_read_tokens', 'total_cache_read_tokens'), cacheWrite: get(row, 'cache_creation_tokens', 'total_cache_creation_tokens'), cost: get(row, 'actual_cost', 'cost', 'total_actual_cost'), reported: true }]
    }).sort((a, b) => b.tokens - a.tokens)
    // A blank row shares the chart's unknown label, so it must not materialise
    // twice: the rollup carries one row per model, not per display label.
    const merged = [...new Map(modelled.map(row => [`${row.provider}\u0000${row.model}`, row])).values()]
    // The model endpoint reads raw request rows only, so a day the backend has
    // already settled into `usage_daily_summaries` contributes tokens that no
    // model row can name — which is why the table could sit at `0 tokens`
    // underneath a 4.7M-token chart. Those tokens get one explicit row instead
    // of disappearing.
    const rollup = gateway === undefined
      ? undefined
      : [...gatewayRollup(gateway, false).values()].reduce(
        (acc, bucket) => ({ tokens: acc.tokens + bucket.tokens, requests: acc.requests + bucket.requests }),
        { tokens: 0, requests: 0 },
      )
    const attributed = merged.reduce((sum, row) => sum + row.tokens, 0)
    // `undefined` means the Host sent no rollup at all, so there is no remainder
    // to name — only a rollup larger than its model rows leaves one.
    if (rollup === undefined || rollup.tokens - attributed <= 0) return merged
    const missing = rollup.tokens - attributed
    return [...merged, {
      model: text.unattributed,
      provider: '',
      requests: Math.max(0, rollup.requests - merged.reduce((sum, row) => sum + row.requests, 0)),
      tokens: missing,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      reported: true,
    }].sort((a, b) => b.tokens - a.tokens)
  }, [isLocal, local, gateway, text.unattributed, text.unknown])

  // Stacked-series derivation: identical for both sources so the local and
  // gateway timelines are always the same shape and semantics.
  const points: UsagePoint[] = useMemo(() => {
    if (isLocal) return local === undefined ? [] : localPoints(local, text)
    return gateway === undefined ? [] : gatewayPoints(gateway, effectiveDays, text)
  }, [isLocal, local, gateway, effectiveDays, text])

  // Filter pills: named models ranked by total tokens across the window.
  // Nameless traffic (the "unknown" rollup) never gets a pill — it stays a
  // tooltip row only, so a single unnamed bucket doesn't clutter the header.
  const rankedModels = useMemo(() => {
    const totals = new Map<string, number>()
    for (const point of points) for (const slice of point.slices) if (slice.model !== text.others) totals.set(slice.model, (totals.get(slice.model) ?? 0) + slice.tokens)
    return [...totals.entries()]
      .filter(([name, tokens]) => tokens > 0 && name !== text.unknown && name !== text.unattributed && !/^unknown-model$/i.test(name))
      .sort((a, b) => b[1] - a[1]).map(([model]) => model)
  }, [points, text.others, text.unknown, text.unattributed])
  // The pill row is a top-N ranking, but the selected model has to stay in it.
  // Changing the window or the data source can push it past the cap; dropping
  // the pill used to reset `activeFilter` to "all" silently, so the chart and
  // the model name under the total disagreed with the choice the user made.
  const modelNames = useMemo(() => {
    const top = rankedModels.slice(0, MODEL_PILL_LIMIT)
    return modelFilter !== 'all' && !top.includes(modelFilter) && rankedModels.includes(modelFilter) ? [...top, modelFilter] : top
  }, [rankedModels, modelFilter])
  const activeFilter = modelFilter !== 'all' && modelNames.includes(modelFilter) ? modelFilter : 'all'

  // Window cards in the reference layout: fixed today/7d/30d cards plus one
  // card for the selected range. Fixed cards whose window equals the selected
  // range are dropped so labels (and React keys) never repeat.
  // The selected-window card follows the reconciled trend on both tabs. It used
  // to prefer the gateway model table, which reads raw request rows only: once
  // the backend settled a day into `usage_daily_summaries`, the table held a
  // fraction of the window and the card printed `0 tokens` beside a 4.7M-token
  // chart. The table stays the fallback for a Host that sends turns with no
  // rollup at all, where it is still the only total available.
  const rangeTotals = useMemo((): { tokens: number; requests: number; cost: number } => {
    const fromPoints = { tokens: points.reduce((sum, point) => sum + point.tokens, 0), requests: points.reduce((sum, point) => sum + point.requests, 0), cost: points.reduce((sum, point) => sum + point.cost, 0) }
    // The reconciled series is the complete one, so the window card follows it.
    // The model table stays as the fallback for a Host that sends turns without
    // a rollup, which is the only case where it used to be the better total.
    if (isLocal || fromPoints.tokens > 0 || fromPoints.requests > 0 || fromPoints.cost > 0) return fromPoints
    return rows.reduce((acc, row) => ({ tokens: acc.tokens + row.tokens, requests: acc.requests + row.requests, cost: acc.cost + row.cost }), { tokens: 0, requests: 0, cost: 0 })
  }, [isLocal, rows, points])
  // Cache waste is a local-ledger fact: the gateway endpoint reports billing
  // totals, not per-turn request prefixes, so it stays absent on that tab
  // rather than being shown as zero.
  const cacheWaste = isLocal ? local?.totals.cacheWaste : undefined
  const rangeLabel = text.rangeDays(effectiveDays)
  const cardFloors: readonly (readonly [string, string])[] = [
    [text.today, dateKey(midnight())],
    ...(effectiveDays === 7 ? [] : [[text.seven, dateKey(midnight(6))] as const]),
    ...(effectiveDays === 30 ? [] : [[text.thirty, dateKey(midnight(29))] as const]),
    [rangeLabel, ''],
  ]
  const cards = cardFloors.map(([label, floor]) => {
    if (floor === '') return { label, ...rangeTotals }
    const picked = points.filter(point => point.key >= floor)
    return { label, tokens: picked.reduce((sum, point) => sum + point.tokens, 0), requests: picked.reduce((sum, point) => sum + point.requests, 0), cost: picked.reduce((sum, point) => sum + point.cost, 0) }
  })
  const providerOf = useCallback((model: string): string => rows.find(row => row.model === model)?.provider ?? '', [rows])
  // One palette for the whole card: the filter pills, the chart legend and the
  // stacked segments must agree, so the hues are resolved once here over every
  // model a pill can offer. Resolving only the top few would let a model's pill
  // show the vendor blue while its segment sits on a nudged hue.
  const seriesColors = useMemo(() => seriesPalette(modelNames, providerOf), [modelNames, providerOf])
  // The unattributed rollup is a remainder, not a vendor: it keeps the neutral
  // series colour so it never reads as one more model in the legend.
  const colorOf = useCallback((model: string): string => model === text.unattributed ? OTHER_SERIES_COLOR : seriesColors.get(model) ?? brandColor(model, providerOf(model)), [seriesColors, providerOf, text.unattributed])

  const balanceValue = balance?.user?.balance
  const balanceLevel = balanceValue === undefined ? undefined : balanceValue > 5 ? 'ok' : balanceValue > 1 ? 'low' : 'danger'
  const balanceLabel = balanceLevel === undefined ? undefined : balanceLevel === 'ok' ? text.balanceOk : balanceLevel === 'low' ? text.balanceLow : text.balanceDanger
  // Non-available gateway states other than signed-out (whose hint the balance
  // strip already shows) must state why the page is empty instead of rendering
  // a silent zero.
  const gatewayNotice = !isLocal && gateway !== undefined && gateway.status !== 'available' && gateway.status !== 'signed-out' ? gateway.message ?? text.noData : undefined

  const dailyAverage = Math.round(rangeTotals.tokens / Math.max(1, effectiveDays))
  // Chart sums for the active model filter, so the headline and the totals
  // strip below the chart always agree with the bars on screen.
  const activeTotals = useMemo(() => points.reduce((sum, point) => {
    const value = heatValue(point, activeFilter)
    return { tokens: sum.tokens + value.tokens, requests: sum.requests + value.requests, cost: sum.cost + value.cost }
  }, { tokens: 0, requests: 0, cost: 0 }), [points, activeFilter])
  const headlineTokens = activeFilter === 'all' ? rangeTotals.tokens : activeTotals.tokens

  // The chart measures its own width so bars spread edge-to-edge at any panel
  // size and stay dense when the window is long.
  const [chartWidth, setChartWidth] = useState(0)
  const chartNode = useMemo(() => {
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width > 0) setChartWidth(width)
    })
    return (node: HTMLElement | null): void => {
      if (node === null) { observer?.disconnect(); return }
      setChartWidth(node.clientWidth)
      observer?.observe(node)
    }
  }, [])

  return <section className={css.root}>
    {error === undefined ? null : <div className={css.alert} role="alert">{text.loadError}: {error}</div>}
    <header className={css.tokenHero}>
      <div>
        <div className={css.tokenEyebrow}><span className={css.tokenPulse} /> TOKEN USAGE</div>
        <h2 className={css.tokenTitle}>{text.title}</h2>
      </div>
      <div className={css.tokenSourceTabs} role="tablist">
        <button className={!isLocal ? css.tokenSourceActive : ''} type="button" role="tab" aria-selected={!isLocal} onClick={() => { setSource('gateway') }}>{text.gateway}</button>
        <button className={isLocal ? css.tokenSourceActive : ''} type="button" role="tab" aria-selected={isLocal} onClick={() => { setSource('local') }}>{text.local}</button>
      </div>
    </header>

    {/* Balance strip is a gateway-billing affordance (image 2); the local tab
        states session usage instead, so it only renders on the gateway tab. */}
    {!isLocal ? <div className={css.tokenBalRow} data-empty={balanceValue === undefined}>
      {balanceValue === undefined ? <span className={css.tokenBalHint}>{text.signedOut}</span>
        : <>
          <span className={css.tokenBalDot} data-level={balanceLevel} />
          <span className={css.tokenBalAmount}>{money(balanceValue)}</span>
          <span className={css.tokenBalBadge} data-level={balanceLevel}>{balanceLabel}</span>
          <span className={css.tokenBalUpdated}>{text.balance}</span>
        </>}
      <button className={css.tokenBalRefresh} type="button" onClick={() => { setBalanceTick(value => value + 1) }}>{text.refreshBalance}</button>
    </div> : null}

    {gatewayNotice === undefined ? null : <div className={css.tokenNotice} role="status">{gatewayNotice}</div>}

    {session !== undefined && session.totalTokens > 0 ? <div className={css.tokenSessionRow}>
      <span>{text.sessionCost}</span>
      <strong>{compact(session.totalTokens, language)} tokens</strong>
    </div> : null}

    {/* Where the input tokens went. A large input total is produced both by
        more work and by the same work being re-sent at full price, and the two
        call for opposite responses, so the ledger names which one happened. */}
    {cacheWaste === undefined ? null : <section className={css.tokenCacheWaste}>
      <div className={css.tokenCacheWasteHead}>
        <span className={css.tokenPanelKicker}>CACHE</span>
        <strong>{text.cacheWasteTitle}</strong>
      </div>
      {cacheWaste.missedTokens === 0 ? <div className={css.tokenCacheWasteClean}>{text.cacheWasteClean}</div>
        : <>
          <div className={css.tokenCacheWasteStats}>
            <div className={css.tokenCacheWasteStat} data-tone="warn">
              <span>{text.cacheWasteTokens}</span>
              <b>{compact(cacheWaste.missedTokens, language)}</b>
            </div>
            <div className={css.tokenCacheWasteStat}>
              <span>{text.cacheWasteMisses}</span>
              <b>{cacheWaste.missCount.toLocaleString()}</b>
            </div>
            <div className={css.tokenCacheWasteStat}>
              <span>{text.cacheWasteCompared}</span>
              <b>{cacheWaste.comparedTurns.toLocaleString()}</b>
            </div>
          </div>
          <div className={css.tokenCacheWasteCauses}>
            {([['idle-gap', text.cacheWasteIdle], ['model-changed', text.cacheWasteModel], ['prefix-changed', text.cacheWastePrefix]] as const)
              .filter(([cause]) => (cause === 'idle-gap' ? cacheWaste.byCause.idleGap : cause === 'model-changed' ? cacheWaste.byCause.modelChanged : cacheWaste.byCause.prefixChanged) > 0)
              .map(([cause, label]) => {
                const count = cause === 'idle-gap' ? cacheWaste.byCause.idleGap : cause === 'model-changed' ? cacheWaste.byCause.modelChanged : cacheWaste.byCause.prefixChanged
                return <span className={css.tokenCacheWasteCause} data-cause={cause} key={cause}><b>{count}</b> {label}</span>
              })}
          </div>
          <ul className={css.tokenCacheWasteWorst}>
            <li className={css.tokenCacheWasteWorstHead}>{text.cacheWasteWorst}</li>
            {cacheWaste.worst.map(miss => <li key={`${miss.at}-${miss.model}-${miss.missedTokens}`}>
              <span className={css.tokenCacheWasteWorstModel}>{visibleModel(miss.model)}</span>
              <span className={css.tokenCacheWasteWorstTokens}>{full(miss.missedTokens)}</span>
              <span className={css.tokenCacheWasteWorstCause} data-cause={miss.cause}>
                {miss.cause === 'idle-gap' ? text.cacheWasteIdle : miss.cause === 'model-changed' ? text.cacheWasteModel : text.cacheWastePrefix}
              </span>
            </li>)}
          </ul>
        </>}
      <div className={css.tokenCacheWasteFoot}>{cacheWaste.pricedTurns === 0 ? text.cacheWasteUnpriced : `${money(cacheWaste.missedCostUsd)} · ${cacheWaste.pricedTurns.toLocaleString()} ${text.cacheWasteCompared}`}</div>
      <p className={css.tokenCacheWasteHint}>{text.cacheWasteHint}</p>
    </section>}

    <div className={css.tokenSummaryGrid}>
      {cards.map(card => <div className={css.tokenMetric} key={card.label}>
        <span>{card.label}</span>
        <strong>{isLocal ? compact(card.tokens, language) : money(card.cost)}</strong>
        <small>{isLocal ? `${card.requests.toLocaleString()} ${text.requests}` : `${compact(card.tokens, language)} tokens`}</small>
      </div>)}
    </div>

    <section className={css.tokenPanel}>
      <div className={css.tokenPanelHeader}>
        <div className={css.tokenPanelTitle}>
          <span className={css.tokenPanelKicker}>USAGE TREND</span>
          <strong>{text.trend}</strong>
        </div>
        <div className={css.tokenRangePills}>
          {[1, 7, 30, 90].filter(value => value <= maxDays).map(value => <button key={value} type="button" className={effectiveDays === value ? css.tokenRangeActive : ''} onClick={() => { setDays(value) }}>{value === 1 ? text.today : text.rangeDays(value)}</button>)}
          {maxDays > 90 ? <button type="button" className={effectiveDays === LOCAL_WINDOW_MAX ? css.tokenRangeActive : ''} onClick={() => { setDays(LOCAL_WINDOW_MAX) }}>{text.rangeDays(LOCAL_WINDOW_MAX)}</button> : null}
        </div>
        {/* The copy for this control shipped in both locales before anything
            rendered it, and the effects always listed `refresh` as a
            dependency: the only way to re-read the ledger was to switch a range
            pill off and back. Held to the selected window, so a refresh
            re-reads the window on screen rather than jumping anywhere. */}
        <button className={css.tokenBalRefresh} type="button" onClick={() => { setRefresh(value => value + 1) }}>{text.refresh}</button>
      </div>
      {modelNames.length === 0 ? null : <div className={css.tokenHeatFilter} role="group" aria-label={text.model}>
        <span className={css.tokenHeatFilterLabel}>{text.model}</span>
        {['all', ...modelNames].map((name) => {
          const style = name === 'all' ? undefined : { '--model-color': colorOf(name) } as CSSProperties
          return <button key={name} type="button" title={name} style={style} className={activeFilter === name ? css.tokenHeatFilterBtnActive : css.tokenHeatFilterBtn} onClick={() => { setModelFilter(name) }}>
            {name === 'all' ? null : <i className={css.tokenPillDot} style={style} aria-hidden />}
            {name === 'all' ? text.allModels : visibleModel(name)}
          </button>
        })}
        {rankedModels.length > modelNames.length ? <span style={{ color: 'var(--fcg-text-tertiary)', fontSize: 'var(--fcg-font-caption)' }} title={text.modelPillsMore(rankedModels.length - modelNames.length)}>+{rankedModels.length - modelNames.length}</span> : null}
      </div>}
      <div className={css.tokenChartHead}>
        <span className={css.tokenChartTitle}>{effectiveDays === 1 ? text.axisTitleHour : text.axisTitle}</span>
        <b className={css.tokenChartTotal}>{full(headlineTokens)} tokens</b>
        {activeFilter === 'all' ? null : <span className={css.tokenChartModel} style={{ '--model-color': colorOf(activeFilter) } as CSSProperties}>{visibleModel(activeFilter)}</span>}
      </div>
      {points.length === 0 ? <div className={css.tokenEmpty}>{busy ? text.loading : text.noData}</div>
        : <TrendChart points={points} filter={activeFilter} language={language} text={text} width={chartWidth} setNode={chartNode} colors={seriesColors} />}
      {points.length === 0 ? null : <div className={css.tokenHeatTotals}>
        <span><b>{full(activeFilter === 'all' ? rangeTotals.tokens : activeTotals.tokens)}</b> tokens</span>
        <span><b>{full(activeFilter === 'all' ? rangeTotals.requests : activeTotals.requests)}</b> {text.requests}</span>
        {!isLocal ? <span><b>{money(rangeTotals.cost)}</b> {text.cost}</span> : null}
        <span className={css.tokenHeatDaily}>{text.daily} <b>{compact(dailyAverage, language)}</b> tokens</span>
      </div>}
    </section>

    <section className={css.tokenPanel}>
      <div className={css.tokenPanelHeader}>
        <div className={css.tokenPanelTitle}>
          <span className={css.tokenPanelKicker}>MODEL DETAILS</span>
          <strong>{text.details}</strong>
        </div>
      </div>
      <div className={css.tokenModelBars}>
        {rows.slice(0, 6).map(row => <div className={css.tokenModelBarRow} key={`${row.provider}:${row.model}`} style={{ '--model-color': colorOf(row.model) } as CSSProperties}>
          <span className={css.tokenModelBarName} title={`${visibleProvider(row.provider)} · ${visibleModel(row.model)}`}>{visibleModel(row.model)}</span>
          <div className={css.tokenModelBarTrack}><i style={{ width: `${Math.max(2, Math.round((row.tokens / Math.max(1, rows[0]?.tokens ?? 1)) * 100))}%` }} /></div>
          <b>{isLocal ? compact(row.tokens, language) : money(row.cost)}</b>
        </div>)}
        {rows.length === 0 ? <p className={css.tokenEmpty}>{busy ? text.loading : text.noData}</p> : null}
      </div>
      <div className={css.tokenGatewayTable}>
        <table className={css.pricingTable}>
          <thead><tr><th>{language === 'zh' ? '模型' : 'Model'}</th><th>{text.input}</th><th>{text.output}</th><th>{text.cache}</th><th>{text.total}</th><th>{isLocal ? text.status : text.cost}</th></tr></thead>
          <tbody>
            {rows.map(row => <tr key={`${row.provider}:${row.model}`}>
              <td><strong><i className={css.tokenModelDot} style={{ '--model-color': colorOf(row.model) } as CSSProperties} />{visibleModel(row.model)}</strong><small>{visibleProvider(row.provider)}</small></td>
              <td>{compact(row.input, language)}</td>
              <td>{compact(row.output, language)}</td>
              <td>{compact(row.cacheRead, language)}</td>
              <td>{compact(row.tokens, language)}</td>
              <td>{isLocal ? row.reported ? text.reported : text.unreported : money(row.cost)}</td>
            </tr>)}
            {rows.length === 0 ? <tr><td className={css.pricingEmpty} colSpan={6}>{busy ? text.loading : text.noData}</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  </section>
}

/** Filter-aware day value: 'all' uses the bucket totals, a named model uses
 *  just that model's slices — the same contract the reference grid follows. */
function heatValue(point: UsagePoint, filter: string): { tokens: number; requests: number; cost: number } {
  if (filter === 'all') return { tokens: point.tokens, requests: point.requests, cost: point.cost }
  const picked = point.slices.filter(slice => slice.model === filter)
  return { tokens: picked.reduce((sum, slice) => sum + slice.tokens, 0), requests: picked.reduce((sum, slice) => sum + slice.requests, 0), cost: picked.reduce((sum, slice) => sum + slice.cost, 0) }
}

/** Cache hit/miss/output aggregates for the hovered bucket, filter-aware. */
function heatSplit(point: UsagePoint, filter: string): { hit: number; miss: number; output: number } | undefined {
  const slices = filter === 'all' ? point.slices : point.slices.filter(slice => slice.model === filter)
  const hit = slices.reduce((sum, slice) => sum + slice.cacheRead, 0)
  const gross = slices.reduce((sum, slice) => sum + slice.input, 0)
  const output = slices.reduce((sum, slice) => sum + slice.output, 0)
  return hit === 0 && gross === 0 && output === 0 ? undefined : { hit, miss: Math.max(0, gross - hit), output }
}

/** Chart geometry: plot height; the axis strip adds its own 20px row, and the
 *  left gutter holds the console's magnitude rail. */
const CHART_HEIGHT = 220
const CHART_GUTTER = 46

/** A bar can only show `height / count` pixels per segment. Holding the 5px
 *  floor on a short bar would push the upper models past the cap and clip them
 *  into the bar's own colour, so the floor yields instead: every model keeps a
 *  sliver and the stack still ends up flush. */
function segmentFloorOf(height: number, count: number): number {
  if (count <= 0) return MIN_SEGMENT
  return Math.min(MIN_SEGMENT, Math.max(1, height / count))
}

/** Tooltip placement: above the hovered bar when there is room, otherwise
 *  beside it on whichever side is free — the chart never lets a tall bar hide
 *  behind its own tooltip the way a top-pinned tooltip would. */
function tipPlacement(anchor: number, bar: number, barTop: number, tipWidth: number, tipHeight: number, width: number): { left: number; top: number } {
  const clamp = (value: number): number => Math.min(Math.max(0, value), Math.max(0, width - tipWidth - 4))
  if (barTop - tipHeight - 12 >= 6) return { left: clamp(anchor - tipWidth / 2), top: barTop - tipHeight - 12 }
  const besideLeft = anchor - bar / 2 - 10 - tipWidth
  return {
    left: besideLeft >= 0 ? besideLeft : clamp(anchor + bar / 2 + 10),
    top: Math.max(6, Math.min(CHART_HEIGHT - tipHeight - 6, barTop - tipHeight / 2)),
  }
}

/** Round the axis top to a two-significant-digit magnitude so the rail reads
 *  like the console's (1.2B / 2.4B) instead of an arbitrary raw count. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = value / power
  const rounded = step <= 1 ? 1 : step <= 1.2 ? 1.2 : step <= 1.5 ? 1.5 : step <= 2 ? 2 : step <= 2.5 ? 2.5 : step <= 3 ? 3 : step <= 4 ? 4 : step <= 5 ? 5 : step <= 6 ? 6 : step <= 8 ? 8 : 10
  return rounded * power
}

/** DeepSeek-console usage chart: a magnitude rail in a left gutter, thin
 *  opaque bars whose three-tone stack mirrors the console's token split
 *  (cache hit → cache miss → output), a hover crosshair, and the console's
 *  dark tooltip — date + exact total headline, then the split rows, then one
 *  row per model. All data arrives resolved in `points`. */
function TrendChart({ points, filter, language, text, width, setNode, colors }: {
  readonly points: readonly UsagePoint[]
  readonly filter: string
  readonly language: 'zh' | 'en'
  readonly text: Copy
  readonly width: number
  readonly setNode: (node: HTMLElement | null) => void
  readonly colors: ReadonlyMap<string, string>
}): ReactNode {
  const [hover, setHover] = useState<number>()
  const hourly = points[0] !== undefined && points[0].key.includes(':')
  // Filtering keeps only the selected model's slices; the "others" rollup is
  // a display bucket and must not leak into a filtered view.
  const values = points.map(point => heatValue(point, filter))
  // Series are ranked across the whole window rather than per bucket, so the
  // legend keeps one stable colour per model and a ranking shift mid-window
  // cannot recolor a bar — the reference chart's contract. Models past the top
  // N fold into a single "others" segment.
  const ranked = useMemo(() => {
    const totals = new Map<string, number>()
    for (const point of points) {
      for (const slice of filter === 'all' ? point.slices : point.slices.filter(item => item.model === filter)) totals.set(slice.model, (totals.get(slice.model) ?? 0) + slice.tokens)
    }
    const names = [...totals.entries()].filter(([, tokens]) => tokens > 0).sort((left, right) => right[1] - left[1]).map(([name]) => name)
    const keep = names.slice(0, MAX_STACK_SERIES)
    return { keep, names: names.length > keep.length ? [...keep, text.others] : keep }
  }, [points, filter, text.others])
  const seriesList = useMemo(() => ranked.names.map(name => ({ name, color: colors.get(name) ?? OTHER_SERIES_COLOR })), [ranked, colors])
  const stackSegments = useMemo(() => (point: UsagePoint) => {
    const grouped = new Map<string, number>()
    for (const slice of filter === 'all' ? point.slices : point.slices.filter(item => item.model === filter)) {
      const key = ranked.keep.includes(slice.model) ? slice.model : text.others
      grouped.set(key, (grouped.get(key) ?? 0) + slice.tokens)
    }
    return seriesList.map(series => ({ ...series, tokens: grouped.get(series.name) ?? 0 }))
  }, [ranked, seriesList, filter, text.others])
  // Console rail: the top line sits on a rounded magnitude, the middle on
  // half of it, plus the zero baseline. An empty window keeps only the
  // baseline so the chart never advertises a fake 0.5/1 scale.
  const rawMax = Math.max(0, ...values.map(value => value.tokens))
  const max = niceMax(rawMax)
  const gridLines = rawMax > 0
    ? [{ fraction: 1, label: compact(max, language) }, { fraction: 0.5, label: compact(max / 2, language) }, { fraction: 0, label: '0' }]
    : [{ fraction: 0, label: '0' }]
  // Bars live to the right of the rail gutter; the rail itself spans the
  // full plot width exactly like the console's gridlines do.
  const plotWidth = Math.max(48, width - CHART_GUTTER)
  const slot = width > 0 && points.length > 0 ? plotWidth / points.length : 0
  // Console density: bars stay thin against their slot so the staircase reads
  // like the reference — 2px floor, never wider than half the slot.
  const bar = Math.max(2, Math.min(slot * 0.55, 18))
  const gap = Math.max(1, slot - bar)
  const plotHeight = (tokens: number): number => Math.round(tokens / max * (CHART_HEIGHT - 24))
  const hoveredIndex = hover === undefined || hover >= points.length ? undefined : hover
  const hovered = hoveredIndex === undefined ? undefined : { point: points[hoveredIndex]!, value: values[hoveredIndex]! }
  const split = hovered === undefined ? undefined : heatSplit(hovered.point, filter)
  const stacked = hovered === undefined ? [] : stackSegments(hovered.point).filter(segment => segment.tokens > 0)
  // Tooltip hugs the cap of the bar it names (flipping inside the plot when
  // that bar is tall) and stays clamped horizontally inside the panel.
  const tipWidth = 268
  const tipRows = (split === undefined ? 0 : (split.hit > 0 ? 1 : 0) + (split.miss > 0 ? 1 : 0) + (split.output > 0 ? 1 : 0)) + stacked.length + 1 + (hovered !== undefined && hovered.value.cost > 0 ? 1 : 0)
  const tipHeight = 26 + tipRows * 17
  const tip = hovered === undefined || slot === 0
    ? { left: 0, top: 0 }
    : tipPlacement(CHART_GUTTER + (hoveredIndex ?? 0) * slot + bar / 2, bar, CHART_HEIGHT - plotHeight(hovered.value.tokens), tipWidth, tipHeight, width)
  const headLabel = hovered === undefined ? '' : hourly ? `${hovered.point.key.slice(5, 10)} ${hovered.point.key.slice(11)}:00–${hovered.point.key.slice(11)}:59` : hovered.point.key
  return <div className={css.tokenChartWrap}>
    <div className={css.tokenChartPlot} ref={setNode} style={{ height: CHART_HEIGHT }} onPointerLeave={() => { setHover(undefined) }}>
      {gridLines.map(line => <div key={line.fraction} className={css.tokenChartGrid} style={{ bottom: (CHART_HEIGHT - 24) * line.fraction }}>
        <span>{line.label}</span>
      </div>)}
      {hoveredIndex === undefined || slot === 0 ? null : <div className={css.tokenChartCross} style={{ left: CHART_GUTTER + hoveredIndex * slot + gap / 2 - 1, width: Math.max(6, slot) }} />}
      {points.map((point, index) => {
        const value = values[index]!
        const visible = value.tokens > 0 || value.requests > 0 || value.cost > 0
        const height = plotHeight(value.tokens)
        const left = slot > 0 ? CHART_GUTTER + index * slot + gap / 2 : CHART_GUTTER
        // One segment per model, positioned inside the bar by the ported
        // visual layout so tiny models keep their minimum height and the stack
        // still fills the bar exactly. The layout helper works in chart
        // coordinates fed by the segment's own box and the value stacked
        // below it, so both are derived from the token scale here.
        const segments = stackSegments(point)
        const segmentValues = segments.map(segment => segment.tokens)
        const pxPerToken = value.tokens > 0 ? height / value.tokens : 0
        const segmentFloor = segmentFloorOf(height, segments.filter(segment => segment.tokens > 0).length)
        let below = 0
        const layouts = segments.map((segment, stackIndex) => {
          const segmentHeight = segment.tokens * pxPerToken
          const layout = pxPerToken > 0
            ? getStackedSegmentVisualLayout({ values: segmentValues, segmentIndex: stackIndex, segmentHeight, segmentY: height - segmentHeight - below * pxPerToken, stackStart: below, minHeight: segmentFloor })
            : null
          below += segment.tokens
          return { segment, layout }
        })
        // Snap the stack to whole pixels so two neighbours share one edge and
        // no device-pixel seam can show the bar's own fill between them.
        const snapped = layouts.map(({ layout }) => Math.round(layout?.height ?? 0))
        let drift = height - snapped.reduce((sum, value) => sum + value, 0)
        // Rounding short: the tallest segment grows. Rounding long: it shrinks,
        // but never past its 1px share — a segment snapped to zero would delete
        // a model's colour outright, and on a four-pixel bar that is exactly
        // what happens to the biggest model. Surplus is left for the bar's own
        // clip, which can only ever trim the cap.
        while (drift > 0 && snapped.some(value => value > 0)) {
          const tallest = snapped.indexOf(Math.max(...snapped))
          snapped[tallest] = (snapped[tallest] ?? 0) + 1
          drift -= 1
        }
        while (drift < 0) {
          const tallest = snapped.reduce((best, value, index) => value > (snapped[best] ?? 0) ? index : best, 0)
          const value = snapped[tallest] ?? 0
          if (value <= 1) break
          snapped[tallest] = value - 1
          drift += 1
        }
        let offset = 0
        const boxes = layouts.map(({ segment, layout }, stackIndex) => {
          const box = layout === null || snapped[stackIndex] === 0 ? null : { segment, isTop: layout.isTop, bottom: offset, height: snapped[stackIndex]! }
          offset += snapped[stackIndex] ?? 0
          return box
        })
        return <div key={point.key} className={css.tokenChartBar} data-active={hoveredIndex === index || undefined} data-empty={visible ? undefined : ''} style={{ left, width: bar, height: visible ? Math.max(height, value.requests > 0 ? 3 : 0) : 0 }} onPointerEnter={() => { setHover(index) }}>
          {boxes.map(box => box === null ? null
            : <i key={box.segment.name} className={css.tokenChartSeg} data-series={box.segment.name} data-top={box.isTop || undefined} style={{ bottom: box.bottom, height: box.height, background: box.segment.color }} />)}
        </div>
      })}
      {hovered === undefined ? null : <div className={css.tokenChartTip} style={{ left: tip.left, top: tip.top, width: tipWidth }} role="status">
        <div className={css.tokenChartTipHead}><b>{headLabel}</b><b>{full(hovered.value.tokens)}</b></div>
        {split === undefined ? null : <>
          {split.hit > 0 ? <div className={css.tokenChartTipRow}><i className={css.tokenChartSwatch} data-tone="hit" />{text.cacheHit}<b>{full(split.hit)}</b></div> : null}
          {split.miss > 0 ? <div className={css.tokenChartTipRow}><i className={css.tokenChartSwatch} data-tone="miss" />{text.cacheMiss}<b>{full(split.miss)}</b></div> : null}
          {split.output > 0 ? <div className={css.tokenChartTipRow}><i className={css.tokenChartSwatch} data-tone="out" />{text.output}<b>{full(split.output)}</b></div> : null}
        </>}
        {stacked.map(segment => <div key={segment.name} className={css.tokenChartTipRow}>
          <i className={css.tokenChartSwatch} style={{ background: segment.color }} />{visibleModel(segment.name)}<b>{full(segment.tokens)}</b>
        </div>)}
        <div className={css.tokenChartTipRow}><i className={css.tokenChartSwatch} data-tone="req" />{text.requests}<b>{full(hovered.value.requests)}</b></div>
        {hovered.value.cost > 0 ? <div className={css.tokenChartTipRow}><i className={css.tokenChartSwatch} data-tone="req" />{text.cost}<b>{money(hovered.value.cost)}</b></div> : null}
      </div>}
    </div>
    <div className={css.tokenChartAxis}>
      {axisTicks(points, hourly).map(tick => <span key={tick.key} style={{ left: `${tick.anchor}%` }}>{tick.label}</span>)}
    </div>
    {seriesList.length <= 1 ? null : <div className={css.tokenChartLegend}>
      {seriesList.map(series => <span key={series.name}><i style={{ background: series.color }} aria-hidden />{visibleModel(series.name)}</span>)}
    </div>}
  </div>
}

/** X-axis ticks: first, last and ~4 evenly spaced middle labels, anchored at
 *  their bucket centers so they track the adaptive bar layout. */
function axisTicks(points: readonly UsagePoint[], hourly: boolean): readonly { key: string; anchor: number; label: string }[] {
  if (points.length === 0) return []
  const label = (point: UsagePoint): string => hourly ? point.key.slice(11) : point.key.slice(5).replace('-', '/')
  if (points.length <= 5) return points.map((point, index) => ({ key: point.key, anchor: points.length === 1 ? 50 : (index / (points.length - 1)) * 100, label: label(point) }))
  const wanted = [0, 0.25, 0.5, 0.75, 1].map(fraction => Math.round(fraction * (points.length - 1)))
  const unique = [...new Set(wanted)]
  return unique.map(index => ({ key: points[index]!.key, anchor: (index / (points.length - 1)) * 100, label: label(points[index]!) }))
}
