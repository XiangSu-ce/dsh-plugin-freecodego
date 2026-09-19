import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { FreeCodeGoGatewayProviderHealth } from '@deepseek-ai/dsh-freecodego-api'
import { readJsonFile, stringArray } from './community-storage.ts'
import { inferMediaCategory, type MediaCategory } from './media-utils.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import type { FreeCodeGoAdvisorCouncilReport, FreeCodeGoAdvisorNote, FreeCodeGoManagedCatalog, FreeCodeGoManagedCatalogGroup } from './types.ts'

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

export const OPENCODE_DIRECT_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_HEALTH_CACHE_TTL_MS = 60 * 60_000
export const OPENCODE_CATALOG_CACHE_TTL_MS = 24 * 60 * 60_000
export const OPENCODE_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000
export const MANAGED_MODEL_CATALOG_CACHE_TTL_MS = 60 * 60_000
export const GATEWAY_HEALTH_CACHE_TTL_MS = 30 * 60_000
/**
 * How long one backend's "no channel-health route" verdict stands.
 *
 * Long enough that a backend without the route is not asked every cadence, but
 * bounded on purpose: a 404 can also come from a proxy or a deploy in flight,
 * and a route that does exist must not stay invisible for a whole session.
 */
export const GATEWAY_HEALTH_UNSUPPORTED_TTL_MS = 6 * 60 * 60_000
export const MODEL_CATALOG_TIMEOUT_MS = 8_000
// ============================================================================
// WorkBuddy International Edition (workbuddy.ai)
// ============================================================================

export const WORKBUDDY_INTL_BASE_URL = 'https://www.workbuddy.ai'
export const WORKBUDDY_INTL_CHAT_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/chat/completions`
/**
 * The product document that lists WorkBuddy's routes for this account.
 *
 * The App's main process fetches `/v3/config`; the gateway answers the older
 * `/console/enterprises/personal/models` document to CLI-shaped requests. Only
 * the product document describes the international pool this provider serves.
 */
export const WORKBUDDY_INTL_CONFIG_URL = `${WORKBUDDY_INTL_BASE_URL}/v3/config`
export const WORKBUDDY_INTL_TOKEN_REFRESH_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/plugin/auth/token/refresh`
/** @deprecated Use {@link WORKBUDDY_INTL_CONFIG_URL}; kept for existing importers. */
export const WORKBUDDY_INTL_MODELS_URL = WORKBUDDY_INTL_CONFIG_URL
export const WORKBUDDY_INTL_BILLING_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/billing/meter/get-user-resource`
/** @deprecated Alias of {@link WORKBUDDY_INTL_BILLING_URL} for readers that
 * name the legacy aggregate resource query. */
export const WORKBUDDY_INTL_USER_RESOURCE_URL = WORKBUDDY_INTL_BILLING_URL

/** Browser-authorization poll endpoint; answered with `{code:11217}` while pending. */
export const WORKBUDDY_INTL_TOKEN_POLL_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/plugin/auth/token`
/**
 * Device-authorization entry point.
 *
 * The plugin grant is *server-issued*: `POST /v2/plugin/auth/state` answers with
 * both the `state` and the `authUrl` to open, and that state is what the poll
 * endpoint is keyed by. A state minted client-side cannot work — the login page
 * 302s into Keycloak, which rewrites the callback URI without the caller's
 * query, so the issued tokens were never recorded under a state this plugin
 * could ask for (the card polled `11217:login ing...` forever).
 */
export const WORKBUDDY_INTL_AUTH_STATE_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/plugin/auth/state`
/**
 * Identity lookup for a state that just issued tokens.
 *
 * The token payload does not always carry the uid the request router needs, so
 * the grant is completed with one authenticated read of this endpoint.
 */
export const WORKBUDDY_INTL_LOGIN_ACCOUNT_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/plugin/login/account`
/**
 * Platform asked for at {@link WORKBUDDY_INTL_AUTH_STATE_URL}.
 *
 * `CLI` is the grant the App/CLI shape is measured to work with, and the same
 * identity chat and refresh already use; the returned `authUrl` says
 * `platform=CLI` too, so browser and API agree on one client class.
 */
export const WORKBUDDY_INTL_AUTH_PLATFORM = 'CLI'
/**
 * User-Agent for the two device-authorization calls.
 *
 * The gateway splits `/v2/plugin/*` by User-Agent: an App/CLI shape is answered
 * the plugin grant, anything else is refused or answered a browser document.
 */
export const WORKBUDDY_INTL_AUTH_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'
/**
 * User-Agent for the `/v3/config` product-document read.
 *
 * The gateway splits that path by User-Agent: the App-shaped `WorkBuddyAI/<v>`
 * (no space) is the form measured to reach the App document, while the CLI
 * shape is answered the older `/console/...` document, or refused outright.
 * Chat and refresh keep the CLI identity; only the directory read differs.
 */
export const WORKBUDDY_INTL_CATALOG_USER_AGENT = 'WorkBuddyAI/2.63.2'
/** Upstream business code for "the user has not finished signing in yet". */
export const WORKBUDDY_LOGIN_PENDING_CODE = 11217
/** A browser-authorization state stays answerable for ten minutes. */
export const WORKBUDDY_LOGIN_STATE_TTL_MS = 10 * 60_000
/**
 * Remaining-credit endpoints, split by resource class.
 *
 * The product's own plans-usage page asks three questions — a summary plus the
 * paid and free package details — and only the detail endpoints carry the real
 * remaining amount and expiry. The older aggregate
 * {@link WORKBUDDY_INTL_USER_RESOURCE_URL} is kept as a fallback for accounts
 * the newer trio does not answer for.
 */
export const WORKBUDDY_INTL_RESOURCE_SUMMARY_URL = `${WORKBUDDY_INTL_BASE_URL}/billing/meter/get-user-resource-summary`
export const WORKBUDDY_INTL_RESOURCE_PAID_URL = `${WORKBUDDY_INTL_BASE_URL}/billing/meter/get-user-resource-paid-packages`
export const WORKBUDDY_INTL_RESOURCE_FREE_URL = `${WORKBUDDY_INTL_BASE_URL}/billing/meter/get-user-resource-free-packages`
/** The product code the credit packages are issued under. */
export const WORKBUDDY_INTL_PRODUCT_CODE = 'p_tcaca'
/** Package codes the paid-credit query filters on (from the public plan page). */
export const WORKBUDDY_INTL_PAID_PACKAGE_CODES: readonly string[] = [
  'TCACA_code_002_AkiJS3ZHF5',
  'TCACA_code_023_4xbGhMrE6q',
  'TCACA_code_026_BaESVICNoi',
  'TCACA_code_027_0FCGVA6vSa',
  'TCACA_code_009_0XmEQc2xOf',
  'TCACA_code_038_OhvqZtiPKr',
]
/** Package codes the free/activity credit query filters on. */
export const WORKBUDDY_INTL_FREE_PACKAGE_CODES: readonly string[] = [
  'TCACA_code_008_cfWoLwvjU4',
  'TCACA_code_007_nzdH5h4Nl0',
  'TCACA_code_028_NtpWi0jzXs',
  'TCACA_code_029_6wCGEWquYy',
  'TCACA_code_030_BjSt89qTvr',
]
export const WORKBUDDY_INTL_CATALOG_TIMEOUT_MS = 8_000

export const VYCE_API_KEY_REF = credentialRef('VYCE_API_KEY')
export const VYCE_BASE_URL = 'https://vyceai.com/v1'
export const VYCE_ANTHROPIC_BASE_URL = 'https://vyceai.com'
export const VYCE_MODEL_PREFIX = 'vyce/'
/** VyceAI has no free roster: its daily check-in credits pay for metered
 * routes, so the ids here are the ones the plugin serves and prices. */
export const VYCE_MODELS = [
  { id: 'deepseek-v4.1', name: 'DeepSeek V4.1', inputPricePerMillion: 0.15, outputPricePerMillion: 0.6 },
] as const
export const VYCE_MODEL_IDS = VYCE_MODELS.map(model => model.id)

export const LOGFARE_API_KEY_REF = credentialRef('LOGFARE_API_KEY')
export const LOGFARE_SESSION_REF = credentialRef('LOGFARE_SESSION_COOKIE')
export const LOGFARE_BASE_URL = 'https://logfare.ai/v1'
export const LOGFARE_MODELS_URL = `${LOGFARE_BASE_URL}/models`
export const LOGFARE_STATUS_URL = `${LOGFARE_BASE_URL}/status?hours=1`
export const LOGFARE_REGISTER_URL = `${LOGFARE_BASE_URL}/auth/register`
export const LOGFARE_TRAINING_PREFERENCE_URL = `${LOGFARE_BASE_URL}/auth/training-preference`
export const LOGFARE_PROFILE_URL = `${LOGFARE_BASE_URL}/auth/me`
export const LOGFARE_CATALOG_TIMEOUT_MS = 10_000
export const LOGFARE_STATUS_TIMEOUT_MS = 30_000
export const LOGFARE_TRAINING_TIMEOUT_MS = 30_000
export const LOGFARE_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const LOGFARE_CATALOG_CACHE_TTL_MS = 10 * 60_000
export const LOGFARE_STATUS_CACHE_TTL_MS = 60_000
export const LOGFARE_MODEL_PREFIX = 'logfare/'
export const SENSENOVA_BASE_URL = 'https://token.sensenova.cn/v1'
export const SENSENOVA_MODELS_URL = `${SENSENOVA_BASE_URL}/models`
export const SENSENOVA_API_KEY_REF = credentialRef('SENSENOVA_API_KEY')
export const GROQ_WHISPER_BASE_URL = 'https://api.groq.com/openai/v1'
export const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo'
export const GROQ_WHISPER_API_KEY_REF = credentialRef('GROQ_WHISPER_API_KEY')
/**
 * How long a direct provider's answered directory narrows the static free tier.
 * SenseNova and NVIDIA both answer with a roster that can only *narrow* their
 * static list, so this is a freshness bound on an optimization — the static
 * roster is still what a reader sees when nothing has answered yet.
 */
export const DIRECT_CATALOG_CACHE_TTL_MS = 10 * 60_000

export const SENSENOVA_HEALTH_DESCRIPTION = 'health:operational|uptime:100|success:100|traffic:0|latency:na'
export const SENSENOVA_MODELS = [
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 128_000 },
] as const
export const SENSENOVA_IMAGE_MODELS = [
  { id: 'sensenova-u1.5-lite', name: 'SenseNova U1.5 Lite' },
  { id: 'sensenova-u1-fast', name: 'SenseNova U1 Fast' },
] as const

/** NVIDIA NIM OpenAI-compatible public endpoint. Free-tier routes need only
 * an API key from build.nvidia.com; the key stays in Host credentials. */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const NVIDIA_MODELS_URL = `${NVIDIA_BASE_URL}/models`
export const NVIDIA_API_KEY_REF = credentialRef('NVIDIA_API_KEY')
/** The NVIDIA routes this plugin offers. Membership here is the free/paid
 * signal: the NIM directory lists every hosted model, free or not, and the
 * account tier is not part of the `/models` answer. */
export const NVIDIA_MODELS = [
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  { id: 'deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813' },
  { id: 'deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731' },
  { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B IT' },
] as const

/** User-configured OpenAI-compatible free route. Its key stays in Host credentials. */
export const LOGFARE_AUTO_MODEL = {
  id: 'logfare/auto',
  name: 'Auto',
  baseURL: LOGFARE_BASE_URL,
} as const

/** Virtual OpenCode route resolved at request time to the current best free
 * model. The upstream free roster rotates (e.g. `hy3-free` disappeared from
 * the public directory while `big-pickle` appeared), so a pinned id silently
 * breaks summarization and advisor routing. */
export const OPENCODE_AUTO_MODEL = { id: 'auto', name: 'Auto' } as const

/** Resolution order for the virtual OpenCode `auto` route. `big-pickle` is
 * the preferred public route; the retired `hy3` is honored only while the
 * upstream still serves it; any other catalog row follows as a last resort
 * so the alias survives arbitrary roster rotations. */
export function openCodeAutoPreference(models: readonly OpenCodeFreeModel[]): OpenCodeFreeModel {
  const byId = new Map(models.map(model => [model.id.toLowerCase(), model]))
  for (const preferred of ['big-pickle', 'hy3']) {
    const found = byId.get(preferred)
    if (found !== undefined) return found
  }
  const fallback = models.find(model => model.id.toLowerCase() !== OPENCODE_AUTO_MODEL.id)
  if (fallback === undefined) throw new Error('OPENCODE_FREE_MODELS_UNAVAILABLE: no free model in the public directory and no built-in fallback loaded')
  return fallback
}

/** Public OpenCode models verified with the built-in `Bearer public` route.
 * Keep only rows that returned a successful zero-cost text completion; the
 * upstream `/models` directory also includes region-locked and unavailable
 * `-free` names. */
export interface OpenCodeFreeModel {
  readonly id: string
  readonly name: string
  readonly upstreamId: string
}

export function titleCaseModel(id: string): string {
  return id.split(/[-_/:]+/u).filter(Boolean).map(part => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ')
}
export interface OpenCodeCatalogCache {
  readonly savedAt: number
  readonly models: readonly OpenCodeFreeModel[]
}
export const MODEL_REASON_FREECODEGO_LOGIN = 'FREECODEGO_LOGIN_REQUIRED'
export const MODEL_REASON_OPENCODE_UNAVAILABLE = 'OPENCODE_MODEL_UNAVAILABLE'
// These are the levels accepted by the plugin's DeepSeek-compatible wire
// serializer. Do not advertise SDK-only levels that would fail at request time.
export const GATEWAY_REASONING_EFFORTS = ['off', 'low', 'high', 'xhigh', 'max'] as const
export const DIRECT_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type GatewayReasoningEffort = typeof GATEWAY_REASONING_EFFORTS[number]
export interface LogfareModel {
  readonly id: string
  readonly name: string
  readonly endpoints: readonly string[]
  readonly tier: 1 | 2 | 3
  readonly requiresTrainingOptIn: boolean
  readonly premiumUnlocked: boolean
  readonly health?: LogfareHealth
}
export interface LogfareHealth {
  readonly status: 'operational' | 'degraded' | 'unknown'
  readonly uptimePercent?: number
  readonly successRate?: number
  readonly latencyMs?: number
  readonly window?: '1h' | '7d' | '30m'
  readonly trafficTotal: number
}
interface ManagedCatalogCache {
  readonly savedAt: number
  readonly catalog: FreeCodeGoManagedCatalog
}

export function isGatewayReasoningEffort(value: unknown): value is GatewayReasoningEffort {
  return typeof value === 'string' && (GATEWAY_REASONING_EFFORTS as readonly string[]).includes(value)
}

export function isDirectReasoningEffort(value: unknown): value is typeof DIRECT_REASONING_EFFORTS[number] {
  return typeof value === 'string' && (DIRECT_REASONING_EFFORTS as readonly string[]).includes(value)
}

/** Advisor calls are text-only; media, embedding, ranking, and guard routes cannot review a turn. */
export function isAdvisorTextModel(model: { readonly id: string; readonly displayName?: string; readonly name?: string }): boolean {
  return !/(?:image|video|audio|embed(?:ding)?|rerank|moderation|guard)/i.test(`${model.id} ${model.displayName ?? model.name ?? ''}`)
}

/** Only routes that declare text input (or declare nothing) may serve the Advisor. */
export function isAdvisorTextModalities(inputModalities: readonly string[] | undefined): boolean {
  return inputModalities === undefined || (inputModalities.length === 1 && inputModalities[0] === 'text')
}

type HostSessionEvent = { readonly type: string; readonly time: number; readonly data: unknown }
export type HostSessionEvents = { readonly snapshotEvents?: () => readonly HostSessionEvent[]; readonly events?: readonly HostSessionEvent[] }

export function hostSessionEvents(session: HostSessionEvents): readonly { readonly type: string; readonly time: number; readonly data: unknown }[] {
  return session.snapshotEvents?.() ?? session.events ?? []
}

export function withTimeout<Value>(operation: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Value>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${label} timed out after ${timeoutMs}ms`)) }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

export function advisorNotesFromSession(session: { readonly id: unknown } & HostSessionEvents): FreeCodeGoAdvisorNote[] {
  const deliveries = new Map<string, FreeCodeGoAdvisorNote['delivery']>()
  for (const event of hostSessionEvents(session)) {
    if (event.type !== 'advisor/delivery') continue
    const data = record(event.data)
    if (typeof data.id === 'string' && (data.channel === 'record' || data.channel === 'inject' || data.channel === 'steer')) deliveries.set(data.id, data.channel)
  }
  return hostSessionEvents(session).flatMap((event) => {
    if (event.type !== 'advisor/note') return []
    const data = record(event.data)
    if (typeof data.id !== 'string' || typeof data.note !== 'string' || typeof data.turn !== 'number') return []
    if (data.severity !== 'nit' && data.severity !== 'concern' && data.severity !== 'blocker') return []
    return [{ id: data.id, sessionId: String(session.id), turn: data.turn, severity: data.severity, note: data.note, delivery: deliveries.get(data.id) ?? 'record', time: event.time }]
  })
}

/** Read durable Council reports without recovering transcript or tool payloads. */
export function advisorCouncilReportsFromSession(session: { readonly id: unknown } & HostSessionEvents): readonly FreeCodeGoAdvisorCouncilReport[] {
  return hostSessionEvents(session).flatMap((event) => {
    if (event.type !== 'advisor/council') return []
    const data = record(event.data)
    if (typeof data.id !== 'string' || typeof data.turn !== 'number' || typeof data.provider !== 'string' || typeof data.model !== 'string' || typeof data.createdAt !== 'number' || !Array.isArray(data.findings)) return []
    const findings = data.findings.flatMap((item): FreeCodeGoAdvisorCouncilReport['findings'] => {
      const finding = record(item)
      if ((finding.role !== 'architecture' && finding.role !== 'security' && finding.role !== 'testing') || (finding.severity !== 'nit' && finding.severity !== 'concern' && finding.severity !== 'blocker') || typeof finding.note !== 'string') return []
      return [{ role: finding.role, severity: finding.severity, note: finding.note }]
    })
    return [{ id: data.id, sessionId: typeof data.sessionId === 'string' ? data.sessionId : String(session.id), turn: data.turn, provider: data.provider, model: data.model, createdAt: data.createdAt, findings }]
  }).sort((left, right) => right.createdAt - left.createdAt).slice(0, 20)
}

/** Resolve a managed model's media role even when the gateway labels its wire
 * protocol as a generic OpenAI chat/responses protocol. The gateway catalog
 * currently reports gpt-image-2 as `openai_responses`, but it is still a
 * dedicated image-generation route and must be eligible for media defaults. */
export function mediaCategoryForManagedModel(model: { readonly id: string; readonly displayName: string; readonly protocol: string }): MediaCategory | undefined {
  const protocol = model.protocol.trim().toLowerCase()
  if (protocol === 'image_generation' || protocol === 'image-generation') return 'image'
  if (protocol === 'video_generation' || protocol === 'video-generation') return 'video'
  if (protocol === 'audio_speech' || protocol === 'audio-speech' || protocol === 'audio_transcription' || protocol === 'audio-transcription') return 'audio'
  return inferMediaCategory(`${model.id} ${model.displayName}`)
}

export function logfareMediaCategory(model: LogfareModel): MediaCategory | undefined {
  const endpoints = model.endpoints.join(' ').toLowerCase()
  if (endpoints.includes('image')) return 'image'
  if (endpoints.includes('video')) return 'video'
  if (/(?:audio|speech|tts)/.test(endpoints)) return 'audio'
  return inferMediaCategory(`${model.id} ${model.name}`)
}

/** Channel monitors are provider-level checks: one OpenAI row applies to all
 * OpenAI gateway models, and one Anthropic row applies to all Claude models. */
export function indexGatewayHealth(monitors: readonly FreeCodeGoGatewayProviderHealth[]): ReadonlyMap<string, LogfareHealth> {
  const health = new Map<string, LogfareHealth>()
  for (const monitor of monitors) {
    const latencyMs = monitor.latencyMs
    mergeGatewayProviderHealth(health, normalizeGatewayProvider(monitor.provider), {
      status: gatewayMonitorStatus(monitor.status),
      uptimePercent: monitor.availability7d,
      ...(latencyMs === undefined ? {} : { latencyMs }),
      window: '7d',
      trafficTotal: 0,
    })
  }
  return health
}

export function mergeGatewayProviderHealth(target: Map<string, LogfareHealth>, provider: string, candidate: LogfareHealth): void {
  if (provider === '') return
  const current = target.get(provider)
  if (current === undefined) { target.set(provider, candidate); return }
  // Several monitors can report the same provider. The merged row must expose
  // the WORST known observation so one failing channel cannot hide behind a
  // healthy sibling; 'unknown' is neutral and never masks a real status.
  const severity = { unknown: 0, operational: 1, degraded: 2 } as const
  const status = severity[candidate.status] >= severity[current.status] ? candidate.status : current.status
  // Uptime reflects only monitors that actually reported a status and takes
  // the minimum: users must see the least optimistic measurement.
  const uptime = [
    current.status === 'unknown' ? undefined : current.uptimePercent,
    candidate.status === 'unknown' ? undefined : candidate.uptimePercent,
  ].filter((value): value is number => value !== undefined)
  const latency = [current.latencyMs, candidate.latencyMs].filter((value): value is number => value !== undefined)
  const window = current.window ?? candidate.window
  target.set(provider, {
    status,
    ...(uptime.length === 0 ? {} : { uptimePercent: Math.min(...uptime) }),
    ...(latency.length === 0 ? {} : { latencyMs: Math.min(...latency) }),
    ...(window === undefined ? {} : { window }),
    trafficTotal: 0,
  })
}

export function normalizeGatewayProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'claude') return 'anthropic'
  return normalized
}

export function gatewayMonitorStatus(status: FreeCodeGoGatewayProviderHealth['status']): LogfareHealth['status'] {
  if (status === 'operational') return 'operational'
  if (status === 'degraded' || status === 'failed' || status === 'error') return 'degraded'
  return 'unknown'
}

/** OpenCode lists the actual upstream IDs exposed by the current public route. */
export async function fetchOpenCodeHealth(models: readonly OpenCodeFreeModel[]): Promise<ReadonlyMap<string, LogfareHealth>> {
  const startedAt = Date.now()
  const health = new Map<string, LogfareHealth>()
  try {
    const response = await fetch(`${OPENCODE_DIRECT_BASE_URL}/models`, {
      headers: { authorization: 'Bearer public', accept: 'application/json', 'x-opencode-client': 'desktop', 'user-agent': 'opencode/freecodego' },
      signal: AbortSignal.timeout(10_000),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      for (const model of models) health.set(model.id, { status: 'degraded', latencyMs, trafficTotal: 0 })
      return health
    }
    const payload = record(await response.json().catch(() => undefined))
    const advertised = new Set((Array.isArray(payload.data) ? payload.data : []).map(record).map(row => typeof row.id === 'string' ? row.id.trim().toLowerCase() : ''))
    for (const model of models) health.set(model.id, {
      // `/models` is a directory probe only; it does not prove that a chat
      // completion succeeds for this route. Keep the distinction explicit so
      // the UI cannot claim every listed model is healthy.
      status: advertised.has(model.upstreamId.toLowerCase()) ? 'unknown' : 'degraded',
      latencyMs,
      trafficTotal: 0,
    })
  } catch {
    for (const model of models) health.set(model.id, { status: 'unknown', trafficTotal: 0 })
  }
  return health
}

export function openCodeHealthDescription(health: LogfareHealth | undefined): string {
  if (health === undefined) return ' · health:unknown|uptime:na|success:na|traffic:0|latency:na|probe:directory'
  const latency = health.latencyMs === undefined ? 'na' : String(Math.round(health.latencyMs))
  return ` · health:${health.status}|uptime:na|success:na|traffic:0|latency:${latency}|probe:directory`
}

export function parseLogfareModel(value: unknown): LogfareModel | undefined {
  const item = record(value)
  const rawId = typeof item.id === 'string' ? item.id.trim() : ''
  const id = logfareModelKey(rawId) === 'auto' ? LOGFARE_AUTO_MODEL.id : rawId
  if (id === '') return undefined
  const endpoints = Array.isArray(item.endpoints) ? item.endpoints.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim()) : []
  const tier = item.tier === 2 || item.tier === 3 ? item.tier : 1
  const name = typeof item.display_name === 'string' && item.display_name.trim() !== '' ? item.display_name.trim() : id
  return {
    id,
    name,
    endpoints,
    tier,
    requiresTrainingOptIn: item.requires_training_optin === true,
    premiumUnlocked: item.premium_unlocked === true,
  }
}

export function logfareSelectionId(id: string): string {
  return logfareModelKey(id) === logfareModelKey(LOGFARE_AUTO_MODEL.id) ? LOGFARE_AUTO_MODEL.id : `${LOGFARE_MODEL_PREFIX}${id}`
}

/** Compare Logfare ids across the provider-prefixed and wire forms. */
export function logfareModelKey(id: string): string {
  const normalized = id.trim().toLowerCase()
  return normalized.replace(/^logfare\//u, '')
}

export function logfareSupportsChat(model: LogfareModel): boolean {
  // The auto route is a provider alias and may be omitted from the upstream
  // endpoint list. It is still a valid chat route when present in fallback or
  // persisted catalogs.
  return logfareModelKey(model.id) === logfareModelKey(LOGFARE_AUTO_MODEL.id) || model.endpoints.some(endpoint => endpoint.toLowerCase() === 'chat/completions')
}

export function logfareUsesTrainingData(model: LogfareModel): boolean {
  return logfareModelKey(model.id) === 'auto' || model.requiresTrainingOptIn
}

export async function fetchLogfareHealth(): Promise<ReadonlyMap<string, LogfareHealth>> {
  try {
    const response = await fetch(LOGFARE_STATUS_URL, { headers: { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' }, signal: AbortSignal.timeout(LOGFARE_STATUS_TIMEOUT_MS) })
    if (!response.ok) return new Map()
    const payload = record(await response.json())
    const health = new Map<string, LogfareHealth>()
    for (const item of Array.isArray(payload.data) ? payload.data : []) {
      const row = record(item)
      const rawId = typeof row.model_id === 'string' ? row.model_id.trim() : ''
      // Store aliases under one provider-local key (`auto` for both `auto`
      // and `logfare/auto`) so the live directory and health feed converge.
      const id = logfareModelKey(rawId)
      const status = row.status === 'operational' || row.status === 'degraded' || row.status === 'unknown' ? row.status : undefined
      if (id === '' || status === undefined) continue
      const uptimePercent = typeof row.uptime_percent === 'number' && Number.isFinite(row.uptime_percent) ? Math.max(0, Math.min(100, row.uptime_percent)) : undefined
      const successRate = typeof row.real_traffic_success_rate === 'number' && Number.isFinite(row.real_traffic_success_rate) ? Math.max(0, Math.min(1, row.real_traffic_success_rate)) : undefined
      const trafficTotal = typeof row.real_traffic_total === 'number' && Number.isSafeInteger(row.real_traffic_total) && row.real_traffic_total >= 0 ? row.real_traffic_total : 0
      health.set(id, { status, ...(uptimePercent === undefined ? {} : { uptimePercent }), ...(successRate === undefined ? {} : { successRate }), window: '1h', trafficTotal })
    }
    return health
  } catch {
    return new Map()
  }
}

export function logfareHealthDescription(health: LogfareHealth | undefined): string {
  if (health === undefined) return ''
  const uptime = health.uptimePercent === undefined ? 'na' : String(Math.round(health.uptimePercent * 10) / 10)
  const success = health.successRate === undefined ? 'na' : String(Math.round(health.successRate * 1_000) / 10)
  return ` · health:${health.status}|uptime:${uptime}|success:${success}|traffic:${health.trafficTotal}|latency:na|window:1h`
}

export function logfareSessionCookie(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const raw = headers.getSetCookie?.() ?? splitSetCookie(response.headers.get('set-cookie') ?? '')
  const pairs = raw.map(value => value.split(';', 1)[0]?.trim() ?? '').filter(value => /^[^=;\s]+=.+$/.test(value))
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/** Split a merged Set-Cookie header on pair boundaries. Older runtimes merge
 * multiple Set-Cookie fields into one comma-joined `get('set-cookie')` value;
 * the naive whole-string regex would then read the merged blob as one pair. */
export function splitSetCookie(value: string): readonly string[] {
  if (value === '') return []
  const parts: string[] = []
  let start = 0
  let index = 0
  while (index < value.length) {
    // A comma only separates two cookies when it lands after a cookie pair
    // (before the next `;` or end) and the following text opens `name=`.
    if (value[index] === ',') {
      const pairEnd = value.indexOf(';', index)
      const segment = value.slice(index + 1, pairEnd === -1 ? undefined : pairEnd)
      if (/^\s*[^\s=;]+=[^;]*/.test(segment)) {
        parts.push(value.slice(start, index))
        start = index + 1
      }
    }
    index += 1
  }
  parts.push(value.slice(start))
  return parts
}

export async function logfareResponseError(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '')
  if (body === '') return `${fallback} (HTTP ${response.status})`
  // Redacted before it is bounded: the registration call this reports on carries a
  // password, and an upstream that echoes what it rejected puts it in the message.
  // The sibling surfaces (provider errors, media details, job summaries) already do
  // this; this one was written before the shared redactor existed.
  try {
    const parsed = record(JSON.parse(body) as unknown)
    const error = record(parsed.error)
    const message = typeof error.message === 'string' ? error.message : typeof parsed.detail === 'string' ? parsed.detail : undefined
    if (message !== undefined && message.trim() !== '') return `${fallback}: ${redactCredentialShapes(message.trim()).slice(0, 300)}`
  } catch { /* Preserve a bounded text error below when the response is not JSON. */ }
  return `${fallback} (HTTP ${response.status}): ${redactCredentialShapes(body.replace(/\s+/g, ' ')).slice(0, 300)}`
}

export function zeroPrice(value: unknown): boolean {
  if (typeof value === 'number') return value === 0
  if (typeof value !== 'string' || value.trim() === '') return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

export async function readManagedCatalogCache(file: string): Promise<ManagedCatalogCache | undefined> {
  const value = await readJsonFile(file)
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return undefined
  const catalog = record(value.catalog)
  if (typeof catalog.catalogRevision !== 'string' || !Array.isArray(catalog.models)) return undefined
  const models: Array<FreeCodeGoManagedCatalog['models'][number]> = []
  for (const item of catalog.models) {
    const model = record(item)
    const id = typeof model.id === 'string' ? model.id : undefined
    const displayName = typeof model.displayName === 'string' ? model.displayName : undefined
    const provider = typeof model.provider === 'string' ? model.provider : undefined
    const protocol = typeof model.protocol === 'string' ? model.protocol : undefined
    const availability = typeof model.availability === 'string' ? model.availability : undefined
    const compatibleEngines = stringArray(model.compatibleEngines)
    const choices: Array<FreeCodeGoManagedCatalog['models'][number]['choices'][number]> = []
    if (Array.isArray(model.choices)) for (const choice of model.choices) {
      const row = record(choice)
      const routeKey = typeof row.routeKey === 'string' ? row.routeKey : undefined
      const label = typeof row.label === 'string' ? row.label : undefined
      const availability = typeof row.availability === 'string' ? row.availability : undefined
      const compatibleEngines = stringArray(row.compatibleEngines)
      if (routeKey === undefined || label === undefined || availability === undefined) continue
      // Every group-level field survives the cache round-trip: dropping one here
      // silently reverts the picker to "no group, no multiplier" after a restart.
      choices.push({ routeKey, label, availability, compatibleEngines,
        ...(typeof row.zeroPrice === 'boolean' ? { zeroPrice: row.zeroPrice } : {}),
        ...(typeof row.locked === 'boolean' ? { locked: row.locked } : {}),
        ...(typeof row.rateMultiplier === 'number' && Number.isFinite(row.rateMultiplier) ? { rateMultiplier: row.rateMultiplier } : {}),
        ...(typeof row.groupName === 'string' ? { groupName: row.groupName } : {}),
        ...(typeof row.groupId === 'number' && Number.isFinite(row.groupId) ? { groupId: row.groupId } : {}),
        ...(typeof row.protocol === 'string' ? { protocol: row.protocol } : {}),
        ...(typeof row.access === 'string' ? { access: row.access } : {}),
        ...(row.unlockRequired === true ? { unlockRequired: true } : {}),
        ...(typeof row.unlockReason === 'string' ? { unlockReason: row.unlockReason } : {}),
        ...(typeof row.unlockExpiresAt === 'string' ? { unlockExpiresAt: row.unlockExpiresAt } : {}),
      })
    }
    if (id === undefined || displayName === undefined || provider === undefined || protocol === undefined || availability === undefined) continue
    models.push({ id, displayName, provider, protocol, availability, compatibleEngines, choices })
  }
  // Group rows survive the cache round-trip for the same reason the choice-level
  // group fields do: a restart that dropped them would head the picker with a
  // model's vendor instead of the plan it is reached through.
  const groups: FreeCodeGoManagedCatalogGroup[] = []
  if (Array.isArray(catalog.groups)) for (const item of catalog.groups) {
    const group = record(item)
    const id = typeof group.id === 'number' && Number.isFinite(group.id) ? group.id : undefined
    const name = typeof group.name === 'string' && group.name.trim() !== '' ? group.name.trim() : undefined
    if (id === undefined || name === undefined) continue
    const rateMultiplier = typeof group.rateMultiplier === 'number' && Number.isFinite(group.rateMultiplier) ? group.rateMultiplier : undefined
    const sortOrder = typeof group.sortOrder === 'number' && Number.isFinite(group.sortOrder) ? group.sortOrder : undefined
    const text = (field: string): string | undefined => typeof group[field] === 'string' ? group[field] : undefined
    const description = text('description')
    const platform = text('platform')
    const protocol = text('protocol')
    const activityLabel = text('activityLabel')
    const unlockReason = text('unlockReason')
    const unlockExpiresAt = text('unlockExpiresAt')
    groups.push({ id, name, enabled: group.enabled !== false,
      // Without this the account's declared default group survives only until
      // the next restart, and unpinned selections fall back to a guess.
      ...(group.default === true ? { default: true as const } : {}),
      ...(description === undefined ? {} : { description }),
      ...(platform === undefined ? {} : { platform }),
      ...(protocol === undefined ? {} : { protocol }),
      ...(rateMultiplier === undefined ? {} : { rateMultiplier }),
      ...(activityLabel === undefined ? {} : { activityLabel }),
      ...(unlockReason === undefined ? {} : { unlockReason }),
      ...(unlockExpiresAt === undefined ? {} : { unlockExpiresAt }),
      ...(sortOrder === undefined ? {} : { sortOrder }),
    })
  }
  return { savedAt: value.savedAt, catalog: { catalogRevision: catalog.catalogRevision, ...(groups.length === 0 ? {} : { groups }), models } }
}

// ============================================================================
// Kilo Gateway (anonymous free models)
// ============================================================================

export const KILO_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/gateway'
export const KILO_MODELS_URL = `${KILO_GATEWAY_BASE_URL}/models`
export const KILO_CATALOG_CACHE_TTL_MS = 24 * 60 * 60_000
/** How long a roster that once answered stays usable when later fetches fail. */
export const KILO_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** Spacing between fetch attempts while the Kilo directory is unreachable. */
export const KILO_CATALOG_RETRY_MS = 60 * 60_000
export const KILO_ANONYMOUS_API_KEY = 'anonymous'
export const KILO_MODEL_PREFIX = 'kilo/'

export interface KiloFreeModel {
  readonly id: string
  readonly name: string
  readonly upstreamId: string
}

export interface KiloCatalogState {
  readonly expiresAt: number
  readonly models: readonly KiloFreeModel[]
}
