/** @module @deepseek-ai/dsh-freecodego-agent-engine-router */

import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AgentFactory, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ensureAgentEngineBinding, routeProvider } from '@deepseek-ai/dsh-freecodego-root-agent'
import type { AgentEngineId, AgentEnginePlan, AgentEngineDefinition, NativeAgentRuntimeOpeners, FreeCodeGoAgentOptions } from '@deepseek-ai/dsh-freecodego-root-agent'
import { FreeCodeGoNativeAgentFactory } from '@deepseek-ai/dsh-freecodego-root-agent'
import type { AgentEngineLease } from './engine-registry.ts'
import { FreeCodeGoAgentEngineRegistry } from './engine-registry.ts'
import { effectiveProviderOf, inheritSameEngineRoute, inheritedEngineOf } from './engine-affinity.ts'
export { enforceSameEngine } from './engine-affinity.ts'
import type { CodexRootRuntimeOptions } from '@deepseek-ai/dsh-freecodego-runtime-codex'
import { openCodexRootRuntime } from '@deepseek-ai/dsh-freecodego-runtime-codex'
import type { ClaudeRuntimeLaunchOptions } from '@deepseek-ai/dsh-freecodego-runtime-claude'
import { openClaudeRootRuntime } from '@deepseek-ai/dsh-freecodego-runtime-claude'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-loop'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Separates the selected Agent engine from its protocol-specific executor. */
    'freecodego/engine-executor': {
      readonly engineId?: 'deepseek' | 'codex' | 'claude'
      readonly engine?: 'codex' | 'claude'
      readonly executor: 'native' | 'adapter-loop'
      readonly provider: string
      readonly modelId?: string
      readonly artifactDigest?: string
      readonly protocolAbi?: string
    }
  }
}

/** Platform paths needed to launch the sealed Codex worker. */
export interface CodexRuntimeConfig extends CodexRootRuntimeOptions {}

/** Router settings. Missing native launch configuration is an explicit unavailable state. */
export interface Config {
  /** Where to find the sealed Codex worker, and what to pass it at launch. */
  readonly codex?: CodexRuntimeConfig
  /** Where to find the sealed Claude worker, and what to pass it at launch. */
  readonly claude?: ClaudeRuntimeLaunchOptions
  /** Per-engine system prompt handed to native sessions at open time. */
  readonly systemPrompts?: Partial<Record<'codex' | 'claude', string>>
}

type FreeCodeGoHarnessInventory = {
  nativeRuntimeOpeners?: () => NativeAgentRuntimeOpeners
  nativeRuntimeStatus?: () => { installed: boolean; artifactDigest?: string; runtimeVersion?: string }
  claudeRuntimeStatus?: () => { installed: boolean; artifactDigest?: string; runtimeVersion?: string }
  defaultAgentOptions?: () => { readonly engine: AgentEngineId; readonly provider: string; readonly model?: string }
  resolveModelRoute?: (model: string) => { readonly provider: string; readonly model: string } | undefined
}

export type RoutedAgentOptions = AgentOptions & FreeCodeGoAgentOptions & { readonly engine?: string; readonly provider?: string; readonly model?: string }

/**
 * Whether the route on the caller's options is an ordinary default that the
 * FreeCodeGo engine selection may replace, rather than a route the caller chose.
 *
 * Each disjunct is one way a caller states "I have no route of my own":
 *
 * - `remapped` is set only when a `freecodego` model id resolved through the
 *   managed catalog, which is how the Web API hands over its own default.
 * - An absent provider means the caller supplied a model and nothing else.
 * - `deepseek-official` is AgentDefaultModel's ordinary route.
 * - `freecodego` with no model, or with the current default model, is that same
 *   ordinary route under the gateway provider.
 *
 * A `freecodego` model id the catalog does *not* resolve stays the caller's
 * explicit route: `remapped` is undefined and the id is not the default model,
 * so an id that no route answers is never silently rewritten into the default
 * engine's route.
 */
function isOrdinaryDefaultRoute(
  raw: RoutedAgentOptions,
  remapped: { readonly provider: string; readonly model: string } | undefined,
  defaults: { readonly engine: AgentEngineId; readonly provider: string; readonly model?: string },
): boolean {
  if (remapped !== undefined) return true
  if (raw.provider === undefined) return true
  if (raw.provider === 'deepseek-official') return true
  return raw.provider === 'freecodego' && (raw.model === undefined || raw.model === defaults.model)
}

function routedOptions(
  options: AgentOptions | undefined,
  inventory: FreeCodeGoHarnessInventory | undefined,
  inheritedEngine?: AgentEngineId,
): RoutedAgentOptions {
  const initial = (options ?? {}) as RoutedAgentOptions
  const remapped = initial.provider === 'freecodego' && initial.model !== undefined
    ? inventory?.resolveModelRoute?.(initial.model)
    : undefined
  const raw = remapped === undefined ? initial : { ...initial, provider: remapped.provider, model: remapped.model }
  const nativeEngine = raw.freeCodeGoNative?.engine
  // A child Session is never allowed to cross the parent's execution engine.
  // Provider/model overrides remain useful within that engine, but an explicit
  // child marker must not turn a DeepSeek Team into a Claude or Codex Team.
  const requestedEngine = inheritedEngine ?? raw.engine ?? raw.freeCodeGoEngine ?? nativeEngine
  if (requestedEngine !== undefined) return { ...raw, engine: requestedEngine }
  const defaults = inventory?.defaultAgentOptions?.()
  if (defaults === undefined) return raw
  const hasExplicitRoute = raw.provider !== undefined || raw.model !== undefined
  // The Web API supplies AgentDefaultModel's ordinary DeepSeek route on every
  // new Session. Treat that route as a default marker when the FreeCodeGo
  // engine selector points at Codex/Claude; explicit native child routes keep
  // their own engine and are not rewritten here.
  const ordinaryDefaultRoute = isOrdinaryDefaultRoute(raw, remapped, defaults)
  const matchesDefaultRoute = (!hasExplicitRoute) || ordinaryDefaultRoute
  if (!matchesDefaultRoute) return raw
  // Entry points historically supplied only the default provider/model. When
  // FreeCodeGo owns a selected root engine, fill the private engine marker at
  // this boundary so switching the default affects new sessions consistently.
  return {
    ...raw,
    engine: defaults.engine,
    ...(defaults.engine !== 'deepseek' && ordinaryDefaultRoute
      ? { provider: defaults.provider }
      : raw.provider === undefined ? { provider: defaults.provider } : {}),
    ...(defaults.engine !== 'deepseek' && ordinaryDefaultRoute && defaults.model !== undefined
      ? { model: defaults.model }
      : raw.model === undefined && defaults.model === undefined ? {} : raw.model === undefined ? { model: defaults.model } : {}),
  }
}

/** The one process-wide AgentFactory that leases a root engine before delegation. */
export class FreeCodeGoAgentEngineRouter extends Service implements AgentFactory {
  // NativeFactory prepares/attaches Host sessions and may resume persisted
  // bindings. These services must be part of the router fiber; otherwise a
  // workspace-driven session.create reaches the native path with a transient
  // context and Cordis rejects `ctx.sessions` as "without inject".
  static inject = ['agents', 'agentLoop', 'sessions', 'sessionPersistence', 'freeCodeGoHarness']
  static Config = z.object({
    codex: z.object({
      executable: z.string(),
      args: z.array(z.string()),
      environment: z.object({}).default({}),
      stateDirectory: z.string(),
      workerPath: z.string(),
    }),
    // No `workerPath` here, and its absence is deliberate: the Claude runtime
    // drives the Agent SDK in the Host process (`DirectClaudeSdkSession`), so a
    // sidecar path is a field with no consumer. It used to be declared *required*
    // in this schema while nothing read it — and because `config.claude` is
    // forwarded whole to `openClaudeRootRuntime`, the excess-property check never
    // fires, so TypeScript could not report it either. `scripts/
    // freecodego-config-readers.spec.ts` is the gate that now catches this shape.
    claude: z.object({
      stateDirectory: z.string(),
      environment: z.object({}).default({}),
    }),
    systemPrompts: z.object({
      codex: z.string(),
      claude: z.string(),
    }),
  })
  private readonly nativeFactory: FreeCodeGoNativeAgentFactory
  private readonly liveHandles = new Map<SessionId, AgentHandle>()
  private readonly leaseReleases = new Map<SessionId, () => void>()
  private readonly agentEngines: FreeCodeGoAgentEngineRegistry

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'freeCodeGoAgentEngineRouter')
    this.agentEngines = new FreeCodeGoAgentEngineRegistry(ctx)
    ctx.effect(() => ctx.provide('agentEngines', this.agentEngines), 'freeCodeGoAgentEngineRouter.agentEngines')
    const inventory = ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined
    // Schemas may materialize optional object rows as `{}`. Treat only a
    // complete explicit launcher as an override; otherwise preserve the
    // verified artifacts supplied by the FreeCodeGo inventory.
    const configuredCodex = config.codex?.executable !== undefined
      && config.codex.workerPath !== undefined
      && config.codex.stateDirectory !== undefined
    // `stateDirectory` is the only structurally required field the in-process
    // Claude launcher has, so it is the whole completeness signal; a
    // schema-materialized `{}` still fails it.
    const configuredClaude = config.claude?.stateDirectory !== undefined
    // The inventory service can activate after this router during profile
    // boot. Keep these wrappers dynamic so a late activation still supplies
    // the verified native runtime opener for new sessions.
    const installedOpeners: NativeAgentRuntimeOpeners = {
      ...(!configuredCodex ? {
        codex: async (options) => {
          const current = this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined
          const opener = current?.nativeRuntimeOpeners?.().codex
          if (opener === undefined) throw new Error('CODEX_RUNTIME_NOT_INSTALLED: install the Codex runtime before selecting this engine')
          return opener(options)
        },
      } : {}),
      ...(!configuredClaude ? {
        claude: async (options) => {
          const current = this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined
          const opener = current?.nativeRuntimeOpeners?.().claude
          if (opener === undefined) throw new Error('CLAUDE_RUNTIME_NOT_INSTALLED: install the Claude runtime before selecting this engine')
          return opener(options)
        },
      } : {}),
    }
    this.nativeFactory = new FreeCodeGoNativeAgentFactory(ctx, {
      defaultWorkspace: process.cwd(),
      ...(config.systemPrompts === undefined ? {} : { engineSystemPrompts: config.systemPrompts }),
      openers: {
        ...installedOpeners,
        // The configured openers forward the open options object itself rather
        // than re-listing its fields. A field-by-field table is a second
        // signature for the same call, and a field added to the protocol (as
        // `sandboxMode` was) would be silently dropped by whichever copies were
        // missed — the install-verified openers above already forward it whole.
        ...(!configuredCodex ? {} : {
          codex: options => openCodexRootRuntime(config.codex!, options),
        }),
        ...(!configuredClaude ? {} : {
          claude: options => openClaudeRootRuntime(config.claude!, options),
        }),
      },
    })
    this.registerEngineDefinitions(inventory, installedOpeners)
    // Runtime installation can settle just after this router registers its
    // definitions. Reconcile the registry so a stale startup `unavailable`
    // state cannot block new sessions when the verified artifact is present.
    const refresh = (): void => {
      const runtime = this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined
      const runtimeAvailable = hasInstalledClaudeRuntime()
      if (runtime?.nativeRuntimeStatus !== undefined) {
        try { this.agentEngines.setAvailability('codex', runtime.nativeRuntimeStatus().installed ? 'available' : 'unavailable') } catch { /* service boot/HMR */ }
      }
      if (runtime?.claudeRuntimeStatus !== undefined || runtimeAvailable) {
        const claudeReady = runtime?.claudeRuntimeStatus?.().installed === true || runtimeAvailable
        try { this.agentEngines.setAvailability('claude', claudeReady ? 'available' : 'unavailable') } catch { /* service boot/HMR */ }
      }
    }
    const timer = setInterval(refresh, 500)
    ctx.effect(() => () => { clearInterval(timer) }, 'freeCodeGoAgentEngineRouter.runtimeAvailability')
    ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
      this.liveHandles.delete(agent.id)
      this.leaseReleases.get(agent.id)?.()
      this.leaseReleases.delete(agent.id)
    }), 'freeCodeGoAgentEngineRouter.releaseDisposedLease')
    refresh()
    // The official AgentRegistry owns a single factory slot. Replace the official
    // AgentLoop target in place so ordinary DeepSeek sessions still delegate
    // to the upstream loop while native routes are handled here.
    const registry = ctx.agents as unknown as { factory?: { target: AgentFactory } }
    const slot = registry.factory
    if (slot === undefined) throw new Error('FreeCodeGo AgentEngineRouter requires the official AgentLoop factory')
    ctx.effect(() => {
      const original = slot.target
      slot.target = this
      return () => { if (slot.target === this) slot.target = original }
    }, 'freeCodeGoAgentEngineRouter.delegateFactory')
  }

  private registerEngineDefinitions(inventory: FreeCodeGoHarnessInventory | undefined, openers: NativeAgentRuntimeOpeners): void {
    const currentInventory = (): FreeCodeGoHarnessInventory | undefined =>
      this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined ?? inventory
    const runtime = currentInventory()
    const definitions: AgentEngineDefinition[] = [
      {
        id: 'deepseek', availability: 'available',
        createPlan: async input => ({ artifactDigest: 'builtin:deepseek', protocolAbi: 'dsh-agent-loop', ...input }),
      },
      {
        id: 'codex', availability: runtime?.nativeRuntimeStatus?.().installed === true ? 'available' : 'unavailable',
        reasons: runtime?.nativeRuntimeStatus?.().installed === true ? [] : ['CODEX_RUNTIME_NOT_INSTALLED'],
        createPlan: async (input) => {
          if (openers.codex === undefined) throw new Error('CODEX_RUNTIME_NOT_INSTALLED: install the Codex runtime before selecting this engine')
          const status = currentInventory()?.nativeRuntimeStatus?.()
          if (status?.installed !== true || status.artifactDigest === undefined) throw new Error('CODEX_RUNTIME_NOT_INSTALLED: install the Codex runtime before selecting this engine')
          return { artifactDigest: status.artifactDigest, protocolAbi: 'freecodego-agent/1', ...input }
        },
      },
      {
        id: 'claude', availability: runtime?.claudeRuntimeStatus?.().installed === true || hasInstalledClaudeRuntime() ? 'available' : 'unavailable',
        reasons: runtime?.claudeRuntimeStatus?.().installed === true || hasInstalledClaudeRuntime() ? [] : ['CLAUDE_RUNTIME_NOT_INSTALLED'],
        createPlan: async (input) => {
          if (openers.claude === undefined) throw new Error('CLAUDE_RUNTIME_NOT_INSTALLED: install the Claude runtime before selecting this engine')
          const status = currentInventory()?.claudeRuntimeStatus?.()
          if (status?.installed !== true || status.artifactDigest === undefined) throw new Error('CLAUDE_RUNTIME_NOT_INSTALLED: install the Claude runtime before selecting this engine')
          return { artifactDigest: status.artifactDigest, protocolAbi: 'freecodego-agent/1', ...input }
        },
      },
    ]
    const existing = new Set(this.agentEngines.liveIds())
    for (const definition of definitions) {
      if (!existing.has(definition.id)) {
        this.agentEngines.register(definition)
        continue
      }
      // The FreeCodeGo inventory may have resolved its runtime before this
      // router fiber registered. Refresh an existing entry as well; otherwise
      // a stale unavailable row rejects every new native session even though
      // the verified Codex/Claude artifact is installed.
      if (runtime !== undefined && (definition.id === 'codex' || definition.id === 'claude')) {
        try { this.agentEngines.setAvailability(definition.id, definition.availability ?? 'unavailable') } catch { /* entry may be draining during HMR */ }
      }
    }
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const parentId = options.meta?.parentSession
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    const inheritedEngine = parent === undefined ? undefined : inheritedEngineOf(parent.options)
    const routed = routedOptions(options.agentOptions, this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined, inheritedEngine)
    const selected: RoutedAgentOptions = inheritedEngine === undefined || parent === undefined
      ? routed
      : inheritSameEngineRoute(routed, parent.options)
    const engine = resolveEngine(selected.engine)
    // One route decides both the durable binding and whether this session runs
    // natively. Reading `selected.provider` at each site let a native session be
    // opened on the adapter loop (no provider, so `native` was false) while the
    // lease minted the adapter's ordinary route into its binding — and that
    // binding is what makes the resume path choose the native runtime.
    const provider = effectiveProviderOf(engine, selected.provider)
    const lease = await this.reserve(options.sessionId, engine, provider, selected.model)
    try {
      const native = usesNativeRuntime(engine, provider)
      const routed: CreateAgentOptions = { ...options, agentOptions: selected }
      const handle = engine === 'deepseek' || !native
        ? await this.fallbackAgentLoop().createAgent(ownerCtx, routed)
        : await this.nativeFactory.createAgent(ownerCtx, { ...routed, enginePlan: lease.plan })
      recordExecutor(handle.agent.session, engine, native, provider)
      return this.wrap(handle, lease)
    } catch (error) {
      lease.release()
      throw error
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const lease = await this.reserveResume(options)
    try {
      const selected = routedOptions(options.agentOptions, this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined)
      // The durable session binding keeps the transcript on its original
      // engine and provider ONLY when the caller did not explicitly choose a
      // route this turn. A caller-supplied non-empty provider/model is an
      // explicit per-turn selection (API/mobile model switch) and must win
      // over the persisted plan — the old unconditional binding precedence
      // silently ignored those switches despite the comment claiming the
      // opposite.
      const engine = lease.plan.engineId
      const requestedProvider = options.agentOptions?.provider?.trim()
      const requestedModel = options.agentOptions?.model?.trim()
      const durableProvider = routeProvider(lease.plan.routeBindingId)
      // The caller's explicit per-turn route, else the one the lease was minted
      // with, else the engine's own. The last arm keeps this total for a durable
      // binding written by a build that minted no provider.
      const effectiveProvider = requestedProvider !== undefined && requestedProvider !== ''
        ? requestedProvider
        : durableProvider ?? effectiveProviderOf(engine, selected.provider)
      const native = usesNativeRuntime(engine, effectiveProvider)
      const resumedOptions: ResumeAgentOptions = {
        ...options,
        agentOptions: {
          ...options.agentOptions,
          engine,
          ...(effectiveProvider === undefined ? {} : { provider: effectiveProvider }),
          model: requestedModel !== undefined && requestedModel !== '' ? requestedModel : lease.plan.modelId ?? selected.model,
        } as AgentOptions,
      }
      const handle = engine === 'deepseek' || !native
        ? await this.fallbackAgentLoop().resume(ownerCtx, resumedOptions)
        : await this.nativeFactory.resume(ownerCtx, { ...resumedOptions, enginePlan: lease.plan })
      recordExecutor(handle.agent.session, engine, native, effectiveProvider)
      return this.wrap(handle, lease)
    } catch (error) {
      lease.release()
      throw error
    }
  }

  /** Dispose an idle root Agent so its durable session can be permanently removed. */
  async disposeAgent(sessionId: SessionId): Promise<boolean> {
    const handle = this.liveHandles.get(sessionId)
    if (handle === undefined || handle.agent.status === 'running') return false
    await handle.dispose()
    return true
  }

  private async reserveResume(options: ResumeAgentOptions): Promise<AgentEngineLease> {
    const persistence = this.ctx.get('sessionPersistence') as {
      open?: (id: string, access: 'read' | 'write') => Promise<{ read(offset?: number, length?: number): Promise<readonly { type: string; data: unknown }[]>; close(): Promise<void> }>
    } | undefined
    if (persistence !== undefined) {
      // The durable log is read through the declared handle (`open` → `read` →
      // `close`). A preview-only `inspect(id)` used to be preferred whenever a
      // build exposed it; no pinned Harness line declares it — it was removed
      // before 0.1.3 — so that branch never ran, and the compatibility policy for
      // this repo does not carry one.
      const inspected = typeof persistence.open === 'function'
        ? await (async () => {
          const handle = await persistence.open!(options.resumeSessionId, 'read')
          try { return { events: await handle.read() } }
          finally { await handle.close() }
        })()
        : undefined
      if (inspected === undefined) return this.reserveWithoutPersistedBinding(options)
      const selected = inspected.events.find(event => event.type === 'agent-engine/selected')
      if (selected !== undefined) {
        const data = selected.data as Partial<AgentEnginePlan>
        if (typeof data.engineId !== 'string' || typeof data.generation !== 'number' || typeof data.artifactDigest !== 'string'
          || typeof data.protocolAbi !== 'string' || typeof data.modelId !== 'string' || typeof data.routeBindingId !== 'string'
          || typeof data.catalogRevision !== 'string' || typeof data.capabilityFingerprint !== 'string') {
          throw new Error(`session "${options.resumeSessionId}" has an invalid durable engine binding`)
        }
        return this.agentEngines.reserveExisting({
          engineId: data.engineId,
          generation: data.generation,
          artifactDigest: data.artifactDigest,
          protocolAbi: data.protocolAbi,
          modelId: data.modelId,
          routeBindingId: data.routeBindingId,
          catalogRevision: data.catalogRevision,
          capabilityFingerprint: data.capabilityFingerprint,
        }, options.resumeSessionId)
      }
    }
    return this.reserveWithoutPersistedBinding(options)
  }

  private reserveWithoutPersistedBinding(options: ResumeAgentOptions): Promise<AgentEngineLease> {
    const selected = routedOptions(options.agentOptions, this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined)
    return this.reserve(options.resumeSessionId, selected.engine, selected.provider, selected.model)
  }

  /** Resolve AgentLoop through the root service registry, never a transient caller fiber. */
  private fallbackAgentLoop(): AgentFactory {
    const loop = this.ctx.get('agentLoop') as AgentFactory | undefined
    if (loop === undefined) throw new Error('FreeCodeGo AgentEngineRouter requires the official AgentLoop service')
    return loop
  }

  private async reserve(
    sessionId: CreateAgentOptions['sessionId'],
    requestedEngine: string | undefined,
    provider: string | undefined,
    model?: string,
  ): Promise<AgentEngineLease> {
    const engine = resolveEngine(requestedEngine)
    // Profile services activate independently. Reconcile immediately before
    // admission so a late plugin activation cannot leave a valid runtime
    // stuck in the registry's startup unavailable state.
    if (engine === 'claude') {
      const inventory = this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined
      const runtimeAvailable = hasInstalledClaudeRuntime()
      if (inventory !== undefined || runtimeAvailable) {
        const available = inventory?.claudeRuntimeStatus?.().installed === true || runtimeAvailable
        this.agentEngines.setAvailability('claude', available ? 'available' : 'unavailable')
      }
    } else if (engine === 'codex') {
      const inventory = this.ctx.get('freeCodeGoHarness') as FreeCodeGoHarnessInventory | undefined
      if (inventory?.nativeRuntimeStatus !== undefined) this.agentEngines.setAvailability('codex', inventory.nativeRuntimeStatus().installed ? 'available' : 'unavailable')
    }
    const selectedModel = model === undefined || model.trim() === ''
      ? engine === 'codex' ? 'codex-auto' : engine === 'claude' ? 'claude-sonnet-4-6' : 'deepseek-v4-flash'
      : model
    // The binding is durable and is what the resume path reads the provider back
    // from, so it records the provider this engine actually runs.
    const selectedProvider = effectiveProviderOf(engine, provider)
    return this.agentEngines.reserve(engine, sessionId, {
      modelId: selectedModel,
      routeBindingId: `harness:${selectedProvider}:${selectedModel}`,
      catalogRevision: 'harness-local',
      capabilityFingerprint: engine === 'deepseek' ? 'dsh-agent-loop' : `freecodego-${engine}-native`,
    })
  }

  private wrap(handle: AgentHandle, lease: AgentEngineLease): AgentHandle {
    ensureAgentEngineBinding(handle.agent.session, lease.plan)
    lease.publish()
    const id = handle.agent.id
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      lease.release()
    }
    let disposing: Promise<void> | undefined
    const wrapped: AgentHandle = {
      agent: handle.agent,
      dispose: () => (disposing ??= handle.dispose().finally(() => {
        release()
        if (this.liveHandles.get(id) === wrapped) this.liveHandles.delete(id)
        this.leaseReleases.delete(id)
      })),
    }
    this.liveHandles.set(id, wrapped)
    this.leaseReleases.set(id, release)
    return wrapped
  }
}

function resolveEngine(value: string | undefined): AgentEngineId {
  if (value === undefined || value === 'deepseek') return 'deepseek'
  if (value === 'codex' || value === 'claude') return value
  throw new Error(`unknown root agent engine "${value}"`)
}

/** Native workers own their provider protocol and credentials. All other
 * provider families stay on the Host LLM adapter while retaining the chosen
 * engine identity in the durable session binding. */
function usesNativeRuntime(engine: AgentEngineId, provider: string | undefined): boolean {
  if (engine === 'codex') return provider !== undefined && provider !== ''
  // Claude Agent SDK consumes an Anthropic Messages facade. The plugin-owned
  // localhost bridge translates that facade to non-native Host providers,
  // so Agnes/WorkBuddy/OpenRouter/third-party routes remain independent.
  if (engine === 'claude') return provider !== undefined && provider !== ''
  return false
}

function recordExecutor(
  session: { snapshotEvents(): readonly { readonly type: string }[]; append(type: 'freecodego/engine-executor', data: { readonly engineId: AgentEngineId; readonly executor: 'native' | 'adapter-loop'; readonly provider: string }): unknown },
  engine: AgentEngineId,
  native: boolean,
  provider: string | undefined,
): void {
  if (session.snapshotEvents().some(event => event.type === 'freecodego/engine-executor')) return
  session.append('freecodego/engine-executor', {
    engineId: engine,
    executor: native ? 'native' : 'adapter-loop',
    provider: provider ?? 'unknown',
  })
}

/** The official SDK worker marker may exist before the Host inventory service
 * publishes its status. The Host opener still validates its digest per session. */
function hasInstalledClaudeRuntime(): boolean {
  const home = process.env.DSH_HOME?.trim() || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
  return existsSync(path.join(home, 'runtimes', 'claude', '.complete'))
    && existsSync(path.join(home, 'runtimes', 'claude', 'claude-agent-sdk-runtime.json'))
}

export default FreeCodeGoAgentEngineRouter
