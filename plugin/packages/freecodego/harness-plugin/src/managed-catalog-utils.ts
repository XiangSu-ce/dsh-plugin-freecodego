import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { FreeCodeGoGatewayProviderHealth } from '@deepseek-ai/dsh-freecodego-api'
import { readJsonFile, stringArray } from './community-storage.ts'
import { inferMediaCategory, type MediaCategory } from './media-utils.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { asRecord as record } from './untrusted-json.ts'
import type { FreeCodeGoAdvisorCouncilReport, FreeCodeGoAdvisorNote, FreeCodeGoManagedCatalog, FreeCodeGoManagedCatalogGroup } from './types.ts'


/**
 * OpenCode's OpenAI-compatible direct route, reached with the built-in `Bearer public` key.
 */
export const OPENCODE_DIRECT_BASE_URL = 'https://opencode.ai/zen/v1'
/**
 * How long a probed OpenCode health snapshot stays fresh (1 hour).
 */
export const OPENCODE_HEALTH_CACHE_TTL_MS = 60 * 60_000
/**
 * How long a fetched OpenCode model directory is reused (ten minutes).
 *
 * It used to be a day, which made the picker a snapshot of yesterday: the free
 * roster gains and retires rows without notice — `mimo-v2.6-flash` was free
 * upstream while the cached rows still lacked it — and a day-long TTL meant the
 * menu kept offering the superseded set. Ten minutes is the same bound the
 * other directory caches use, so opening a picker revalidates instead of
 * re-reading a stale file.
 */
export const OPENCODE_CATALOG_CACHE_TTL_MS = 10 * 60_000
/**
 * How long a failed OpenCode directory read suppresses the next attempt, so a
 * picker that is opened repeatedly during an outage does not run a 15-second
 * fetch each time.
 */
export const OPENCODE_CATALOG_RETRY_MS = 60 * 60_000
/**
 * How long an OpenCode directory that once answered stays usable when later fetches fail (7 days).
 */
export const OPENCODE_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/**
 * How long the account's managed model catalog is reused before refetching (1 hour).
 */
export const MANAGED_MODEL_CATALOG_CACHE_TTL_MS = 60 * 60_000
/**
 * How long a gateway channel-health snapshot stays fresh (30 minutes).
 */
export const GATEWAY_HEALTH_CACHE_TTL_MS = 30 * 60_000
/**
 * How long one backend's "no channel-health route" verdict stands.
 *
 * Long enough that a backend without the route is not asked every cadence, but
 * bounded on purpose: a 404 can also come from a proxy or a deploy in flight,
 * and a route that does exist must not stay invisible for a whole session.
 */
export const GATEWAY_HEALTH_UNSUPPORTED_TTL_MS = 6 * 60 * 60_000
/**
 * Timeout for one managed model catalog fetch.
 */
export const MODEL_CATALOG_TIMEOUT_MS = 8_000
// ============================================================================
// WorkBuddy International Edition (workbuddy.ai)
// ============================================================================

/**
 * Root of the WorkBuddy international product site.
 */
export const WORKBUDDY_INTL_BASE_URL = 'https://www.workbuddy.ai'
/**
 * WorkBuddy international chat-completions endpoint.
 */
export const WORKBUDDY_INTL_CHAT_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/chat/completions`
/**
 * The product document that lists WorkBuddy's routes for this account.
 *
 * The App's main process fetches `/v3/config`; the gateway answers the older
 * `/console/enterprises/personal/models` document to CLI-shaped requests. Only
 * the product document describes the international pool this provider serves.
 */
export const WORKBUDDY_INTL_CONFIG_URL = `${WORKBUDDY_INTL_BASE_URL}/v3/config`
/**
 * Endpoint that refreshes a WorkBuddy device-authorization token pair.
 */
export const WORKBUDDY_INTL_TOKEN_REFRESH_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/plugin/auth/token/refresh`
/**
 * Legacy name for the WorkBuddy directory document.
 *
 * @deprecated Use {@link WORKBUDDY_INTL_CONFIG_URL}; kept for existing importers.
 */
export const WORKBUDDY_INTL_MODELS_URL = WORKBUDDY_INTL_CONFIG_URL
/**
 * Aggregate remaining-credit query for a WorkBuddy international account.
 */
export const WORKBUDDY_INTL_BILLING_URL = `${WORKBUDDY_INTL_BASE_URL}/v2/billing/meter/get-user-resource`
/**
 * Legacy name for the aggregate remaining-credit query.
 *
 * @deprecated Alias of {@link WORKBUDDY_INTL_BILLING_URL} for readers that
 * name the legacy aggregate resource query.
 */
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
/**
 * Remaining credits across the account's paid packages.
 */
export const WORKBUDDY_INTL_RESOURCE_PAID_URL = `${WORKBUDDY_INTL_BASE_URL}/billing/meter/get-user-resource-paid-packages`
/**
 * Remaining credits across the account's free/activity packages.
 */
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
/**
 * Timeout for one WorkBuddy directory read.
 */
export const WORKBUDDY_INTL_CATALOG_TIMEOUT_MS = 8_000

/**
 * Credential slot holding the VyceAI API key.
 */
export const VYCE_API_KEY_REF = credentialRef('VYCE_API_KEY')
/**
 * VyceAI's OpenAI-compatible endpoint root.
 */
export const VYCE_BASE_URL = 'https://vyceai.com/v1'
/**
 * VyceAI's OpenAI-compatible model directory.
 *
 * The endpoint is authenticated, so it is only read once a key is configured;
 * what it reports is the authority on which routes the account can reach.
 */
export const VYCE_MODELS_URL = `${VYCE_BASE_URL}/models`
/**
 * Timeout for one VyceAI directory read.
 */
export const VYCE_CATALOG_TIMEOUT_MS = 8_000
/**
 * How long a fetched VyceAI directory serves before it is read again.
 */
export const VYCE_CATALOG_CACHE_TTL_MS = 10 * 60_000
/**
 * VyceAI root for Anthropic-shaped requests.
 */
export const VYCE_ANTHROPIC_BASE_URL = 'https://vyceai.com'
/**
 * Provider prefix (`vyce/`) on every VyceAI selection id.
 */
export const VYCE_MODEL_PREFIX = 'vyce/'
/**
 * One row of the VyceAI roster.
 *
 * The price is optional because the live directory names routes the plugin
 * cannot price on its own: those rows still belong in the picker, they just do
 * not advertise a number the plugin has no source for.
 */
export interface VyceModel {
  readonly id: string
  readonly name: string
  readonly inputPricePerMillion?: number
  readonly outputPricePerMillion?: number
}
/** VyceAI has no free roster: its daily check-in credits pay for metered
 * routes. These are the ids the plugin knows before any directory answers, and
 * both are among the routes that start switched on in the model list — the
 * third default, `claude-sonnet-4-6`, is only named once the directory answers. */
export const VYCE_MODELS: readonly VyceModel[] = [
  { id: 'deepseek-v4.1', name: 'DeepSeek V4.1', inputPricePerMillion: 0.15, outputPricePerMillion: 0.6 },
  { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash' },
]
/**
 * Ids of the VyceAI routes the plugin knows without a directory read.
 */
export const VYCE_MODEL_IDS: readonly string[] = VYCE_MODELS.map(model => model.id)

/**
 * Credential slot holding the Logfare API key.
 */
export const LOGFARE_API_KEY_REF = credentialRef('LOGFARE_API_KEY')
/**
 * Credential slot holding the Logfare browser session cookie.
 */
export const LOGFARE_SESSION_REF = credentialRef('LOGFARE_SESSION_COOKIE')
/**
 * Logfare's OpenAI-compatible endpoint root.
 */
export const LOGFARE_BASE_URL = 'https://logfare.ai/v1'
/**
 * Logfare model directory endpoint.
 */
export const LOGFARE_MODELS_URL = `${LOGFARE_BASE_URL}/models`
/**
 * Logfare uptime/status endpoint (last hour).
 */
export const LOGFARE_STATUS_URL = `${LOGFARE_BASE_URL}/status?hours=1`
/**
 * Logfare account-registration endpoint.
 */
export const LOGFARE_REGISTER_URL = `${LOGFARE_BASE_URL}/auth/register`
/**
 * Logfare endpoint that reads or sets the training-data preference.
 */
export const LOGFARE_TRAINING_PREFERENCE_URL = `${LOGFARE_BASE_URL}/auth/training-preference`
/**
 * Logfare authenticated profile endpoint.
 */
export const LOGFARE_PROFILE_URL = `${LOGFARE_BASE_URL}/auth/me`
/**
 * Timeout for one Logfare directory read.
 */
export const LOGFARE_CATALOG_TIMEOUT_MS = 10_000
/**
 * Timeout for one Logfare status read.
 */
export const LOGFARE_STATUS_TIMEOUT_MS = 30_000
/**
 * Timeout for one Logfare training-preference call.
 */
export const LOGFARE_TRAINING_TIMEOUT_MS = 30_000
/**
 * Desktop-browser User-Agent the Logfare site answers to on non-API pages.
 */
export const LOGFARE_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/**
 * How long a fetched Logfare directory is reused (10 minutes).
 */
export const LOGFARE_CATALOG_CACHE_TTL_MS = 10 * 60_000
/**
 * How long a Logfare status snapshot stays fresh (1 minute).
 */
export const LOGFARE_STATUS_CACHE_TTL_MS = 60_000
/**
 * Provider prefix (`logfare/`) on every Logfare selection id.
 */
export const LOGFARE_MODEL_PREFIX = 'logfare/'
/**
 * SenseNova's OpenAI-compatible endpoint root.
 */
export const SENSENOVA_BASE_URL = 'https://token.sensenova.cn/v1'
/**
 * SenseNova model directory endpoint.
 */
export const SENSENOVA_MODELS_URL = `${SENSENOVA_BASE_URL}/models`
/**
 * Credential slot holding the SenseNova API key.
 */
export const SENSENOVA_API_KEY_REF = credentialRef('SENSENOVA_API_KEY')
/**
 * Groq's OpenAI-compatible endpoint root, used here for Whisper transcription.
 */
export const GROQ_WHISPER_BASE_URL = 'https://api.groq.com/openai/v1'
/**
 * Groq Whisper model id the plugin transcribes with.
 */
export const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo'
/**
 * Credential slot holding the Groq API key.
 */
export const GROQ_WHISPER_API_KEY_REF = credentialRef('GROQ_WHISPER_API_KEY')
/**
 * How long a direct provider's answered directory narrows the static free tier.
 * SenseNova and NVIDIA both answer with a roster that can only *narrow* their
 * static list, so this is a freshness bound on an optimization — the static
 * roster is still what a reader sees when nothing has answered yet.
 */
export const DIRECT_CATALOG_CACHE_TTL_MS = 10 * 60_000

/**
 * Static health line shown for SenseNova until a live check answers.
 */
export const SENSENOVA_HEALTH_DESCRIPTION = 'health:operational|uptime:100|success:100|traffic:0|latency:na'
/**
 * SenseNova's static free text roster.
 */
export const SENSENOVA_MODELS = [
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 128_000 },
] as const
/**
 * SenseNova's static image-generation roster.
 */
export const SENSENOVA_IMAGE_MODELS = [
  { id: 'sensenova-u1.5-lite', name: 'SenseNova U1.5 Lite' },
  { id: 'sensenova-u1-fast', name: 'SenseNova U1 Fast' },
] as const

/** NVIDIA NIM OpenAI-compatible public endpoint. Free-tier routes need only
 * an API key from build.nvidia.com; the key stays in Host credentials. */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
/**
 * NVIDIA NIM model directory endpoint.
 */
export const NVIDIA_MODELS_URL = `${NVIDIA_BASE_URL}/models`
/**
 * Credential slot holding the NVIDIA API key.
 */
export const NVIDIA_API_KEY_REF = credentialRef('NVIDIA_API_KEY')
/** The NVIDIA routes this plugin offers. Membership here is the free/paid
 * signal: the NIM directory lists every hosted model, free or not, and the
 * account tier is not part of the `/models` answer. */
export const NVIDIA_MODELS = [
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  { id: 'deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813' },
  { id: 'deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731' },
  { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B IT' },
  { id: 'z-ai/glm-5.3', name: 'GLM 5.3' },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' },
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
 * so the alias survives arbitrary roster rotations. 
 * @returns the open Code Free Model.
 * @param models - the current public OpenCode roster to resolve against.
 */
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

/**
 * Whether two OpenCode rosters name the same rows, in the same order.
 *
 * This decides whether a successful directory read is worth announcing to the
 * client. The announcement makes `ui-model-selection` rebuild its model
 * directory, and a rebuild tears down an open picker — so a read that changed
 * nothing must stay silent, or the menu closes a tick after it opens.
 * @param before - the roster that was being served, when there was one.
 * @param after - the roster the directory just returned.
 * @returns true when every id, name and upstream alias matches, position included.
 */
export function sameOpenCodeRoster(before: readonly OpenCodeFreeModel[] | undefined, after: readonly OpenCodeFreeModel[]): boolean {
  if (before === undefined || before.length !== after.length) return false
  return before.every((model, index) => model.id === after[index]?.id && model.name === after[index]?.name && model.upstreamId === after[index]?.upstreamId)
}

/**
 * Pick OpenCode's free rows out of a `/models` payload.
 *
 * The rule is a policy, not a roster: a row counts as free when the directory
 * says so (`free`/`is_free`/`zero_price`, or zero prompt *and* completion
 * prices), when its id ends in `free`, or when it belongs to the two families
 * whose public feed omits pricing entirely (the pickle and muse-spark routes).
 * Rows that OpenCode later withdraws therefore leave this list on the next
 * read instead of being carried until someone edits a constant.
 *
 * Exported so the documentation generator (`scripts/generate-free-model-tables`)
 * derives its tables from the same rule the picker uses; a second copy of this
 * filter is how the published tables drift from what the menu actually lists.
 * @param rows - the `data` array of a directory payload, unvalidated.
 * @returns the free rows, directory order, with the `-free` suffix stripped from the selection id.
 */
export function parseOpenCodeDirectory(rows: readonly unknown[]): readonly OpenCodeFreeModel[] {
  const models: OpenCodeFreeModel[] = []
  const seen = new Set<string>()
  for (const value of rows) {
    const row = record(value)
    const upstreamId = typeof row.id === 'string' ? row.id.trim() : ''
    if (upstreamId === '') continue
    // `asRecord` answers an object for anything, so the undefined arm has to be
    // kept here: a row without pricing is what the feed omits for the two route
    // families below, and the check is the one that says so.
    const pricing = row.pricing === undefined ? undefined : record(row.pricing)
    const explicitFree = row.free === true || row.is_free === true || row.zero_price === true
      || (pricing !== undefined && zeroPrice(pricing.prompt) && zeroPrice(pricing.completion))
    // OpenCode's public feed currently omits pricing for two named public
    // routes (the pickle and muse-spark families). Keep the policy pattern
    // based rather than maintaining a fixed model roster; future `-free`
    // rows are accepted automatically as they appear.
    if (!explicitFree && !/(?:^|-|:)free$/iu.test(upstreamId) && !/(?:pickle|muse[-_.]?spark)/iu.test(upstreamId)) continue
    const id = upstreamId.replace(/-free$/iu, '')
    if (id === '' || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    const display = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim().replace(/\s+free$/iu, '') : titleCaseModel(id)
    models.push({ id, name: display, upstreamId })
  }
  return models
}

/**
 * Turn a model id into a display name, splitting on separators and title-casing each part.
 * @param id - the model id to format.
 * @returns the title-cased display name.
 */
export function titleCaseModel(id: string): string {
  return id.split(/[-_/:]+/u).filter(Boolean).map(part => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ')
}
/**
 * A persisted snapshot of the verified OpenCode free roster.
 */
export interface OpenCodeCatalogCache {
  readonly savedAt: number
  readonly models: readonly OpenCodeFreeModel[]
}
/**
 * Reason code telling the picker the user must sign in to FreeCodeGo.
 */
export const MODEL_REASON_FREECODEGO_LOGIN = 'FREECODEGO_LOGIN_REQUIRED'
/**
 * Reason code telling the picker no OpenCode model is available.
 */
export const MODEL_REASON_OPENCODE_UNAVAILABLE = 'OPENCODE_MODEL_UNAVAILABLE'
// These are the levels accepted by the plugin's DeepSeek-compatible wire
// serializer. Do not advertise SDK-only levels that would fail at request time.
/**
 * Reasoning levels the gateway wire serializer accepts, in ascending effort.
 */
export const GATEWAY_REASONING_EFFORTS = ['off', 'low', 'high', 'xhigh', 'max'] as const
/**
 * Reasoning levels the direct (non-gateway) providers accept.
 */
export const DIRECT_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/**
 * One reasoning-effort level the gateway accepts.
 */
export type GatewayReasoningEffort = typeof GATEWAY_REASONING_EFFORTS[number]
/**
 * One Logfare route as parsed from the provider directory.
 */
export interface LogfareModel {
  readonly id: string
  readonly name: string
  readonly endpoints: readonly string[]
  readonly tier: 1 | 2 | 3
  readonly requiresTrainingOptIn: boolean
  readonly premiumUnlocked: boolean
  readonly health?: LogfareHealth
}
/**
 * A health observation for one route or provider.
 */
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

/**
 * Whether a value is a reasoning level the gateway accepts.
 * @param value - the value to test.
 * @returns whether `value` is a gateway reasoning effort.
 */
export function isGatewayReasoningEffort(value: unknown): value is GatewayReasoningEffort {
  return typeof value === 'string' && (GATEWAY_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Whether a value is a reasoning level the direct providers accept.
 * @param value - the value to test.
 * @returns whether `value` is a direct reasoning effort.
 */
export function isDirectReasoningEffort(value: unknown): value is typeof DIRECT_REASONING_EFFORTS[number] {
  return typeof value === 'string' && (DIRECT_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Advisor calls are text-only; media, embedding, ranking, and guard routes cannot review a turn.
 * @param model - the model whose id and name are tested for a media, embedding, or guard route.
 * @returns whether the route can review a turn as text.
 */
export function isAdvisorTextModel(model: { readonly id: string; readonly displayName?: string; readonly name?: string }): boolean {
  return !/(?:image|video|audio|embed(?:ding)?|rerank|moderation|guard)/i.test(`${model.id} ${model.displayName ?? model.name ?? ''}`)
}

/**
 * Only routes that declare text input (or declare nothing) may serve the Advisor.
 * @param inputModalities - the route's declared input modalities, or `undefined` when it declares none.
 * @returns whether the route may serve the Advisor.
 */
export function isAdvisorTextModalities(inputModalities: readonly string[] | undefined): boolean {
  return inputModalities === undefined || (inputModalities.length === 1 && inputModalities[0] === 'text')
}

type HostSessionEvent = { readonly type: string; readonly time: number; readonly data: unknown }
/**
 * The event sources a host session may expose: a live snapshot function or a stored event list.
 */
export type HostSessionEvents = { readonly snapshotEvents?: () => readonly HostSessionEvent[]; readonly events?: readonly HostSessionEvent[] }

/**
 * Read a host session's events from whichever source it exposes.
 * @param session - the session whose events are read.
 * @returns the session's events, empty when it exposes neither source.
 */
export function hostSessionEvents(session: HostSessionEvents): readonly { readonly type: string; readonly time: number; readonly data: unknown }[] {
  return session.snapshotEvents?.() ?? session.events ?? []
}

/**
 * Reject with a labelled error when a promise does not settle in time.
 * @param operation - the promise to await.
 * @param timeoutMs - how long to wait before rejecting.
 * @param label - the operation name used in the timeout error.
 * @returns the operation's value, or a rejection when it times out.
 */
export function withTimeout<Value>(operation: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Value>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${label} timed out after ${timeoutMs}ms`)) }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

/**
 * Recover advisor notes and their delivery channels from a session's events.
 * @param session - the session whose advisor events are read.
 * @returns the advisor note rows, in event order.
 */
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

/** Read durable Council reports without recovering transcript or tool payloads. 
 * @returns the advisor Council Report rows, in backend order.
 * @param session - the session whose Council events are read.
 */
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
/**
 * edicated image-generation route and must be eligible for media defaults.
 * @param model - the managed model whose id, display name, and protocol are inspected.
 * @returns the media category the model serves, or `undefined` for a text route.
 */
export function mediaCategoryForManagedModel(model: { readonly id: string; readonly displayName: string; readonly protocol: string }): MediaCategory | undefined {
  const protocol = model.protocol.trim().toLowerCase()
  if (protocol === 'image_generation' || protocol === 'image-generation') return 'image'
  if (protocol === 'video_generation' || protocol === 'video-generation') return 'video'
  if (protocol === 'audio_speech' || protocol === 'audio-speech' || protocol === 'audio_transcription' || protocol === 'audio-transcription') return 'audio'
  return inferMediaCategory(`${model.id} ${model.displayName}`)
}

/**
 * Resolve a Logfare route's media role from its declared endpoints and name.
 * @param model - the Logfare route to classify.
 * @returns the media category the route serves, or `undefined` for text.
 */
export function logfareMediaCategory(model: LogfareModel): MediaCategory | undefined {
  const endpoints = model.endpoints.join(' ').toLowerCase()
  if (endpoints.includes('image')) return 'image'
  if (endpoints.includes('video')) return 'video'
  if (/(?:audio|speech|tts)/.test(endpoints)) return 'audio'
  return inferMediaCategory(`${model.id} ${model.name}`)
}

/** Channel monitors are provider-level checks: one OpenAI row applies to all
/**
 * penAI gateway models, and one Anthropic row applies to all Claude models.
 * @param monitors - the provider-level channel monitors to index.
 * @returns a per-provider health map, merged across monitors of the same provider.
 */
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

/**
 * Fold one provider health observation into a map, keeping the worst status and the least optimistic measurements.
 * @param target - the map to merge into, mutated in place.
 * @param provider - the normalized provider key; an empty key is ignored.
 * @param candidate - the observation to merge.
 */
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

/**
 * Normalize a gateway provider name to its provider-local key.
 * @param provider - the raw provider name.
 * @returns the lower-cased key, mapping `claude` to `anthropic`.
 */
export function normalizeGatewayProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'claude') return 'anthropic'
  return normalized
}

/**
 * Map a gateway monitor status onto the provider-local health status vocabulary.
 * @param status - the gateway monitor's status.
 * @returns the matching health status; unrecognized values map to `unknown`.
 */
export function gatewayMonitorStatus(status: FreeCodeGoGatewayProviderHealth['status']): LogfareHealth['status'] {
  if (status === 'operational') return 'operational'
  if (status === 'degraded' || status === 'failed' || status === 'error') return 'degraded'
  return 'unknown'
}

/**
 * OpenCode lists the actual upstream IDs exposed by the current public route.
 * @param models - the verified OpenCode roster to probe.
 * @returns a per-model health map from the directory probe.
 */
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

/**
 * Render an OpenCode health observation as the picker's health line.
 * @param health - the observation to render, or `undefined` before any probe.
 * @returns the health description string.
 */
export function openCodeHealthDescription(health: LogfareHealth | undefined): string {
  if (health === undefined) return ' · health:unknown|uptime:na|success:na|traffic:0|latency:na|probe:directory'
  const latency = health.latencyMs === undefined ? 'na' : String(Math.round(health.latencyMs))
  return ` · health:${health.status}|uptime:na|success:na|traffic:0|latency:${latency}|probe:directory`
}

/**
 * Parse one Logfare directory entry into a route, mapping the auto alias onto its built-in id.
 * @param value - the raw directory entry.
 * @returns the parsed route, or `undefined` when it has no id.
 */
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

/**
 * Build the provider-prefixed selection id for a Logfare route, keeping the auto alias unprefixed.
 * @param id - the route id or alias.
 * @returns the selection id the catalog exposes.
 */
export function logfareSelectionId(id: string): string {
  return logfareModelKey(id) === logfareModelKey(LOGFARE_AUTO_MODEL.id) ? LOGFARE_AUTO_MODEL.id : `${LOGFARE_MODEL_PREFIX}${id}`
}

/**
 * Compare Logfare ids across the provider-prefixed and wire forms.
 * @param id - the id in either the provider-prefixed or wire form.
 * @returns the comparison key with the provider prefix stripped.
 */
export function logfareModelKey(id: string): string {
  const normalized = id.trim().toLowerCase()
  return normalized.replace(/^logfare\//u, '')
}

/**
 * Whether a Logfare route serves chat completions, treating the auto alias as a valid chat route.
 * @param model - the route to test.
 * @returns whether the route can serve chat completions.
 */
export function logfareSupportsChat(model: LogfareModel): boolean {
  // The auto route is a provider alias and may be omitted from the upstream
  // endpoint list. It is still a valid chat route when present in fallback or
  // persisted catalogs.
  return logfareModelKey(model.id) === logfareModelKey(LOGFARE_AUTO_MODEL.id) || model.endpoints.some(endpoint => endpoint.toLowerCase() === 'chat/completions')
}

/**
 * Whether a Logfare route may train on its traffic, treating the auto alias as training-enabled.
 * @param model - the route to test.
 * @returns whether the route uses training data.
 */
export function logfareUsesTrainingData(model: LogfareModel): boolean {
  return logfareModelKey(model.id) === 'auto' || model.requiresTrainingOptIn
}

/**
 * Fetch Logfare's live per-route status, keyed by the comparison form of each route id.
 * @returns a per-route health map, empty when the status call fails.
 */
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

/**
 * Render a Logfare health observation as the picker's health line.
 * @param health - the observation to render, or `undefined` when none is known.
 * @returns the health description string, empty when no observation is known.
 */
export function logfareHealthDescription(health: LogfareHealth | undefined): string {
  if (health === undefined) return ''
  const uptime = health.uptimePercent === undefined ? 'na' : String(Math.round(health.uptimePercent * 10) / 10)
  const success = health.successRate === undefined ? 'na' : String(Math.round(health.successRate * 1_000) / 10)
  return ` · health:${health.status}|uptime:${uptime}|success:${success}|traffic:${health.trafficTotal}|latency:na|window:1h`
}

/**
 * Extract the session cookie pairs from a response, preferring the runtime's split `getSetCookie()`.
 * @param response - the response whose Set-Cookie headers are read.
 * @returns the joined `name=value` pairs, or `undefined` when none are present.
 */
export function logfareSessionCookie(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const raw = headers.getSetCookie?.() ?? splitSetCookie(response.headers.get('set-cookie') ?? '')
  const pairs = raw.map(value => value.split(';', 1)[0]?.trim() ?? '').filter(value => /^[^=;\s]+=.+$/.test(value))
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/** Split a merged Set-Cookie header on pair boundaries. Older runtimes merge
 * multiple Set-Cookie fields into one comma-joined `get('set-cookie')` value;
/**
 * he naive whole-string regex would then read the merged blob as one pair.
 * @param value - the merged header value to split.
 * @returns the individual Set-Cookie strings, in order.
 */
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

/**
 * Build a bounded, credential-redacted error message from a failed upstream response.
 * @param response - the failed response whose body is read.
 * @param fallback - the message used when the body carries none.
 * @returns the error message, with any credential-shaped text redacted.
 */
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

/**
 * Whether a price value represents zero, accepting either a number or its numeric string.
 * @param value - the price value to test.
 * @returns whether the value is a finite zero.
 */
export function zeroPrice(value: unknown): boolean {
  if (typeof value === 'number') return value === 0
  if (typeof value !== 'string' || value.trim() === '') return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

/**
 * Read and validate the persisted managed model catalog, dropping malformed rows.
 * @param file - the cache file path.
 * @returns the parsed cache, or `undefined` when the file is missing or malformed.
 */
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

/**
 * Kilo Gateway's anonymous model endpoint root.
 */
export const KILO_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/gateway'
/**
 * Kilo Gateway model directory endpoint.
 */
export const KILO_MODELS_URL = `${KILO_GATEWAY_BASE_URL}/models`
/**
 * How long a fetched Kilo directory is reused (24 hours).
 */
export const KILO_CATALOG_CACHE_TTL_MS = 24 * 60 * 60_000
/** How long a roster that once answered stays usable when later fetches fail. */
export const KILO_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** Spacing between fetch attempts while the Kilo directory is unreachable. */
export const KILO_CATALOG_RETRY_MS = 60 * 60_000
/**
 * The placeholder key Kilo's anonymous free routes accept.
 */
export const KILO_ANONYMOUS_API_KEY = 'anonymous'
/**
 * Provider prefix (`kilo/`) on every Kilo selection id.
 */
export const KILO_MODEL_PREFIX = 'kilo/'

/**
 * Compare Kilo ids across the picker-prefixed and directory forms.
 *
 * Every Kilo selection id carries the `kilo/` prefix (`listKiloModels`
 * namespaces its rows with it), while the public directory lists the same routes
 * bare (`nex-agi/nex-n2.5-pro`). Resolving a selection therefore has to compare
 * the two spellings through one key — matching the prefixed selection against the
 * bare roster found nothing and failed every Kilo route with "not available in
 * the public directory". `logfareModelKey` is the same rule for the provider that
 * has always worked this way.
 * @param id - the id in either the picker-prefixed or directory form.
 * @returns the comparison key with the provider prefix stripped.
 */
export function kiloModelKey(id: string): string {
  const normalized = id.trim().toLowerCase()
  return normalized.replace(/^kilo\//u, '')
}

/**
 * One Kilo free route as exposed to the picker.
 */
export interface KiloFreeModel {
  readonly id: string
  readonly name: string
  readonly upstreamId: string
}

/**
 * A cached Kilo roster with its expiry.
 */
export interface KiloCatalogState {
  readonly expiresAt: number
  readonly models: readonly KiloFreeModel[]
}

/**
 * Pick Kilo's free rows out of its anonymous `/models` payload.
 *
 * `isFree`/`free` and a zero price are the three ways Kilo states "this route
 * costs nothing", and the `:free` suffix stays on the directory spelling
 * (`upstreamId`) while the selection id drops it. Exported for the same reason
 * `parseOpenCodeDirectory` is: the published free-model tables and the picker
 * must not answer this question twice.
 * @param rows - the `data` array of the gateway payload, unvalidated.
 * @returns the free routes, directory order, deduplicated by directory id.
 */
export function parseKiloDirectory(rows: readonly unknown[]): readonly KiloFreeModel[] {
  const models: KiloFreeModel[] = []
  const seen = new Set<string>()
  for (const value of rows) {
    const row = record(value)
    const upstreamId = typeof row.id === 'string' ? row.id.trim() : ''
    if (upstreamId === '' || seen.has(upstreamId.toLowerCase())) continue
    // Filter to free models only
    if (row.isFree !== true && row.free !== true && !zeroPrice(row.price)) continue
    // Skip models with :free suffix already - keep original id
    const id = upstreamId.replace(/:free$/i, '')
    const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : titleCaseModel(id)
    models.push({ id, name, upstreamId })
    seen.add(upstreamId.toLowerCase())
  }
  return models
}
