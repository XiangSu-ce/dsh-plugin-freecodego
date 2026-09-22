import type { NativeRuntimeEvent, NativeRuntimeInitializeResult, NativeRuntimeMethod, NativeSandboxMode } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import { redactCredentialShapes } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import { NativeRuntimeHost, type NativeRuntimeHostOptions } from '@deepseek-ai/dsh-freecodego-native-runtime-host'

export * from './native-session-binding.ts'
export * from './engine-plan.ts'
export * from './native-agent.ts'
export * from './native-inbox.ts'
export * from './factory.ts'

/** Which native session a root agent runs, as the runtime named it at open time. */
export interface NativeRootAgentBinding {
  /** Engine serving this binding. */
  readonly engine: 'codex' | 'claude'
  /** Session id the native runtime assigned; the runtime's own name for it. */
  readonly runtimeSessionId: string
  /** Harness Session this native session is attached to. */
  readonly harnessSessionId: string
  /** Model the native session was opened with. */
  readonly modelId: string
  /** Provider that model resolves through. */
  readonly provider: string
  /** Digest of the runtime artifacts this session was launched from. */
  readonly artifactDigest: string
  /** Protocol ABI the runtime and this Host agreed on during the handshake. */
  readonly protocolAbi: string
}

/** A native runtime event, tagged with the binding that produced it. */
export type NativeRootAgentEvent = NativeRuntimeEvent & {
  /** Binding the event arrived on; says which root agent it belongs to. */
  readonly binding: NativeRootAgentBinding
}

/** Everything the factory needs to open one native root agent. */
export interface NativeRootAgentCreateOptions {
  /** Engine to launch. */
  readonly engine: 'codex' | 'claude'
  /** Harness Session the new native session is attached to. */
  readonly harnessSessionId: string
  /** Model the native session should be opened with. */
  readonly modelId: string
  /** Provider that model resolves through. */
  readonly provider: string
  /** Working directory the native engine is given as its workspace root. */
  readonly workspace: string
  /** Digest of the runtime artifacts to launch; a mismatch is refused, not repaired. */
  readonly artifactDigest: string
  /** Protocol ABI this Host speaks; the runtime must agree at handshake. */
  readonly protocolAbi: string
  /** Reattaches to an existing native session instead of creating one. */
  readonly resume?: boolean
  /** Session id to reattach to; only meaningful together with `resume`. */
  readonly nativeSessionId?: string
  /** Engine persona/behavior guidance sent as the native session's system prompt; engines without one ignore it. */
  readonly systemPrompt?: string
  /**
   * Requests a non-mutating native session for an engineering council child. A
   * floor the runtimes cannot widen; the reviewer child floor, not the user's
   * sandbox choice.
   */
  readonly readOnly?: boolean
  /**
   * The Harness sandbox mode resolved for this Session, forwarded so the native
   * engine applies the same file policy the Harness tools do. Absent when no
   * sandbox policy service is mounted, in which case the engine's own default
   * stands rather than a mode nobody chose.
   */
  readonly sandboxMode?: NativeSandboxMode
  /**
   * Runs after the protocol handshake and before session/create so launchers
   * can deliver per-session configuration (for example the Claude worker's
   * `host/configure` payload). Failures abort the open.
   */
  readonly prepare?: (send: (method: NativeRuntimeMethod, params: unknown) => Promise<void>) => Promise<void>
  /** Called for every native runtime event this session emits. */
  readonly onEvent?: (event: NativeRootAgentEvent) => void
}

/** Protocol-backed native session. It owns no Harness Session or credentials. */
export class NativeRootAgentSession {
  private disposed = false
  private readonly binding: NativeRootAgentBinding

  private constructor(private readonly host: NativeRuntimeHost, options: NativeRootAgentCreateOptions, runtimeSessionId: string) {
    this.binding = { engine: options.engine, runtimeSessionId, harnessSessionId: options.harnessSessionId, modelId: options.modelId, provider: options.provider, artifactDigest: options.artifactDigest, protocolAbi: options.protocolAbi }
  }

    /**
   * Start a native session through the worker protocol and return the handle that owns it.
   * @param hostOptions - how to launch the runtime host worker for this session.
   * @param options - the immutable engine plan and Harness session facts to open with.
   * @returns the opened session, bound to the runtime session id the worker issued.
   */
static async open(hostOptions: NativeRuntimeHostOptions, options: NativeRootAgentCreateOptions): Promise<NativeRootAgentSession> {
    let session: NativeRootAgentSession | undefined
    /**
     * The highest wire sequence forwarded so far.
     *
     * A failure the host reports is not a wire frame and has no sequence of its
     * own, so the event synthesized for it continues this run instead of
     * inventing a number that could collide with a later real frame.
     */
    let lastSequence = -1
    const forward = (event: NativeRuntimeEvent): void => {
      if (event.params.harnessSessionId !== options.harnessSessionId) throw new Error('native runtime event belongs to another Harness session')
      if (typeof event.params.sequence === 'number' && event.params.sequence > lastSequence) lastSequence = event.params.sequence
      options.onEvent?.({ ...event, binding: session?.binding ?? ({ engine: options.engine, runtimeSessionId: event.params.runtimeSessionId, harnessSessionId: options.harnessSessionId, modelId: options.modelId, provider: options.provider, artifactDigest: options.artifactDigest, protocolAbi: options.protocolAbi }) })
    }
    const host = new NativeRuntimeHost({
      ...hostOptions,
      onEvent: forward,
      // A worker that dies is reported as the one event the Harness already
      // settles a turn with. Nothing else can carry it: `session/prompt`
      // answers as soon as the turn starts, so the death lands between events,
      // and the turn would otherwise wait forever on a completion that cannot
      // arrive. Reporting it also drops the dead session, which is what lets
      // the next turn reopen a worker instead of reusing a corpse.
      onFailure: (error) => {
        forward({
          method: 'session/failed',
          params: {
            runtimeSessionId: session?.binding.runtimeSessionId ?? '',
            harnessSessionId: options.harnessSessionId,
            sequence: lastSequence + 1,
            message: redactCredentialShapes(error.message),
          },
        })
      },
    })
    try {
      const initialized = await host.request<NativeRuntimeInitializeResult>('initialize', { protocolVersion: options.protocolAbi, engine: options.engine })
      if (initialized.protocolAbi !== options.protocolAbi || !initialized.engines.includes(options.engine)) {
        throw new Error(`native runtime does not support ${options.engine} with protocol ABI ${options.protocolAbi}`)
      }
      if (options.prepare !== undefined) await options.prepare((method, params) => host.request(method, params))
      const method: NativeRuntimeMethod = options.resume ? 'session/resume' : 'session/create'
      const result = await host.request<{ runtimeSessionId?: string; modelId?: string; provider?: string }>(method, { harnessSessionId: options.harnessSessionId, ...(options.nativeSessionId === undefined ? {} : { runtimeSessionId: options.nativeSessionId }), modelId: options.modelId, provider: options.provider, workspace: options.workspace, ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }), ...(options.readOnly === true ? { readOnly: true } : {}), ...(options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode }) })
      const runtimeSessionId = result.runtimeSessionId
      if (typeof runtimeSessionId !== 'string' || runtimeSessionId.trim() === '') throw new Error('native runtime did not return runtimeSessionId')
      session = new NativeRootAgentSession(host, {
        ...options,
        ...(typeof result.modelId === 'string' && result.modelId.trim() !== '' ? { modelId: result.modelId } : {}),
        ...(typeof result.provider === 'string' && result.provider.trim() !== '' ? { provider: result.provider } : {}),
      }, runtimeSessionId)
      return session
    } catch (error) {
      await host.dispose()
      throw error
    }
  }

    /**
   * Immutable identity of the runtime session, as durable session bindings record it.
   */
get identity(): NativeRootAgentBinding { return this.binding }

  private diagnostics: readonly string[] = []

  /**
   * Record a non-fatal diagnostic without killing the session. The latest
   * messages are readable through `recentDiagnostics()` so a swallowed
   * capability refresh (or similar soft failure) stays observable.
   * @param message - the diagnostic text; truncated to 2,000 characters and capped at ten messages.
   */
  emitDiagnostic(message: string): void {
    this.diagnostics = [...this.diagnostics.slice(-9), message.slice(0, 2_000)]
  }

  /** Recent non-fatal diagnostics for status surfaces. 
   * @returns the most recent non-fatal diagnostics, oldest first.
   */
  recentDiagnostics(): readonly string[] {
    return this.diagnostics
  }

  /** Refresh Host-owned tool/capability configuration without recreating the session. 
   * @param params - Host-shaped tool and capability configuration to install on the live session.
   */
  async configure(params: unknown): Promise<void> {
    this.assertLive()
    await this.host.request('host/configure', params)
  }

    /**
   * Send one turn's user content, optionally overriding the route the model is prompted on.
   * @param content - the user content for this turn.
   * @param route - model, provider, and reasoning effort to prompt with instead of the agent's own.
   * @param signal - aborts the turn while the runtime is still working on it.
   */
async prompt(content: string, route?: { readonly modelId: string; readonly provider: string; readonly reasoningEffort?: string }, signal?: AbortSignal): Promise<void> {
    this.assertLive()
    if (content.trim() === '') throw new Error('native root prompt must not be empty')
    await this.host.request('session/prompt', {
      runtimeSessionId: this.binding.runtimeSessionId,
      harnessSessionId: this.binding.harnessSessionId,
      content,
      ...(route === undefined ? {} : { modelId: route.modelId, provider: route.provider, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }),
    }, signal === undefined ? {} : { signal })
  }

    /**
   * Ask the runtime to cancel the active turn; a disposed session ignores the request.
   * @param reason - short reason recorded with the cancellation.
   */
async cancel(reason = 'user'): Promise<void> {
    if (this.disposed) return
    await this.host.request('session/cancel', { runtimeSessionId: this.binding.runtimeSessionId, harnessSessionId: this.binding.harnessSessionId, reason }).catch(() => undefined)
  }

    /**
   * Answer a pending runtime request, such as a permission or question prompt.
   * @param method - the response method the pending request expects.
   * @param requestId - id of the pending request.
   * @param response - engine-shaped response payload.
   */
async respond(method: 'permission/respond' | 'question/respond' | 'bridge/respond', requestId: string, response: unknown): Promise<void> {
    this.assertLive()
    await this.host.request(method, { runtimeSessionId: this.binding.runtimeSessionId, harnessSessionId: this.binding.harnessSessionId, requestId, response })
  }

    /**
   * Release the native process and make every later call on this session fail.
   */
async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.host.request('session/dispose', { runtimeSessionId: this.binding.runtimeSessionId, harnessSessionId: this.binding.harnessSessionId }).catch(() => undefined)
    await this.host.dispose()
  }

  private assertLive(): void { if (this.disposed) throw new Error('native root agent session is disposed') }
}

export default NativeRootAgentSession
