/**
 * Host-only Cline account pool, token refresh, device login, live free-model
 * directory, and the LLM adapter that serves them.
 *
 * Cline has no API key. A request carries a WorkOS-issued access token in the
 * `workos:`-prefixed bearer form, and that token is rotated through
 * `/auth/refresh`. The free routes come from Cline's own
 * `ai/cline/recommended-models` feed rather than a pinned list, so a model that
 * becomes free later is selectable without a plugin update; the pinned list is
 * only a floor for when the feed cannot be reached.
 *
 * Several accounts rotate on auth and rate failures. Cline grants each free
 * promotion its own budget, so a budget is parked against the *route* that ran
 * out, not against the account: a capped `deepseek-v4-flash` must leave
 * `glm-5.3-flash` and the rest of the account's routes usable. Only a gate the
 * upstream attributes to the account itself (billing, or a failure that names
 * no route) parks the account. Either way the park lasts until the upstream's
 * own "try again in …" delay elapses rather than being retried blindly.
 *
 * @module cline
 */

import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { activeAccountIdAfterRemoval, activeAccountIdAfterWrite } from './account-utils.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { parseSse, serializeRequest, translate } from './openai-wire.ts'
import { isHttpUrl } from './system-browser.ts'
import type { ClineAccountInfo, ClineDeviceLogin, ClineFreeModel, ClineUsage, ClineUsageWindow } from './types.ts'

/** Host-only credential slot for the Cline account pool. */
export const CLINE_AUTH_REF: CredentialRef = credentialRef('CLINE_AUTH')

/** Cline's product API root. `/chat/completions` is OpenAI-compatible. */
export const CLINE_API_BASE = 'https://api.cline.bot/api/v1'
const CLINE_CHAT_URL = `${CLINE_API_BASE}/chat/completions`
/** The authenticated free-model feed; the only honest source of availability. */
const CLINE_MODELS_URL = `${CLINE_API_BASE}/ai/cline/recommended-models`
const CLINE_USAGE_URL = `${CLINE_API_BASE}/users/me/plan/usage-limits`
const CLINE_PROFILE_URL = `${CLINE_API_BASE}/users/me`
const CLINE_REGISTER_URL = `${CLINE_API_BASE}/auth/register`
const CLINE_REFRESH_URL = `${CLINE_API_BASE}/auth/refresh`
const WORKOS_DEVICE_URL = 'https://api.workos.com/user_management/authorize/device'
const WORKOS_AUTHENTICATE_URL = 'https://api.workos.com/user_management/authenticate'
/** Public WorkOS client id used by the official Cline clients. */
const WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'

/**
 * The client identity Cline's product API requires on a free route.
 *
 * Cline's free promotions are gated on the *client* that asks for them, not on
 * the account: a request that does not identify itself as a Cline product
 * surface is refused with HTTP 403 and
 * "<model> is only available via Cline product surfaces. If you are using an old
 * version of Cline, please update to the latest version". A bearer token alone
 * is not enough — the request has to carry the same `X-CLIENT-*` / `X-PLATFORM`
 * / `X-CORE-VERSION` / `User-Agent` triple the official clients send, and
 * `X-Task-ID` has to name the same session as the body's `session_id`.
 *
 * These are the values the reference Cline CLI client reports (the same set a
 * working Cline proxy relays), not invented ones: the upstream compares them
 * against a known-product allowlist, so a plausible-looking substitute is
 * refused exactly like no header at all.
 */
const CLINE_CLIENT_IDENTITY: Readonly<Record<string, string>> = {
  'user-agent': 'Cline/3.0.50',
  'http-referer': 'https://cline.bot',
  'x-title': 'Cline',
  'x-is-multiroot': 'false',
  'x-client-type': 'cline-cli',
  'x-client-version': '3.0.50',
  'x-platform': 'terminal',
  'x-platform-version': '3.0.50',
  'x-core-version': '0.0.70',
}

/**
 * The identity headers for one request, with its session id attached.
 *
 * `taskId` is the same value the request body carries as `session_id`: the
 * upstream treats a task id that disagrees with the body as a mismatched
 * surface, and one id built in two places is how they come to disagree.
 */
export function clineClientHeaders(taskId: string): Record<string, string> {
  return { ...CLINE_CLIENT_IDENTITY, 'x-task-id': taskId }
}

const CLINE_MODELS_CACHE_TTL_MS = 5 * 60_000
const CLINE_REQUEST_TIMEOUT_MS = 30_000
/** A caller without a signal still needs a bound, but a model stream runs far
 * longer than a metadata read; this matches the shared adapter's cap. */
const CLINE_CHAT_TIMEOUT_MS = 120_000
const CLINE_MODELS_TIMEOUT_MS = 15_000
/** Refresh this long before the recorded expiry so a request never carries a
 * token that expires mid-stream. */
const CLINE_REFRESH_BUFFER_MS = 5 * 60_000
/** Fallback park when a rate-limit body carries no parseable delay. */
const CLINE_RATE_LIMIT_FALLBACK_MS = 60_000
const CLINE_DEFAULT_MAX_TOKENS = 128_000
const CLINE_CONTEXT_WINDOW = 200_000
const CLINE_REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const

/** Cache window for the usage-limits read; it is a status board, not a quota gate. */
const CLINE_USAGE_CACHE_TTL_MS = 60_000

/** Host-only account record persisted in the credential vault. */
interface ClineAccount {
  readonly id: string
  readonly refreshToken: string
  readonly accessToken?: string
  readonly expiresAt?: number
  readonly email?: string
  /** Park deadline for the whole account, used by account-level gates. */
  readonly cooldownUntil?: number
  /** Park deadlines per route: model id → the moment it can be tried again. */
  readonly cooldowns?: Readonly<Record<string, number>>
  readonly note?: string
}

interface ClineStore {
  readonly accounts: readonly ClineAccount[]
  readonly activeAccountId?: string
}

/** One verified credential, as the refresh and device-login paths hand it to the store. */
interface ClineAccountUpdate {
  readonly id: string
  readonly refreshToken: string
  readonly accessToken: string
  readonly expiresAt?: number
  readonly email?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}function redact(value: string): string {
  // Curated credential shapes first (this module's own rules only knew bearer and
  // keyword forms), then the local ones.
  return redactCredentialShapes(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/(?:^|[\s"'=&?])(?:access[_-]?token|refresh[_-]?token|accessToken|refreshToken|client[_-]?secret|token)(?:["'=:\s]+)[a-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 512)
}
/** Stable account key: the email when the token carries one, else the token. */
function accountKey(email: string | undefined, refreshToken: string): string {
  return (email ?? `cline-${refreshToken.slice(-16)}`).trim().toLowerCase()
}
/** Read the recorded expiry in epoch ms; `undefined` means "refresh first". */
function parseExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  const text = string(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}
/** Best-effort email recovery from an access token's JWT payload. */
function decodeJwtEmail(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined || payload === '') return undefined
  try {
    const decoded = object(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return string(decoded.email) ?? string(object(decoded.profile).email)
  } catch { return undefined }
}
/** Cline's free routes use `<vendor>/<model>` ids; the vendor names the group. */
function providerOf(id: string): string {
  const separator = id.indexOf('/')
  return separator > 0 ? id.slice(0, separator) : 'cline'
}
/** The route a cooldown belongs to; an empty or absent model parks the account. */
function routeKey(model: string | undefined): string | undefined {
  const key = model?.trim()
  return key === undefined || key === '' ? undefined : key
}
/** The model named by a serialized request body, when it names one. */
function modelOf(body: string): string | undefined {
  try { return string(object(JSON.parse(body)).model) } catch { return undefined }
}
/**
 * The task id a serialized request body already carries.
 *
 * Read back from the body rather than re-generated so `X-Task-ID` and
 * `session_id` cannot drift apart: the adapter puts the id in the body, and the
 * transport takes the header from here.
 */
function taskIdOf(body: string): string | undefined {
  try { return string(object(JSON.parse(body)).session_id) } catch { return undefined }
}
/** A fresh Cline session id, used only when a body arrived without one. */
function newTaskId(): string {
  return `sess_${Date.now().toString(36)}`
}
/**
 * The park deadline that covers one route.
 *
 * An account-level park (billing, or a failure with no route to blame) always
 * applies; a route park only applies to its own model.
 */
function routeCooldown(account: ClineAccount, model: string | undefined): number {
  const accountWide = account.cooldownUntil ?? 0
  const key = routeKey(model)
  return key === undefined ? accountWide : Math.max(accountWide, account.cooldowns?.[key] ?? 0)
}
/** Whether this account can carry one route right now. */
function servesRoute(account: ClineAccount, model: string | undefined, now: number): boolean {
  return routeCooldown(account, model) <= now
}
/**
 * Whether the pool still holds a usable credential for this account.
 *
 * Refresh-only accounts count as usable: `accessToken()` mints a token from the
 * refresh token on demand. An account missing both was deliberately dropped by
 * a failed refresh and needs the user to authorize it again.
 */
function credentialsUsable(account: ClineAccount): boolean {
  return !(account.accessToken === undefined && account.expiresAt === undefined)
}
/** One route's park, as the browser-safe card needs it. */
function liveCooldowns(account: ClineAccount, now: number): readonly { readonly model: string; readonly until: number }[] {
  return Object.entries(account.cooldowns ?? {})
    .filter(([, until]) => until > now)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, until]) => ({ model, until }))
}
/** Read a per-route cooldown map, keeping only deadlines that are still ahead. */
function readCooldowns(value: unknown, now: number): Record<string, number> | undefined {
  const entries = Object.entries(object(value))
    .map(([model, until]) => [model.trim(), parseExpiry(until)] as const)
    .filter((entry): entry is readonly [string, number] => entry[0] !== '' && entry[1] !== undefined && entry[1] > now)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}
/** A wait as a person would say it out loud, for the failure text. */
function humanizeWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/**
 * Read one usage window from an upstream row of unknown shape.
 *
 * The endpoint is used by Cline's own dashboard but is not in the public API
 * reference, so the parser stays narrow and tolerant: it accepts the field
 * spellings seen in the wild and drops any row it cannot make sense of rather
 * than guessing a percentage it does not actually know.
 */
function parseClineUsageWindow(id: string, value: unknown): ClineUsageWindow | undefined {
  const row = object(value)
  const limit = number(row.limit ?? row.limitTotal ?? row.total ?? row.maximum)
  const used = number(row.used ?? row.utilized ?? row.current)
  const rawPercent = number(row.usedPercent ?? row.percent ?? row.percentage ?? row.utilization)
  const usedPercent = rawPercent !== undefined ? rawPercent
    : used !== undefined && limit !== undefined && limit > 0 ? Math.min(100, Math.max(0, used / limit * 100))
      : undefined
  const resetsAt = parseExpiry(row.resetAt ?? row.resetsAt ?? row.reset_at ?? row.resetTime)
  if (usedPercent === undefined && used === undefined && limit === undefined && resetsAt === undefined) return undefined
  return {
    id,
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

/**
 * Parse the usage-limits payload. Known shapes: a top-level `data` envelope
 * with per-window keys, or a flat record of window names. A `plan` label is
 * kept when present; everything unrecognized is ignored.
 */
function parseClineUsage(payload: Record<string, unknown>): ClineUsage {
  const envelope = object(payload.data)
  const source = Object.keys(envelope).length > 0 ? envelope : payload
  const candidates: readonly (readonly [string, unknown])[] = [
    ['five-hour', source.fiveHour ?? source.five_hour ?? source['5h'] ?? source.fiveHourUsage],
    ['weekly', source.weekly ?? source.sevenDay ?? source.seven_day ?? source['7d'] ?? source.weeklyUsage],
    ['monthly', source.monthly ?? source.thirtyDay ?? source.thirty_day ?? source['30d'] ?? source.monthlyUsage],
  ]
  const windows = candidates
    .filter(([, value]) => value !== undefined)
    .map(([id, value]) => parseClineUsageWindow(id, value))
    .filter((window): window is ClineUsageWindow => window !== undefined)
  const rawBalance = number(payload.balance) ?? number(source.balance)
  const plan = string(payload.plan ?? source.plan ?? object(payload.plan).name ?? source.tier)
  return {
    windows,
    ...(plan === undefined ? {} : { plan }),
    ...(rawBalance === undefined ? {} : { balanceUsd: rawBalance / 1_000_000 }),
  }
}
function parseClineModel(value: unknown): ClineFreeModel | undefined {
  const row = object(value)
  const id = string(row.id ?? row.model)
  if (id === undefined) return undefined
  const name = string(row.name ?? row.displayName ?? row.title) ?? id
  const description = string(row.description)
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : undefined
  return {
    id,
    name,
    provider: string(row.provider) ?? providerOf(id),
    ...(description === undefined ? {} : { description }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags }),
  }
}
/** Parse "try again in 17h 59m" into a cooldown deadline. */
function cooldownUntilFrom(detail: string, now = Date.now()): number {
  const hours = /(\d+)\s*h/i.exec(detail)
  const minutes = /(\d+)\s*m(?!s)/i.exec(detail)
  const seconds = /(\d+)\s*s/i.exec(detail)
  const total = (hours === null ? 0 : Number(hours[1]) * 3_600_000)
    + (minutes === null ? 0 : Number(minutes[1]) * 60_000)
    + (seconds === null ? 0 : Number(seconds[1]) * 1_000)
  return now + (total > 0 ? total : CLINE_RATE_LIMIT_FALLBACK_MS)
}

/** A failed upstream call after every account was tried. */
export class ClineUpstreamError extends Error {
  /** The route this failure belongs to, when the request named one. */
  readonly model?: string
  /** Until the pool can carry that route again, when every account is parked. */
  readonly retryAfterMs?: number

  constructor(readonly status: number, readonly detail: string, options: { readonly model?: string; readonly retryAfterMs?: number } = {}) {
    super(`Cline upstream request failed (HTTP ${status})${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'ClineUpstreamError'
    if (options.model !== undefined) this.model = options.model
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

export class ClineClient {
  private cursor = 0
  private modelsCache: { readonly expiresAt: number; readonly models: readonly ClineFreeModel[] } | undefined
  private modelsPromise: Promise<readonly ClineFreeModel[]> | undefined
  private usageCache: { readonly expiresAt: number; readonly usage: ClineUsage } | undefined
  private usagePromise: Promise<ClineUsage> | undefined
  constructor(private readonly credentials: CredentialProvider) {}

  /**
   * Read the account pool. Cheap and offline: the picker and the Settings card
   * ask this on every render, so it never touches the network.
   */
  async accounts(): Promise<readonly ClineAccountInfo[]> {
    const store = await this.readStore()
    const now = Date.now()
    return store.accounts.map((account) => {
      // A route park leaves the account in rotation: `cooling` stays reserved
      // for a park the upstream put on the account itself, and the routes that
      // merely ran out of free budget are listed separately.
      const coolingModels = liveCooldowns(account, now)
      return {
        id: account.id,
        ...(account.email === undefined ? {} : { email: account.email }),
        status: !credentialsUsable(account)
          ? 'reauth-required'
          : (account.cooldownUntil ?? 0) > now ? 'cooling' : 'active',
        ...(account.cooldownUntil === undefined ? {} : { cooldownUntil: account.cooldownUntil }),
        ...(coolingModels.length === 0 ? {} : { coolingModels }),
        ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
        ...(account.note === undefined ? {} : { note: account.note }),
      }
    })
  }

  /**
   * Which free routes the pool can carry right now, and whether anyone is
   * signed in at all.
   *
   * The picker uses this to park exactly the routes that ran out of free
   * budget: a capped promotion must not take the account's other routes — or
   * the whole provider — down with it.
   */
  async poolAvailability(): Promise<{ readonly signedIn: boolean; readonly parked: ReadonlySet<string> }> {
    const store = await this.readStore()
    const now = Date.now()
    const parked = new Set<string>()
    for (const model of await this.freeModels()) {
      if (!store.accounts.some(account => credentialsUsable(account) && servesRoute(account, model.id, now))) parked.add(model.id)
    }
    return { signedIn: store.accounts.length > 0, parked }
  }

  /** Whether any account can currently carry a request. */
  async signedIn(): Promise<boolean> {
    const store = await this.readStore()
    return store.accounts.length > 0
  }

  /**
   * `GET /ai/cline/recommended-models`, authenticated through the pool.
   *
   * Live-only: the list is exactly what the upstream feed reports right now.
   * An unreachable feed or a signed-out pool yields an empty list rather than
   * a stale substitute — a fabricated model id would 4xx on every call, so
   * showing nothing is the honest state.
   */
  async freeModels(): Promise<readonly ClineFreeModel[]> {
    const cached = this.modelsCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models
    const inFlight = this.modelsPromise
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<readonly ClineFreeModel[]> => {
      try {
        const store = await this.readStore()
        if (store.accounts.length === 0) return []
        const payload = object(await this.requestJson(CLINE_MODELS_URL, { method: 'GET' }))
        const rows = Array.isArray(payload.free) ? payload.free : Array.isArray(payload.models) ? payload.models : []
        return rows.map(parseClineModel).filter((model): model is ClineFreeModel => model !== undefined)
      } catch { return [] }
    })()
    this.modelsPromise = operation
    try {
      const models = await operation
      this.modelsCache = { expiresAt: Date.now() + CLINE_MODELS_CACHE_TTL_MS, models }
      return models
    } finally {
      if (this.modelsPromise === operation) this.modelsPromise = undefined
    }
  }

  /**
   * `GET /users/me/plan/usage-limits` for the active account, plus the
   * pay-as-you-go credit balance.
   *
   * Best-effort by design: the card treats usage as an extra panel, so a
   * failed or unexpected payload is an empty snapshot rather than an error —
   * the same failure must not take the account list down with it.
   */
  async usage(): Promise<ClineUsage> {
    const cached = this.usageCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.usage
    const inFlight = this.usagePromise
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<ClineUsage> => {
      const empty: ClineUsage = { windows: [] }
      try {
        const store = await this.readStore()
        // The recorded account only counts while it still holds a credential: a
        // failed refresh leaves it awaiting reauthorization, and reading the
        // panel from it would blank usage while other accounts still serve.
        const active = store.accounts.find(account => account.id === store.activeAccountId && credentialsUsable(account))
          ?? store.accounts.find(credentialsUsable)
        if (active === undefined) return empty
        const accessToken = await this.accessToken(active)
        const headers = { ...clineClientHeaders(newTaskId()), authorization: `Bearer workos:${accessToken}` }
        const response = await fetch(CLINE_USAGE_URL, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS),
        })
        if (!response.ok) return empty
        const usage = parseClineUsage(object(await this.json(response)))
        const balance = await this.creditBalance(headers).catch(() => undefined)
        return balance === undefined ? usage : { ...usage, ...(usage.balanceUsd === undefined ? { balanceUsd: balance } : {}) }
      } catch { return empty }
    })()
    this.usagePromise = operation
    try {
      const usage = await operation
      this.usageCache = { expiresAt: Date.now() + CLINE_USAGE_CACHE_TTL_MS, usage }
      return usage
    } finally {
      if (this.usagePromise === operation) this.usagePromise = undefined
    }
  }

  /** `GET /users/{id}/balance`, reported by the upstream in millionths of a USD. */
  private async creditBalance(headers: { readonly [key: string]: string }): Promise<number | undefined> {
    const profile = object(await this.requestJsonWithHeaders(CLINE_PROFILE_URL, { method: 'GET' }, headers))
    const id = string(profile.id)
    if (id === undefined) return undefined
    const response = await fetch(`${CLINE_API_BASE}/users/${encodeURIComponent(id)}/balance`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const payload = object(await this.json(response))
    const raw = number(payload.balance)
    // The dashboard shows 500000 as $0.50, so the integer is millionths.
    return raw === undefined ? undefined : raw / 1_000_000
  }

  /** Drop the cached usage snapshot so the next read hits the network. */
  invalidateUsage(): void {
    this.usageCache = undefined
    this.usagePromise = undefined
  }


  /** Drop the cached free-model feed and usage snapshot; the next read hits the network. */
  invalidateCatalog(): void {
    this.modelsCache = undefined
    this.modelsPromise = undefined
    this.usageCache = undefined
    this.usagePromise = undefined
  }

  /**
   * Add or replace one account from a refresh token.
   *
   * The token is exchanged immediately: storing an unverified token would let
   * the UI show an account that can never carry a request.
   */
  async addAccountFromRefreshToken(refreshToken: string): Promise<void> {
    const token = refreshToken.trim()
    if (token === '') throw new Error('CLINE_REFRESH_TOKEN_REQUIRED: paste a Cline refresh token')
    const refreshed = await this.refreshTokens(token)
    // Authorizing an account is a choice: it becomes the account the panel
    // reports and the default calls address.
    await this.upsertAccount(refreshed, { adopt: true })
  }

  /** Start a WorkOS device login; the caller renders the code and polls. */
  async startDeviceLogin(): Promise<ClineDeviceLogin> {
    const response: Response = await fetch(WORKOS_DEVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
      signal: AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
    })
    const payload = object(await this.json(response))
    if (!response.ok) throw new Error(`CLINE_LOGIN_FAILED: device authorization failed (HTTP ${response.status})`)
    const deviceCode = string(payload.device_code)
    const userCode = string(payload.user_code)
    // The verification page is opened in the system browser and also rendered as
    // a clickable link in Settings, so only http(s) is accepted: a `javascript:`
    // or `file:` value from a hostile or compromised response would otherwise be
    // one click away from running in the Settings origin. A complete URL that
    // fails the allow-list falls back to the plain one instead of being
    // relayed.
    const verificationUrl = [string(payload.verification_uri_complete), string(payload.verification_uri)]
      .find(candidate => candidate !== undefined && isHttpUrl(candidate))
    if (deviceCode === undefined || userCode === undefined || verificationUrl === undefined) {
      throw new Error('CLINE_LOGIN_FAILED: device authorization response was incomplete')
    }
    const expiresInSeconds = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 300
    return {
      deviceCode,
      userCode,
      verificationUrl,
      intervalSeconds: typeof payload.interval === 'number' && payload.interval > 0 ? payload.interval : 5,
      expiresAt: Date.now() + expiresInSeconds * 1_000,
    }
  }

  /**
   * Poll one WorkOS device authorization.
   *
   * One poll per call, so the Settings page owns the cadence and the Host never
   * holds a five-minute request open.
   */
  /** `true` while the user has not finished authorizing in the browser. */
  async pollDeviceLogin(deviceCode: string): Promise<boolean> {
    const code = deviceCode.trim()
    if (code === '') throw new Error('CLINE_LOGIN_FAILED: device code is required')
    const response = await fetch(WORKOS_AUTHENTICATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code,
        client_id: WORKOS_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
    })
    const payload = object(await this.json(response))
    if (response.ok) {
      const workosAccess = string(payload.access_token)
      const workosRefresh = string(payload.refresh_token)
      if (workosAccess === undefined || workosRefresh === undefined) throw new Error('CLINE_LOGIN_FAILED: WorkOS returned no token')
      await this.registerWorkosTokens(workosAccess, workosRefresh)
      return false
    }
    const error = string(payload.error)
    // Both spellings mean "keep polling"; a `slow_down` is the upstream asking
    // for a longer interval, which the Settings page applies on its own clock.
    if (error === 'authorization_pending' || error === 'slow_down') return true
    const description = string(payload.error_description) ?? error ?? `HTTP ${response.status}`
    throw new Error(`CLINE_LOGIN_FAILED: ${redact(description)}`)
  }

  async removeAccount(accountId: string): Promise<void> {
    const store = await this.readStore()
    const accounts = store.accounts.filter(account => account.id !== accountId)
    const activeAccountId = activeAccountIdAfterRemoval(accounts, store.activeAccountId)
    await this.saveStore({ accounts, ...(activeAccountId === undefined ? {} : { activeAccountId }) })
    this.invalidateCatalog()
  }

  /** Remove every account and drop the cached directory. */
  async logout(): Promise<void> {
    await this.saveStore({ accounts: [] })
    this.invalidateCatalog()
    this.invalidateUsage()
  }

  /** Refresh one account (or all) and report which ones still work. */
  async refreshAccounts(accountId?: string): Promise<readonly ClineAccountInfo[]> {
    const store = await this.readStore()
    const targets = accountId === undefined ? store.accounts : store.accounts.filter(account => account.id === accountId)
    for (const account of targets) {
      try {
        const refreshed = await this.refreshTokens(account.refreshToken)
        await this.upsertAccount({ ...refreshed, id: account.id })
      } catch {
        // A dead token is recorded rather than removed: the row must stay
        // visible so the user can see which account needs re-authorizing.
        await this.saveAccount(withoutTokens(account, { clearCooldown: true, note: 'CLINE_REAUTH_REQUIRED' }))
      }
    }
    this.invalidateCatalog()
    this.invalidateUsage()
    return this.accounts()
  }

  /** Stream one chat completion, rotating accounts on auth and rate failures. */
  async chat(body: string, signal?: AbortSignal): Promise<Response> {
    const store = await this.readStore()
    if (store.accounts.length === 0) throw new Error('CLINE_LOGIN_REQUIRED: add a Cline account first')
    const model = modelOf(body)
    const now = Date.now()
    // Only this route's park is honoured: another model's spent budget is not a
    // reason to skip an account that could serve this request.
    const ready = store.accounts.filter(account => credentialsUsable(account) && servesRoute(account, model, now))
    // Every parked account is not a reason to fail: the cooldown is a hint the
    // upstream gave us, so still try the pool once before giving up.
    const candidates = ready.length > 0 ? ready : store.accounts
    let lastStatus = 0
    let lastDetail = ''
    for (let index = 0; index < candidates.length; index++) {
      const account = candidates[(this.cursor + index) % candidates.length]
      if (account === undefined) continue
      let accessToken: string
      try {
        accessToken = await this.accessToken(account)
      } catch {
        await this.saveAccount(withoutTokens(account, { note: 'CLINE_REAUTH_REQUIRED' }))
        lastStatus = lastStatus === 0 ? 401 : lastStatus
        lastDetail = lastDetail === '' ? 'CLINE_REAUTH_REQUIRED' : lastDetail
        continue
      }
      const response = await this.send(accessToken, body, signal)
      if (response.status === 401) {
        // The recorded expiry can be stale or absent; one forced refresh decides
        // whether the account is dead or merely carried an old token.
        await this.saveAccount(withoutTokens(account))
        lastStatus = 401
        continue
      }
      if (CLINE_ROTATE_STATUSES.has(response.status)) {
        const detail = await this.failureDetail(response)
        if (response.status === 403 && CLINE_SURFACE_REJECTION.test(detail)) {
          throw new ClineUpstreamError(403, redact(detail), {
            ...(model === undefined ? {} : { model }),
          })
        }
        lastStatus = response.status
        lastDetail = await this.park(account, response, model, detail)
        continue
      }
      if (!response.ok) {
        // A status no account-level park can fix: a malformed request or an
        // upstream fault. Rotating would park every healthy account over a
        // request none of them could serve, and — because the adapter only
        // reads `response.body` — the upstream's own explanation would be
        // replaced downstream by a generic "stream ended without [DONE]".
        // The `ok` gate is what makes returning the response a promise the
        // adapter can rely on.
        throw new ClineUpstreamError(response.status, redact(await this.failureDetail(response)), {
          ...(model === undefined ? {} : { model }),
        })
      }
      this.cursor = (this.cursor + index + 1) % candidates.length
      return response
    }
    const retryAfterMs = await this.routeResetIn(model)
    throw new ClineUpstreamError(lastStatus === 0 ? 401 : lastStatus, lastDetail, {
      ...(model === undefined ? {} : { model }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }

  /**
   * How long until the pool can carry one route again, when every usable
   * account is parked for it.
   *
   * Answers `undefined` when a usable account is free now — and also when no
   * usable account is left, because a dead credential is not a wait and
   * reporting one would promise a recovery the pool cannot make.
   */
  private async routeResetIn(model: string | undefined): Promise<number | undefined> {
    if (model === undefined) return undefined
    const store = await this.readStore()
    const now = Date.now()
    let earliest: number | undefined
    for (const account of store.accounts.filter(credentialsUsable)) {
      const until = routeCooldown(account, model)
      if (until <= now) return undefined
      earliest = earliest === undefined ? until : Math.min(earliest, until)
    }
    return earliest === undefined ? undefined : earliest - now
  }

  /**
   * The upstream's own account of a refusal, decoded once.
   *
   * A response body can only be read once, and Cline states the reason in the
   * body rather than in the status line, so every failure path that needs the
   * explanation reads it here instead of draining `response.text()` itself.
   */
  private async failureDetail(response: Response): Promise<string> {
    const raw = await response.text().catch(() => '')
    const parsed = object(safeJson(raw))
    return string(object(parsed.error).message) ?? string(parsed.message) ?? raw
  }

  private async send(accessToken: string, body: string, signal?: AbortSignal): Promise<Response> {
    // The body's own session id, so the header and the payload cannot disagree.
    // Both are needed: the surface check reads `X-Task-ID`, and the upstream
    // accounts the call against the body's `session_id`.
    const taskId = taskIdOf(body) ?? newTaskId()
    return fetch(CLINE_CHAT_URL, {
      method: 'POST',
      headers: {
        ...clineClientHeaders(taskId),
        authorization: `Bearer workos:${accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body,
      signal: signal ?? AbortSignal.timeout(CLINE_CHAT_TIMEOUT_MS),
    })
  }

  /**
   * Record a gate the upstream applied, and return its redacted detail.
   *
   * The park is scoped to the requested model whenever the request named one:
   * Cline's free promotions carry their own budgets, so a model that ran out
   * must not take the account's other free routes offline. `402` is the
   * account's own billing state and a request without a model has no route to
   * blame, so those park the account itself.
   */
  private async park(account: ClineAccount, response: Response, model: string | undefined, readDetail?: string): Promise<string> {
    // A caller that had to read the body to classify the refusal passes it in;
    // a response body can only be read once.
    const detail = readDetail ?? await this.failureDetail(response)
    const cooldownUntil = cooldownUntilFrom(detail)
    const note = redact(detail).slice(0, 200)
    const key = response.status === 402 ? undefined : routeKey(model)
    await this.saveAccount(key === undefined
      ? { ...account, cooldownUntil, note }
      : { ...account, cooldowns: { ...account.cooldowns, [key]: cooldownUntil }, note })
    return redact(detail)
  }

  /** A valid access token for one account, refreshing when needed. */
  private async accessToken(account: ClineAccount): Promise<string> {
    if (account.accessToken !== undefined && account.expiresAt !== undefined && account.expiresAt - CLINE_REFRESH_BUFFER_MS > Date.now()) {
      return account.accessToken
    }
    const refreshed = await this.refreshTokens(account.refreshToken)
    await this.upsertAccount({ ...refreshed, id: account.id, ...(account.email === undefined ? {} : { email: account.email }) })
    return refreshed.accessToken
  }

  private async refreshTokens(refreshToken: string): Promise<ClineAccountUpdate> {
    const response = await fetch(CLINE_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
      signal: AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
    })
    const payload = object(await this.json(response))
    if (!response.ok) throw new Error(`CLINE_REAUTH_REQUIRED: Cline token refresh failed (HTTP ${response.status})`)
    const data = object(payload.data)
    const accessToken = string(data.accessToken)
    if (accessToken === undefined) throw new Error('CLINE_REAUTH_REQUIRED: Cline token refresh returned no access token')
    const nextRefresh = string(data.refreshToken) ?? refreshToken
    const email = string(object(data.userInfo).email) ?? decodeJwtEmail(accessToken)
    const expiresAt = parseExpiry(data.expiresAt)
    return {
      id: accountKey(email, nextRefresh),
      refreshToken: nextRefresh,
      accessToken,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(email === undefined ? {} : { email }),
    }
  }

  /** Exchange WorkOS tokens for Cline tokens and store the account. */
  private async registerWorkosTokens(workosAccess: string, workosRefresh: string): Promise<void> {
    const response = await fetch(CLINE_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: workosAccess, refreshToken: workosRefresh }),
      signal: AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
    })
    const payload = object(await this.json(response))
    if (!response.ok) throw new Error(`CLINE_LOGIN_FAILED: Cline registration failed (HTTP ${response.status})`)
    const data = object(payload.data)
    const accessToken = string(data.accessToken)
    if (accessToken === undefined) throw new Error('CLINE_LOGIN_FAILED: Cline registration returned no access token')
    const refreshToken = string(data.refreshToken) ?? workosRefresh
    const email = string(object(data.userInfo).email) ?? decodeJwtEmail(accessToken)
    const expiresAt = parseExpiry(data.expiresAt)
    await this.upsertAccount({
      id: accountKey(email, refreshToken),
      refreshToken,
      accessToken,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(email === undefined ? {} : { email }),
    }, { adopt: true })
    this.invalidateCatalog()
  }

  private async upsertAccount(account: ClineAccountUpdate, options: { readonly adopt?: boolean } = {}): Promise<void> {
    const store = await this.readStore()
    const previous = store.accounts.find(item => item.id === account.id)
    const record: ClineAccount = {
      id: account.id,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
      ...(account.email === undefined ? {} : { email: account.email }),
      // A park is the upstream's own budget state, not credential state: a
      // token refresh happens on every account every few hours and must not
      // silently hand a capped model back to the pool.
      ...(previous?.cooldownUntil === undefined ? {} : { cooldownUntil: previous.cooldownUntil }),
      ...(previous?.cooldowns === undefined ? {} : { cooldowns: previous.cooldowns }),
    }
    const accounts = [...store.accounts.filter(item => item.id !== record.id), record]
    await this.saveStore({
      accounts,
      activeAccountId: activeAccountIdAfterWrite(accounts, {
        previousActiveId: store.activeAccountId,
        writtenId: record.id,
        ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
      }),
    })
  }

  /**
   * Write one account's operational state: a route park, a dead-token reset, a
   * failed re-check.
   *
   * The refresh token is deliberately not this method's to write. Rotation is
   * one-way — the upstream answers a refresh with a new token and retires the old
   * one — and the `account` a caller holds was read *before* the request that
   * rotated it. Writing that copy back would restore a token the upstream has
   * already retired, so the account would need re-authorization forever the
   * moment its next request failed with 401. The stored record is the newer of
   * the two by construction, so its token is the one that survives; credentials
   * change through {@link upsertAccount}, which is fed by the refresh itself.
   */
  private async saveAccount(account: ClineAccount): Promise<void> {
    const store = await this.readStore()
    const stored = store.accounts.find(item => item.id === account.id)
    const record: ClineAccount = stored === undefined ? account : { ...account, refreshToken: stored.refreshToken }
    const accounts = stored === undefined
      ? [...store.accounts, record]
      : store.accounts.map(item => item.id === account.id ? record : item)
    // Every write here is a side effect — a route park, a dead-token reset, a
    // failed re-check — so the account the user is on must survive them.
    await this.saveStore({
      accounts,
      activeAccountId: activeAccountIdAfterWrite(accounts, { previousActiveId: store.activeAccountId, writtenId: record.id }),
    })
  }

  /** Authenticated metadata read; rotates accounts the way `chat` does. */
  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const store = await this.readStore()
    if (store.accounts.length === 0) throw new Error('CLINE_LOGIN_REQUIRED: add a Cline account first')
    let lastError: unknown
    for (const account of store.accounts) {
      try {
        const accessToken = await this.accessToken(account)
        const response = await fetch(url, {
          ...init,
          headers: { ...clineClientHeaders(newTaskId()), authorization: `Bearer workos:${accessToken}` },
          signal: AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS),
        })
        // `await` is load-bearing: without it a JSON parse rejection escapes this
        // `catch` and skips the retry that records `lastError`.
        if (response.ok) return await this.json(response)
        lastError = new ClineUpstreamError(response.status, redact(await response.text().catch(() => '')))
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new ClineUpstreamError(502, 'CLINE_MODELS_UNAVAILABLE')
  }

  /** One authenticated read with caller-supplied headers; no rotation. */
  private async requestJsonWithHeaders(url: string, init: RequestInit, headers: { readonly [key: string]: string }): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS),
    })
    if (!response.ok) throw new ClineUpstreamError(response.status, redact(await response.text().catch(() => '')))
    return this.json(response)
  }

  private async readStore(): Promise<ClineStore> {
    const value = await this.credentials.resolve(CLINE_AUTH_REF)
    if (value !== undefined) {
      try {
        const parsed = object(JSON.parse(value.value))
        const list = Array.isArray(parsed.accounts) ? parsed.accounts : []
        const accounts = list.map(item => object(item)).map((item) => {
          const refreshToken = string(item.refreshToken)
          if (refreshToken === undefined) return undefined
          const email = string(item.email)
          const accessToken = string(item.accessToken)
          const expiresAt = parseExpiry(item.expiresAt)
          // Only live parks are read back: an elapsed deadline is not a reason
          // to render — or serve — the account as limited.
          const now = Date.now()
          const parkedUntil = parseExpiry(item.cooldownUntil)
          const cooldownUntil = parkedUntil !== undefined && parkedUntil > now ? parkedUntil : undefined
          const cooldowns = readCooldowns(item.cooldowns, now)
          const note = string(item.note)
          return {
            id: string(item.id) ?? accountKey(email, refreshToken),
            refreshToken,
            ...(accessToken === undefined ? {} : { accessToken }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(email === undefined ? {} : { email }),
            ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
            ...(cooldowns === undefined ? {} : { cooldowns }),
            ...(note === undefined ? {} : { note }),
          } satisfies ClineAccount
        }).filter((item): item is ClineAccount => item !== undefined)
        const activeAccountId = string(parsed.activeAccountId)
        return activeAccountId === undefined ? { accounts } : { accounts, activeAccountId }
      } catch { /* a malformed store is treated as signed out */ }
    }
    return { accounts: [] }
  }

  private saveStore(store: ClineStore): Promise<void> {
    return this.credentials.set(CLINE_AUTH_REF, JSON.stringify(store))
  }

  /** Parse a response body without treating a non-2xx status as fatal. */
  private async json(response: Response): Promise<unknown> {
    const raw = await response.text().catch(() => '')
    if (raw.trim() === '') return {}
    try { return JSON.parse(raw) } catch { return {} }
  }
}

/** Statuses that mean "this account cannot serve now; try the next one". */
const CLINE_ROTATE_STATUSES: ReadonlySet<number> = new Set([402, 403, 429])

/**
 * Cline's answer when the *client* is not a surface it sells free routes to.
 *
 * It arrives as a 403, which is otherwise a per-account gate. The distinction
 * matters in both directions: rotating accounts over it parks a pool of healthy
 * accounts, and reporting it as a quota problem sends the user to the billing
 * screen for something no account setting can change.
 */
const CLINE_SURFACE_REJECTION = /product surfaces?/iu

/**
 * Drop an account's cached access token (and optionally its cooldown) so the
 * next attempt re-authorizes it. The keys are removed rather than set to
 * `undefined`: the vault store round-trips through JSON, and an explicit
 * `undefined` would be dropped there anyway while failing the exact-optional
 * type contract here.
 */
function withoutTokens(account: ClineAccount, options: { readonly clearCooldown?: boolean; readonly note?: string } = {}): ClineAccount {
  const { accessToken: _accessToken, expiresAt: _expiresAt, cooldownUntil, note: previousNote, ...rest } = account
  const note = options.note ?? previousNote
  return {
    ...rest,
    ...(options.clearCooldown === true || cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(note === undefined ? {} : { note }),
  }
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return {} }
}

/**
 * Map Cline failures onto the shared LLM error vocabulary.
 *
 * Only `401` says the sign-in itself is dead. `402/403/429` are the free tier's
 * budget and plan gates: the credential is fine, one route is out of money, and
 * reporting that as `AUTH` made the UI tell users their API key was invalid
 * while every credential the pool held was still good.
 */
function clineLlmError(error: unknown): LlmError {
  if (error instanceof ClineUpstreamError) {
    const code = error.status === 401 ? 'AUTH'
      : error.status === 402 || error.status === 403 || error.status === 429 ? 'RATE_LIMIT'
        : error.status >= 500 ? 'SERVER'
          : `HTTP_${error.status}`
    return new LlmError(clineFailureMessage(error), code, { status: error.status })
  }
  if (error instanceof Error && error.message.startsWith('CLINE_')) {
    const credentials = /^CLINE_(?:LOGIN_REQUIRED|REAUTH_REQUIRED)/.test(error.message)
    return new LlmError(error.message, credentials ? 'AUTH' : 'TRANSPORT', { cause: error })
  }
  return new LlmError('Cline request failed', 'TRANSPORT', { cause: error })
}

/**
 * A failure line that names the route and when it comes back, so a rate limit
 * reads as a rate limit instead of a bad key.
 */
function clineFailureMessage(error: ClineUpstreamError): string {
  const detail = error.detail.trim()
  const suffix = detail === '' ? '' : `（上游：${detail}）`
  if (error.status === 401) {
    return `Cline 账号凭据不再被上游接受，请在设置中重新授权该账号。 Cline sign-in was rejected by the upstream; re-authorize the account in Settings.${suffix}`
  }
  const route = error.model ?? '该模型'
  if (error.status === 402 || error.status === 403) {
    return `Cline 拒绝了 ${route}（额度或订阅不足，HTTP ${error.status}）；请改用其他模型，或在设置中检查 Cline 账号。 Cline rejected ${route} (quota or subscription, HTTP ${error.status}); use another model or review the Cline account in Settings.${suffix}`
  }
  if (error.status === 429) {
    if (error.retryAfterMs === undefined) {
      return `Cline 的 ${route} 免费额度已限流，暂时无法继续；请改用其他模型或稍后重试。 The free budget for ${route} is rate limited; switch models or retry later.${suffix}`
    }
    const wait = humanizeWait(error.retryAfterMs)
    return `Cline 的 ${route} 免费额度已限流，最早约 ${wait} 后恢复；现在可改用其他模型。 The free budget for ${route} is rate limited for about ${wait}; use another model meanwhile.${suffix}`
  }
  return `Cline provider request failed (HTTP ${error.status})${detail === '' ? '' : `: ${detail}`}`
}

/**
 * The Cline provider adapter.
 *
 * It owns request serialization instead of reusing the generic OpenAI-compatible
 * adapter because free-tier routing is a pool decision: a 401 must refresh and a
 * 429 must move to another account *within one turn*, and a generic adapter that
 * resolves one static connection per stream cannot express that.
 */
export class ClineAdapter extends LlmAdapter {
  constructor(private readonly client: ClineClient) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cline' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.client.freeModels()
    // Budgets are per model: a route is unavailable only when no account can
    // carry *that* route, so a capped model never greys out the rest.
    const pool = await this.client.poolAvailability()
    return models.map((model) => {
      const servable = pool.signedIn && !pool.parked.has(model.id)
      return {
        provider,
        id: model.id,
        name: model.name,
        // Every row on this feed is a free route: the account's per-model promo
        // budget pays for it. The picker derives its FREE tag from an `x0` in
        // this string, and Cline's feed sends prose with no rate at all, so
        // without stating the rate here the free routes render as unpriced. The
        // rate leads the string so an upstream note that happens to mention a
        // multiplier cannot shadow it.
        description: 'Cline · ×0 · 官方免费模型',
        inputModalities: ['text'] as const,
        ...servable
          ? { availability: 'available' as const }
          : { availability: 'unavailable' as const, unavailableReason: pool.signedIn ? 'CLINE_MODEL_RATE_LIMITED' : 'CLINE_LOGIN_REQUIRED' },
      }
    })
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = (await this.client.freeModels()).find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description === undefined ? {} : { description: known.description }),
      inputModalities: ['text'],
      context: { contextWindow: CLINE_CONTEXT_WINDOW },
      defaultMaxTokens: CLINE_DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: CLINE_REASONING_EFFORTS.map(effort => ({
          id: ReasoningEffortId(effort),
          name: effort.slice(0, 1).toUpperCase() + effort.slice(1),
        })),
        defaultEffort: ReasoningEffortId('high'),
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request: GenerateOptions = {
      ...options,
      // Cline's free routes are reasoning models; the reference client always
      // sends an effort, so an unset one means "use the documented default".
      reasoningEffort: options.reasoningEffort ?? ReasoningEffortId('high'),
      maxTokens: options.maxTokens ?? CLINE_DEFAULT_MAX_TOKENS,
    }
    const body = serializeRequest(request, { reasoningWire: 'standard' })
    // The single task id for this call: `send` lifts it into `X-Task-ID`. Cline
    // gates its free routes on the client identity and on the task id agreeing
    // with the body, so it is written here and read back — never created twice.
    body.session_id = newTaskId()
    let response: Response
    try {
      response = await this.client.chat(JSON.stringify(body), options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Cline request aborted by caller', 'ABORTED', { cause: error })
      throw clineLlmError(error)
    }
    if (response.body === null) throw new LlmError('Cline returned no response body', 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Cline request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('Cline stream failed', 'TRANSPORT', { cause: error })
    }
  }
}
