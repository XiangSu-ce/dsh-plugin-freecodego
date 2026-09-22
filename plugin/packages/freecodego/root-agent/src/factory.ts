/** AgentFactory lifecycle transaction for plugin-owned native engines. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentEnginePlan, FreeCodeGoAgentOptions } from './engine-plan.ts'
import { ensureAgentEngineBinding, routeProvider } from './engine-plan.ts'
import { SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { appendNativeSessionBinding, nativeSessionBinding, replaceNativeSessionBinding } from './native-session-binding.ts'
import { FreeCodeGoNativeAgent } from './native-agent.ts'
import type { NativeRootAgentEvent } from './index.ts'
import { isNativeSandboxMode, type NativeSandboxMode } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'

/**
 * The Harness sandbox policy service, as much of it as this factory reads.
 *
 * Structural rather than imported: root-agent owns no dependency on the sandbox
 * packages, and these two members are the service's public face. The rule below
 * deliberately mirrors the plugin's `sandboxModeStatus` (override, else the
 * deployment default), so a status readout and the mode handed to the engine
 * cannot disagree about which one is in effect.
 */
interface SandboxPolicyLike {
  readonly defaultMode?: unknown
  overrideOf(session: Session): unknown
}

/**
 * The sandbox mode to hand the native engine for one Session.
 *
 * The Session is the authority here: the Harness writes `sandbox/mode` when the
 * user picks a mode (`freecodego`'s `sandboxModeSet`), and the plugin's Harness
 * tools obey it, so the engine must be told the same mode or one session ends up
 * with two policies. A read that yields no mode — service not mounted, or a
 * value outside the vocabulary — returns `undefined` so the engine keeps its own
 * default instead of the plugin inventing a restriction the user never chose.
 * @param ctx - context carrying the Host sandbox policy service.
 * @param session - the Harness session whose policy is being read.
 * @returns the mode the engine must run under, or `undefined` when no readable policy is mounted.
 */
export function nativeSandboxModeForSession(ctx: Context, session: Session): NativeSandboxMode | undefined {
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
  if (policy === undefined) return undefined
  const override = policy.overrideOf(session)
  const mode = isNativeSandboxMode(override) ? override : policy.defaultMode
  return isNativeSandboxMode(mode) ? mode : undefined
}

/** Arguments passed to a runtime opener after the immutable engine plan is leased. */
export interface NativeAgentOpenOptions {
  readonly engine: 'codex' | 'claude'
  readonly harnessSessionId: string
  readonly modelId: string
  readonly provider: string
  readonly workspace: string
  readonly artifactDigest: string
  readonly protocolAbi: string
  readonly resume: boolean
  /** The live Harness Agent owning this protocol session. */
  readonly agent: Agent
  readonly nativeSessionId?: string
  /** Engine persona/behavior guidance forwarded as the native session's system prompt. */
  readonly systemPrompt?: string
  /**
   * Forces the native runtime to deny mutations and permission escalation. The
   * council reviewer floor; see {@link nativeSandboxModeForSession} for the
   * user's own sandbox choice.
   */
  readonly readOnly: boolean
  /** The Session's resolved Harness sandbox mode, absent when none could be read. */
  readonly sandboxMode?: NativeSandboxMode
  readonly onEvent: (event: NativeRootAgentEvent) => void
}

/** Common protocol-session face shared by the Codex bridge and Claude SDK adapter. */
export interface NativeAgentSession {
  readonly identity: NativeRootAgentEvent['binding']
  prompt(content: string, route?: { readonly modelId: string; readonly provider: string; readonly reasoningEffort?: string }, signal?: AbortSignal): Promise<void>
  cancel(reason?: string): Promise<void>
  respond(method: 'permission/respond' | 'question/respond' | 'bridge/respond', requestId: string, response: unknown): Promise<void>
  dispose(): Promise<void>
}

/** Runtime sidecar opener supplied by the platform bundle. */
export type NativeAgentRuntimeOpener = (options: NativeAgentOpenOptions) => Promise<NativeAgentSession>

/** Runtime opener table; omitted engines fail explicitly instead of falling back to DeepSeek. */
export type NativeAgentRuntimeOpeners = Partial<Record<'codex' | 'claude', NativeAgentRuntimeOpener>>

/**
 * Per-engine system prompt, keyed by the same engine union as {@link NativeAgentRuntimeOpeners}.
 *
 * Named rather than spelled inline so the key set has one home: the router's
 * `systemPrompts` Config field is checked against this declaration by
 * `scripts/freecodego-config-readers.spec.ts`, which can only verify an
 * exemption that names a type. A second inline `Record<'codex' | 'claude', …>`
 * would let one of the two key lists drift.
 */
export type NativeAgentSystemPrompts = Partial<Record<'codex' | 'claude', string>>

/** Configuration needed to construct a plugin-owned native AgentFactory. */
export interface FreeCodeGoNativeAgentFactoryOptions {
  readonly openers: NativeAgentRuntimeOpeners
  readonly defaultWorkspace?: string
  /** Per-engine system prompt handed to each opened native session; engines without an entry open unprompted. */
  readonly engineSystemPrompts?: NativeAgentSystemPrompts
}

/** Implements the public AgentFactory lifecycle without importing private AgentLoop classes. */
export class FreeCodeGoNativeAgentFactory implements AgentFactory {
  constructor(private readonly ctx: Context, private readonly config: FreeCodeGoNativeAgentFactoryOptions) {}

  async createAgent(ownerCtx: Context, options: CreateAgentOptions & { readonly enginePlan?: AgentEnginePlan }): Promise<AgentHandle> {
    if (options.enginePlan === undefined) throw new Error('native AgentFactory requires an immutable engine plan')
    const session = this.ctx.sessions.prepare(options.sessionId, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    })
    ensureAgentEngineBinding(session, options.enginePlan)
    const stored = await this.openNewSession(session, options.signal)
    try {
      return await this.publish(
        ownerCtx,
        session,
        options.sessionId,
        options.agentOptions ?? {},
        options.enginePlan,
        false,
        options.setup,
        options.signal,
        stored === undefined ? undefined : () => stored.handle.close(),
        stored,
        options.parentAgent,
      )
    } catch (error) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions & { readonly enginePlan?: AgentEnginePlan }): Promise<AgentHandle> {
    if (options.enginePlan === undefined) throw new Error('native AgentFactory requires an immutable engine plan')
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence === undefined) throw new Error('cannot resume native agent: session persistence is not configured')
    const handle = await persistence.open(options.resumeSessionId, 'write', options.signal === undefined ? undefined : { signal: options.signal })
    try {
      const persisted = await handle.read(0, undefined, options.signal === undefined ? undefined : { signal: options.signal })
      // Semantic crash repair belongs to the agent layer: persistence hands back
      // the physically valid log, and a turn the process died inside has no
      // `turn/end`. The next `turn/start` would then open inside that still-open
      // turn, so the resumed session could neither run a turn nor number one
      // (the relational invariant rejects `turn/start` while a turn is open).
      // The upstream loop appends the same synthetic closers through its own
      // write handle before seeding; this factory owns the native engines and
      // has to match it.
      const closers = interruptedTurnClosers(persisted.events)
      if (closers.length > 0) {
        await handle.append(closers, options.signal === undefined ? undefined : { signal: options.signal })
      }
      // Harness 0.1.6 returns a caller-owned event slice plus its aliasing
      // state; `seedSource` no longer exists on the prepare inputs.
      const session = this.ctx.sessions.prepare(options.resumeSessionId, {
        seed: [...persisted.events, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: persisted.eventState,
      })
      const preparation = SessionPreparation.create(session)
      return await this.publish(ownerCtx, session, options.resumeSessionId, options.agentOptions ?? {}, options.enginePlan, true, options.setup, options.signal, async () => {
        preparation[Symbol.dispose]()
        await handle.close()
      }, { handle, storedCount: persisted.events.length + closers.length }, options.parentAgent)
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  /** Create the durable write handle before publication so pre-live events are stored. */
  private async openNewSession(session: Session, signal?: AbortSignal): Promise<{ readonly handle: SessionHandle; readonly storedCount: number } | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...(signal === undefined ? {} : { signal }),
    })
    try {
      const seed = session.snapshotEvents()
      if (seed.length > 0) await handle.append(seed, signal === undefined ? undefined : { signal })
      return { handle, storedCount: seed.length }
    } catch (error) {
      // The caller only sees `stored` after this returns; a failed seed append
      // must close the created handle here or the write handle leaks.
      await handle.close().catch(() => {})
      throw error
    }
  }

  private async publish(
    ownerCtx: Context,
    session: Session,
    id: SessionId,
    options: { readonly engine?: string; readonly provider?: string; readonly model?: string } & FreeCodeGoAgentOptions,
    plan: AgentEnginePlan,
    resume: boolean,
    setup: CreateAgentOptions['setup'],
    signal: AbortSignal | undefined,
    releasePreparation?: () => void | Promise<void>,
    stored?: { readonly handle: SessionHandle; readonly storedCount: number },
    owner?: Agent,
  ): Promise<AgentHandle> {
    ensureAgentEngineBinding(session, plan)
    const engine = plan.engineId
    if (engine === 'deepseek') throw new Error('native AgentFactory cannot create the DeepSeek engine')
    const opener = this.config.openers[engine]
    if (opener === undefined) throw new Error(`native runtime for engine "${engine}" is not configured`)
    const agent = new FreeCodeGoNativeAgent(this.ctx, id, options, session)
    const nativeId = resume ? nativeSessionBinding(session, engine, plan.artifactDigest, plan.protocolAbi) : undefined
    let opened: NativeAgentSession | undefined
    const ownerAbort = new AbortController()
    const stopOwnerWatch = ownerCtx.effect(() => () => { ownerAbort.abort(new Error(`agent "${id}" setup owner was disposed`)) }, `freeCodeGoNativeAgent.setup(${id})`)
    try {
      const engineSystemPrompt = this.config.engineSystemPrompts?.[engine]
      // Read per open, including recovery: a mode the user changed mid-session is
      // in effect the moment the session's `sandbox/mode` event lands, and the
      // next session this factory opens has to carry it.
      const sandboxMode = nativeSandboxModeForSession(this.ctx, session)
      const openNative = async (recover = false): Promise<NativeAgentSession> => await opener({
        engine,
        harnessSessionId: String(id),
        modelId: plan.modelId,
        // The plan is the only place the provider survives when the options
        // carry none. Forwarding the whole `harness:<provider>:<model>` binding
        // as a provider name handed the worker a route id where it expects a
        // provider; the engine's own id is the last resort for a binding written
        // by a build that minted no provider.
        provider: options.provider ?? routeProvider(plan.routeBindingId) ?? plan.engineId,
        workspace: session.header.cwd ?? this.config.defaultWorkspace ?? process.cwd(),
        artifactDigest: plan.artifactDigest,
        protocolAbi: plan.protocolAbi,
        // A crashed Worker cannot safely resume an in-memory runtime session.
        // Recovery starts a fresh native session while preserving Harness history.
        resume: recover ? false : resume,
        agent,
        readOnly: options.freeCodeGoReadOnly === true,
        ...(sandboxMode === undefined ? {} : { sandboxMode }),
        ...(!recover && nativeId !== undefined ? { nativeSessionId: nativeId } : {}),
        ...(engineSystemPrompt === undefined ? {} : { systemPrompt: engineSystemPrompt }),
        onEvent: (event) => { agent.onNativeEvent(event) },
      })
      const opening = openNative()
      void opening.then((lateSession) => {
        if (ownerAbort.signal.aborted || signal?.aborted === true) void lateSession.dispose()
      }, () => undefined)
      opened = await raceAbort(opening, AbortSignal.any([ownerAbort.signal, ...(signal === undefined ? [] : [signal])]), id)
      agent.attachNative(opened)
      appendNativeSessionBinding(session, { engine, runtimeSessionId: opened.identity.runtimeSessionId, artifactDigest: plan.artifactDigest, protocolAbi: plan.protocolAbi })
      agent.setNativeRecovery(async () => {
        const recovered = await openNative(true)
        replaceNativeSessionBinding(session, { engine, runtimeSessionId: recovered.identity.runtimeSessionId, artifactDigest: plan.artifactDigest, protocolAbi: plan.protocolAbi })
        return recovered
      })
      if (setup !== undefined) {
        // Harness 0.1.6 passes the unpublished agent alongside its scope; the
        // scope alone no longer exposes it.
        const commit = await setup(agent.ctx, agent)
        commit?.commit()
      }
      if (stored !== undefined) {
        const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
        if (suffix.length > 0) await stored.handle.append(suffix)
      }
      if (signal?.aborted) throw signal.reason ?? new Error(`agent "${id}" creation aborted`)
    } catch (error) {
      await opened?.dispose().catch(() => undefined)
      await agent.scope.dispose()
      await releasePreparation?.()
      await stopOwnerWatch()
      throw error
    }
    await stopOwnerWatch()
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      await agent.disposeNative()
      detachAgent?.()
      detachSession?.()
      await agent.scope.dispose()
      await releasePreparation?.()
    })())
    try {
      detachSession = this.ctx.sessions.enter(session)
      // Harness 0.1.6 removed `Context.agent`; the creating agent travels on
      // the creation options as `parentAgent` for child ownership.
      detachAgent = this.ctx.agents.enter(agent, owner)
      this.ctx.sessions.announce(session)
      // Harness 0.1.6 folded `agent/session-start` into the single serial
      // `agent/created` announcement, which now carries the start source; the
      // registry rejects a second announcement for the same entry.
      await this.ctx.agents.announce(agent, resume ? 'resume' : 'startup')
      ownerCtx.effect(() => () => { void dispose() }, `freeCodeGoNativeAgent.lifecycle(${id})`)
      return { agent, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal, id: SessionId): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error(`agent "${id}" setup aborted`)
  let rejectAbort: (reason: unknown) => void = () => undefined
  const onAbort = (): void => { rejectAbort(signal.reason ?? new Error(`agent "${id}" setup aborted`)) }
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; signal.addEventListener('abort', onAbort, { once: true }) })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
