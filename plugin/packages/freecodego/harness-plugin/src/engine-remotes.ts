/**
 * Engine, capability, and runtime remotes for the FreeCodeGo Harness plugin:
 * default engine/model persistence, the redacted engine catalog, model
 * availability, session-lifecycle facts and deletion, native runtime installs,
 * capability and MCP/Skill switches, native runtime openers, and the gateway
 * client wiring shared by the managed catalog and media clusters. The plugin
 * class satisfies the narrow host view below; members that map to plugin
 * methods delegate back to the live instance so instance-level overrides
 * (tests, future remotes) keep working.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engine-remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { FreeCodeGoAccountCoordinator, FreeCodeGoApiClient, FreeCodeGoMobileAuthClient, HarnessFreeCodeGoCredentialVault, isLockedRoute } from '@deepseek-ai/dsh-freecodego-api'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CodexRuntimeManager, ClaudeRuntimeManager } from '@deepseek-ai/dsh-freecodego-native-runtime-host'
import type { FreeCodeGoAgentOptions, NativeAgentRuntimeOpeners } from '@deepseek-ai/dsh-freecodego-root-agent'
import { openCodexRootRuntime } from '@deepseek-ai/dsh-freecodego-runtime-codex'
import { claudeHarnessToolName, claudeMcpToolName, openClaudeRootRuntime } from '@deepseek-ai/dsh-freecodego-runtime-claude'
import { backendNotConfigured, setEngineAvailability } from './account-utils.ts'
import { AgnesAdapter, AgnesClient } from './agnes.ts'
import { ClineAdapter, ClineClient } from './cline.ts'
import { WorkBuddyIntlClient } from './workbuddy-intl.ts'
import { WorkBuddyPoolService } from './workbuddy-pool.ts'
import type { ClaudeProtocolBridge } from './claude-protocol-bridge.ts'
import type { FreeCodeGoCapabilityRegistry } from './capabilities.ts'
import { installFreeCodeGoPluginConflictGuard } from './plugin-conflicts.ts'
import { requireRuntimeWorkerPath } from './runtime-assets.ts'
import type { Config } from './plugin-config.ts'
import { deletePersistedSession } from './session-storage-utils.ts'
import { readPersistedEvents, type SessionDeletionPersistence, type SessionEventsPersistence } from './session-storage-utils.ts'
import { gatewayModelId, inferMediaCategory } from './media-utils.ts'
import { agnesMediaCategory } from './agnes.ts'
import { record } from './media-generation.ts'
import { normalizeWireProtocol, SUPPORTED_WIRE_PROTOCOLS } from './openai-compatible-adapter.ts'
import { AGNES_TEXT_MODEL_IDS } from './engineering-remotes.ts'
import { enrichCatalogChoices, mergeCatalogModels, parseGroupPin } from './model-catalog.ts'
import {
  KILO_GATEWAY_BASE_URL, KILO_ANONYMOUS_API_KEY, KILO_MODEL_PREFIX, LOGFARE_AUTO_MODEL, LOGFARE_MODEL_PREFIX, MODEL_CATALOG_TIMEOUT_MS, OPENCODE_AUTO_MODEL, openCodeAutoPreference, OPENCODE_DIRECT_BASE_URL,
  VYCE_MODEL_PREFIX,
  withTimeout,
} from './managed-catalog-utils.ts'
import { FREE_UPSTREAM_MODELS, type FreeCodeGoManagedCatalogs } from './managed-catalogs.ts'
import type { FreeCodeGoSettingsPort } from './policy.ts'
import type { FreeCodeGoCapabilitySnapshot, FreeCodeGoClaudeRuntimeStatus, FreeCodeGoCodexRuntimeStatus, FreeCodeGoEngineId, FreeCodeGoEngineSnapshot, FreeCodeGoManagedCatalog, FreeCodeGoModelAvailability, FreeCodeGoMcpServer, FreeCodeGoModelCategory, FreeCodeGoPluginConflictStatus, FreeCodeGoSkillDetail, FreeCodeGoSkillDetailRequest, FreeCodeGoSkillRoot } from './types.ts'
import type { FreeCodeGoManagedRuntime } from '@deepseek-ai/dsh-freecodego-api'

/** Default hosted FreeCodeGo origin; deployments may override it with HTTPS. */
export const FREECODEGO_CLOUD_ORIGIN = 'https://freecodego.com'

/**
 * Narrow view of the plugin surface required by the engine, capability, and
 * runtime remotes. The plugin satisfies it through its `engineRemotesHost`
 * accessor. Mutable plugin state (`account`, `api`, `credentials`, `agnes`,
 * `gatewayBaseUrl`) is read per accessor call and written back through the
 * setter members so `configureGateway` keeps mutating the live instance.
 */
export interface EngineRemotesHost {
  readonly ctx: Context
  readonly config: Config
  readonly capabilities: FreeCodeGoCapabilityRegistry
  readonly pluginConflictGuard: ReturnType<typeof installFreeCodeGoPluginConflictGuard>
  readonly agentEngines: { setAvailability?: (id: 'codex' | 'claude', availability: 'available' | 'unavailable' | 'updating') => void } | undefined
  /**
   * The settings these remotes read and write.
   *
   * Every read is a *behaviour* read — the engine and model a new session gets —
   * so it goes through the policy port rather than the registered scope: this file
   * never has to know which namespace, defaults, or storage produced the answer.
   */
  readonly policy: FreeCodeGoSettingsPort
  readonly api: FreeCodeGoApiClient | undefined
  readonly account: FreeCodeGoAccountCoordinator | undefined
  readonly agnes: AgnesClient | undefined
  readonly cline: ClineClient | undefined
  readonly catalogs: FreeCodeGoManagedCatalogs
  readonly claudeBridge: ClaudeProtocolBridge
  readonly gatewayBaseUrl: string
  /** Accessors keep instance-level runtime overrides visible. */
  readonly codexRuntime: () => CodexRuntimeManager
  readonly claudeRuntime: () => ClaudeRuntimeManager
  readonly restoreAccount: () => Promise<void>
  readonly defaultAgentOptions: () => { readonly engine: 'deepseek' | 'codex' | 'claude'; readonly provider: string; readonly model?: string }
  readonly configuredProviderRoute: (model: string) => { readonly provider: string; readonly model: string } | undefined
  readonly routeForModel: (model: string, accessToken: string) => Promise<string>
  readonly setCredentials: (credentials: CredentialProvider | undefined) => void
  readonly setAgnes: (agnes: AgnesClient | undefined) => void
  readonly setCline: (cline: ClineClient | undefined) => void
  readonly setWorkbuddy: (workbuddy: WorkBuddyIntlClient | undefined) => void
  readonly setWorkbuddyPool: (pool: WorkBuddyPoolService | undefined) => void
  readonly setAccount: (account: FreeCodeGoAccountCoordinator | undefined) => void
  readonly setApi: (api: FreeCodeGoApiClient | undefined) => void
  readonly setGatewayBaseUrl: (baseUrl: string) => void
}

export async function setDefaultEngine(host: EngineRemotesHost, engine: string): Promise<{ readonly engine: 'deepseek' | 'codex' | 'claude' }> {
  if (engine !== 'deepseek' && engine !== 'codex' && engine !== 'claude') throw new Error('agent engine must be deepseek, codex, or claude')
  if (engine === 'codex' && !host.codexRuntime().status().installed) throw new Error('CODEX_RUNTIME_NOT_INSTALLED: install Codex before selecting it')
  if (engine === 'claude' && !host.claudeRuntime().status().installed) throw new Error('CLAUDE_RUNTIME_NOT_INSTALLED: install Claude before selecting it')
  if (host.policy.get() === undefined) throw new Error('FreeCodeGo settings are not configured')
  await host.policy.update({
    defaultEngine: engine,
  })
  return { engine }
}

/** Persist the model id used by future sessions; live sessions remain pinned.
 * An empty model explicitly clears the persisted default, after which the Host
 * falls back to config/engine defaults. The picker no longer offers this as a
 * standing "backend default" choice — it was a no-op wherever no default was
 * stored — but clearing stays supported for callers that hold the setting. */
export async function setDefaultModel(host: EngineRemotesHost, model: string): Promise<{ readonly model: string }> {
  if (model.trim() === '') {
    if (host.policy.get() === undefined) throw new Error('FreeCodeGo settings are not configured')
    await host.policy.update({ defaultModel: '' })
    return { model: '' }
  }
  const normalized = model.trim()
  if (normalized.length > 256 || /[\r\n]/.test(normalized)) throw new Error('agent model is invalid')
  if (host.policy.get() === undefined) throw new Error('FreeCodeGo settings are not configured')
  const media = /^__freecodego_media_default__:(image|video|audio):(.*)$/u.exec(normalized)
  if (media !== null) {
    const category = media[1] as 'image' | 'video' | 'audio'
    const mediaModel = media[2]?.trim() ?? ''
    const current = (host.policy.get()?.mediaDefaults ?? { image: '', video: '', audio: '' })
    await host.policy.update({ mediaDefaults: { ...current, [category]: mediaModel } })
    return { model: mediaModel }
  }
  // A media-only id (image/video generation) is not a valid text default;
  // direct it into the media-default channel instead of persisting it as
  // the chat model for future sessions. The shared heuristic covers the
  // live Agnes media directory (any `agnes-*-image-*` / `agnes-*-video-*`
  // id), so selection can never break every new session afterwards.
  const mediaCategory = inferMediaCategory(normalized)
    ?? (normalized.toLowerCase().startsWith('agnes/') ? agnesMediaCategory(normalized.slice('agnes/'.length)) : agnesMediaCategory(normalized))
  if (mediaCategory !== undefined) {
    const current = (host.policy.get()?.mediaDefaults ?? { image: '', video: '', audio: '' })
    await host.policy.update({ mediaDefaults: { ...current, [mediaCategory]: normalized } })
    return { model: normalized }
  }
  const routed = host.configuredProviderRoute(normalized)
  const persisted = routed === undefined || normalized.includes('/') || routed.provider === 'freecodego'
    ? normalized
    : `${routed.provider}/${routed.model}`
  await host.policy.update({ defaultModel: persisted })
  return { model: persisted }
}

/** Root-engine defaults are read by the Host API only for new identities. */
export function defaultAgentOptions(host: EngineRemotesHost): { readonly engine: 'deepseek' | 'codex' | 'claude'; readonly provider: string; readonly model?: string } {
  const configuredEngine = host.policy.get()?.defaultEngine ?? host.config.defaultEngine ?? 'deepseek'
  const engine = configuredEngine === 'codex' || configuredEngine === 'claude' ? configuredEngine : 'deepseek'
  const model = host.policy.get()?.defaultModel ?? host.config.defaultModel
  const normalizedModel = model?.trim()
  // Media defaults are persisted through the `__freecodego_media_default__`
  // channel; a media Agnes id must never become the text default route.
  if (normalizedModel !== undefined && AGNES_TEXT_MODEL_IDS.has(normalizedModel)) return { engine, provider: 'agnes', model: normalizedModel }
  if (normalizedModel?.toLowerCase().startsWith(LOGFARE_MODEL_PREFIX)) return { engine, provider: 'logfare', model: normalizedModel.slice(LOGFARE_MODEL_PREFIX.length) }
  if (normalizedModel?.toLowerCase().startsWith(VYCE_MODEL_PREFIX)) return { engine, provider: 'vyce', model: normalizedModel }
  // Migrate aliases persisted by releases that incorrectly placed OpenCode
  // routes under `freecodego`. The current Host catalog owns these ids under
  // the dedicated `opencode` provider, so new sessions must not resurrect
  // `freecodego/hy3` (or its sibling aliases). Persisted ids may still carry
  // the plugin-adapter prefix, so strip it before the catalog comparison.
  // The live OpenCode directory is authoritative: a dynamically discovered
  // free model routed to the FreeCodeGo gateway would fail every new session
  // with MODEL_ROUTE_UNAVAILABLE, so consult it (synchronously, from the
  // Host-cached catalog) before falling back to the gateway.
  const bareModel = normalizedModel?.replace(/^freecodego\//iu, '')
  const openCodeCandidates = host.catalogs.cachedOpenCodeFreeModels?.() ?? FREE_UPSTREAM_MODELS
  if (bareModel !== undefined && openCodeCandidates.some(candidate => candidate.id.toLowerCase() === bareModel.toLowerCase())) {
    return { engine, provider: 'opencode', model: bareModel }
  }
  const configuredRoute = normalizedModel === undefined ? undefined : host.configuredProviderRoute(normalizedModel)
  if (configuredRoute !== undefined) return { engine, provider: configuredRoute.provider, model: configuredRoute.model }
  // Codex chooses the effective model from its authenticated config when no
  // explicit model is supplied. Keep a private sentinel in the durable
  // engine plan so the shared AgentOptions shape remains total; the Codex
  // worker strips it before thread/start and returns the real model id.
  if (engine === 'codex') return model === undefined || model.trim() === ''
    ? { engine, provider: 'codex', model: 'codex-auto' }
    : { engine, provider: 'codex', model }
  return normalizedModel === undefined || normalizedModel === ''
    ? { engine, provider: 'freecodego' }
    : { engine, provider: 'freecodego', model: normalizedModel }
}

/** Resolve a saved model against user-owned llm-pi-ai routes before falling back to FreeCodeGo.
 * The OpenRouter direct provider was retired: persisting its mapping made old
 * profiles resolve to an adapter that no longer exists, so those ids now fall
 * through to the configured-route/gateway path (or fail explicitly there). */
function providerForModelId(host: EngineRemotesHost, model: string): string | undefined {
  const normalized = model.trim()
  if (normalized.toLowerCase().startsWith(LOGFARE_MODEL_PREFIX)) return 'logfare'
  if (normalized.toLowerCase().startsWith(VYCE_MODEL_PREFIX)) return 'vyce'
  return host.configuredProviderRoute(normalized)?.provider
}

/** Resolve the native execution plan through the RC.1 AgentFactory seam. */
export function nativeAgentOptionsAlpha(
  host: EngineRemotesHost,
  restore?: { readonly engine: 'codex' | 'claude'; readonly modelId?: string; readonly provider?: string },
  requested?: AgentOptions,
): AgentOptions & FreeCodeGoAgentOptions & { readonly provider: string } {
  const defaults = defaultAgentOptions(host)
  const requestedProvider = requested?.provider?.trim()
  const requestedModel = requested?.model?.trim()
  // The two keys below are FreeCodeGo's own extension of the option bag, not part
  // of the Harness's `AgentOptions`; widening the view once here is what lets both
  // the read and the strip use one spelling of the caller's request.
  const freeCodeGoRequested = requested as (AgentOptions & FreeCodeGoAgentOptions) | undefined
  const requestedEngine = freeCodeGoRequested?.freeCodeGoNative?.engine ?? freeCodeGoRequested?.freeCodeGoEngine
  const delegated = requestedEngine !== undefined
  const acceptRequestedRoute = defaults.engine === 'claude' || delegated
  const { freeCodeGoNative: _staleNativePlan, freeCodeGoEngine: _staleEngine, ...passthrough } = freeCodeGoRequested ?? {}
  const selected = restore === undefined
    ? {
      ...defaults,
      ...(requestedEngine === undefined ? {} : { engine: requestedEngine }),
      ...(!acceptRequestedRoute || requestedProvider === undefined || requestedProvider === '' ? {} : { provider: requestedProvider }),
      ...(!acceptRequestedRoute || requestedModel === undefined || requestedModel === '' ? {} : { model: requestedModel }),
    }
    : {
      engine: restore.engine,
      provider: restore.provider ?? (restore.modelId === undefined ? undefined : providerForModelId(host, restore.modelId)) ?? (restore.engine === 'codex' ? 'codex' : 'freecodego'),
      ...(restore.modelId === undefined
        ? defaults.engine === restore.engine && defaults.model !== undefined
          ? { model: defaults.model }
          : {}
        : { model: restore.modelId }),
    }
  // A stale caller can still send the old FreeCodeGo provider marker with a
  // model that belongs to a user-owned llm-pi-ai route. Correct it at the
  // native boundary so Claude/Codex bridges never silently use our gateway.
  const selectedExternal = selected.provider === 'freecodego' && selected.model !== undefined
    ? host.configuredProviderRoute(selected.model)
    : undefined
  const routedSelected = selectedExternal === undefined
    ? selected
    : { ...selected, provider: selectedExternal.provider, model: selectedExternal.model }
  if (routedSelected.engine === 'deepseek') return {
    ...passthrough,
    provider: routedSelected.provider,
    ...(routedSelected.model === undefined ? {} : { model: routedSelected.model }),
    freeCodeGoEngine: 'deepseek',
  }
  const runtime = routedSelected.engine === 'codex' ? host.codexRuntime().status() : host.claudeRuntime().status()
  if (!runtime.installed || runtime.artifactDigest === undefined) {
    return {
      ...passthrough,
      provider: routedSelected.provider,
      ...(routedSelected.model === undefined ? {} : { model: routedSelected.model }),
      ...(routedSelected.engine === 'claude' ? { freeCodeGoEngine: 'claude' as const } : {}),
    }
  }
  if (routedSelected.engine === 'claude' && (routedSelected.model === undefined || routedSelected.model.trim() === '')) {
    throw new Error('CLAUDE_MODEL_REQUIRED: select a plugin model before creating a Claude session')
  }
  const modelId = routedSelected.model ?? 'codex-auto'
  return {
    ...passthrough,
    provider: routedSelected.provider,
    model: modelId,
    freeCodeGoNative: {
      engine: routedSelected.engine,
      modelId,
      provider: routedSelected.provider,
      artifactDigest: runtime.artifactDigest,
      protocolAbi: 'freecodego-agent/1',
    },
  }
}

/** Return the redacted engine directory consumed by settings surfaces. */
export function catalog(host: EngineRemotesHost): { readonly defaultEngine: FreeCodeGoEngineId; readonly defaultModel?: string; readonly engines: readonly FreeCodeGoEngineSnapshot[] } {
  const backendReady = host.api !== undefined && host.account !== undefined
  const codex = host.codexRuntime().status()
  return {
    defaultEngine: host.defaultAgentOptions().engine === 'codex' || host.defaultAgentOptions().engine === 'claude' ? host.defaultAgentOptions().engine : 'freecodego',
    ...(host.defaultAgentOptions().model === undefined ? {} : { defaultModel: host.defaultAgentOptions().model }),
    engines: [{
      id: 'freecodego', generation: 1,
      availability: backendReady ? 'available' : 'unavailable',
      reasons: backendReady ? [] : ['FREECODEGO_BACKEND_NOT_CONFIGURED'],
      draining: false, activeLeaseCount: 0,
    }, {
      id: 'codex', generation: 1,
      availability: codex.installed ? 'available' : 'unavailable',
      reasons: codex.installed ? [] : [codex.reason ?? 'CODEX_RUNTIME_NOT_INSTALLED'],
      draining: false, activeLeaseCount: 0,
    }, {
      id: 'claude', generation: 1,
      availability: host.claudeRuntime().status().installed ? 'available' : 'unavailable',
      reasons: host.claudeRuntime().status().installed ? [] : [host.claudeRuntime().status().reason ?? 'CLAUDE_RUNTIME_NOT_INSTALLED'],
      draining: false, activeLeaseCount: 0,
    }],
  }
}

/**
 * The generic Harness SessionController catalog intentionally carries only
 * portable model fields. Preserve FreeCodeGo credential readiness here so
 * our private picker can render known-but-unconfigured routes as disabled.
 */
export async function modelAvailability(host: EngineRemotesHost): Promise<readonly FreeCodeGoModelAvailability[]> {
  const states = new Map<string, FreeCodeGoModelAvailability>()
  const collect = (provider: string, models: readonly LlmModelInfo[]): void => {
    for (const model of models) {
      const source = model as LlmModelInfo & { readonly availability?: unknown; readonly unavailableReason?: unknown }
      const available = source.availability !== 'unavailable'
      states.set(`${provider}\u0000${model.id}`, {
        provider,
        model: model.id,
        available,
        ...(available || typeof source.unavailableReason !== 'string' ? {} : { reason: source.unavailableReason }),
      })
    }
  }
  const safe = async (provider: string, operation: Promise<readonly LlmModelInfo[]>): Promise<void> => {
    try { collect(provider, await withTimeout(operation, MODEL_CATALOG_TIMEOUT_MS, `${provider} model directory`)) } catch { /* isolate slow providers */ }
  }
  await Promise.all([
    safe('freecodego', host.catalogs.listFreeCodeGoModels('freecodego')),
    safe('vyce', host.catalogs.listVyceModels('vyce')),
    safe('logfare', host.catalogs.listLogfareTextModels('logfare')),
    safe('sensenova', host.catalogs.listSenseNovaModels('sensenova')),
    safe('nvidia', host.catalogs.listNvidiaModels('nvidia')),
    ...(host.agnes === undefined ? [] : [safe('agnes', new AgnesAdapter(host.agnes, () => host.ctx.get('attachments')).listModels('agnes'))]),
    // Cline's free directory is budgeted per model, so the picker needs the
    // per-route answer: a spent model is disabled while its siblings stay
    // selectable instead of the whole provider looking down.
    ...(host.cline === undefined ? [] : [safe('cline', new ClineAdapter(host.cline).listModels('cline'))]),
  ])
  return [...states.values()]
}

/** Session-local execution fact for the UI. This is log-derived rather than
 * inferred from the currently selected toolbar default. */
export async function sessionEngineStatus(host: EngineRemotesHost, sessionId: string): Promise<{ readonly engine: string; readonly executor: 'native' | 'adapter-loop'; readonly provider: string; readonly model: string }> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('session engine status session id is invalid')
  const session = (host.ctx.get('sessions') as { get(id: string): ({ snapshotEvents?: () => readonly { readonly type: string; readonly data: Record<string, unknown> }[]; events?: readonly { readonly type: string; readonly data: Record<string, unknown> }[] } | undefined)   } | undefined)?.get(sessionId)
  let events: readonly { readonly type: string; readonly data: unknown }[] | undefined = session === undefined ? undefined : session.snapshotEvents?.() ?? session.events
  if (events === undefined) {
    const persistence = host.ctx.get('sessionPersistence') as SessionEventsPersistence | undefined
    if (persistence === undefined) throw new Error(`session "${sessionId}" is not available`)
    events = (await readPersistedEvents(persistence, SessionId(sessionId))).events
  }
  const selection = events?.findLast(event => event.type === 'agent-engine/selected')?.data as Record<string, unknown> | undefined
  const executor = events?.findLast(event => event.type === 'freecodego/engine-executor')?.data as Record<string, unknown> | undefined
  const nativeBinding = events?.findLast(event => event.type === 'freecodego/native-session')?.data as Record<string, unknown> | undefined
  const engine = typeof selection?.engineId === 'string'
    ? selection.engineId
    : typeof executor?.engine === 'string'
      ? executor.engine
      : typeof executor?.engineId === 'string'
        ? executor.engineId
        : typeof nativeBinding?.engine === 'string'
          ? nativeBinding.engine
          : undefined
  if (engine === undefined) throw new Error(`session "${sessionId}" has no FreeCodeGo engine binding`)
  return {
    engine,
    executor: executor?.executor === 'native' || (executor === undefined && nativeBinding !== undefined) ? 'native' : 'adapter-loop',
    provider: typeof executor?.provider === 'string'
      ? executor.provider
      : typeof nativeBinding?.provider === 'string'
        ? nativeBinding.provider
        : 'unknown',
    model: typeof selection?.modelId === 'string'
      ? selection.modelId
      : typeof executor?.modelId === 'string'
        ? executor.modelId
        : typeof nativeBinding?.modelId === 'string'
          ? nativeBinding.modelId
          : '',
  }
}

/** Permanently delete one idle session and withdraw it from workspace navigation. */
export async function sessionDelete(host: EngineRemotesHost, sessionId: string): Promise<{ readonly deleted: true }> {
  if (!host.capabilities.configuration().sessionDeleteEnabled) throw new Error('Session delete is disabled in FreeCodeGo settings')
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('session id is invalid')
  const id = SessionId(sessionId)
  const agent = host.ctx.agents.get(id)
  const liveHeader = host.ctx.sessions.get(id)?.header
  if (agent?.status === 'running') {
    throw new Error('SESSION_DELETE_REQUIRES_IDLE_SESSION: wait for the current response to finish before deleting this conversation')
  }
  if (agent !== undefined) {
    // The single-package bundle registers the process-wide factory under
    // `freeCodeGoAgentEngineRouter`; keep the former alpha name as a
    // compatibility fallback for older preview profiles.
    const router = (host.ctx.get('freeCodeGoAgentEngineRouter') ?? host.ctx.get('freeCodeGoAgentFactoryAlpha')) as {
      disposeAgent?(sessionId: import('@deepseek-ai/dsh-session').SessionId): Promise<boolean>
    } | undefined
    if (await router?.disposeAgent?.(id) !== true || host.ctx.get('agents')?.get(id) !== undefined) {
      throw new Error('SESSION_DELETE_REQUIRES_CLOSED_SESSION: close or switch away from this conversation before deleting it')
    }
  }
  if (host.ctx.sessions.get(id) !== undefined) {
    throw new Error('SESSION_DELETE_REQUIRES_CLOSED_SESSION: close or switch away from this conversation before deleting it')
  }
  // A cached sidebar projection can outlive a manually removed or failed
  // persistence record. With no live owner left, deletion is already
  // complete; still remove every navigation association for that id.
  const persistence = host.ctx as Context & { readonly sessionPersistence: SessionDeletionPersistence }
  await deletePersistedSession(persistence.sessionPersistence, id, liveHeader)
  // A capability probe, not a declared call: no shipped Harness — alpha.1 or
  // alpha.2 — declares `forgetSession` on `WorkspaceRegistry` (that service
  // publishes get/list/create/delete/insertBefore/archiveSession/
  // unarchiveSession and rebuilds its header index from
  // `sessionPersistence.list()`), so this is skipped on every build we pin. It
  // stays because a Host that did expose it is the only way to drop the durable
  // association before the registry next re-lists; the navigation association a
  // user can see is the client list, which the publication below updates.
  await (host.ctx.get('workspaceRegistry') as { forgetSession?(id: import('@deepseek-ai/dsh-session').SessionId): Promise<void> } | undefined)?.forgetSession?.(id)
  // JSONL has no live Session disposal edge once the file is removed, so
  // publish the same client-list event that SessionController would emit.
  ;(host.ctx as unknown as { emit(name: string, sessionId: import('@deepseek-ai/dsh-session').SessionId): void }).emit('api-session/removed', id)
  return { deleted: true }
}

/** Return the current cross-engine MCP and Skill capability inventory. */
export async function capabilitiesSnapshot(host: EngineRemotesHost): Promise<FreeCodeGoCapabilitySnapshot> {
  return host.capabilities.snapshot()
}

/** Persist MCP and Skill switches; disabled capabilities are not mounted for future sessions. */
export async function capabilitiesSetEnabled(host: EngineRemotesHost, input: { readonly mcpEnabled?: boolean; readonly skillEnabled?: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean }): Promise<FreeCodeGoCapabilitySnapshot> {
  if (input === null || typeof input !== 'object') throw new Error('capability switches must be an object')
  return host.capabilities.setEnabled(input)
}

/** Persist a manual model capability category without altering native provider settings. */
export async function modelCategorySet(host: EngineRemotesHost, input: { readonly key: string; readonly category?: FreeCodeGoModelCategory }): Promise<FreeCodeGoCapabilitySnapshot> {
  if (input === null || typeof input !== 'object') throw new Error('model category update must be an object')
  return host.capabilities.setModelCategory(input)
}

/** Resolve native-worker requests through the same Host-owned capability inventory used by DeepSeek. */
export async function claudeBridgeHandle(host: EngineRemotesHost, request: {
  readonly bridge: string
  readonly op: string
  readonly input: unknown
  readonly sessionId: string
  readonly workspaceRoot?: string
  readonly signal: AbortSignal
  /**
   * Set only by the in-process Host transport, which carries a tool result as
   * live objects rather than as a size-capped protocol frame. With it, a media
   * tool's attachment is returned as image bytes so the engine can hand the
   * model a real image; the worker protocols leave it unset and get the
   * reference block instead.
   */
  readonly inlineImages?: boolean
}): Promise<unknown> {
  const agents = host.ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  const agent = agents?.get(request.sessionId)
  if (request.bridge === 'mcp' && request.op === 'execute') {
    const input = request.input as { name?: unknown; arguments?: unknown }
    if (typeof input?.name !== 'string') throw new Error('MCP bridge request requires a tool name')
    return host.capabilities.executeMcpTool(agent, input.name, input.arguments ?? {}, request.signal)
  }
  if (request.bridge === 'tool' && request.op === 'execute') {
    const input = request.input as { name?: unknown; arguments?: unknown }
    if (typeof input?.name !== 'string') throw new Error('Harness tool bridge request requires a tool name')
    return host.capabilities.executeHarnessTool(agent, input.name, input.arguments ?? {}, request.signal, { inlineImages: request.inlineImages === true })
  }
  // Skill enumeration and loading are their own bridge rather than a harness-tool
  // call: the Skill provider is not a model-facing tool on the Host, and the
  // Claude sidecar advertises them as `freecodego_skill_discover` /
  // `freecodego_skill_load`. Removing this branch while those tools stayed
  // declared made every call fail with "unsupported bridge", even though the
  // system prompt still told the model they were available.
  if (request.bridge === 'skill' && request.op === 'list') return host.capabilities.listSkills(agent, request.signal)
  if (request.bridge === 'skill' && request.op === 'load') {
    const input = request.input as { name?: unknown }
    if (typeof input?.name !== 'string') throw new Error('Skill bridge request requires a skill name')
    return host.capabilities.loadSkill(input.name, agent, request.signal)
  }
  // No capability-specific pair table lives here any more. The Claude sidecar
  // used to carry one (`webSearch/search`, `lsp/query`) and it was a second,
  // hand-maintained copy of Harness tool signatures: every entry had drifted
  // from the tool it named, so each advertised call failed validation even
  // after the pair resolved. Both Claude transports now bridge every Harness
  // tool generically through `tool/execute`, which needs no registration here
  // and cannot disagree with the tool it names.
  throw new Error(`unsupported FreeCodeGo capability bridge "${request.bridge}/${request.op}"`)
}

/** Read automatic third-party plugin conflict protection state and repair history. */
export function pluginConflictStatus(host: EngineRemotesHost): FreeCodeGoPluginConflictStatus {
  return host.pluginConflictGuard.snapshot()
}

/** Enable or disable automatic third-party plugin conflict prevention. */
export async function pluginConflictSetEnabled(host: EngineRemotesHost, enabled: boolean): Promise<FreeCodeGoPluginConflictStatus> {
  if (typeof enabled !== 'boolean') throw new Error('plugin conflict protection enabled must be a boolean')
  return host.pluginConflictGuard.setEnabled(enabled)
}

/** Save one third-party stdio or Streamable HTTP MCP server. */
export async function mcpSave(host: EngineRemotesHost, input: Omit<FreeCodeGoMcpServer, 'id'> & { readonly id?: string }): Promise<FreeCodeGoCapabilitySnapshot> {
  return host.capabilities.saveMcpServer(input)
}

/** Remove one third-party MCP server. */
export async function mcpRemove(host: EngineRemotesHost, id: string): Promise<FreeCodeGoCapabilitySnapshot> {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('MCP server id is required')
  return host.capabilities.removeMcpServer(id)
}

/** Save one additional filesystem Skill root. */
/**
 * Read one Skill's body and companion files for the settings library dialog.
 *
 * Scoped to no Agent on purpose: the library's list comes from
 * {@link capabilitiesSnapshot}, which discovers the global layer, so reading a
 * row back with a session scope could resolve a different Skill of the same
 * name than the one the user clicked.
 */
export async function skillDetail(host: EngineRemotesHost, input: FreeCodeGoSkillDetailRequest): Promise<FreeCodeGoSkillDetail> {
  return host.capabilities.readSkill(input.name, input.file)
}

export async function skillRootSave(host: EngineRemotesHost, input: Omit<FreeCodeGoSkillRoot, 'id'> & { readonly id?: string }): Promise<FreeCodeGoCapabilitySnapshot> {
  return host.capabilities.saveSkillRoot(input)
}

/** Remove one additional filesystem Skill root. */
export async function skillRootRemove(host: EngineRemotesHost, id: string): Promise<FreeCodeGoCapabilitySnapshot> {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('Skill root id is required')
  return host.capabilities.removeSkillRoot(id)
}

/**
 * Set or clear the user's answer for one Skill's model invocation.
 *
 * `modelInvocable: undefined` clears the override, restoring the Skill file's
 * own declaration.
 */
export async function skillInvocationSet(host: EngineRemotesHost, input: { readonly name: string; readonly modelInvocable?: boolean }): Promise<FreeCodeGoCapabilitySnapshot> {
  if (input === null || typeof input !== 'object') throw new Error('Skill invocation input is required')
  return host.capabilities.setSkillInvocation(input)
}

export async function codexRuntimeInstall(host: EngineRemotesHost, packageID?: string): Promise<FreeCodeGoCodexRuntimeStatus> {
  setEngineAvailability(host.agentEngines, 'codex', 'updating')
  try {
    const result = await host.codexRuntime().install(packageID)
    setEngineAvailability(host.agentEngines, 'codex', result.installed ? 'available' : 'unavailable')
    return result
  } catch (error) {
    setEngineAvailability(host.agentEngines, 'codex', 'unavailable')
    throw error
  }
}

export async function codexRuntimeRemove(host: EngineRemotesHost): Promise<FreeCodeGoCodexRuntimeStatus> {
  const result = await host.codexRuntime().remove()
  setEngineAvailability(host.agentEngines, 'codex', 'unavailable')
  return result
}

export async function claudeRuntimeInstall(host: EngineRemotesHost, packageID?: string): Promise<FreeCodeGoClaudeRuntimeStatus> {
  // Mirror the codex flow: signal the install, map the result to availability,
  // and restore a honest state when the installation fails.
  setEngineAvailability(host.agentEngines, 'claude', 'updating')
  try {
    const result = await host.claudeRuntime().install(packageID)
    setEngineAvailability(host.agentEngines, 'claude', result.installed ? 'available' : 'unavailable')
    return result
  } catch (error) {
    setEngineAvailability(host.agentEngines, 'claude', 'unavailable')
    throw error
  }
}

export async function claudeRuntimeRemove(host: EngineRemotesHost): Promise<FreeCodeGoClaudeRuntimeStatus> {
  const result = await host.claudeRuntime().remove()
  setEngineAvailability(host.agentEngines, 'claude', 'unavailable')
  return result
}

/** Return a dynamic opener; each session revalidates the installed artifact. */
export function nativeRuntimeOpeners(host: EngineRemotesHost): NativeAgentRuntimeOpeners {
  return {
    codex: async (options) => {
      const runtime = await host.codexRuntime().runtime()
      if (runtime.manifest.protocolAbi !== options.protocolAbi) throw new Error(`Codex runtime protocol ABI ${runtime.manifest.protocolAbi} does not match ${options.protocolAbi}`)
      if (options.artifactDigest !== runtime.manifest.artifactDigest) throw new Error('Codex runtime changed while a session was being created; restart the session')
      const useHostProviderBridge = options.provider !== 'codex' && options.provider !== 'openai-codex'
      const bridge = useHostProviderBridge ? await host.claudeBridge.openAIEndpoint(options.provider, options.modelId) : undefined
      return openCodexRootRuntime({
        executable: runtime.executable,
        ...(runtime.args === undefined ? {} : { args: runtime.args }),
        // Per-session state keeps each Codex session's config.toml isolated.
        stateDirectory: path.join(host.codexRuntime().rootDirectory, 'state', options.harnessSessionId.replace(/[^A-Za-z0-9_-]/g, '-')),
        workerPath: requireRuntimeWorkerPath(),
        capabilitiesForTurn: () => host.capabilities.nativeConfiguration(options.agent),
        ...(bridge === undefined ? {} : { environment: {
          OPENAI_BASE_URL: bridge.baseURL,
          OPENAI_API_KEY: bridge.apiKey,
          FREECODEGO_CODEX_PROVIDER_OVERRIDE: 'openai',
        } }),
      }, {
        ...options,
        systemPrompt: options.systemPrompt ?? codexSystemPrompt(host, options.provider, options.modelId, options.workspace, options.agent),
        prepare: (send: (method: import('@deepseek-ai/dsh-freecodego-native-runtime-protocol').NativeRuntimeMethod, params: unknown) => Promise<void>) =>
          send('host/configure', host.capabilities.nativeConfiguration(options.agent)),
      })
    },
    claude: async (options) => {
      const runtime = await host.claudeRuntime().runtime()
      if (runtime.protocolAbi !== options.protocolAbi) throw new Error(`Claude runtime protocol ABI ${runtime.protocolAbi} does not match ${options.protocolAbi}`)
      // The SDK resolves a short-lived local facade for every prompt so a
      // model/provider change in an existing conversation takes effect on
      // the very next turn without consulting local Claude configuration.
      const environment: Record<string, string> = {
        FREECODEGO_CLAUDE_EXECUTABLE: process.platform === 'win32'
          ? runtime.executablePath.replaceAll('\\', '/')
          : runtime.executablePath,
      }
      return openClaudeRootRuntime({
        stateDirectory: path.join(host.claudeRuntime().rootDirectory, 'state'),
        environment,
        gatewayForRoute: async (route: { readonly provider: string; readonly modelId: string; readonly reasoningEffort?: string }) => await host.catalogs.claudeGatewayForRoute(route),
        capabilitiesForTurn: () => host.capabilities.nativeConfiguration(options.agent),
        systemPromptForRoute: (route: { readonly provider: string; readonly modelId: string; readonly reasoningEffort?: string }) => claudeSystemPrompt(host, route, options.workspace, options.agent),
      }, {
        ...options,
        prepare: (send: (method: import('@deepseek-ai/dsh-freecodego-native-runtime-protocol').NativeRuntimeMethod, params: unknown) => Promise<void>) =>
          send('host/configure', host.capabilities.nativeConfiguration(options.agent)),
      })
    },
  }
}

/** Media-generation tools whose guidance is worth calling out by name. */
const MEDIA_TOOLS = ['freecodego_generate_image', 'freecodego_generate_video', 'freecodego_generate_audio'] as const

/**
 * Media guidance for a native-engine prompt, restricted to callable tools.
 *
 * Both transports need the same paragraph and neither may name a tool its own
 * Agent cannot see. That set is not the whole registry: `deferred-tools.ts`
 * denies every deferred tool to each Agent on `agent/created` — on by default —
 * and `nativeConfiguration(agent)` reads the Agent's view, so a deferred media
 * tool is absent from the inventory the transports advertise. A prompt that
 * named it anyway would be the one instruction shape this plugin treats as a
 * defect everywhere else: tell the model to call a tool, then withhold the
 * schema, without telling it to run `tool_search`.
 *
 * `callable` is the caller's name derivation, because the same tool is addressed
 * differently per transport: Codex receives the bare Harness name over the Host
 * bridge, while the Claude SDK mounts it as
 * `mcp__freecodego-host__freecodego_harness_<name>`.
 */
function mediaGuidance(
  visible: readonly { readonly name: string }[],
  callable: (name: string) => string,
): string {
  const names = MEDIA_TOOLS
    .filter(name => visible.some(candidate => candidate.name === name))
    .map(callable)
  return names.length === 0
    ? 'No media-generation tool is mounted for this session; do not claim to generate images, video, or speech.'
    : `For image, video, or speech generation, use ${names.join(', ')}. These tools enforce the user-selected media defaults; never substitute a text model or invent a media model id.`
}

/**
 * Explain the exact plugin-owned Harness surface to the official Claude SDK.
 *
 * Every tool named here goes through the same name derivation the mounted MCP
 * server uses. The prompt used to hard-code the media tools as
 * `freecodego_generate_image` and friends, which is the *Harness registry* name,
 * not the callable one: this transport advertises Harness tools as
 * `mcp__freecodego-host__freecodego_harness_<name>`, so a model that followed
 * the instruction called a tool that does not exist under that name.
 */
export function claudeSystemPrompt(
  host: EngineRemotesHost,
  route: { readonly provider: string; readonly modelId: string; readonly reasoningEffort?: string },
  workspace: string,
  agent?: Agent,
): string {
  const capabilities = host.capabilities.nativeConfiguration(agent)
  // Mirrors the mounted inventory: an enabled MCP connection is addressed by
  // its own MCP name, not by a second `freecodego_harness_` alias of it.
  const managedMcpTools = capabilities.mcpEnabled
    ? capabilities.mcpTools.map(tool => claudeMcpToolName(tool.name))
    : []
  const mcpNames = new Set(capabilities.mcpEnabled ? capabilities.mcpTools.map(tool => tool.name) : [])
  const mountedHarnessTools = capabilities.harnessTools.filter(tool => !mcpNames.has(tool.name))
  const harnessTools = mountedHarnessTools.map(tool => claudeMcpToolName(claudeHarnessToolName(tool.name)))
  const sections = [
    'You are the Claude Agent SDK runtime embedded in DeepSeek Harness through the FreeCodeGo plugin.',
    `The active Harness workspace is ${workspace}. A model route has been selected by FreeCodeGo for this turn${route.reasoningEffort === undefined ? '' : ` with reasoning effort "${route.reasoningEffort}"`}. Do not reveal internal provider ids, route keys, or transport aliases to the user; describe the model by its public display name when needed.`,
    'Harness is the source of truth for sessions, permissions, tool audit records, child-agent lineage, cancellation, and model selection. Do not claim that these capabilities are unavailable when the corresponding FreeCodeGo MCP tools are listed below.',
    'For independent work, use the Harness subagent tool when available. It creates a real DeepSeek Harness child session and preserves its model policy, lifecycle, permissions, logs, and UI visibility. Do not substitute an unmanaged local Claude child process for Harness delegation.',
    'Use only the plugin-provided FreeCodeGo MCP tools for Harness Skills, configured MCP connections, or child-session operations. Do not read arbitrary project MCP configuration files or rely on a local Claude login.',
    harnessTools.length === 0
      ? 'No additional Harness-control tools are currently mounted for this session.'
      : `Mounted Harness and third-party plugin tools: ${harnessTools.join(', ')}.`,
    capabilities.skillEnabled
      ? `Harness Skills are enabled through ${claudeMcpToolName('freecodego_skill_discover')} and ${claudeMcpToolName('freecodego_skill_load')}.`
      : 'Harness Skills are currently disabled in FreeCodeGo settings.',
    managedMcpTools.length === 0
      ? 'No user-configured Harness MCP tools are enabled.'
      : `Enabled Harness MCP tools: ${managedMcpTools.join(', ')}.`,
    mediaGuidance(mountedHarnessTools, name => claudeMcpToolName(claudeHarnessToolName(name))),
    'When a tool requires approval, wait for the Harness approval result. Report concrete outcomes and keep all user-visible work within the active Harness session.',
  ]
  return sections.join('\n\n')
}

/** Codex App Server receives this as developer instructions for every native thread. */
export function codexSystemPrompt(host: EngineRemotesHost, _provider: string, _model: string, workspace: string, agent?: Agent): string {
  const capabilities = host.capabilities.nativeConfiguration(agent)
  const harnessTools = capabilities.harnessTools.map(tool => tool.name).join(', ')
  const mcp = capabilities.mcpEnabled
    ? capabilities.mcpTools.map(tool => tool.name).join(', ')
    : ''
  return [
    'You are the Codex App Server runtime embedded in DeepSeek Harness through the FreeCodeGo plugin.',
    `The active Harness workspace is ${workspace}. FreeCodeGo selected the model route for this turn. Harness owns model selection, session history, permissions, audit records, cancellation, and the user-visible conversation. Do not reveal internal provider ids, route keys, or transport aliases to the user.`,
    'Use the plugin-managed Codex home only. Do not depend on a user global Codex configuration for FreeCodeGo model routing.',
    capabilities.skillEnabled
      ? 'Harness Skill roots are enabled in this Codex session; discover and use them through the native Codex Skills interface when relevant.'
      : 'Harness Skills are currently disabled in FreeCodeGo settings.',
    mcp === ''
      ? 'No user-configured Harness MCP tools are enabled.'
      : `Enabled Harness MCP tools: ${mcp}. They are routed only through the FreeCodeGo Host MCP bridge.`,
    harnessTools === ''
      ? 'No additional Harness-control tools are mounted for this session.'
      // `list_subagent_models` is a Harness registry tool (upstream's subagent
      // package registers it), so it is only nameable when this Agent's
      // inventory actually carries it. The sentence used to assert it
      // unconditionally, which is a name the model cannot call wherever the
      // subagent package is absent.
      : `Harness and third-party plugin tools available through the FreeCodeGo MCP bridge: ${harnessTools}.${capabilities.harnessTools.some(candidate => candidate.name === 'list_subagent_models') ? ' Use list_subagent_models before assigning specialized child models.' : ''} Use Advisor tools when an independent review would improve the result.`,
    // Derived, not restated: this line used to name all three tools
    // unconditionally, so a Codex session was told to call tools its own Agent
    // could not see. The Claude prompt above had already been fixed for exactly
    // this; the wording survived here because nothing tested this function.
    mediaGuidance(capabilities.harnessTools, name => name),
    'When native Codex collaboration or subagent features are available for the installed runtime, preserve Harness workspace and permission constraints. Do not claim an unavailable feature exists.',
  ].join('\n\n')
}

/** Rebuild Host-only clients whenever the persisted endpoint changes. */
export function configureGateway(host: EngineRemotesHost): void {
  host.setAccount(undefined)
  host.setApi(undefined)
  const credentials = host.ctx.get('credentials')
  host.setCredentials(credentials)
  host.setAgnes(credentials === undefined ? undefined : new AgnesClient(credentials))
  // Cline is a Host-only pool too: its adapter rotates several accounts, so it
  // must be rebuilt alongside the vault rather than captured once at startup.
  host.setCline(credentials === undefined ? undefined : new ClineClient(credentials))
  // WorkBuddy International is the same shape of Host-only pool, and its
  // rotated tokens are written back through the catalog host that already owns
  // the vault document.
  const workbuddy = credentials === undefined ? undefined : new WorkBuddyIntlClient(credentials, account => host.catalogs.workbuddyPersistTokens(account))
  host.setWorkbuddy(workbuddy)
  // Its credit snapshots ride the same rebuild: the vault that holds the
  // accounts is the one these calls authenticate against.
  host.setWorkbuddyPool(workbuddy === undefined ? undefined : new WorkBuddyPoolService({
    client: () => workbuddy,
    accounts: () => host.catalogs.workbuddyAccounts(),
    persist: (accountId, update) => host.catalogs.workbuddyApplyAccountState(accountId, update),
  }))
  if (credentials !== undefined) {
    const gateway = host.config.gateway ?? {}
    const auth = new FreeCodeGoMobileAuthClient({
      baseUrl: gateway.baseUrl ?? FREECODEGO_CLOUD_ORIGIN,
    })
    // The API clients normalize the configured URL to its origin. Reuse the
    // same normalized value for managed OpenAI-compatible connections.
    host.setGatewayBaseUrl(auth.origin)
    const vault = new HarnessFreeCodeGoCredentialVault(credentials, auth.origin)
    host.setAccount(new FreeCodeGoAccountCoordinator(auth, vault))
    host.setApi(new FreeCodeGoApiClient({
      baseUrl: gateway.baseUrl ?? FREECODEGO_CLOUD_ORIGIN,
    }))
    // Restore a durable session in the background so the first model
    // catalog request can use cached credentials without opening Settings.
    void host.restoreAccount().then(() => { host.ctx.emit('llm/adapters-updated') }, () => undefined)
  }
}

/**
 * Match FreeCodeGo's own desktop client: gateway calls authenticate with the
 * Host-vault access token and select the model group through a route header.
 * Warp runtime keys are intentionally not used here because their default
 * route can differ from the selected model group.
 */
export async function managedRuntime(host: EngineRemotesHost, model?: string): Promise<FreeCodeGoManagedRuntime & { readonly routeKey?: string; readonly protocol?: string }> {
  if (host.api === undefined || host.account === undefined) throw new Error('FreeCodeGo managed runtime is not configured')
  await host.restoreAccount()
  return host.account.withAccessToken(async (accessToken) => {
    const route = model === undefined ? undefined : await routeForModelDetail(host, model, accessToken)
    return {
      openAIBaseUrl: `${host.gatewayBaseUrl}/v1`,
      openAIToken: accessToken,
      routeKeys: [],
      ...(route === undefined ? {} : { routeKey: route.routeKey }),
      ...(route?.protocol === undefined ? {} : { protocol: route.protocol }),
    }
  })
}

/** Fetch a redacted remote catalog using the Host vault; tokens never cross this Remote boundary. */
export async function managedCatalog(host: EngineRemotesHost): Promise<FreeCodeGoManagedCatalog> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  return host.account.withAccessToken(async (accessToken) => {
    const catalog = await host.api!.getCatalog({ accessToken })
    const options = await host.api!.getModelOptions({ accessToken }).catch(() => [])
    const resolved = await host.catalogs.withDynamicMediaCatalog({ ...catalog, models: mergeCatalogModels(enrichCatalogChoices(catalog.models, options)) })
    await host.catalogs.writeManagedCatalogCache(resolved)
    return resolved
  })
}

/** Resolve direct upstream routes that stay outside the FreeCodeGo gateway. */
export async function directConnection(host: EngineRemotesHost, model: string | undefined, allowExternalProviders = true): Promise<{ connection: Omit<import('./openai-compatible-adapter.ts').OpenAiCompatibleConnection, 'apiKey'>; runtime: FreeCodeGoManagedRuntime } | undefined> {
  if (model === undefined) return undefined
  const normalized = model.trim().toLowerCase()
  if (allowExternalProviders && normalized.startsWith(LOGFARE_MODEL_PREFIX)) {
    const apiKey = await host.catalogs.logfareApiKey()
    if (apiKey === undefined) throw new Error('FreeCodeGo model access key is not configured')
    const wireModel = normalized === LOGFARE_AUTO_MODEL.id ? LOGFARE_AUTO_MODEL.id : model.trim().slice(LOGFARE_MODEL_PREFIX.length)
    if (wireModel.trim() === '') throw new Error('FreeCodeGo model id is not configured')
    return {
      connection: {
        baseURL: LOGFARE_AUTO_MODEL.baseURL,
        model: wireModel,
        headers: { 'user-agent': 'freecodego/logfare' },
      },
      runtime: { openAIToken: apiKey, routeKeys: [] },
    }
  }
  if (allowExternalProviders && normalized.startsWith(KILO_MODEL_PREFIX)) {
    const wireModel = normalized === `${KILO_MODEL_PREFIX}auto`
      ? 'kilo-auto/free'
      : model.trim().slice(KILO_MODEL_PREFIX.length)
    if (wireModel.trim() === '') throw new Error('FreeCodeGo model id is not configured')
    const kiloModels = await host.catalogs.kiloFreeModels()
    const kiloModel = kiloModels.find(candidate => candidate.id.toLowerCase() === wireModel.toLowerCase() || candidate.upstreamId.toLowerCase() === wireModel.toLowerCase())
    if (kiloModel === undefined) throw new Error(`Kilo model "${wireModel}" is not available in the public directory`)
    return {
      connection: {
        baseURL: KILO_GATEWAY_BASE_URL,
        model: kiloModel.upstreamId,
        headers: { 'user-agent': 'freecodego/kilo' },
      },
      runtime: { openAIToken: KILO_ANONYMOUS_API_KEY, routeKeys: [] },
    }
  }
  if (!allowExternalProviders) return undefined
  // The virtual `auto` route (and legacy persisted `hy3` profiles) follow the
  // live public directory at request time: the upstream free roster rotates,
  // so honoring a pinned id verbatim would silently break the route.
  const openCodeRequested = normalized === OPENCODE_AUTO_MODEL.id || normalized === `opencode/${OPENCODE_AUTO_MODEL.id}` || normalized === 'hy3' || normalized === 'opencode/hy3'
  const openCodeModels = await host.catalogs.openCodeFreeModels()
  const openCodeModel = openCodeRequested
    ? openCodeAutoPreference(openCodeModels)
    : openCodeModels.find(candidate => normalized === candidate.id || normalized === `opencode/${candidate.id}`)
  if (openCodeModel !== undefined) {
    return {
      connection: {
        baseURL: OPENCODE_DIRECT_BASE_URL,
        model: openCodeModel.upstreamId,
        headers: {
          'x-opencode-client': 'desktop',
          'user-agent': 'opencode/freecodego',
        },
      },
      runtime: { openAIToken: 'public', routeKeys: [] },
    }
  }
  return undefined
}

/** Route key only: the Remote contract used by the model picker and media routes. */
export async function routeForModel(host: EngineRemotesHost, model: string, accessToken: string): Promise<string> {
  return (await routeForModelDetail(host, model, accessToken)).routeKey
}

/**
 * Route key plus the chosen group's protocol, so the caller can pick a wire
 * (`openai` chat-completions vs `anthropic` Messages) for the request.
 */
export async function routeForModelDetail(
  host: EngineRemotesHost,
  model: string,
  accessToken: string,
): Promise<{ readonly routeKey: string; readonly protocol: string | undefined }> {
  const snapshot = await loadModelOptionsSnapshot(host, accessToken)
  const normalized = gatewayModelId(model)
  // The picker may hand us an explicit group pin (`id@group:N`): the user chose
  // that row because of ITS group, so the pin outranks everything else and an
  // unsatisfiable pin fails instead of quietly serving another group.
  const requested = parseGroupPin(model)
  const pinnedGroupId = requested.groupId
  const selectionModel = requested.modelId
  const selected = snapshot.models.find(item => item.model === selectionModel || item.model.toLowerCase() === selectionModel.toLowerCase() || item.model === normalized || item.model.toLowerCase() === normalized.toLowerCase())
  if (selected === undefined) throw Object.assign(new Error(`FreeCodeGo has no model options for ${selectionModel}`), { code: 'MODEL_ROUTE_UNAVAILABLE' })
  // Unpinned selections follow the backend: its declared account-default group
  // (`groups[].default`), then its own choice order. Nothing here ranks groups
  // by price — a local cheapest-group rule made the picker's group rows
  // meaningless, because the row the user read was not the route that served.
  const defaultGroupId = snapshot.groups.find(group => group.default === true)?.id
  // A pin returns from `selectModelOptionChoice` before the default group is
  // consulted (or fails), so passing both is a statement of precedence rather
  // than a branch here: pin, then backend default, then backend order. The
  // protocol list is the transport's own wire mapping, not a list kept here: a
  // protocol the router accepted without a wire was routed to whichever body
  // the caller happened to serialize.
  const choice = selectModelOptionChoice(selected.options, SUPPORTED_WIRE_PROTOCOLS, undefined, pinnedGroupId, defaultGroupId)
  if (choice === undefined) throw Object.assign(new Error(`FreeCodeGo has no enabled route for model ${selectionModel}`), { code: 'MODEL_ROUTE_UNAVAILABLE' })
  return { routeKey: choice.routeKey, protocol: choice.protocol }
}

/**
 * Read the model-options projection, groups included.
 *
 * The default group lives in `groups[]`, which a caller that only asked for
 * `models` never sees — and without it, "which group serves when the user chose
 * none" has to be guessed locally. Older Host builds expose only
 * `getModelOptions`; those fall back to an empty group list, so routing uses
 * the backend's own choice order instead of failing.
 */
async function loadModelOptionsSnapshot(
  host: EngineRemotesHost,
  accessToken: string,
): Promise<{ readonly groups: readonly { readonly id: number; readonly default?: boolean }[]; readonly models: Awaited<ReturnType<FreeCodeGoApiClient['getModelOptions']>> }> {
  const api = host.api!
  if (typeof api.getModelOptionsSnapshot === 'function') return api.getModelOptionsSnapshot({ accessToken })
  return { groups: [], models: await api.getModelOptions({ accessToken }) }
}

/** Minimum shape {@link selectModelOptionChoice} needs from a model-option choice. */
export interface FreeCodeGoModelChoice {
  readonly enabled: boolean
  readonly routeKey: string
  readonly protocol?: string
  readonly zeroPrice?: boolean
  readonly rateMultiplier?: number
  readonly unlockRequired?: boolean
  /** Backend gate string; `locked` alone is enough to make a choice unusable. */
  readonly access?: string
  /** Derived lock flag when the caller already normalized the row. */
  readonly locked?: boolean
  readonly unlockReason?: string
  readonly unlockExpiresAt?: string
  readonly groupId?: number
}

/** Either lock spelling makes a choice unusable. */
function isLockedChoice(choice: FreeCodeGoModelChoice): boolean {
  return choice.locked === true || isLockedRoute(choice)
}

/**
 * Pick one enabled group choice for a model.
 *
 * The Host does not rank groups by price. A local "cheapest usable group" rule
 * looked helpful and was not: the group is what the account is billed through,
 * the same model is deliberately sold through several groups at several rates,
 * and a rule that silently picks one makes the picker's group rows a lie — the
 * user selects the free row and the request goes out on whichever sibling the
 * local comparator happened to favour. Which group serves is therefore decided
 * by, in order: the user's explicit group pin, the backend's declared default
 * group, then the backend's own order. Protocol is the one thing that stays
 * filtered here, because it is not a preference — a wire this adapter cannot
 * speak (`anthropic` vs `openai_responses` vs no wire at all) cannot be sent,
 * and the caller passes the protocols its transport actually supports.
 *
 * A locked or disabled group is never returned: the backend refuses those
 * groups, so choosing one would only turn a clear UI state into a request
 * failure. `undefined` therefore means "no usable group".
 *
 * `preferredRouteKey` is an explicit caller override for a route the caller has
 * already resolved; a stale route key falls back to the rules below.
 *
 * `preferredGroupId` is the picker's group pin: when the user selected a
 * specific (model, group) row, that exact group is used while it stays enabled
 * and unlocked. An unsatisfiable pin (group removed, disabled, or locked)
 * returns `undefined` rather than falling back — silently serving another group
 * would bill the request at a rate the user never chose. The picker re-lists
 * the groups the account can actually use.
 *
 * `defaultGroupId` is the backend's account-default group (`groups[].default`).
 * It applies only when the user pinned nothing; when the model is not offered
 * through that group the first usable choice in backend order wins, so routing
 * stays a function of the backend's payload rather than of local heuristics.
 */
export function selectModelOptionChoice<T extends FreeCodeGoModelChoice>(
  choices: readonly T[],
  preferredProtocols?: readonly string[],
  preferredRouteKey?: string,
  preferredGroupId?: number,
  defaultGroupId?: number,
): T | undefined {
  const enabled = choices.filter(choice => choice.enabled)
  if (enabled.length === 0) return undefined
  const usable = enabled.filter(choice => !isLockedChoice(choice))
  if (usable.length === 0) return undefined
  // An explicit route-key override wins while it is still enabled and unlocked;
  // a stale one (group removed, disabled, or locked) falls back to the rules
  // below instead of failing against a group the account cannot use.
  if (preferredRouteKey !== undefined && preferredRouteKey !== '') {
    const pinned = usable.find(choice => choice.routeKey === preferredRouteKey)
    if (pinned !== undefined) return pinned
  }
  if (preferredGroupId !== undefined && Number.isFinite(preferredGroupId)) {
    const pinned = usable.filter(choice => choice.groupId === preferredGroupId)
    if (pinned.length === 0) return undefined
    return speakableChoices(pinned, preferredProtocols)[0]
  }
  const pool = speakableChoices(usable, preferredProtocols)
  if (defaultGroupId !== undefined && Number.isFinite(defaultGroupId)) {
    const declared = pool.find(choice => choice.groupId === defaultGroupId)
    if (declared !== undefined) return declared
  }
  // Backend order, not price order: the pool keeps the order the payload
  // carried. Nothing here compares rates.
  return pool[0]
}

/** Choices whose wire the caller can send.
 *
 * A filter, not a ranking: every returned choice is equally sendable. When the
 * caller supplied protocols and none match, no choice is usable. A missing
 * protocol remains eligible because legacy options use the OpenAI default.
 * Returning an explicitly unwired route would make the transport serialize the
 * wrong request body. */
function speakableChoices<T extends FreeCodeGoModelChoice>(pool: readonly T[], preferredProtocols?: readonly string[]): readonly T[] {
  const preferred = new Set((preferredProtocols ?? []).map(normalizeWireProtocol).filter(value => value !== ''))
  if (preferred.size === 0) return pool
  return pool.filter((choice) => {
    const protocol = normalizeWireProtocol(choice.protocol)
    return protocol === '' || preferred.has(protocol)
  })
}

/** Resolve a saved model against user-owned llm-pi-ai routes before falling back to FreeCodeGo. */
export function configuredProviderRoute(ctx: Context, model: string): { readonly provider: string; readonly model: string } | undefined {
  const llm = ctx.get('llm') as { listProviders?: () => readonly { readonly id: string }[] } | undefined
  for (const entry of llm?.listProviders?.() ?? []) {
    const provider = entry.id.trim()
    // The plugin's own `freecodego` adapter is not a user-owned route; it is
    // the marker this plugin itself registers in the llm catalog.
    if (provider.toLowerCase() === 'freecodego') continue
    if (provider !== '' && model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) return { provider, model: model.slice(provider.length + 1) }
  }
  const settings = ctx.get('settings') as { get?: (namespace: 'llm-pi-ai') => unknown } | undefined
  if (typeof settings?.get !== 'function') return undefined
  const providers = record(record(settings.get('llm-pi-ai')).providers)
  for (const [provider, profile] of Object.entries(providers)) {
    const row = record(profile)
    const models = Array.isArray(row.models) ? row.models : []
    const direct = models.some(entry => record(entry).id === model || String(record(entry).id ?? '').toLowerCase() === model.toLowerCase())
    if (direct) return { provider, model }
    const prefix = `${provider}/`
    if (model.toLowerCase().startsWith(prefix.toLowerCase())) return { provider, model: model.slice(prefix.length) }
  }
  return undefined
}
