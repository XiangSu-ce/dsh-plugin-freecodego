/** Harness Agent implementation driven by an isolated native runtime session. */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, InboxTarget } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAccumulator, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId, ContentBlock } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { redactCredentialShapes } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { NativeRootAgentEvent } from './index.ts'
import type { NativeAgentSession } from './factory.ts'
import { FreeCodeGoNativeInbox } from './native-inbox.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number }

interface Completion {
  resolve(status: string): void
  reject(reason: unknown): void
}

type NativeSessionRecovery = () => Promise<NativeAgentSession>
type ReasoningSource = 'claude-agent-sdk' | 'codex-app-server' | 'adapter'

/**
 * Longest reasoning level accepted from a durable selection.
 *
 * Every engine vocabulary is an order of magnitude shorter (`low`, `medium`,
 * `xhigh`, …); the bound exists because the value is read from a session event
 * and forwarded to the engine verbatim, so an unbounded one would let a log
 * hand the worker a megabyte of "level".
 */
const MAX_REASONING_EFFORT_CHARS = 64

function callId(value: string): ToolCallId { return value as ToolCallId }

/** Public Agent that serializes Harness inbox turns through one native runtime session. */
export class FreeCodeGoNativeAgent implements Agent {
  readonly inbox: FreeCodeGoNativeInbox
  readonly scope: Scope
  readonly ctx: Context
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private native: NativeAgentSession | undefined
  private recovery: NativeSessionRecovery | undefined
  private recoveryOpening: Promise<NativeAgentSession> | undefined
  private completion: Completion | undefined
  private readonly dispatch
  /** Native runtimes do not expose Harness stream chunks directly; retain a
   * compact v2 stream alongside the assembled text until settlement. */
  private assistantStream = new AssistantStreamAccumulator()
  private deltaText = ''
  private finalText = ''
  private reasoningText = ''
  private reasoningSource: ReasoningSource | undefined
  private reasoningSourceLabel: string | undefined
  /** Route captured for the active turn, after a user changes the model. */
  private activeRoute: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
  private readonly pendingApprovals = new Set<string>()
  /** Native workers stream tool lifecycle frames through one progress channel. */
  private readonly nativeToolCalls = new Map<string, { name: string; arguments: string }>()
  /** Aborted on dispose so off-turn bridge requests cannot outlive the agent. */
  private readonly bridgeLifecycle = new AbortController()
  private disposed = false

  constructor(
    private readonly runtimeCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(runtimeCtx, this)
    this.inbox = new FreeCodeGoNativeInbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    this.phase = { kind: 'idle', lastTurn: session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0 }
    this.scope = createScope(runtimeCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus { return this.phase.kind === 'running' ? 'running' : 'idle' }

  /** Attach the opened process bridge before this agent is published. */
  attachNative(session: NativeAgentSession): void {
    if (this.native !== undefined) throw new Error(`native agent "${this.id}" already has a runtime session`)
    this.native = session
  }

  /** Configure lazy recovery after a worker crashes; the failed turn is never replayed. */
  setNativeRecovery(recovery: NativeSessionRecovery): void { this.recovery = recovery }

  /** Project a correlated native event into the current Harness turn. */
  onNativeEvent(event: NativeRootAgentEvent): void {
    if (event.binding.harnessSessionId !== this.id || this.disposed) return
    if (this.native !== undefined && event.binding.runtimeSessionId !== this.native.identity.runtimeSessionId) return
    if (event.method === 'assistant/delta') {
      const text = typeof event.params.text === 'string' ? event.params.text : ''
      if (text !== '' && this.phase.kind === 'running') {
        this.deltaText += text
        this.assistantStream.push({ time: Date.now(), chunk: { type: 'text-delta', index: 0, text } })
      }
      return
    }
    if (event.method === 'assistant/reasoning/delta' || event.method === 'assistant/reasoning/final') {
      const text = typeof event.params.text === 'string' ? event.params.text : ''
      if (text !== '' && this.phase.kind === 'running') {
        const origin = reasoningOrigin(event.params)
        if (origin.source !== undefined) this.reasoningSource = origin.source
        if (origin.sourceLabel !== undefined) this.reasoningSourceLabel = origin.sourceLabel
        if (event.method === 'assistant/reasoning/final') {
          if (this.reasoningText === '') this.reasoningText = text
        } else {
          this.reasoningText += text
          this.assistantStream.push({ time: Date.now(), chunk: { type: 'reasoning-delta', index: 1, text } })
        }
      }
      return
    }
    if (event.method === 'assistant/final') {
      const text = typeof event.params.text === 'string' ? event.params.text : ''
      // Codex emits one final per completed agentMessage item; a single turn
      // can produce several of them (one per narration segment between tool
      // calls). Accumulate instead of overwriting so the persisted
      // assistant/message keeps every segment.
      if (text !== '') this.finalText = this.finalText === '' ? text : `${this.finalText}\n\n${text}`
      return
    }
    if (event.method === 'session/completed') {
      // The worker relays the app-server's own turn status verbatim. A missing
      // or non-string status is a protocol violation: assuming success would
      // record a broken turn as a completed one.
      if (typeof event.params.status !== 'string') {
        this.completion?.reject(new Error('native runtime sent a malformed completion status'))
        return
      }
      const status = event.params.status
      if (status === 'completed' || status === 'aborted' || status === 'cancelled') {
        this.completion?.resolve(status)
        return
      }
      const failed = this.native
      this.native = undefined
      void failed?.dispose().catch(() => undefined)
      this.completion?.reject(new Error(typeof event.params.message === 'string' && event.params.message !== ''
        ? event.params.message
        : `native turn finished with status "${status}"`))
      return
    }
    if (event.method === 'tool/progress') {
      this.projectNativeToolProgress(event.params)
      return
    }
    if (event.method === 'permission/requested') {
      const id = typeof event.params.requestId === 'string'
        ? event.params.requestId
        : typeof event.params.approvalId === 'string' ? event.params.approvalId : undefined
      const rawDetail = event.params.detail ?? event.params.request
      const detail = typeof rawDetail === 'object' && rawDetail !== null && !Array.isArray(rawDetail)
        ? rawDetail as { method?: unknown; toolName?: unknown; reason?: unknown }
        : {}
      if (id === undefined) return
      if (this.phase.kind !== 'running') {
        // A request that arrives with no running turn has no signal to prompt on
        // and nobody left to ask: the turn that produced it has already settled.
        // It still has to be *answered*, because both engines block on this
        // response — the Claude SDK awaits `canUseTool`, and Codex holds the turn
        // until its watchdog fires — so dropping it turns a late request into a
        // stalled turn with nothing that explains why. The question path below
        // answers in exactly this situation; this branch used to just return.
        void this.native?.respond('permission/respond', id, { type: 'rejected' }).catch(() => undefined)
        return
      }
      void this.handleNativePermission(id, {
        toolName: typeof detail.toolName === 'string' ? detail.toolName : typeof detail.method === 'string' ? detail.method : 'native',
        // The transport's own identity for the pending call. Codex names the
        // operation only by its App Server method, so that method is what the
        // plugin's native guard projects back onto a tool it can judge. Claude
        // reports a tool name instead, and the guard uses that.
        ...(typeof event.params.method === 'string' ? { method: event.params.method } : {}),
        detail: rawDetail,
        ...(typeof detail.reason === 'string' ? { reason: detail.reason } : {}),
      }, this.phase.abort.signal)
      return
    }
    if (event.method === 'question/requested') {
      const id = typeof event.params.requestId === 'string' ? event.params.requestId : undefined
      if (id === undefined) return
      const questions = normalizeQuestions(event.params.request)
      if (questions === undefined || this.phase.kind !== 'running') {
        void this.native?.respond('question/respond', id, { answers: [] }).catch(() => undefined)
        return
      }
      void this.handleNativeQuestion(id, questions, this.phase.abort.signal)
      return
    }
    if (event.method === 'bridge/requested') {
      const id = typeof event.params.requestId === 'string' ? event.params.requestId : undefined
      if (id === undefined) return
      // Off-turn bridges ride the lifecycle signal so a disposed agent cannot
      // leave them executing against a signal that is never aborted.
      void this.handleBridgeRequest(id, event.params, this.phase.kind === 'running' ? this.phase.abort.signal : this.bridgeLifecycle.signal)
      return
    }
    if (event.method === 'session/failed') {
      const failed = this.native
      this.native = undefined
      void failed?.dispose().catch(() => undefined)
      this.completion?.reject(new Error(typeof event.params.message === 'string' ? event.params.message : 'native runtime failed'))
    }
  }

  /** Resolve a native permission request and persist its Harness audit outcome. */
  async respondPermission(requestId: string, outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable', response: unknown = outcome === 'allowed-once' ? { type: 'approved' } : { type: 'rejected' }): Promise<void> {
    await (await this.requireNative()).respond('permission/respond', requestId, response)
    this.pendingApprovals.delete(requestId)
    // Direct callers of this low-level method still receive an audit record;
    // the normal native event path is audited by ctx.approval.request().
    const events = this.session.snapshotEvents()
    if (events.some(event => event.type === 'approval/asked' && String(event.data.id) === requestId)
      && !events.some(event => event.type === 'approval/decided' && String(event.data.id) === requestId)) {
      this.session.append('approval/decided', { id: ApprovalRequestId(requestId), outcome })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) throw new Error(`native agent "${this.id}" is disposed`)
    const afterAbort = wakeup && this.phase.kind === 'running' && this.phase.abort.signal.aborted
    this.inbox.splice(afterAbort ? 'next-turn' : target, Infinity, 0, [message])
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(message: UserMessage): void { this.send(message, 'next-step', false) }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.inbox.clear()
    if (this.phase.kind !== 'running' && this.phase.kind !== 'maintenance') return
    this.phase.abort.abort(cause)
    this.completion?.reject(cause)
    void this.native?.cancel(cause.kind)
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>
    do await (observed = this.activityDone)
    while (observed !== this.activityDone)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const phase: Phase = { kind: 'maintenance', abort: new AbortController(), lastTurn: this.phase.lastTurn }
    this.setPhase(phase)
    this.activityDone = done.promise
    return task(phase.abort.signal).finally(() => {
      this.setPhase({ kind: 'idle', lastTurn: phase.lastTurn })
      done.resolve()
      if (this.inbox.hasPending) this.wake()
    })
  }

  /** Stop the bridge after the factory has prevented further publication. */
  async disposeNative(): Promise<void> {
    this.disposed = true
    // Any bridge that arrived outside a running turn must fail fast instead of
    // executing against a signal nobody will ever abort.
    this.bridgeLifecycle.abort(new Error('native agent disposed'))
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
    await this.native?.dispose()
  }

  private setPhase(phase: Phase): void {
    const previous = this.status
    this.phase = phase
    if (previous !== this.status) this.dispatch.emit('agent/status', { status: this.status })
  }

  private wake(): void {
    if (this.phase.kind !== 'idle') return
    const done = Promise.withResolvers<void>()
    const phase: Extract<Phase, { kind: 'running' }> = { kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn, step: 0 }
    this.setPhase(phase)
    this.activityDone = done.promise
    this.runtimeCtx.agents.withInitiator(this, () => this.drive(phase)).then(done.resolve, done.reject)
  }

  private async drive(initial: Extract<Phase, { kind: 'running' }>): Promise<void> {
    try {
      while (!initial.abort.signal.aborted && this.inbox.hasPending) await this.runTurn(initial)
    } catch (error) {
      if (!initial.abort.signal.aborted) this.dispatch.emit('agent/error', { turn: initial.turn, step: initial.step, error })
    } finally {
      if (this.phase.kind === 'running') this.setPhase({ kind: 'idle', lastTurn: this.phase.turn })
      if (!this.disposed && this.inbox.hasPending) this.wake()
    }
  }

  private async runTurn(phase: Extract<Phase, { kind: 'running' }>): Promise<void> {
    const turn = phase.turn + 1
    const step = 1
    phase.turn = turn
    phase.step = step
    let enteredStep = false
    let reason: { kind: 'completed' } | { kind: 'aborted'; reason: AgentCancelCause } | { kind: 'error'; error: { code: string; message: string } } = { kind: 'completed' }
    this.session.append('turn/start', { turn })
    try {
      const messages = this.inbox.claim('next-turn', turn)
      if (messages.length === 0) return
      this.session.append('step/start', { turn, step })
      enteredStep = true
      for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
      this.assistantStream = new AssistantStreamAccumulator()
      this.deltaText = ''
      this.finalText = ''
      this.reasoningText = ''
      this.reasoningSource = undefined
      this.reasoningSourceLabel = undefined
      this.activeRoute = selectedNativeRoute(this.session)
      this.nativeToolCalls.clear()
      const completion = Promise.withResolvers<string>()
      this.completion = completion
      // Observed from the moment it exists, not from the `await` below. A
      // cancel, or a worker that dies before it answers the prompt, settles this
      // promise while `requireNative()`/`prompt()` are still in flight — and a
      // turn is a whole `await native.prompt(...)` for the in-process Claude
      // runtime, so a user pressing Stop mid-turn lands in that window every
      // time. A rejection on a promise with no handler is an unhandled
      // rejection, which Node treats as fatal, so the observer is attached at
      // creation. It changes nothing the `await` sees: that await still receives
      // the rejection, and the turn is still recorded as aborted.
      void completion.promise.catch(() => undefined)
      const native = await this.requireNative()
      await native.prompt(renderNativePrompt(messages), this.activeRoute === undefined
        ? undefined
        : { modelId: this.activeRoute.model, provider: this.activeRoute.provider, ...(this.activeRoute.reasoningEffort === undefined ? {} : { reasoningEffort: this.activeRoute.reasoningEffort }) })
      const outcome = await completion.promise
      // A cancelled/aborted native turn must surface as an aborted Harness
      // turn, not as a completed one: the previous unconditional success path
      // recorded `turn/end {completed}` for a turn the user interrupted.
      if (outcome !== 'completed') {
        throw new NativeTurnAbortedError()
      }
      this.appendFinal(turn, step)
      if (!phase.abort.signal.aborted) {
        await this.dispatch.serial('agent/turn-stopping', { turn, signal: phase.abort.signal })
      }
    } catch (error) {
      if (phase.abort.signal.aborted || error instanceof NativeTurnAbortedError) {
        reason = { kind: 'aborted', reason: phase.abort.signal.aborted ? phase.abort.signal.reason as AgentCancelCause : { kind: 'user' } }
      } else {
        reason = { kind: 'error', error: { code: 'NATIVE_RUNTIME', message: error instanceof Error ? error.message : String(error) } }
      }
    } finally {
      this.completion = undefined
      this.activeRoute = undefined
      if (enteredStep) this.session.append('step/end', { turn, step })
      this.session.append('turn/end', { turn, reason })
      this.nativeToolCalls.clear()
    }
  }

  private appendFinal(turn: number, step: number): void {
    const text = this.finalText === '' ? this.deltaText : this.finalText
    if (text === '' && this.reasoningText === '') return
    const content: ContentBlock[] = [
      ...(this.reasoningText === '' ? [] : [{
        type: 'reasoning' as const,
        text: this.reasoningText,
        ...(this.reasoningSource === undefined ? {} : { source: this.reasoningSource }),
        ...(this.reasoningSourceLabel === undefined ? {} : { sourceLabel: this.reasoningSourceLabel }),
      }]),
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ]
    this.session.append('assistant/message', {
      turn,
      step,
      message: createAssistantMessage({
        content,
        // `unknown` rather than an engine name: this package serves both native
        // engines, so a literal `codex` labelled a Claude session, and the one
        // path that reaches the fallback — the worker failed mid-turn, so
        // `native` is already gone, and the session recorded no model
        // selection — has no engine left to read either.
        source: {
          provider: this.activeRoute?.provider ?? this.native?.identity.provider ?? this.options.provider ?? 'unknown',
          model: this.activeRoute?.model ?? this.native?.identity.modelId ?? this.options.model ?? 'unknown',
        },
      }),
      stream: [...this.assistantStream.snapshot()],
    }, { surfaceOp: 'append' })
  }

  /** Convert Codex/Claude provider-specific tool frames into Harness events. */
  private projectNativeToolProgress(params: Record<string, unknown>): void {
    if (this.phase.kind !== 'running') return
    const method = typeof params.method === 'string' ? params.method : ''
    const detail = unwrapNativeToolDetail(params.detail ?? params)
    const call = readNativeToolCall(detail)
    const result = readNativeToolResult(detail)
    const completed = /(?:completed|complete|result|finished|failed|error|done)/i.test(method)
      || (typeof detail.type === 'string' && /(?:completed|result|finished|failed|error|done)/i.test(detail.type))
    const hasResultPayload = completed || ['result', 'output', 'content', 'error', 'isError', 'exitCode'].some(key => key in detail)
      || (detail.status === 'failed' || detail.status === 'error' || detail.status === 'completed')
    if (result !== undefined && hasResultPayload) {
      const existing = this.nativeToolCalls.get(result.callId)
      // A result with no call to attach it to is dropped rather than recorded.
      // The Harness session invariant requires a `tool/call` before a
      // `tool/result` in the same step, and the frames that land here without
      // one are exactly the frames this projection cannot attribute: an App
      // Server item that is not tool activity at all (its method still says
      // `completed`, which is why it read as a result), or a result whose call
      // frame never arrived. Recording either would append a result for a call
      // no transcript ever announced.
      if (existing === undefined) {
        if (call === undefined) return
        this.appendNativeToolCall(call)
      }
      this.session.append('tool/result', {
        turn: this.phase.turn,
        step: this.phase.step,
        message: createToolResultMessage({
          callId: callId(result.callId),
          content: result.content,
          isError: result.isError,
        }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }, { surfaceOp: 'append' })
      this.nativeToolCalls.delete(result.callId)
      return
    }
    if (call !== undefined) this.appendNativeToolCall(call)
  }

  private appendNativeToolCall(call: { callId: string; name: string; arguments: string }): void {
    if (this.nativeToolCalls.has(call.callId)) return
    this.nativeToolCalls.set(call.callId, { name: call.name, arguments: call.arguments })
    this.session.append('tool/call', {
      turn: this.phase.kind === 'running' ? this.phase.turn : 0,
      step: this.phase.kind === 'running' ? this.phase.step : 0,
      callId: callId(call.callId),
      name: call.name,
      arguments: call.arguments,
    })
  }

  private async requireNative(): Promise<NativeAgentSession> {
    if (this.native !== undefined) return this.native
    // Disposal aborts the bridge before it waits for the turn to settle, so a
    // caller that arrives during `whenIdle` fails here instead of recovering: a
    // recovery would open a native worker this agent is already tearing down,
    // and the recovery callback's own `disposed` check would discard it again a
    // moment later.
    if (this.disposed) throw new Error(`native agent "${this.id}" is disposed`)
    if (this.recovery === undefined) throw new Error(`native agent "${this.id}" has not opened a runtime session`)
    const opening = this.recoveryOpening ??= this.recovery().then(async (session) => {
      if (this.disposed) {
        await session.dispose().catch(() => undefined)
        throw new Error(`native agent "${this.id}" was disposed during runtime recovery`)
      }
      this.native = session
      return session
    }).finally(() => { this.recoveryOpening = undefined })
    return await opening
  }

  private async handleNativePermission(
    requestId: string,
    request: {
      readonly toolName: string
      readonly method?: string
      readonly detail?: unknown
      readonly reason?: string
    },
    signal: AbortSignal,
  ): Promise<void> {
    // One pending id, one prompt: a worker that repeats the same
    // `permission/requested` frame must not ask the user twice for one call.
    // The latch below still decides which answer is the one delivered.
    if (this.pendingApprovals.has(requestId)) return
    this.pendingApprovals.add(requestId)
    // A native engine's own file and shell tools run inside the engine, so they
    // never pass through the Harness tool registry and the guards installed
    // there cannot see them. This is the one seam where both native transports
    // report a pending call, so it is where the plugin is asked. A refusal
    // short-circuits ahead of the prompt: the model is told why, and the user is
    // not asked to authorize something their configuration already forbids.
    const denial = await this.nativeToolDenial(request)
    if (denial !== undefined) {
      if (!this.pendingApprovals.delete(requestId) || this.disposed) return
      await this.native?.respond('permission/respond', requestId, { type: 'rejected', message: denial }).catch(() => undefined)
      return
    }
    let outcome: ApprovalOutcome = 'unavailable'
    try {
      const approval = this.ctx.get('approval')
      if (approval !== undefined) {
        const reason = nativePermissionReason(request)
        outcome = await approval.request({ agent: this, toolName: request.toolName, ...reason === undefined ? {} : { reason }, signal })
      }
    } catch {
      outcome = 'unavailable'
    }
    if (!this.pendingApprovals.delete(requestId) || this.disposed) return
    await this.native?.respond('permission/respond', requestId, outcome === 'allowed-once' ? { type: 'approved' } : { type: 'rejected' }).catch(() => undefined)
  }

  /**
   * Ask the plugin's native guard about a pending call.
   *
   * The plugin owns the settings, the compiled command policy and the Plan Mode
   * store, so the judgement has to come from there. A guard that throws, or a
   * Host without one, leaves the call to the engine's own approval — a broken
   * guard must not become a broken turn.
   */
  private async nativeToolDenial(request: {
    readonly toolName: string
    readonly method?: string
    readonly detail?: unknown
  }): Promise<string | undefined> {
    const harness = this.ctx.get('freeCodeGoHarness') as {
      nativeToolGuard?: (input: {
        readonly toolName: unknown
        readonly method?: unknown
        readonly detail?: unknown
        readonly agent?: unknown
      }) => Promise<string | undefined>
    } | undefined
    if (harness?.nativeToolGuard === undefined) return undefined
    try {
      return await harness.nativeToolGuard({
        toolName: request.toolName,
        ...(request.method === undefined ? {} : { method: request.method }),
        detail: request.detail,
        agent: this,
      })
    } catch {
      return undefined
    }
  }

  private async handleNativeQuestion(requestId: string, questions: readonly AskUserQuestionItem[], signal: AbortSignal): Promise<void> {
    try {
      const userQuestions = this.ctx.get('userQuestions')
      if (userQuestions === undefined) throw new Error('user-questions service is not configured')
      const answer = await userQuestions.ask({ agent: this, questions: [...questions], signal })
      if (!this.disposed) await this.native?.respond('question/respond', requestId, answer).catch(() => undefined)
    } catch {
      await this.native?.respond('question/respond', requestId, { answers: [] }).catch(() => undefined)
    }
  }

  /** Resolve one worker host-bridge request through the FreeCodeGo inventory.
   * Errors are returned to the worker as a failed tool call; they must never
   * reject the surrounding turn. */
  private async handleBridgeRequest(requestId: string, params: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    // A response the Host refuses still has to end as a visible tool error.
    // The refusal that matters here is the credential screen: a tool result
    // carrying secret-shaped fields is dropped before it reaches the worker, and
    // swallowing that drop leaves the worker waiting for an answer that never
    // comes — the tool call stalls, the turn dies on the watchdog, and nothing
    // says why. The replacement below names no values, so it passes the same
    // screen; if it cannot be delivered either, the worker is already gone and
    // there is nobody left to tell.
    const respond = (payload: unknown): void => {
      if (this.disposed) return
      void this.native?.respond('bridge/respond', requestId, payload).catch(() => {
        void this.native?.respond('bridge/respond', requestId, {
          error: 'the tool result was withheld: it contained credential-shaped fields',
        }).catch(() => undefined)
      })
    }
    try {
      const bridge = typeof params.bridge === 'string' ? params.bridge : ''
      const op = typeof params.op === 'string' ? params.op : ''
      const harness = this.ctx.get('freeCodeGoHarness') as { claudeBridgeHandle?: (request: {
        readonly bridge: string
        readonly op: string
        readonly input: unknown
        readonly sessionId: string
        readonly workspaceRoot?: string
        readonly signal: AbortSignal
        readonly inlineImages?: boolean
      }) => Promise<unknown> } | undefined
      if (harness?.claudeBridgeHandle === undefined || bridge === '') throw new Error(`no host backend is available for the "${bridge || op}" capability in this environment`)
      const result = await harness.claudeBridgeHandle({
        bridge,
        op,
        input: params.input,
        sessionId: this.id,
        // Only a transport that says so gets image bytes; the worker protocols
        // cannot carry them and must keep the attachment reference.
        inlineImages: params.inlineImages === true,
        ...(typeof params.workspaceRoot === 'string' ? { workspaceRoot: params.workspaceRoot } : {}),
        signal,
      })
      respond({ result })
    } catch (error) {
      // Masked here, at the producer, because this is the only place that holds
      // the tool's own error text: the transport screens a `bridge/respond`
      // payload by *key* name, so a credential sitting inside a message value
      // passes it untouched, and both engine workers can only clean up what they
      // receive. A tool that names a credential in its failure is the ordinary
      // case — a request that 401s quotes its own header.
      respond({ error: redactCredentialShapes(error instanceof Error ? error.message : String(error)) })
    }
  }
}

/** Internal marker: the native runtime reported an aborted/cancelled turn. */
class NativeTurnAbortedError extends Error {
  constructor() { super('native turn was cancelled') }
  override get name(): string { return 'NativeTurnAbortedError' }
}

function renderNativePrompt(messages: readonly UserMessage[]): string {
  // Each claimed inbox message keeps its own paragraph block so message
  // boundaries survive into the native prompt; attachment-only blocks render
  // as a typed placeholder instead of a serialized object blob.
  return messages.map(message => message.content.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return `[image attachment: ${block.attachment.attachmentId}]`
    if (block.type === 'file') return `[file attachment: ${block.attachment.attachmentId}]`
    return `[${block.type}]`
  }).filter(part => part !== '').join('\n\n')).filter(block => block !== '').join('\n\n')
}

/** Read the durable next-request route selected through Harness' model picker. */
function selectedNativeRoute(session: Session): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined {
  // `model/selection` is declared by the optional session-controller package,
  // so root-agent treats it as a validated extension event at this boundary.
  const event = (session.snapshotEvents() as readonly unknown[]).findLast((candidate) => {
    const value = candidate !== null && typeof candidate === 'object' ? candidate as { readonly type?: unknown } : undefined
    return value?.type === 'model/selection'
  }) as { readonly data?: unknown } | undefined
  const selection = event?.data
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return undefined
  const value = selection as { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '' || provider.length > 256 || model.length > 512 || /[\r\n]/.test(provider) || /[\r\n]/.test(model)) return undefined
  // Trimmed and bounded like its siblings rather than only trimmed for the
  // emptiness test: the level is forwarded to the engine verbatim and both
  // workers drop one they do not recognise, so a padded or newline-bearing
  // value would silently leave the user's choice unapplied.
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  const reasoningEffort = effort === '' || effort.length > MAX_REASONING_EFFORT_CHARS || /[\r\n]/.test(effort)
    ? undefined
    : effort
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function reasoningOrigin(params: Record<string, unknown>): { readonly source?: ReasoningSource; readonly sourceLabel?: string } {
  const source = params.source === 'claude-agent-sdk' || params.source === 'codex-app-server' || params.source === 'adapter'
    ? params.source
    : undefined
  const sourceLabel = typeof params.sourceLabel === 'string' && params.sourceLabel.trim() !== ''
    ? params.sourceLabel.slice(0, 120)
    : undefined
  return {
    ...(source === undefined ? {} : { source }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
  }
}

function normalizeQuestions(value: unknown): readonly AskUserQuestionItem[] | undefined {
  const candidate = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { questions?: unknown }).questions
    : value
  if (!Array.isArray(candidate) || candidate.length === 0) return undefined
  const questions: AskUserQuestionItem[] = []
  for (const item of candidate) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.question !== 'string') return undefined
    questions.push({
      id: record.id,
      question: record.question,
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      ...(typeof record.multiSelect === 'boolean' ? { multiSelect: record.multiSelect } : {}),
      ...(Array.isArray(record.options) ? { options: record.options.filter((option): option is { label: string; description?: string; preview?: string } => typeof option === 'object' && option !== null && typeof (option as { label?: unknown }).label === 'string').map(option => ({ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}), ...(typeof (option as { preview?: unknown }).preview === 'string' ? { preview: (option as { preview: string }).preview } : {}) })) } : {}),
    })
  }
  return questions
}

/**
 * One line naming what a pending native call will do.
 *
 * The engines ask with a tool name and, at best, their own terse reason, and the
 * approval panel shows `reason` as its headline — falling back to a generic
 * "… is requesting permission" when it is absent. Naming the command or the path
 * is what makes the prompt answerable, and it is the only place a user can see a
 * native engine's arguments before they run. The credential guard has already
 * run by the time this text is built, so a command that would print or read
 * secret material never reaches the prompt.
 */
function nativePermissionReason(request: {
  readonly toolName: string
  readonly detail?: unknown
  readonly reason?: string
}): string | undefined {
  const detail = unwrapNativeToolDetail(request.detail)
  // The two transports lay their arguments out differently: the Claude SDK
  // nests them under `input`, while the Codex App Server puts a method's params
  // at the top level. Read both, arguments first.
  const nested = detail.input
  const args = typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : detail
  const pick = (keys: readonly string[]): string | undefined => firstString(args, keys) ?? (args === detail ? undefined : firstString(detail, keys))
  const parts: string[] = []
  const command = summaryArguments(args.command) ?? summaryArguments(detail.command)
  if (command !== undefined) parts.push(command)
  const path = pick(['path', 'file_path', 'notebook_path', 'grantRoot'])
  if (path !== undefined) parts.push(path)
  const changes = countKeys(detail.fileChanges)
  if (changes > 0) parts.push(`${String(changes)} file change(s)`)
  const remote = pick(['url', 'pattern', 'query'])
  if (remote !== undefined) parts.push(remote)
  // A permission escalation is granted as a profile, so the prompt has to name
  // what is being granted: approving one blind would hand over an access set the
  // user never saw.
  const profile = permissionProfileSummary(detail.permissions)
  if (profile !== undefined) parts.push(profile)
  const own = typeof request.reason === 'string' && request.reason.trim() !== '' ? request.reason.trim() : undefined
  if (own !== undefined && !parts.includes(own)) parts.push(own)
  if (parts.length === 0) return undefined
  const text = `${request.toolName}: ${parts.join(' — ')}`
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

/**
 * One line naming the access a permission-escalation request is asking for.
 *
 * The granted profile is echoed back to the engine unchanged, so this text is
 * the user's only account of it. Unreadable parts are counted rather than
 * dropped, so a prompt can never read as an empty request while a real grant is
 * being handed over.
 */
function permissionProfileSummary(profile: unknown): string | undefined {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  const record = profile as Record<string, unknown>
  const parts: string[] = []
  const fileSystem = typeof record.fileSystem === 'object' && record.fileSystem !== null ? record.fileSystem as Record<string, unknown> : undefined
  if (fileSystem !== undefined) {
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : []
    for (const entry of entries.slice(0, 3)) {
      const item = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
      const access = typeof item.access === 'string' ? item.access : 'access'
      const where = permissionPathLabel(item.path)
      if (where !== undefined) parts.push(`${access} ${where}`)
    }
    if (entries.length > 3) parts.push(`+${String(entries.length - 3)} more path(s)`)
    for (const legacy of ['write', 'read'] as const) {
      const list = Array.isArray(fileSystem[legacy]) ? fileSystem[legacy] : []
      if (list.length > 0) parts.push(`${legacy} ${list.filter((value): value is string => typeof value === 'string').join(', ')}`)
    }
  }
  const network = typeof record.network === 'object' && record.network !== null ? record.network as Record<string, unknown> : undefined
  if (network !== undefined) parts.push(network.enabled === false ? 'network denied' : 'network access')
  if (parts.length === 0 && (fileSystem !== undefined || network !== undefined)) parts.push('additional access (unreadable profile)')
  return parts.length === 0 ? undefined : `granting ${parts.join('; ')}`
}

/** Render one sandbox path selector as the path it names. */
function permissionPathLabel(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.path === 'string') return record.path
  if (typeof record.pattern === 'string') return record.pattern
  const special = typeof record.value === 'object' && record.value !== null ? record.value as Record<string, unknown> : undefined
  if (special !== undefined && typeof special.kind === 'string') return `<${special.kind}>`
  return undefined
}

/** Render one argument value as one line: a string as-is, a string array joined, anything else omitted. */
function summaryArguments(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (!Array.isArray(value)) return undefined
  const parts = value.filter((part): part is string => typeof part === 'string' && part !== '')
  return parts.length === 0 ? undefined : parts.join(' ')
}

function countKeys(value: unknown): number {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value).length : 0
}

function unwrapNativeToolDetail(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const nested = record.item ?? record.tool ?? record.event
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : record
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string' && record[key] !== '') return record[key]
  return undefined
}

function nativeToolName(record: Record<string, unknown>): string | undefined {
  const explicit = firstString(record, ['name', 'toolName', 'tool_name', 'tool'])
  if (explicit !== undefined) return explicit
  const type = firstString(record, ['type', 'kind'])?.toLowerCase()
  if (type === undefined) return undefined
  if (type.includes('command') || type.includes('shell') || type.includes('bash')) return 'bash'
  if (type.includes('filechange') || type.includes('file_change') || type.includes('edit')) return 'edit'
  if (type.includes('read')) return 'read'
  if (type.includes('search') || type.includes('grep')) return 'grep'
  if (type.includes('mcp')) return 'mcp'
  // A frame whose own type names a RESULT is not a call: the generic `tool`
  // fallback below would name it `tool_result` and the projection would record
  // a phantom tool call with `{}` arguments for a result frame.
  if (type.includes('result')) return undefined
  return type.includes('tool') ? type : undefined
}

function stringifyNativeArguments(record: Record<string, unknown>): string {
  const value = record.arguments ?? record.args ?? record.input ?? record.parameters
    ?? record.command ?? record.prompt ?? record.path ?? record.changes ?? {}
  if (typeof value === 'string') return record.command !== undefined ? JSON.stringify({ command: value }) : JSON.stringify({ input: value })
  try { return JSON.stringify(value) }
  catch { return '{}' }
}

function nativeCallId(record: Record<string, unknown>): string | undefined {
  return firstString(record, ['callId', 'toolCallId', 'tool_call_id', 'id', 'requestId'])
}

function readNativeToolCall(record: Record<string, unknown>): { callId: string; name: string; arguments: string } | undefined {
  const callId = nativeCallId(record)
  const name = nativeToolName(record)
  if (callId === undefined || name === undefined) return undefined
  return { callId, name, arguments: stringifyNativeArguments(record) }
}

function nativeContent(value: unknown): ContentBlock[] {
  if (Array.isArray(value)) {
    const blocks: ContentBlock[] = []
    for (const item of value) {
      if (typeof item === 'object' && item !== null && typeof (item as { type?: unknown }).type === 'string') blocks.push(item as ContentBlock)
      else if (typeof item === 'string') blocks.push({ type: 'text', text: item })
    }
    if (blocks.length > 0) return blocks
  }
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (value !== undefined) {
    try { return [{ type: 'text', text: JSON.stringify(value) }] }
    catch { return [{ type: 'text', text: String(value) }] }
  }
  return []
}

function readNativeToolResult(record: Record<string, unknown>): { callId: string; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string } } | undefined {
  const callId = nativeCallId(record)
  if (callId === undefined) return undefined
  const rawError = record.error
  const isError = record.isError === true || rawError !== undefined || record.status === 'failed' || record.status === 'error'
    || (typeof record.exitCode === 'number' && record.exitCode !== 0)
  const content = nativeContent(record.content ?? record.output ?? record.aggregatedOutput ?? record.result ?? record.text ?? record.message)
  const error = rawError === undefined ? undefined : {
    name: typeof rawError === 'object' && rawError !== null && typeof (rawError as { name?: unknown }).name === 'string' ? (rawError as { name: string }).name : 'NativeToolError',
    code: typeof rawError === 'object' && rawError !== null && typeof (rawError as { code?: unknown }).code === 'string' ? (rawError as { code: string }).code : 'native_tool_error',
  }
  return { callId, content, isError, ...(error === undefined ? {} : { error }) }
}
