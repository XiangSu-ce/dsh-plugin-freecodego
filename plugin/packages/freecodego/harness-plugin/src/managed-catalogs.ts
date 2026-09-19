/**
 * Adapter registration and the hosted managed-model directory for the
 * FreeCodeGo Harness plugin: provider adapters registered into the LLM
 * registry, plus the cached catalogs, health probes, and reasoning-effort
 * bookkeeping behind the model picker.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/managed-catalogs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FreeCodeGoSettingsReadPort } from './policy.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { harnessHomeDirectory } from './data-home.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { FreeCodeGoAccountCoordinator, FreeCodeGoApiClient, FreeCodeGoManagedRuntime } from '@deepseek-ai/dsh-freecodego-api'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { FreeCodeGoManagedCatalog, FreeCodeGoCapabilitySettings, FreeCodeGoAdvisorSettings, FreeCodeGoPluginConflictSettings, FreeCodeGoPluginUpdateSettings, FreeCodeGoEngineeringSettings, WorkBuddyInternationalAccount, WorkBuddyInternationalModel } from './types.ts'
import type { ClaudeProtocolBridge } from './claude-protocol-bridge.ts'
import { AgnesAdapter, agnesMediaCategory, AGNES_DOCUMENTED_MODELS } from './agnes.ts'
import type { AgnesClient } from './agnes.ts'
import { ClineAdapter } from './cline.ts'
import type { ClineClient } from './cline.ts'
import { readWorkBuddyIntlAccounts, readWorkBuddyIntlActiveId, workBuddyIntlAccountId, WORKBUDDY_INTL_STORE_REF, WorkBuddyIntlAdapter } from './workbuddy-intl.ts'
import type { WorkBuddyIntlClient } from './workbuddy-intl.ts'
import type { WorkBuddyAccountUpdate } from './workbuddy-pool.ts'
import { OpenAiCompatibleAdapter } from './openai-compatible-adapter.ts'
import type { OpenAiCompatibleConnection } from './openai-compatible-adapter.ts'
import { expandGroupPinnedModels, imageInputModalities, mergeCatalogModels, modelMultiplierDescription, modelRowGroupBlock, parseGroupPin } from './model-catalog.ts'
import { activeAccountIdAfterRemoval, backendNotConfigured } from './account-utils.ts'

/** Bilingual hint appended to every direct-provider 429 error: the proxy
 * exit IP is the usual cause of rate limiting on these free upstreams. */
export const RATE_LIMIT_PROXY_HINT = '当前 IP 可能被上游限流：请尝试关闭本地/全局代理后重试。\nYour current IP may be rate-limited by the upstream: try disabling your local/global proxy and retry.'
import { readJsonFile, writeJsonFile } from './community-storage.ts'
import { PendingWriteDrain } from './abort-drain.ts'
import { mediaSelection } from './media-utils.ts'
import { record, text } from './media-generation.ts'
import {
  DIRECT_REASONING_EFFORTS, fetchLogfareHealth, fetchOpenCodeHealth,
  DIRECT_CATALOG_CACHE_TTL_MS,
  GATEWAY_HEALTH_CACHE_TTL_MS, GATEWAY_HEALTH_UNSUPPORTED_TTL_MS, GATEWAY_REASONING_EFFORTS, GROQ_WHISPER_API_KEY_REF,
  indexGatewayHealth, isDirectReasoningEffort, isGatewayReasoningEffort, KILO_ANONYMOUS_API_KEY,
  KILO_CATALOG_CACHE_TTL_MS, KILO_CATALOG_MAX_AGE_MS, KILO_CATALOG_RETRY_MS, KILO_GATEWAY_BASE_URL, KILO_MODEL_PREFIX, KILO_MODELS_URL,
  LOGFARE_API_KEY_REF, LOGFARE_AUTO_MODEL, OPENCODE_AUTO_MODEL, openCodeAutoPreference,
  LOGFARE_BASE_URL, LOGFARE_BROWSER_USER_AGENT, LOGFARE_CATALOG_CACHE_TTL_MS, LOGFARE_CATALOG_TIMEOUT_MS,
  LOGFARE_MODELS_URL, LOGFARE_PROFILE_URL, LOGFARE_SESSION_REF, LOGFARE_STATUS_CACHE_TTL_MS,
  LOGFARE_TRAINING_PREFERENCE_URL, LOGFARE_TRAINING_TIMEOUT_MS,
  logfareHealthDescription, logfareModelKey, logfareResponseError, logfareSelectionId, logfareSupportsChat,
  logfareUsesTrainingData, MANAGED_MODEL_CATALOG_CACHE_TTL_MS, MODEL_CATALOG_TIMEOUT_MS, MODEL_REASON_FREECODEGO_LOGIN,
  MODEL_REASON_OPENCODE_UNAVAILABLE, OPENCODE_CATALOG_CACHE_TTL_MS, OPENCODE_CATALOG_MAX_AGE_MS, OPENCODE_DIRECT_BASE_URL,
  OPENCODE_HEALTH_CACHE_TTL_MS, openCodeHealthDescription, parseLogfareModel, readManagedCatalogCache,
  NVIDIA_API_KEY_REF, NVIDIA_BASE_URL, NVIDIA_MODELS, NVIDIA_MODELS_URL,
  SENSENOVA_API_KEY_REF, SENSENOVA_BASE_URL, SENSENOVA_HEALTH_DESCRIPTION, SENSENOVA_MODELS, SENSENOVA_MODELS_URL,
  VYCE_ANTHROPIC_BASE_URL, VYCE_API_KEY_REF, VYCE_BASE_URL, VYCE_MODEL_IDS, VYCE_MODEL_PREFIX, VYCE_MODELS,
  WORKBUDDY_INTL_TOKEN_REFRESH_URL,
  titleCaseModel, zeroPrice,
} from './managed-catalog-utils.ts'
import type { GatewayReasoningEffort, KiloCatalogState, KiloFreeModel, LogfareHealth, LogfareModel, OpenCodeCatalogCache, OpenCodeFreeModel } from './managed-catalog-utils.ts'

export const FREE_UPSTREAM_MODELS: readonly OpenCodeFreeModel[] = [
  { id: 'mimo-v2.5', name: 'MiMo V2.5', upstreamId: 'mimo-v2.5-free' },
  { id: 'big-pickle', name: 'Big Pickle', upstreamId: 'big-pickle' },
  { id: 'hy3', name: 'HY3', upstreamId: 'hy3-free' },
  { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra', upstreamId: 'nemotron-3-ultra-free' },
  { id: 'nemotron-3.5-lightning', name: 'Nemotron 3.5 Lightning', upstreamId: 'nemotron-3.5-lightning-free' },
]

const LOGFARE_FALLBACK_MODELS: readonly LogfareModel[] = [
  { id: LOGFARE_AUTO_MODEL.id, name: LOGFARE_AUTO_MODEL.name, endpoints: ['chat/completions', 'messages', 'responses'], tier: 1, requiresTrainingOptIn: false, premiumUnlocked: true },
  { id: 'gemma-4-26b', name: 'Gemma 4 26B', endpoints: ['chat/completions', 'messages', 'responses'], tier: 1, requiresTrainingOptIn: false, premiumUnlocked: true },
  { id: 'gpt-image-2', name: 'GPT Image 2', endpoints: ['images/generations', 'images/edits'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'kiro-auto', name: 'Kiro Auto', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'minimax-m3', name: 'MiniMax M3', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'moondream3.1', name: 'Moondream 3.1 9B', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'glm-5.2', name: 'GLM 5.2', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'glm-5.3', name: 'GLM 5.3', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'qwen-3.8-27b', name: 'Qwen 3.8 27B', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813', endpoints: ['chat/completions', 'messages', 'responses'], tier: 2, requiresTrainingOptIn: true, premiumUnlocked: false },
]

/** Persisted engine settings scope shared by the plugin and its catalog runtime. */
export type FreeCodeGoEngineSettingsScope = SettingsScope<{
  defaultModel: string
  defaultEngine: string
  mediaDefaults: { image: string; video: string; audio: string }
} & FreeCodeGoCapabilitySettings & FreeCodeGoAdvisorSettings & FreeCodeGoPluginConflictSettings & FreeCodeGoPluginUpdateSettings & FreeCodeGoEngineeringSettings & {
  /**
   * Folder-trust gate for project-scoped surfaces (trust.ts).
   *
   * Declared here rather than folded in as `& FreeCodeGoTrustSettings` because
   * this whole trailing object is the *hand-maintained* shape of the zip in
   * `index.ts`: the schema list and this type are two descriptions of one
   * contract, and the assignment of `settings.register(...)` to
   * {@link FreeCodeGoEngineSettingsScope} in `index.ts` is what holds them
   * together.
   *
   * Which direction that check catches, stated exactly
   * -------------------------------------------------
   * **A field declared here and missing from the schema is a compile error**, at
   * that assignment: the registered scope is not assignable to this type. A field
   * the schema offers and this type does not declare is **not** caught — TypeScript
   * allows an object with extra properties to be assigned to a narrower type, so no
   * assertion here can see it. That direction is the one that produces a toggle a
   * user can set and nothing reads, so it is called out rather than implied: a
   * setting added to the schema alone needs a field declared here as well, and the
   * only thing that can catch a miss is a runtime comparison of the two key sets,
   * which needs a runtime key list this type does not currently have.
   */
  folderTrustEnabled: boolean
  /**
   * Sandbox profile deny globs, enforced in the plugin policy layer.
   *
   * A direct list rather than a profile *name*: the named-profile documents live in
   * `sandbox-profiles.json`, and resolving a name to its globs at read time would put
   * a filesystem read behind a settings lookup. `sandbox/profiles.ts` owns the
   * spelling rules, and only its normalization is applied here.
   */
  sandboxDenyPatterns: string[]
  /** Credential-file read protection toggle (tool-guards). */
  envReadGuardEnabled: boolean
  /** Doom-loop detection toggle (tool-guards). */
  doomLoopGuardEnabled: boolean
  /** Probe-based LSP stack toggle (lsp-mount). */
  lspEnabled: boolean
  /** Post-compaction rehydration of todo list and durable memory (rehydration.ts). */
  rehydrationEnabled: boolean
  /** Opt-in conversation-arc section in the rehydrated context (rehydration.ts). */
  rehydrationArcEnabled: boolean
  /** Declarative command policy with load-time example validation (command-policy.ts). */
  commandPolicyEnabled: boolean
  /** Plan Mode: structural refusal of workspace mutation (plan-mode.ts). */
  planModeEnabled: boolean
  /** Model-visible context budget, injected at band granularity (context-budget.ts). */
  contextBudgetEnabled: boolean
  /** Shrink the prompt when the cache is provably expired (cache-cold.ts). */
  cacheColdClearEnabled: boolean
  /** Pre-call request-shape fingerprinting for cache-break attribution (request-shape.ts). */
  cacheBreakAttributionEnabled: boolean
  /** Streaming repetition guard for the model's own output (assistant-loop-guard.ts). */
  assistantLoopGuardEnabled: boolean
  /** Model-visible prompt-composition breakdown and usage tree (prompt-composition.ts). */
  promptCompositionEnabled: boolean
  /** Compaction-summary fidelity audit against the replaced history (compaction-fidelity.ts). */
  compactionFidelityEnabled: boolean
  /** Paged byte-exact recall of parked tool results (spill-recall.ts). */
  spillRecallEnabled: boolean
  /**
   * Memory consolidation rollout (memory/rollout.ts).
   *
   * A string stage rather than a boolean, because consolidation has two
   * intermediate positions that matter: `record_only` captures without calling a
   * model, and `shadow` calls the model without committing. Typed as `string`
   * rather than as the four-value union because this document is the shape of the
   * user's own file, and a value the schema would have rejected must still be
   * readable so `resolveMemoryRollout` can report it instead of failing at load.
   */
  memoryRollout: string
}>

/**
 * What one direct provider's directory read produced. `ids` is empty for
 * everything except an answer, so a caller narrows the static free tier only
 * with a roster that actually arrived.
 */
interface DirectCatalogOutcome {
  readonly kind: 'answered' | 'rejected' | 'unreachable'
  readonly ids: readonly string[]
}

/** Cache, in-flight read, and retry spacing for one direct provider. */
interface DirectCatalogState {
  answer: { readonly expiresAt: number; readonly ids: readonly string[] } | undefined
  load: Promise<DirectCatalogOutcome> | undefined
  retryAfter: number
}

const emptyDirectCatalogState = (): DirectCatalogState => ({ answer: undefined, load: undefined, retryAfter: 0 })

/** Late-bound plugin dependencies. Getters (not values) keep the mutable
 * account/credential state and instance-level method overrides effective. */
export interface FreeCodeGoManagedCatalogsDeps {
  readonly ctx: Context
  readonly credentials: () => CredentialProvider | undefined
  readonly account: () => FreeCodeGoAccountCoordinator | undefined
  readonly api: () => FreeCodeGoApiClient | undefined
  /**
   * The settings this catalog runtime reads.
   *
   * Was the registered scope; it is a read port now, so a catalog cannot write a
   * user's document and cannot observe changes it has no use for.
   */
  readonly settings: () => FreeCodeGoSettingsReadPort | undefined
  readonly gatewayBaseUrl: () => string
  readonly claudeBridge: () => ClaudeProtocolBridge
  readonly agnes: () => AgnesClient | undefined
  readonly cline: () => ClineClient | undefined
  readonly workbuddy: () => WorkBuddyIntlClient | undefined
  readonly configuredProviderRoute: (model: string) => { readonly provider: string; readonly model: string } | undefined
  readonly directConnection: (model: string | undefined, allowExternalProviders?: boolean) => Promise<{ connection: Omit<OpenAiCompatibleConnection, 'apiKey'>; runtime: FreeCodeGoManagedRuntime } | undefined>
  readonly managedRuntime: (model?: string) => Promise<FreeCodeGoManagedRuntime & { readonly routeKey?: string; readonly protocol?: string }>
  readonly managedCatalog: () => Promise<FreeCodeGoManagedCatalog>
  readonly restoreAccount: () => Promise<void>
  readonly readManagedCatalogCache: () => Promise<FreeCodeGoManagedCatalog | undefined>
  readonly refreshManagedCatalogInBackground: () => void
  readonly refreshGatewayHealthInBackground: () => void
}

/** Registers the provider adapters into the LLM registry and owns every
 * hosted model directory, health cache, and reasoning-capability record. */
export class FreeCodeGoManagedCatalogs {
  private logfareCatalogPromise: Promise<readonly LogfareModel[]> | undefined
  private logfareCatalogCache: { readonly expiresAt: number; readonly models: readonly LogfareModel[] } | undefined
  private logfareCatalogGeneration = 0
  private logfareCatalogRetryAfter = 0
  private logfareHealthCache: { readonly expiresAt: number; readonly health: ReadonlyMap<string, LogfareHealth> } | undefined
  private logfareHealthPromise: Promise<void> | undefined
  private openCodeHealthCache: { readonly expiresAt: number; readonly health: ReadonlyMap<string, LogfareHealth> } | undefined
  private openCodeHealthPromise: Promise<ReadonlyMap<string, LogfareHealth>> | undefined
  private openCodeCatalogCache: OpenCodeCatalogCache | undefined
  private openCodeCatalogPromise: Promise<readonly OpenCodeFreeModel[]> | undefined
  private openCodeCatalogRefreshAfter = 0
  private kiloCatalogCache: KiloCatalogState | undefined
  private kiloCatalogPromise: Promise<readonly KiloFreeModel[]> | undefined
  private kiloCatalogRetryAfter = 0
  private gatewayHealthCache: { readonly expiresAt: number; readonly health: ReadonlyMap<string, LogfareHealth> } | undefined
  private gatewayHealthPromise: Promise<void> | undefined
  private gatewayHealthRefreshAfter = 0
  /**
   * The backend that answered 404 for the channel-health route, and until when
   * that verdict stands.
   *
   * A 404 is a fact about one backend, not about this process: the app rebuilds
   * these clients whenever the persisted endpoint changes, so pointing the app
   * at a backend without that route — and then switching back — must not lose
   * the monitoring cards for the rest of the session. The verdict is also
   * bounded in time, because a 404 can come from a proxy or a deploy in flight.
   */
  private gatewayHealthUnsupported: { readonly endpoint: string; readonly expiresAt: number } | undefined
  /**
   * Directory reads for the two direct providers. The cached value is the bare
   * id list, deliberately without any route label: rows carry the caller's label
   * back and the registry rejects a row whose `provider` is not the route it
   * asked for (`INVALID_CATALOG`), so caching rows would either key the cache by
   * label or hand one caller another caller's roster.
   */
  private sensenovaCatalog: DirectCatalogState = emptyDirectCatalogState()
  private nvidiaCatalog: DirectCatalogState = emptyDirectCatalogState()
  private readonly rejectedGatewayReasoning = new Map<string, Set<Exclude<GatewayReasoningEffort, 'off'>>>()
  private managedCatalogRefreshPromise: Promise<void> | undefined
  private managedCatalogRefreshAfter = 0

  constructor(private readonly deps: FreeCodeGoManagedCatalogsDeps) {}

  /** Register the one provider used by the Harness agent loop. Runtime
   * endpoint and bearer token are resolved from FreeCodeGo for every stream;
   * neither official DeepSeek credentials nor browser values are consulted. */
  registerFreeCodeGoAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: provider => this.listFreeCodeGoModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      resolveConnection: async (model) => {
        const external = this.deps.configuredProviderRoute(model)
        if (external !== undefined && external.provider !== 'freecodego') throw new Error(`Model "${model}" belongs to Harness provider "${external.provider}"; select that provider instead of the FreeCodeGo gateway`)
        // The FreeCodeGo adapter is gateway-only: it resolves through the
        // managed runtime for authenticated accounts.
        const direct = await this.deps.directConnection(model, false)
        if (direct !== undefined) {
          const token = direct.runtime.openAIToken
          if (token === undefined || token.trim() === '') throw backendNotConfigured()
          return { ...direct.connection, apiKey: token }
        }
        const runtime = await this.deps.managedRuntime(model)
        const baseURL = runtime.openAIBaseUrl
        const token = runtime.openAIToken
        if (baseURL === undefined || token === undefined) throw backendNotConfigured()
        // A group-pinned selection (`id@group:N`) selects the route via headers;
        // the wire body must carry the bare model id, or the gateway would see
        // a model name that does not exist.
        const wireModel = parseGroupPin(model).modelId
        const routeHeaders = runtime.routeKey === undefined
          ? {}
          : {
            // This is the same model binding used by the working FreeCodeGo
            // desktop client. It selects the enabled backend gateway group.
            'X-FreeCodeGo-Route-Key': runtime.routeKey,
            'X-LiteAgent-Route-Key': runtime.routeKey,
          }
        // The selected group's protocol decides the wire: an anthropic model
        // must reach /v1/messages with a Messages body, because the OpenAI
        // chat path would be routed to an OpenAI group instead.
        const wire = runtime.protocol === 'anthropic' ? 'anthropic' as const : 'openai' as const
        return { baseURL, apiKey: token, ...(wireModel === model ? {} : { model: wireModel }), headers: routeHeaders, wire }
      },
      // Thinking-capable gateway routes default to High and forward an exact
      // user choice, including Off, with the next model request.
      normalizeReasoningEffort: effort => isGatewayReasoningEffort(effort) ? effort : undefined,
      defaultReasoningEffort: 'high',
      reasoningEffortsForModel: model => this.gatewayReasoningEfforts(model),
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
      onReasoningRejected: (model, effort) => {
        if (isGatewayReasoningEffort(effort)) this.rejectGatewayReasoningEffort(model, effort)
      },
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 256_000,
    })
    const llm = this.deps.ctx.get('llm') as { registerAdapter: (providers: readonly string[], value: unknown) => unknown } | undefined
    llm?.registerAdapter(['freecodego'], adapter)
  }

  /** VyceAI OpenAI-compatible routes. The key stays Host-only; the site's
   * daily check-in credit pays the metered price, so nothing here is free. */
  registerVyceAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'VyceAI',
      listModels: provider => this.listVyceModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      resolveConnection: async (model) => {
        const key = await this.vyceApiKey()
        if (key === undefined) throw new Error('VYCE_API_KEY_REQUIRED: configure a VyceAI API key in Settings first')
        const wireModel = model.trim().replace(/^vyce\//iu, '')
        if (!VYCE_MODEL_IDS.includes(wireModel as typeof VYCE_MODEL_IDS[number])) throw new Error(`VyceAI model "${model}" is not available in the plugin's directory`)
        return { baseURL: VYCE_BASE_URL, apiKey: key, model: wireModel, headers: { 'user-agent': 'freecodego/vyce' } }
      },
      reasoningWire: 'standard',
      normalizeReasoningEffort: effort => isDirectReasoningEffort(effort) ? effort : undefined,
      defaultReasoningEffort: 'off',
      reasoningEffortsForModel: () => DIRECT_REASONING_EFFORTS,
      includeUsage: false,
      omitDefaultMaxTokens: true,
      omitMaxTokens: false,
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 256_000,
    })
    this.deps.ctx.get('llm')?.registerAdapter(['vyce'], adapter)
  }

  /**
   * Claude can use VyceAI's native Anthropic-compatible endpoint directly.
   * Every other provider remains behind the local bridge, which preserves the
   * common Host adapter contract for DeepSeek, Codex, and Claude sessions.
   */
  async claudeGatewayForRoute(route: { readonly provider: string; readonly modelId: string; readonly reasoningEffort?: string }): Promise<{ readonly baseURL: string; readonly apiKey: string; readonly model?: string }> {
    const provider = route.provider.trim().toLowerCase()
    if (provider !== 'vyce') {
      return this.deps.claudeBridge().endpoint(route.provider, route.modelId, route.reasoningEffort)
    }
    const key = await this.vyceApiKey()
    if (key === undefined) throw new Error('VYCE_API_KEY_REQUIRED: configure a VyceAI API key in Settings first')
    const model = route.modelId.trim().replace(/^vyce\//iu, '')
    if (!VYCE_MODEL_IDS.includes(model as typeof VYCE_MODEL_IDS[number])) throw new Error(`VyceAI model "${route.modelId}" is not available in the plugin's directory`)
    return { baseURL: VYCE_ANTHROPIC_BASE_URL, apiKey: key, model }
  }

  /** OpenCode Zen is a public direct provider, never a FreeCodeGo gateway route. */
  registerOpenCodeAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'OpenCode Zen',
      listModels: provider => this.listOpenCodeModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      resolveConnection: async (model) => {
        const requested = model.trim().toLowerCase()
        // `auto` follows the live public directory at request time; the
        // remaining ids must exist verbatim. The upstream roster rotates, so
        // the auto route keeps auxiliary calls alive without config churn.
        // Legacy profiles persisted with the retired `hy3` id are aliased to
        // auto: the static floor keeps the row selectable, but the upstream
        // no longer serves `hy3-free`, so honoring it verbatim would fail.
        const found = requested === OPENCODE_AUTO_MODEL.id || requested === 'hy3'
          ? openCodeAutoPreference(await this.openCodeFreeModels())
          : (await this.openCodeFreeModels()).find(candidate => candidate.id.toLowerCase() === requested)
        if (found === undefined) throw new Error(`OpenCode model "${model}" is not available in the public directory`)
        return { baseURL: OPENCODE_DIRECT_BASE_URL, apiKey: 'public', model: found.upstreamId, headers: { 'x-opencode-client': 'desktop', 'user-agent': 'opencode/freecodego' } }
      },
      reasoningWire: 'standard',
      normalizeReasoningEffort: effort => isDirectReasoningEffort(effort) ? effort : undefined,
      defaultReasoningEffort: 'off',
      reasoningEffortsForModel: () => DIRECT_REASONING_EFFORTS,
      rateLimitedHint: () => RATE_LIMIT_PROXY_HINT,
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 256_000,
    })
    this.deps.ctx.get('llm')?.registerAdapter(['opencode'], adapter)
  }

  /** Kilo Gateway free models are public and require no login or API key. */
  registerKiloAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Kilo Free',
      listModels: provider => this.listKiloModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      resolveConnection: async (model) => {
        const requested = model.trim().toLowerCase()
        const found = requested === 'auto'
          ? this.kiloAutoPreference(await this.kiloFreeModels())
          : (await this.kiloFreeModels()).find(candidate => candidate.id.toLowerCase() === requested)
        if (found === undefined) throw new Error(`Kilo model "${model}" is not available in the public directory`)
        return { baseURL: KILO_GATEWAY_BASE_URL, apiKey: KILO_ANONYMOUS_API_KEY, model: found.upstreamId, headers: { 'user-agent': 'freecodego/kilo' } }
      },
      reasoningWire: 'standard',
      normalizeReasoningEffort: effort => isDirectReasoningEffort(effort) ? effort : undefined,
      defaultReasoningEffort: 'off',
      reasoningEffortsForModel: () => DIRECT_REASONING_EFFORTS,
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 256_000,
    })
    this.deps.ctx.get('llm')?.registerAdapter(['kilo'], adapter)
  }

  /** Return the preferred Kiló free model for the `auto` route. */
  kiloAutoPreference(models: readonly KiloFreeModel[]): KiloFreeModel | undefined {
    // kilo-auto/free is the designated auto route
    const autoModel = models.find(model => model.id === 'kilo-auto/free')
    if (autoModel !== undefined) return autoModel
    // fallback to first free model
    return models[0]
  }

  /** Fetch Kiló's public model directory and filter to free models only. */
  async listKiloModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.kiloFreeModels()
    return models.map(model => ({
      provider,
      id: `${KILO_MODEL_PREFIX}${model.id}`,
      name: model.name,
      description: `Kilo · ×0 · free · upstream: ${model.upstreamId}`,
      availability: 'available' as const,
      inputModalities: ['text'] as const,
    }))
  }

  /**
   * Filter and parse Kiló models that have isFree === true.
   *
   * A fetch that fails while a previous roster is known keeps it: "the feed did
   * not answer" is not the same fact as "the directory has no free routes", and
   * recording the former as the latter blanked every Kilo route for a full day
   * and overwrote the last good snapshot on disk with an empty one. The disk
   * snapshot is consulted too, so a restart or an invalidation still paints the
   * picker instead of waiting on the network.
   */
  async kiloFreeModels(): Promise<readonly KiloFreeModel[]> {
    const cached = this.kiloCatalogCache ?? await this.readKiloCatalogCache()
    if (cached !== undefined) this.kiloCatalogCache = cached
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.models
    if (this.kiloCatalogPromise !== undefined) return this.kiloCatalogPromise
    // One attempt per window: a directory that stays down must not be re-fetched
    // by every picker open, and the previous roster keeps serving meanwhile.
    if (Date.now() < this.kiloCatalogRetryAfter) return cached?.models ?? []
    const operation = this.loadKiloModels()
    this.kiloCatalogPromise = operation
    try {
      const models = await operation
      const savedAt = Date.now()
      await this.writeCatalogCache(this.catalogCachePath('kilo-free-models.json'), { version: 1, savedAt, models })
      this.kiloCatalogCache = { expiresAt: savedAt + KILO_CATALOG_CACHE_TTL_MS, models }
      this.deps.ctx.emit('llm/adapters-updated')
      return models
    } catch {
      this.kiloCatalogRetryAfter = Date.now() + KILO_CATALOG_RETRY_MS
      return cached?.models ?? []
    } finally {
      if (this.kiloCatalogPromise === operation) this.kiloCatalogPromise = undefined
    }
  }

  /**
   * The last successful roster on disk, so a cold start (or an invalidation)
   * still shows Kilo's free routes while the network is revalidated. Rows are
   * re-derived field by field instead of trusted wholesale, and a snapshot older
   * than the maximum age is discarded rather than served.
   */
  private async readKiloCatalogCache(): Promise<KiloCatalogState | undefined> {
    const value = record(await readJsonFile(this.catalogCachePath('kilo-free-models.json')))
    if (value.version !== 1 || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > KILO_CATALOG_MAX_AGE_MS || !Array.isArray(value.models)) return undefined
    const models = value.models.flatMap((item) => {
      const row = record(item)
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      const upstreamId = typeof row.upstreamId === 'string' ? row.upstreamId.trim() : ''
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      return id !== '' && upstreamId !== '' && name !== '' ? [{ id, upstreamId, name }] : []
    })
    if (models.length === 0) return undefined
    return { expiresAt: value.savedAt + KILO_CATALOG_CACHE_TTL_MS, models }
  }

  /** Invalidate all pending and cached Kilo directory probes. */
  invalidateKiloCatalog(): void {
    this.kiloCatalogPromise = undefined
    this.kiloCatalogCache = undefined
  }

  /**
   * One fetch attempt. A rejection or a non-2xx status is thrown to the caller,
   * which holds on to the previous roster; an answered-but-empty directory is a
   * result, not a failure.
   */
  private async loadKiloModels(): Promise<readonly KiloFreeModel[]> {
    const response = await fetch(KILO_MODELS_URL, {
      headers: { authorization: `Bearer ${KILO_ANONYMOUS_API_KEY}`, accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' },
      signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Kilo model catalog failed with HTTP ${response.status}`)
    const payload = record(await response.json())
    const rows = Array.isArray(payload.data) ? payload.data : []
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

  /** Logfare is a direct provider, never a FreeCodeGo gateway route. */
  registerLogfareAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'logfare',
      listModels: provider => this.listLogfareTextModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      assertSelectable: async (model) => {
        const normalized = model.trim().replace(/^logfare\//iu, '').toLowerCase()
        const candidate = (await this.logfareModels()).find(item => logfareModelKey(item.id) === logfareModelKey(normalized))
        if (candidate === undefined || !logfareSupportsChat(candidate)) throw new Error(`FreeCodeGo model "${model}" is not available for chat completions`)
        if (candidate.requiresTrainingOptIn && !candidate.premiumUnlocked) throw new Error('LOGFARE_PREMIUM_OPT_IN_REQUIRED: enable training-data consent in FreeCodeGo settings before using this model')
      },
      resolveConnection: async (model) => {
        const apiKey = await this.logfareApiKey()
        if (apiKey === undefined) throw new Error('LOGFARE_API_KEY_REQUIRED: configure the model access key in FreeCodeGo settings first')
        if (model.trim() === '') throw new Error('FreeCodeGo model id is not configured')
        const wireModel = logfareModelKey(model) === 'auto' ? LOGFARE_AUTO_MODEL.id : logfareModelKey(model)
        return { baseURL: LOGFARE_BASE_URL, apiKey, model: wireModel, headers: { 'user-agent': 'freecodego/logfare' } }
      },
      reasoningWire: 'standard',
      normalizeReasoningEffort: () => undefined,
      defaultReasoningEffort: 'off',
      reasoningEffortsForModel: () => ['off'],
      includeUsage: false,
      // The public route enforces a 256k context window but does not publish a
      // stable per-model output limit. Omit max_tokens and let the service
      // adapt the completion budget to the selected model and prompt.
      defaultContextWindow: 256_000,
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
    })
    this.deps.ctx.get('llm')?.registerAdapter(['logfare'], adapter)
  }

  registerAgnesAdapter(): void {
    const client = this.deps.agnes()
    if (client === undefined) return
    this.deps.ctx.get('llm')?.registerAdapter(['agnes'], new AgnesAdapter(client, () => this.deps.ctx.get('attachments')))
  }

  /** WorkBuddy International's free routes, served from the Host account pool. */
  registerWorkbuddyAdapter(): void {
    const client = this.deps.workbuddy()
    if (client === undefined) return
    this.deps.ctx.get('llm')?.registerAdapter(['workbuddy'], new WorkBuddyIntlAdapter(client))
  }

  /** Cline's free routes, served from the Host account pool. */
  registerClineAdapter(): void {
    const client = this.deps.cline()
    if (client === undefined) return
    this.deps.ctx.get('llm')?.registerAdapter(['cline'], new ClineAdapter(client))
  }

  /** Register NVIDIA NIM's OpenAI-compatible public endpoint. Free-tier
   * routes resolve through integrate.api.nvidia.com with the user key. */
  registerNvidiaAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'NVIDIA NIM',
      listModels: provider => this.listNvidiaModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      resolveConnection: async () => {
        const key = await this.nvidiaApiKey()
        if (key === undefined) throw new Error('NVIDIA_API_KEY_REQUIRED: configure an NVIDIA API key first')
        return { baseURL: NVIDIA_BASE_URL, apiKey: key }
      },
      reasoningWire: 'standard',
      normalizeReasoningEffort: effort => isDirectReasoningEffort(effort) ? effort : undefined,
      defaultReasoningEffort: 'off',
      reasoningEffortsForModel: model => NVIDIA_MODELS.some(candidate => candidate.id === model)
        ? DIRECT_REASONING_EFFORTS
        : undefined,
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
      defaultContextWindow: 1_000_000,
    })
    this.deps.ctx.get('llm')?.registerAdapter(['nvidia'], adapter)
  }

  /** Register SenseNova's OpenAI-compatible public-beta endpoint. */
  registerSenseNovaAdapter(): void {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'SenseNova',
      listModels: provider => this.listSenseNovaModels(provider),
      resolveAttachments: () => this.deps.ctx.get('attachments'),
      resolveConnection: async () => {
        const key = await this.sensenovaApiKey()
        if (key === undefined) throw new Error('SENSENOVA_API_KEY_REQUIRED: configure a SenseNova API key first')
        return { baseURL: SENSENOVA_BASE_URL, apiKey: key }
      },
      reasoningWire: 'standard',
      normalizeReasoningEffort: effort => isDirectReasoningEffort(effort) ? effort : undefined,
      defaultReasoningEffort: 'high',
      reasoningEffortsForModel: model => SENSENOVA_MODELS.some(candidate => candidate.id === model)
        ? DIRECT_REASONING_EFFORTS
        : undefined,
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
      defaultContextWindow: 1_000_000,
    })
    this.deps.ctx.get('llm')?.registerAdapter(['sensenova'], adapter)
  }

  /** Return the provider catalog even when optional credentials are absent.
   *
   * Rows are the picker's contract with the user: one row per (model, group)
   * the account can use, so the same model genuinely appears under each
   * backend group it is offered through, labelled with that group's own rate.
   * The row id carries the pin (`id@group:N`); routing and the wire strip it
   * and send the pinned group's route key. A model the backend offers through
   * no usable group keeps a single unpinned row; routing then follows the
   * backend's declared default group, then the backend's own choice order —
   * never a locally computed cheapest group. */
  async listFreeCodeGoModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const [cachedManaged, openCodeModels] = await Promise.all([
      this.deps.readManagedCatalogCache(),
      this.openCodeFreeModels(),
    ])
    let managed = cachedManaged
    this.deps.refreshManagedCatalogInBackground()
    // FreeCodeGo gateway health probes are shown in the dedicated monitoring
    // cards, not in the model picker. Keeping this directory text to pricing
    // metadata avoids stale rolling latency values misleading model selection.
    this.deps.refreshGatewayHealthInBackground()
    if (managed !== undefined) managed = { ...managed, models: mergeCatalogModels(managed.models) }
    const backendAccessible = this.deps.account()?.snapshot().status === 'authenticated'
      || await this.deps.account()?.hasStoredSession() === true
    const availabilityRow = (model: FreeCodeGoManagedCatalog['models'][number]): {
      readonly id: string
      readonly displayName: string
      readonly availability: 'available' | 'unavailable'
      readonly unavailableReason?: string
      readonly inputModalities: readonly ('text' | 'image')[]
    } => ({
      id: model.id,
      displayName: model.displayName,
      ...(backendAccessible && model.availability === 'available'
        ? { availability: 'available' as const }
        : { availability: 'unavailable' as const, unavailableReason: MODEL_REASON_FREECODEGO_LOGIN }),
      inputModalities: imageInputModalities(model.id, model.displayName),
    })
    // Expand BEFORE the login gate: a pinned row must name its group even when
    // the account is signed out, so the picker explains "this group needs a
    // login" instead of hiding the whole structure. Options come from the same
    // cache the catalog itself came from.
    const options = managed?.models.flatMap((model) => {
      const groupedChoices = model.choices.filter((choice): choice is typeof choice & { readonly groupId: number } => choice.groupId !== undefined)
      return groupedChoices.length === 0
        ? []
        : [{
        model: model.id,
        options: groupedChoices.map(choice => ({
          groupId: choice.groupId,
          routeKey: choice.routeKey,
          ...(choice.protocol === undefined ? {} : { protocol: choice.protocol }),
          enabled: choice.availability !== 'unavailable' || choice.unlockRequired === true,
          ...(choice.access === undefined ? {} : { access: choice.access }),
          unlockRequired: choice.unlockRequired === true,
          ...(choice.unlockReason === undefined ? {} : { unlockReason: choice.unlockReason }),
          ...(choice.unlockExpiresAt === undefined ? {} : { unlockExpiresAt: choice.unlockExpiresAt }),
          ...(choice.rateMultiplier === undefined ? {} : { rateMultiplier: choice.rateMultiplier }),
          ...(choice.groupName === undefined ? {} : { groupName: choice.groupName }),
          zeroPrice: choice.zeroPrice === true || choice.rateMultiplier === 0,
          locked: choice.locked === true,
        })),
      }]
    }) ?? []
    const expanded = expandGroupPinnedModels(managed?.models.map(availabilityRow) ?? [], options)
    const rows = expanded.map((model) => {
      const pinned = model.__groupLabel !== undefined
      // Two rows for one model differ only by their group, so the name must
      // say which line it bills through; otherwise the picker renders two
      // indistinguishable labels and the decorator cannot tell them apart.
      const name = pinned ? `${model.displayName} · ${model.__groupLabel}` : model.displayName
      // The group's own reason explains the row only when the model itself is
      // usable; see `modelRowGroupBlock` for why the model's block outranks it.
      const groupBlock = modelRowGroupBlock(model)
      return {
        provider,
        id: model.id,
        name,
        // The trailing metadata lane parses this string (source before "·",
        // then ×N multipliers), so keep the shape: `<group> · ×<rate>`.
        description: pinned
          ? `${model.__groupLabel} · ${model.__groupRate === undefined ? '倍率未知' : `×${model.__groupRate}`}`
          : `FreeCodeGo · ${modelMultiplierDescription({ choices: managed?.models.find(candidate => candidate.id === model.id || candidate.id.toLowerCase() === model.id.toLowerCase())?.choices ?? [] })}`,
        inputModalities: model.inputModalities,
        ...model.availability === 'available' && groupBlock === undefined
          ? { availability: 'available' as const }
          : { availability: 'unavailable' as const, unavailableReason: groupBlock ?? model.unavailableReason ?? MODEL_REASON_FREECODEGO_LOGIN },
      }
    })
    const openCodeIds = new Set(openCodeModels.map(model => model.id.toLowerCase()))
    const seen = new Set<string>()
    return rows.filter((model) => {
      const key = model.id.toLowerCase()
      // A stale cache from an older release can still carry a raw OpenCode
      // wire id. Keep it out of the gateway provider even before the cache
      // is refreshed and the curated direct route is re-added.
      if (/^(?:opencode|openrouter)[/:]/u.test(key)) return false
      if (model.description?.toLowerCase().startsWith('opencode ·') || model.description?.toLowerCase().startsWith('openrouter ·')) return false
      // A legacy managed snapshot may have stored an OpenCode wire id without
      // its provider prefix (for example `hy3`). Those ids belong exclusively
      // to the direct `opencode` adapter and must never be exposed as
      // `freecodego/<model>` routes.
      if (openCodeIds.has(key)) return false
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  refreshManagedCatalogInBackground(): void {
    const now = Date.now()
    if (this.managedCatalogRefreshPromise !== undefined || now < this.managedCatalogRefreshAfter) return
    this.managedCatalogRefreshAfter = now + MANAGED_MODEL_CATALOG_CACHE_TTL_MS
    const operation = this.deps.managedCatalog().then(() => {
      this.deps.ctx.emit('llm/adapters-updated')
    }, () => {
      this.managedCatalogRefreshAfter = Date.now() + 60_000
    })
    this.managedCatalogRefreshPromise = operation
    void operation.finally(() => {
      if (this.managedCatalogRefreshPromise === operation) this.managedCatalogRefreshPromise = undefined
    })
  }

  /** Refresh user-visible gateway monitor facts without delaying model picker paint. */
  refreshGatewayHealthInBackground(): void {
    // Resolve the endpoint before the round trip: this backend's verdict must be
    // recorded against the backend the request was made to, not against whatever
    // endpoint is current when the answer lands.
    const endpoint = this.deps.gatewayBaseUrl()
    const unsupported = this.gatewayHealthUnsupported
    if ((unsupported !== undefined && unsupported.endpoint === endpoint && Date.now() < unsupported.expiresAt) || this.deps.api() === undefined || this.deps.account() === undefined || this.deps.account()!.snapshot().status !== 'authenticated') return
    const now = Date.now()
    if (this.gatewayHealthPromise !== undefined || (this.gatewayHealthCache?.expiresAt ?? 0) > now || this.gatewayHealthRefreshAfter > now) return
    this.gatewayHealthRefreshAfter = now + GATEWAY_HEALTH_CACHE_TTL_MS
    const operation = this.deps.account()!.withAccessToken(accessToken => this.deps.api()!.getGatewayProviderHealth({ accessToken }))
      .then((monitors) => {
        this.gatewayHealthCache = { expiresAt: Date.now() + GATEWAY_HEALTH_CACHE_TTL_MS, health: indexGatewayHealth(monitors) }
        this.deps.ctx.emit('llm/adapters-updated')
      }, (error: unknown) => {
        if (/channel-health failed with HTTP 404/i.test(error instanceof Error ? error.message : String(error))) {
          this.gatewayHealthUnsupported = { endpoint, expiresAt: Date.now() + GATEWAY_HEALTH_UNSUPPORTED_TTL_MS }
          return
        }
        if (this.gatewayHealthCache !== undefined) this.gatewayHealthCache = { ...this.gatewayHealthCache, expiresAt: Date.now() + GATEWAY_HEALTH_CACHE_TTL_MS }
        // The monitor polls the gateway with the account's credential, so a
        // refusal can quote the request it authenticated. `managed-catalog-utils`
        // masks the same class of body for the registration path; this is the
        // health path beside it.
        console.warn(`[freecodego] gateway channel monitor refresh failed: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`)
      })
    this.gatewayHealthPromise = operation
    void operation.finally(() => {
      if (this.gatewayHealthPromise === operation) this.gatewayHealthPromise = undefined
    })
  }

  async listOpenCodeModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.openCodeFreeModels()
    const health = this.openCodeHealthCache?.health ?? new Map<string, LogfareHealth>()
    this.refreshLocalHealthInBackground(models)
    const autoRow = { provider, id: OPENCODE_AUTO_MODEL.id, name: OPENCODE_AUTO_MODEL.name, description: `OpenCode · ×0 · ${openCodeAutoPreference(models).name}`, availability: 'available' as const, inputModalities: ['text'] as const }
    return [autoRow, ...models.map((model) => {
      const status = health.get(model.id)?.status ?? 'unknown'
      return {
        provider,
        id: model.id,
        name: model.name,
        description: `OpenCode · ×0${openCodeHealthDescription(health.get(model.id))}`,
        ...(status === 'degraded'
          ? { availability: 'unavailable' as const, unavailableReason: MODEL_REASON_OPENCODE_UNAVAILABLE }
          : { availability: 'available' as const }),
        inputModalities: imageInputModalities(model.id, model.name),
      }
    })]
  }

  /**
   * Read OpenCode's public model directory without hard-coding its roster.
   * The API currently exposes free routes with a `-free` suffix; optional
   * boolean/price metadata is honored when the provider adds it. A stale
   * successful snapshot remains usable for seven days and is refreshed once
   * per day during idle/background calls.
   */
  async openCodeFreeModels(): Promise<readonly OpenCodeFreeModel[]> {
    const cached = this.openCodeCatalogCache ?? await this.readOpenCodeCatalogCache()
    if (cached !== undefined) {
      this.openCodeCatalogCache = cached
      // A pre-dynamic release could have persisted only the first handful of
      // routes. Treat such a sparse snapshot as stale immediately, while
      // still returning it so the selector never blanks during revalidation.
      const hasNamedPublicRoutes = cached.models.some(model => /(?:pickle|muse[-_.]?spark)/iu.test(model.id))
      if (Date.now() - cached.savedAt >= OPENCODE_CATALOG_CACHE_TTL_MS || cached.models.length < 5 || !hasNamedPublicRoutes) this.refreshOpenCodeCatalogInBackground()
      return cached.models
    }
    if (this.openCodeCatalogPromise !== undefined) return this.openCodeCatalogPromise
    this.refreshOpenCodeCatalogInBackground()
    return FREE_UPSTREAM_MODELS
  }

  /** Synchronous read of the in-memory OpenCode snapshot for callers that
   * cannot await (default-route resolution during session creation). Returns
   * the built-in list when no live snapshot has loaded yet; the background
   * refresh keeps it current. */
  cachedOpenCodeFreeModels(): readonly OpenCodeFreeModel[] {
    return this.openCodeCatalogCache?.models ?? FREE_UPSTREAM_MODELS
  }

  private refreshOpenCodeCatalogInBackground(): void {
    if (this.openCodeCatalogPromise !== undefined || Date.now() < this.openCodeCatalogRefreshAfter) return
    this.openCodeCatalogRefreshAfter = Date.now() + OPENCODE_CATALOG_CACHE_TTL_MS
    // Resolve the destination before the fetch: `catalogCachePath` reads the
    // active home on every call, and a write that resolves the path after the
    // network round trip can cache this roster under a home the refresh was
    // never started for.
    const cachePath = this.catalogCachePath('opencode-free-models.json')
    const operation = this.loadOpenCodeCatalog().then(async (models) => {
      const savedAt = Date.now()
      await this.writeCatalogCache(cachePath, { version: 1, savedAt, models })
      this.openCodeCatalogCache = { savedAt, models }
      this.deps.ctx.emit('llm/adapters-updated')
    }, () => {
      this.openCodeCatalogRefreshAfter = Date.now() + 60 * 60_000
    })
    const pending = operation.then(() => this.openCodeCatalogCache?.models ?? FREE_UPSTREAM_MODELS)
    this.openCodeCatalogPromise = pending
    void pending.finally(() => {
      if (this.openCodeCatalogPromise === pending) this.openCodeCatalogPromise = undefined
    })
  }

  private async loadOpenCodeCatalog(): Promise<readonly OpenCodeFreeModel[]> {
    const response = await fetch(`${OPENCODE_DIRECT_BASE_URL}/models`, {
      headers: { authorization: 'Bearer public', accept: 'application/json', 'x-opencode-client': 'desktop', 'user-agent': 'opencode/freecodego' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`OpenCode model catalog failed with HTTP ${response.status}`)
    const payload = record(await response.json())
    const rows = Array.isArray(payload.data) ? payload.data : []
    const models: OpenCodeFreeModel[] = []
    const seen = new Set<string>()
    for (const value of rows) {
      const row = record(value)
      const upstreamId = typeof row.id === 'string' ? row.id.trim() : ''
      if (upstreamId === '') continue
      const pricing = record(row.pricing)
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
    // The API-discovered rows are the whole answer. The built-in roster is a
    // *fallback* for a failed fetch, not a floor to add to a successful one:
    // merging it unconditionally kept routes that OpenCode has since withdrawn
    // (a retired free alias stayed selectable forever, and selecting it failed
    // at request time). A directory that answers is authoritative.
    return models.length > 0 ? models : FREE_UPSTREAM_MODELS
  }

  private async readOpenCodeCatalogCache(): Promise<OpenCodeCatalogCache | undefined> {
    const value = record(await readJsonFile(this.catalogCachePath('opencode-free-models.json')))
    if (value.version !== 1 || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > OPENCODE_CATALOG_MAX_AGE_MS || !Array.isArray(value.models)) return undefined
    const models = value.models.flatMap((item) => {
      const row = record(item)
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      const upstreamId = typeof row.upstreamId === 'string' ? row.upstreamId.trim() : ''
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      return id !== '' && upstreamId !== '' && name !== '' ? [{ id, upstreamId, name }] : []
    })
    if (models.length === 0) return undefined
    return { savedAt: value.savedAt, models }
  }

  /** Health probes enrich an already-rendered directory; they never gate its first paint. */
  refreshLocalHealthInBackground(openCodeModels: readonly OpenCodeFreeModel[] = FREE_UPSTREAM_MODELS): void {
    const probes: Promise<unknown>[] = []
    // A snapshot past its TTL must revalidate too, otherwise a transient
    // upstream outage stays frozen until the Host restarts.
    if (this.openCodeHealthCache === undefined || this.openCodeHealthCache.expiresAt <= Date.now()) probes.push(this.openCodeHealth(openCodeModels))
    if (probes.length === 0) return
    void Promise.all(probes).then(() => { this.deps.ctx.emit('llm/adapters-updated') }, () => undefined)
  }

  /** Cache OpenCode's public model directory and retain a health row per free route. */
  async openCodeHealth(models: readonly OpenCodeFreeModel[] = FREE_UPSTREAM_MODELS): Promise<ReadonlyMap<string, LogfareHealth>> {
    const cached = this.openCodeHealthCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.health
    if (this.openCodeHealthPromise !== undefined) return this.openCodeHealthPromise
    const operation = fetchOpenCodeHealth(models)
    this.openCodeHealthPromise = operation
    try {
      const health = await operation
      this.openCodeHealthCache = { expiresAt: Date.now() + OPENCODE_HEALTH_CACHE_TTL_MS, health }
      return health
    } finally {
      if (this.openCodeHealthPromise === operation) this.openCodeHealthPromise = undefined
    }
  }

  async listLogfareTextModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const [apiKey, models] = await Promise.all([this.logfareApiKey(), this.logfareModels()])
    const health = this.logfareHealthCache?.health
    this.refreshLogfareHealthInBackground()
    return models.filter(logfareSupportsChat).flatMap((model) => {
      const modelHealth = model.health ?? health?.get(logfareModelKey(model.id))
      // A provider outage must not permanently erase a model from the
      // directory. Only an explicit zero-uptime report for the current 1h
      // window makes a route non-selectable; other rows remain visible so the
      // user can retry when the upstream recovers.
      return [{
        provider,
        id: model.id,
        name: model.id === LOGFARE_AUTO_MODEL.id ? 'Auto' : model.name,
        // Auto remains immediately usable, but its traffic is also part of the
        // provider's training-data program and should be labelled consistently.
        description: `logfare · ×0${logfareUsesTrainingData(model) ? ' · tag:training' : ''}${logfareHealthDescription(model.health ?? health?.get(logfareModelKey(model.id)))}`,
        ...(apiKey === undefined
          ? { availability: 'unavailable' as const, unavailableReason: 'LOGFARE_API_KEY_REQUIRED' }
          : model.requiresTrainingOptIn && !model.premiumUnlocked
            ? { availability: 'unavailable' as const, unavailableReason: 'LOGFARE_PREMIUM_OPT_IN_REQUIRED' }
            : modelHealth?.status === 'degraded' && modelHealth.uptimePercent === 0
              ? { availability: 'unavailable' as const, unavailableReason: 'MODEL_PROVIDER_DEGRADED' }
              : { availability: 'available' as const }),
        inputModalities: imageInputModalities(model.id, model.name),
      }]
    })
  }

  /** Merge live media-capable models (Logfare + Agnes) into the settings
   * catalog. Agnes rows come from the provider's live `/models` directory, so
   * the picker shows only genuinely available models — no pinned roster. */
  async withDynamicMediaCatalog(catalog: FreeCodeGoManagedCatalog): Promise<FreeCodeGoManagedCatalog> {
    const models = await this.logfareModels()
    const dynamic = models.flatMap((model) => {
      const endpoints = model.endpoints.map(endpoint => endpoint.toLowerCase())
      const category = endpoints.some(endpoint => endpoint.includes('image'))
        ? 'image'
        : endpoints.some(endpoint => endpoint.includes('video'))
          ? 'video'
          : endpoints.some(endpoint => endpoint.includes('audio') || endpoint.includes('speech') || endpoint.includes('transcri'))
            ? 'audio'
            : undefined
      if (category === undefined) return []
      const id = logfareSelectionId(model.id)
      return [{
        id,
        displayName: model.name,
        provider: 'logfare',
        protocol: category === 'image' ? 'image_generation' : category === 'video' ? 'video_generation' : 'audio_speech',
        availability: model.requiresTrainingOptIn && !model.premiumUnlocked ? 'unavailable' : 'available',
        compatibleEngines: [],
        choices: [{ routeKey: id, label: 'logfare', availability: model.requiresTrainingOptIn && !model.premiumUnlocked ? 'unavailable' : 'available', compatibleEngines: [] }],
      } satisfies FreeCodeGoManagedCatalog['models'][number]]
    })
    const byKey = new Map(catalog.models.map(model => [`${model.provider.toLowerCase()}\u0000${model.id.toLowerCase()}`, model]))
    for (const model of dynamic) byKey.set(`${model.provider}\u0000${model.id.toLowerCase()}`, model)
    // Agnes media routes: the live directory is the source of truth for which
    // ids exist; a signed-out state keeps the documented floor visible so the
    // provider group does not disappear from the picker.
    const agnes = this.deps.agnes()
    if (agnes !== undefined) {
      const status = await agnes.status().catch(() => undefined)
      const signedIn = status?.status === 'authenticated'
      const liveModels = signedIn
        ? await agnes.liveMediaCatalog()
        : AGNES_DOCUMENTED_MODELS.filter(model => model.id !== 'agnes-3.0-flash').map(model => ({ id: model.id, name: model.name }))
      // API key missing → every Agnes media route stays visible but marked
      // unavailable, mirroring the adapter's fail-closed chat behavior.
      const availability = signedIn && (status?.apiKeyConfigured) ? 'available' : 'unavailable'
      for (const model of liveModels) {
        const category = agnesMediaCategory(model.id)
        if (category === undefined) continue
        const id = mediaSelection('agnes', model.id)
        byKey.set(`agnes\u0000${id.toLowerCase()}`, {
          id,
          displayName: model.name,
          provider: 'agnes',
          protocol: category === 'image' ? 'image_generation' : category === 'video' ? 'video_generation' : 'audio_speech',
          availability,
          compatibleEngines: [],
          choices: [{ routeKey: id, label: 'Agnes AI', availability, compatibleEngines: [] }],
        } satisfies FreeCodeGoManagedCatalog['models'][number])
      }
    }
    return { ...catalog, models: [...byKey.values()] }
  }

  async vyceApiKey(): Promise<string | undefined> {
    const credential = await this.deps.credentials()?.resolve(VYCE_API_KEY_REF)
    // `||`: an empty stored value is a cleared key, and it must fall through to
    // the environment rather than shadow it (the Groq/Logfare/SenseNova/NVIDIA
    // accessors already do).
    const value = credential?.value.trim() || process.env.VYCE_API_KEY?.trim() || ''
    return value === '' ? undefined : value
  }

  async listVyceModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const key = await this.vyceApiKey()
    return VYCE_MODELS.map(model => ({
      provider,
      id: `${VYCE_MODEL_PREFIX}${model.id}`,
      name: model.name,
      description: `VyceAI · $${model.inputPricePerMillion}/$${model.outputPricePerMillion} · 签到免费额度可用`,
      ...(key === undefined ? { availability: 'unavailable' as const, unavailableReason: 'VYCE_API_KEY_REQUIRED' } : { availability: 'available' as const }),
      inputModalities: ['text', 'image'] as const,
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 256_000,
    }))
  }

  async groqWhisperApiKey(): Promise<string | undefined> {
    const credential = await this.deps.credentials()?.resolve(GROQ_WHISPER_API_KEY_REF)
    const value = credential?.value.trim() || process.env.GROQ_WHISPER_API_KEY?.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async logfareApiKey(): Promise<string | undefined> {
    const credential = await this.deps.credentials()?.resolve(LOGFARE_API_KEY_REF)
    const value = credential?.value.trim() || process.env.LOGFARE_API_KEY?.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async logfareSession(): Promise<string | undefined> {
    const credential = await this.deps.credentials()?.resolve(LOGFARE_SESSION_REF)
    const value = credential?.value.trim()
    return value === undefined || value === '' ? undefined : value
  }

  /** The service returns the active preference through its session-authenticated profile. */
  async logfareTrainingOptIn(): Promise<boolean> {
    const session = await this.logfareSession()
    if (session === undefined) return false
    try {
      const response = await fetch(LOGFARE_PROFILE_URL, {
        headers: { accept: 'application/json', cookie: session, 'user-agent': 'FreeCodeGo-Harness' },
        signal: AbortSignal.timeout(LOGFARE_CATALOG_TIMEOUT_MS),
      })
      if (!response.ok) return false
      const profile = record(await response.json())
      const user = record(profile.user)
      return profile.training_opt_in === true || user.training_opt_in === true
    } catch {
      return false
    }
  }

  async updateLogfareTrainingPreference(enabled: boolean): Promise<void> {
    const [session, apiKey] = await Promise.all([this.logfareSession(), this.logfareApiKey()])
    if (session === undefined) throw new Error('FreeCodeGo model session is unavailable; apply for access again')
    const response = await fetch(LOGFARE_TRAINING_PREFERENCE_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', cookie: session, ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }), origin: 'https://logfare.ai', referer: 'https://logfare.ai/consent', 'user-agent': LOGFARE_BROWSER_USER_AGENT },
      body: JSON.stringify({ training_opt_in: enabled }),
      signal: AbortSignal.timeout(LOGFARE_TRAINING_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(await logfareResponseError(response, 'FreeCodeGo training preference update failed'))
    this.invalidateLogfareCatalog()
  }

  /** Fetch the live Logfare directory so new standard and premium models appear without a plugin release. */
  async logfareModels(): Promise<readonly LogfareModel[]> {
    const cached = this.logfareCatalogCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models
    this.refreshLogfareModelsInBackground()
    return cached?.models ?? LOGFARE_FALLBACK_MODELS
  }

  private refreshLogfareModelsInBackground(): void {
    void this.refreshLogfareModels().catch(() => undefined)
  }

  /** Refresh the public one-hour status independently of the model directory. */
  refreshLogfareHealthInBackground(): void {
    const now = Date.now()
    if (this.logfareHealthPromise !== undefined || (this.logfareHealthCache?.expiresAt ?? 0) > now) return
    const operation = fetchLogfareHealth().then((health) => {
      this.logfareHealthCache = { expiresAt: Date.now() + LOGFARE_STATUS_CACHE_TTL_MS, health }
      this.deps.ctx.emit('llm/adapters-updated')
    }, () => undefined)
    this.logfareHealthPromise = operation
    void operation.finally(() => {
      if (this.logfareHealthPromise === operation) this.logfareHealthPromise = undefined
    })
  }

  async refreshLogfareModels(): Promise<readonly LogfareModel[]> {
    if (this.logfareCatalogPromise !== undefined) return this.logfareCatalogPromise
    // One attempt per directory cadence after a failure: a directory that stays
    // down must not be re-fetched by every caller, and the last roster keeps
    // serving meanwhile.
    if (Date.now() < this.logfareCatalogRetryAfter) return this.logfareCatalogCache?.models ?? LOGFARE_FALLBACK_MODELS
    const generation = this.logfareCatalogGeneration
    const operation = this.loadLogfareModels().then((models) => {
      if (generation === this.logfareCatalogGeneration) {
        this.logfareCatalogCache = { expiresAt: Date.now() + LOGFARE_CATALOG_CACHE_TTL_MS, models }
        this.deps.ctx.emit('llm/adapters-updated')
      }
      return models
    }, () => {
      // "Did not answer" is not a roster. Caching the fallback here announced a
      // directory change that never happened, hid the live routes for the whole
      // TTL, and stopped the read path from retrying even after the upstream
      // recovered. Keep what was already known instead — the fallback set is for
      // a cold start, where nothing else exists. An invalidation during the
      // flight has already cleared the cache, so that roster is not resurrected.
      this.logfareCatalogRetryAfter = Date.now() + LOGFARE_CATALOG_CACHE_TTL_MS
      return this.logfareCatalogCache?.models ?? LOGFARE_FALLBACK_MODELS
    })
    this.logfareCatalogPromise = operation
    try { return await operation } finally { if (this.logfareCatalogPromise === operation) this.logfareCatalogPromise = undefined }
  }

  invalidateLogfareCatalog(): void {
    this.logfareCatalogGeneration += 1
    this.logfareCatalogPromise = undefined
    this.logfareCatalogCache = undefined
  }

  /**
   * One directory attempt. A transport failure or a non-2xx status is thrown to
   * the caller, which keeps the previous roster; only a directory that actually
   * answered may yield the fallback rows (an empty answer would otherwise blank
   * the picker).
   */
  private async loadLogfareModels(): Promise<readonly LogfareModel[]> {
    const [apiKey, trainingOptIn] = await Promise.all([this.logfareApiKey(), this.logfareTrainingOptIn()])
    // Keep model discovery independent from the optional health service. The
    // status endpoint can be slow during an upstream incident; it must not
    // replace a valid live model directory with the small fallback set.
    const response = await fetch(LOGFARE_MODELS_URL, {
      headers: { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) },
      signal: AbortSignal.timeout(LOGFARE_CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`FreeCodeGo model catalog failed with HTTP ${response.status}`)
    const payload = record(await response.json())
    const models = (Array.isArray(payload.data) ? payload.data : []).map(parseLogfareModel).filter((model): model is LogfareModel => model !== undefined)
      .map(model => model.requiresTrainingOptIn && trainingOptIn && !model.premiumUnlocked ? { ...model, premiumUnlocked: true } : model)
    // Health is refreshed separately and merged by listLogfareTextModels.
    return models.length > 0 ? models : LOGFARE_FALLBACK_MODELS
  }

  async sensenovaApiKey(): Promise<string | undefined> {
    const credential = await this.deps.credentials()?.resolve(SENSENOVA_API_KEY_REF)
    const value = credential?.value.trim() || process.env.SENSENOVA_API_KEY?.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async nvidiaApiKey(): Promise<string | undefined> {
    const credential = await this.deps.credentials()?.resolve(NVIDIA_API_KEY_REF)
    const value = credential?.value.trim() || process.env.NVIDIA_API_KEY?.trim()
    return value === undefined || value === '' ? undefined : value
  }

  /** Drop the pending NVIDIA directory probes when the stored key changes. */
  invalidateNvidiaCatalog(): void {
    this.nvidiaCatalog = emptyDirectCatalogState()
  }

  /** Drop the pending SenseNova directory probes when the stored key changes. */
  invalidateSenseNovaCatalog(): void {
    this.sensenovaCatalog = emptyDirectCatalogState()
  }

  /** Forget cached gateway channel monitors and the "no such route" verdict, so a
   * fresh login re-probes whichever backend it lands on. */
  invalidateGatewayHealth(): void {
    this.gatewayHealthCache = undefined
    this.gatewayHealthUnsupported = undefined
  }

  /** List SenseNova text/tool models, using the live directory when a key is available. */
  async listSenseNovaModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const key = await this.sensenovaApiKey()
    const rows = (source: readonly { readonly id: string; readonly name: string }[], availability: 'available' | 'unavailable', reason?: string): LlmModelInfo[] => source.map(model => ({
      provider, id: model.id, name: model.name, description: `SenseNova · ×0 · ${SENSENOVA_HEALTH_DESCRIPTION}`,
      availability, inputModalities: ['text'] as const,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
    }))
    if (key === undefined) return rows(SENSENOVA_MODELS, 'unavailable', 'SENSENOVA_API_KEY_REQUIRED')
    const outcome = await this.directCatalogOutcome(SENSENOVA_MODELS_URL, key, this.sensenovaCatalog)
    // The directory shares its host and bearer token with inference, so a 401 is
    // an answer about the credential itself, not an unreachable directory: those
    // routes fail on first use. Only 401 is read this way — 403 can mean an
    // authenticated account that may not list — and a directory that did not
    // answer at all still advertises the free tier, because a listing endpoint
    // being down does not make the routes unusable.
    if (outcome.kind === 'rejected') return rows(SENSENOVA_MODELS, 'unavailable', 'SENSENOVA_API_KEY_REJECTED')
    const allowed = new Set(outcome.ids)
    const listed = SENSENOVA_MODELS.filter(model => allowed.has(model.id))
    return rows(listed.length > 0 ? listed : SENSENOVA_MODELS, 'available')
  }

  /** List NVIDIA NIM text models. The public NIM directory answers without a
   * key; only membership in NVIDIA_MODELS is the free-tier signal, so a live
   * fetch can narrow the roster but never widen it. */
  async listNvidiaModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const key = await this.nvidiaApiKey()
    const rows = (source: readonly { readonly id: string; readonly name: string }[], availability: 'available' | 'unavailable', reason?: string): LlmModelInfo[] => source.map(model => ({
      provider, id: model.id, name: model.name, description: 'NVIDIA · ×0 · free',
      availability, inputModalities: ['text'] as const,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
    }))
    if (key === undefined) return rows(NVIDIA_MODELS, 'unavailable', 'NVIDIA_API_KEY_REQUIRED')
    const outcome = await this.directCatalogOutcome(NVIDIA_MODELS_URL, key, this.nvidiaCatalog)
    // See listSenseNovaModels: a refused credential is a fact about using these
    // routes, while a directory that did not answer is not.
    if (outcome.kind === 'rejected') return rows(NVIDIA_MODELS, 'unavailable', 'NVIDIA_API_KEY_REJECTED')
    const allowed = new Set(outcome.ids)
    const listed = NVIDIA_MODELS.filter(model => allowed.has(model.id))
    return rows(listed.length > 0 ? listed : NVIDIA_MODELS, 'available')
  }

  /**
   * One answered directory read, shared by every caller and cached for the
   * cadence in `DIRECT_CATALOG_CACHE_TTL_MS`.
   *
   * A read that has a roster to show never waits on the network: past its TTL it
   * keeps serving the known roster while revalidating off the read path. Only a
   * directory that actually answered is cached and only that may announce a
   * change — a failed read is not an answer, and recording one as such is how a
   * transient outage becomes a roster that looks authoritative for a whole TTL.
   */
  private async directCatalogOutcome(url: string, key: string, state: DirectCatalogState): Promise<DirectCatalogOutcome> {
    const answer = state.answer
    if (answer !== undefined) {
      if (Date.now() >= answer.expiresAt) this.loadDirectCatalogInBackground(url, key, state)
      return { kind: 'answered', ids: answer.ids }
    }
    if (state.load !== undefined) return state.load
    // One attempt per cadence after a failure: a directory that stays down must
    // not be re-fetched by every listing, and the static roster serves meanwhile.
    if (Date.now() < state.retryAfter) return { kind: 'unreachable', ids: [] }
    return this.loadDirectCatalog(url, key, state)
  }

  private loadDirectCatalogInBackground(url: string, key: string, state: DirectCatalogState): void {
    if (state.load !== undefined || Date.now() < state.retryAfter) return
    void this.loadDirectCatalog(url, key, state).catch(() => undefined)
  }

  private loadDirectCatalog(url: string, key: string, state: DirectCatalogState): Promise<DirectCatalogOutcome> {
    const operation = (async (): Promise<DirectCatalogOutcome> => {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) })
        if (response.status === 401) return { kind: 'rejected', ids: [] }
        if (!response.ok) return { kind: 'unreachable', ids: [] }
        const payload = record(await response.json())
        const ids = Array.isArray(payload.data)
          ? payload.data.map((item) => { const id = record(item).id; return typeof id === 'string' ? id.trim() : '' }).filter(id => id !== '')
          : []
        state.answer = { expiresAt: Date.now() + DIRECT_CATALOG_CACHE_TTL_MS, ids }
        state.retryAfter = 0
        this.deps.ctx.emit('llm/adapters-updated')
        return { kind: 'answered', ids }
      } catch {
        return { kind: 'unreachable', ids: [] }
      }
    })()
    // The attempt itself spaces the next one, so a refused or unreachable
    // directory is not re-fetched until the cadence is over.
    state.retryAfter = Date.now() + DIRECT_CATALOG_CACHE_TTL_MS
    state.load = operation
    void operation.finally(() => { if (state.load === operation) state.load = undefined })
    return operation
  }

  /**
   * Writes into the plugin's state directory (`catalogCachePath`) started
   * without a caller able to await them — the model directories below and the
   * community/marketplace catalogs — so plugin teardown can wait instead of
   * abandoning them.
   *
   * Several directory refreshes announce themselves as "in the background"
   * precisely so a picker never blocks on the network. The file they write
   * afterwards still belongs to this plugin's lifetime: an untracked write can
   * land after the plugin was unloaded, and — because the path is derived from
   * `DSH_HOME` at write time — into whatever home is current then rather than
   * the one the refresh was started for.
   */
  readonly pendingWrites = new PendingWriteDrain()

  /** Write one catalog cache file under the plugin's tracked-write budget. */
  private async writeCatalogCache(file: string, value: Record<string, unknown>): Promise<void> {
    await this.pendingWrites.run(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await writeJsonFile(file, value)
    })
  }

  /** Profile-state cache files live under the active DSH home. */
  catalogCachePath(name: string): string {
    return path.join(harnessHomeDirectory(), 'state', 'freecodego', name)
  }

  /** Return only the gateway reasoning levels not rejected by this exact model. */
  private gatewayReasoningEfforts(model: string): readonly GatewayReasoningEffort[] | undefined {
    // Logfare ids share the same rejection cache; no prefix bypasses it.
    const rejected = this.rejectedGatewayReasoning.get(model)
    return rejected === undefined ? GATEWAY_REASONING_EFFORTS : GATEWAY_REASONING_EFFORTS.filter(effort => effort === 'off' || !rejected.has(effort))
  }

  /** Cache an upstream 400 that explicitly rejects one selected effort. */
  private rejectGatewayReasoningEffort(model: string, effort: Exclude<GatewayReasoningEffort, 'off'>): void {
    const rejected = this.rejectedGatewayReasoning.get(model) ?? new Set<Exclude<GatewayReasoningEffort, 'off'>>()
    if (rejected.has(effort)) return
    rejected.add(effort)
    this.rejectedGatewayReasoning.set(model, rejected)
    // Background persistence is best-effort: a full disk or locked file must
    // not surface as an unhandled rejection.
    void this.writeGatewayReasoningCapabilities().catch(() => undefined)
    this.deps.ctx.emit('llm/adapters-updated')
  }

  /** Restore prior model-specific provider rejections without storing any credential. */
  async loadGatewayReasoningCapabilities(): Promise<void> {
    try {
      const parsed = record(JSON.parse(await fs.readFile(this.catalogCachePath('gateway-reasoning-capabilities.json'), 'utf8')))
      const rejected = record(parsed.rejected)
      for (const [model, value] of Object.entries(rejected)) {
        if (!Array.isArray(value)) continue
        const levels = value.filter((entry): entry is Exclude<GatewayReasoningEffort, 'off'> => typeof entry === 'string' && entry !== 'off' && isGatewayReasoningEffort(entry))
        if (levels.length > 0) this.rejectedGatewayReasoning.set(model, new Set(levels))
      }
      if (this.rejectedGatewayReasoning.size > 0) this.deps.ctx.emit('llm/adapters-updated')
    } catch { /* no cache before the first model-specific rejection */ }
  }

  private async writeGatewayReasoningCapabilities(): Promise<void> {
    const rejected: Record<string, readonly Exclude<GatewayReasoningEffort, 'off'>[]> = {}
    for (const [model, levels] of this.rejectedGatewayReasoning) rejected[model] = [...levels]
    const file = this.catalogCachePath('gateway-reasoning-capabilities.json')
    await this.writeCatalogCache(file, { version: 1, rejected })
  }

  async readManagedCatalogCache(): Promise<FreeCodeGoManagedCatalog | undefined> {
    const cache = await readManagedCatalogCache(this.catalogCachePath('managed-model-catalog.json'))
    return cache === undefined ? undefined : cache.catalog
  }

  async writeManagedCatalogCache(catalog: FreeCodeGoManagedCatalog): Promise<void> {
    const file = this.catalogCachePath('managed-model-catalog.json')
    await this.writeCatalogCache(file, { version: 1, savedAt: Date.now(), catalog })
  }

  // ============================================================================
  // WorkBuddy International Edition (workbuddy.ai)
  // ============================================================================

  /**
   * Read WorkBuddy accounts from the credential provider vault.
   *
   * The provider client is the one owner of this document: the card, the
   * directory, and the chat adapter all have to see the same pool, and two
   * parsers of one vault blob drifted apart the moment either side changed.
   */
  async workbuddyAccounts(): Promise<readonly WorkBuddyInternationalAccount[]> {
    return readWorkBuddyIntlAccounts(this.deps.credentials())
  }

  /**
   * The account the card last selected, if any.
   *
   * Read through the same store the pool reads, so the reported selection and
   * the account a turn starts on cannot drift apart.
   */
  async workbuddyActiveAccountId(): Promise<string | undefined> {
    return readWorkBuddyIntlActiveId(this.deps.credentials())
  }

  /** Clear WorkBuddy accounts from the credential provider vault. */
  clearWorkbuddyAccounts(): void {
    void this.deps.credentials()?.unset(credentialRef('WORKBUDDY_INTL_STORE')).catch(() => undefined)
  }

  /**
   * Add or replace one WorkBuddy account from caller-supplied tokens.
   *
   * The desktop-authorization import produces exactly this shape, so the
   * imported account rides the same store, refresh, and rotation paths the
   * previous password login used. An imported credential without a usable
   * expiry is recorded with a one-hour window so the refresh margin engages
   * on the first request instead of being treated as already valid.
   */
  async workbuddyImportAccount(input: { readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt?: number; readonly email?: string; readonly id?: string; readonly uid?: string; readonly domain?: string; readonly enterpriseId?: string }): Promise<void> {
    const accessToken = input.accessToken.trim()
    if (accessToken === '') throw new Error('WORKBUDDY_IMPORT_FAILED: access token is empty')
    // Each step of the identity chain is normalized before it is tested. The
    // email step used to read `input.email?.trim() !== ''`, which is *true* when
    // the field is absent (`undefined !== ''`), so the chain's token-suffix
    // fallback was unreachable: an import carrying only tokens threw
    // `Cannot read properties of undefined (reading 'trim')` instead of
    // deriving `workbuddy-<token tail>`.
    const email = input.email?.trim() ?? ''
    const uid = input.uid?.trim() ?? ''
    const id = input.id?.trim() || uid || (email === '' ? '' : accountId(email)) || `workbuddy-${accessToken.slice(-12)}`
    const account: WorkBuddyInternationalAccount = {
      id,
      ...(input.email === undefined || input.email.trim() === '' ? {} : { email: input.email.trim() }),
      accessToken,
      ...(input.refreshToken === undefined || input.refreshToken.trim() === '' ? {} : { refreshToken: input.refreshToken.trim() }),
      expiresAt: typeof input.expiresAt === 'number' && input.expiresAt > 0 ? input.expiresAt : Date.now() + 3_600_000,
      creditTotal: 0,
      lastChecked: Date.now(),
      // The routing identity the product host expects; preserved verbatim so
      // chat requests can carry the same X-User-Id/X-Domain the sign-in used.
      ...(uid === '' ? {} : { uid }),
      ...(input.domain === undefined || input.domain.trim() === '' ? {} : { domain: input.domain.trim() }),
      ...(input.enterpriseId === undefined || input.enterpriseId.trim() === '' ? {} : { enterpriseId: input.enterpriseId.trim() }),
    }
    const store = await this.workbuddyAccounts()
    const accounts = [...store.filter(a => a.id !== account.id), account]
    const credentialProvider = this.deps.credentials()
    if (credentialProvider === undefined) throw new Error('Credential provider is not configured')
    await credentialProvider.set(credentialRef('WORKBUDDY_INTL_STORE'), JSON.stringify({ accounts, activeAccountId: account.id }))
  }

  /**
   * The free routes the WorkBuddy pool can serve right now.
   *
   * Served from the same client the chat adapter uses, so the card lists exactly
   * the routes a turn can actually reach.
   */
  async workbuddyFreeModels(): Promise<readonly WorkBuddyInternationalModel[]> {
    const client = this.deps.workbuddy()
    if (client === undefined) return []
    return client.freeModels()
  }

  /**
   * Replace one stored account's tokens after a refresh.
   *
   * The credit snapshot is carried over: a token rotation says nothing about the
   * account's balance, and zeroing it would make the card report a spent account
   * as brand new.
   */
  async workbuddyPersistTokens(input: { readonly id: string; readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number }): Promise<void> {
    const credentialProvider = this.deps.credentials()
    if (credentialProvider === undefined) return
    const credential = await credentialProvider.resolve(WORKBUDDY_INTL_STORE_REF)
    if (credential?.value === undefined) return
    try {
      const parsed = record(JSON.parse(credential.value))
      const rows = Array.isArray(parsed.accounts) ? parsed.accounts : []
      const accounts = rows.map((item) => {
        const row = record(item)
        // Address the row through the same resolver the reader uses. Testing
        // `row.id` alone both missed the legacy rows that have no `id` (whose
        // rotation then never reached the vault) and, because the guard was
        // written as a negated conjunction, treated a row with no string `id`
        // as the target and overwrote it with ANOTHER account's tokens — two
        // accounts left sharing one credential and the clobbered refresh token
        // gone.
        if (workBuddyIntlAccountId(row) !== input.id) return item
        return {
          ...row,
          accessToken: input.accessToken,
          ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
          expiresAt: input.expiresAt,
          lastChecked: Date.now(),
        }
      })
      await credentialProvider.set(WORKBUDDY_INTL_STORE_REF, JSON.stringify({ ...parsed, accounts }))
    } catch {
      // A failed persist costs one extra refresh next turn, never the account.
    }
  }

  /** Drop the cached WorkBuddy directory so the next read hits the network. */
  invalidateWorkbuddyCatalog(): void {
    this.deps.workbuddy()?.invalidateCatalog()
  }

  // ============================================================================
  // Additional WorkBuddy operations
  // ============================================================================

  /**
   * Remove a specific WorkBuddy account by ID.
   *
   * The id is resolved through {@link workBuddyIntlAccountId}, never read off
   * `row.id`: a caller only ever holds an id the reader handed out, and for a
   * vault written before rows carried an `id` that id is the uid, the address,
   * or the token tail. Matching the raw field found nothing there, so removal
   * reported success and the account was back on the next read.
   *
   * A refused write is reported: swallowing it presented a pool that still held
   * the account as a completed removal.
   */
  async workbuddyRemoveAccount(accountId: string): Promise<void> {
    const credentialProvider = this.deps.credentials()
    if (credentialProvider === undefined) throw new Error('Credential provider is not configured')
    const credential = await credentialProvider.resolve(credentialRef('WORKBUDDY_INTL_STORE'))
    if (credential?.value === undefined) return

    const parsed = record(JSON.parse(credential.value))
    const rows = Array.isArray(parsed.accounts) ? parsed.accounts : []
    const identified = rows.map(item => ({ item, id: workBuddyIntlAccountId(record(item)) }))
    const survivors = identified.filter(entry => entry.id !== accountId)
    // The selection survives a removal that did not touch it, and moves to a
    // survivor the reader can address when it did. `accounts[0].id` would have
    // promoted a token-only row under an empty id, leaving no selection at all.
    const activeAccountId = activeAccountIdAfterRemoval(
      survivors.flatMap(entry => entry.id === undefined ? [] : [{ id: entry.id }]),
      text(parsed.activeAccountId),
    )
    delete parsed.activeAccountId
    await credentialProvider.set(credentialRef('WORKBUDDY_INTL_STORE'), JSON.stringify({
      ...parsed,
      accounts: survivors.map(entry => entry.item),
      // An emptied or unaddressable pool records no selection rather than a key
      // holding `undefined`.
      ...(activeAccountId === undefined ? {} : { activeAccountId }),
    }))
  }

  /**
   * Set the active WorkBuddy account by ID.
   *
   * Resolved through the reader's own function for the same reason as removal.
   * The not-found error travels to the caller: the previous catch replaced it
   * with a constant sentence, so a stale id and a refused write were reported
   * identically.
   */
  async workbuddySetActiveAccount(accountId: string): Promise<void> {
    const credentialProvider = this.deps.credentials()
    if (credentialProvider === undefined) throw new Error('Credential provider is not configured')
    const credential = await credentialProvider.resolve(credentialRef('WORKBUDDY_INTL_STORE'))
    if (credential?.value === undefined) throw new Error('No WorkBuddy accounts configured')

    const parsed = record(JSON.parse(credential.value))
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
    const exists = accounts.some(item => workBuddyIntlAccountId(record(item)) === accountId)
    if (!exists) throw new Error(`WorkBuddy account '${accountId}' not found`)
    await credentialProvider.set(credentialRef('WORKBUDDY_INTL_STORE'), JSON.stringify({ ...parsed, accounts, activeAccountId: accountId }))
    this.invalidateWorkbuddyCatalog()
  }

  /** Refresh WorkBuddy access token using refresh token. */
  async workbuddyRefreshToken(refreshToken: string): Promise<{ readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number }> {
    const response = await fetch(WORKBUDDY_INTL_TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FreeCodeGo-Harness',
        // The refresh token travels in a header, never in the body: the body
        // form is not accepted by this endpoint.
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
      },
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      throw new Error(`WorkBuddy token refresh failed: HTTP ${response.status}`)
    }

    const data = record(await response.json())
    const accessToken = typeof data.accessToken === 'string' && data.accessToken.trim() !== '' ? data.accessToken.trim() : (typeof data.access_token === 'string' && data.access_token.trim() !== '' ? data.access_token.trim() : undefined)

    if (accessToken === undefined) {
      throw new Error('WorkBuddy token refresh returned no access token')
    }

    return {
      accessToken,
      ...(typeof data.refreshToken === 'string' && data.refreshToken.trim() !== '' ? { refreshToken: data.refreshToken.trim() } : {}),
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : (typeof data.expiresInSec === 'number' ? Date.now() + data.expiresInSec * 1000 : Date.now() + 3600_000),
    }
  }

  /**
   * Merge what a pool sweep learned into the stored account document.
   *
   * A failed credit query records *why* and leaves the last good figures in
   * place: overwriting a real balance with zeros because one request timed out
   * would make the card announce an emptied account.
   */
  async workbuddyApplyAccountState(accountId: string, update: WorkBuddyAccountUpdate): Promise<void> {
    if (update.credits === undefined) return
    const provider = this.deps.credentials()
    if (provider === undefined) return
    const credential = await provider.resolve(WORKBUDDY_INTL_STORE_REF)
    if (credential?.value === undefined) return
    try {
      const parsed = record(JSON.parse(credential.value))
      const rows = Array.isArray(parsed.accounts) ? parsed.accounts : []
      const credits = update.credits
      const accounts = rows.map((item) => {
        const row = record(item)
        // Same resolver as the reader and the token writer: a legacy row with no
        // `id` is addressed by its uid/address, so its credit sweep lands in the
        // vault instead of being dropped every time.
        if (workBuddyIntlAccountId(row) !== accountId) return item
        return {
          ...row,
          ...(credits === undefined ? {} : {
            ...(credits.error === undefined ? {
              creditTotal: credits.total,
              creditRemaining: credits.remaining,
              creditUsed: credits.used,
              ...(credits.soonestExpireAt === undefined ? {} : { creditExpiresAt: credits.soonestExpireAt }),
            } : {}),
            creditCheckedAt: credits.checkedAt,
            creditExpiringSoon: credits.expiringSoon,
            // `undefined` drops the key through JSON.stringify, which is how a
            // recovered account stops reporting its last failure.
            creditError: credits.error,
          }),
          lastChecked: Date.now(),
        }
      })
      await provider.set(WORKBUDDY_INTL_STORE_REF, JSON.stringify({ ...parsed, accounts }))
    } catch {
      // A failed persist costs one extra sweep later, never the account.
    }
  }

}

function accountId(email: string): string {
  return email.trim().toLowerCase()
}
