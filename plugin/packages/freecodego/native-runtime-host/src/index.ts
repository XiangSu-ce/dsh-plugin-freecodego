/** Isolated process supervisor for FreeCodeGo native workers. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { NativeRuntimeJsonlDecoder, encodeNativeRuntimeMessage, redactCredentialShapes, withNativeRuntimeAbort, withNativeRuntimeTimeout } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import type { NativeRuntimeEvent, NativeRuntimeMessage, NativeRuntimeMethod, NativeRuntimeRequest } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'

export interface NativeRuntimeHostOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Only these environment entries are passed to the worker. */
  readonly env?: Readonly<Record<string, string>>
  readonly maxFrameBytes?: number
  readonly maxStderrBytes?: number
  readonly requestTimeoutMs?: number
  readonly killGraceMs?: number
  readonly onEvent?: (event: NativeRuntimeEvent) => void
  /**
   * Called once when the worker becomes unusable, before any later request is
   * refused.
   *
   * A worker that dies mid-turn leaves nothing else to notice it:
   * `session/prompt` answers as soon as the turn starts, so there is no
   * in-flight request left to reject, and the turn itself is only ever settled
   * by an event. Without this the Harness waits on a completion that can never
   * arrive, and the agent stays `running` forever.
   *
   * A `dispose()` the caller asked for is a decision rather than a failure, so
   * it does not report one.
   */
  readonly onFailure?: (error: Error) => void
}

export interface NativeRuntimeRequestOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface Pending {
  readonly method: NativeRuntimeMethod
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

const METHODS = new Set<NativeRuntimeMethod>([
  'initialize', 'account/status', 'account/login/start', 'account/login/complete', 'account/logout',
  'catalog/list', 'session/create', 'session/resume', 'session/prompt', 'session/cancel',
  'session/dispose', 'permission/respond', 'question/respond', 'models/refresh', 'host/configure', 'bridge/respond', 'turn/start', 'turn/cancel',
])
// Match credential-bearing fields without rejecting Codex telemetry such as
// `tokenUsage` and `cachedInputTokens`.
const SECRET_KEY = /(?:^token$|access[-_]?token|refresh[-_]?token|secret|password|api[-_]?key|authorization|cookie|private[-_]?key)/i
/**
 * Model-content event channels relayed verbatim from the native worker. Tool
 * arguments echo model output (e.g. MCP args like `user_password_reset`) and
 * must never be key-name screened: a false positive here rejects every pending
 * request and kills the session.
 */
const PAYLOAD_PASSTHROUGH = new Set([
  'tool/progress',
  'bridge/requested',
  // The two events the worker is *waiting* on. A screen false positive here does
  // not just lose a log line: the approval or question never reaches the user, so
  // the worker sits on an answer nobody was asked to give until its own watchdog
  // fails the turn — and the detail is tool input echoing model output, exactly
  // the payload the comment above already refuses to key-name screen. Forwarding
  // them is also the only honest option for an approval: the user has to see the
  // input they are approving, unredacted, or the gate is not a gate.
  'permission/requested',
  'question/requested',
  'assistant/delta',
  'assistant/reasoning/delta',
  'assistant/reasoning/final',
  'assistant/final',
  'session/completed',
  'session/failed',
  'session/started',
])
/** Events dropped by the payload policy before the host terminates the worker. */
const MAX_DROPPED_SECRET_EVENTS = 5
/**
 * Methods whose worker-side completion lasts as long as a whole agent turn.
 * They are bounded by the caller's `session/cancel` (user stop) and worker
 * watchdogs, never by the short default request timeout: a mid-turn timeout
 * terminates the worker and loses the entire native session.
 */
const LONG_RUNNING_METHODS = new Set<NativeRuntimeMethod>(['session/prompt'])

/** Owns exactly one worker process and rejects unsafe or ambiguous protocol traffic. */
export class NativeRuntimeHost {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, Pending>()
  private decoder: NativeRuntimeJsonlDecoder
  private stderrBytes = 0
  private disposed = false
  private failure: Error | undefined
  /** Set with `failure`, so a dying worker reports itself once and not per symptom. */
  private failureNotified = false
  private sequence = -1
  private droppedSecretEvents = 0
  /** Set before the first kill attempt; cleared in start() and once dispose finishes. */
  private killRequested = false
  private readonly options: Required<Pick<NativeRuntimeHostOptions, 'maxStderrBytes' | 'requestTimeoutMs' | 'killGraceMs'>>

  constructor(private readonly config: NativeRuntimeHostOptions) {
    if (config.command.length === 0 || config.command.includes('\0')) throw new Error('native runtime command is invalid')
    this.decoder = new NativeRuntimeJsonlDecoder(config.maxFrameBytes ?? 1024 * 1024)
    this.options = {
      maxStderrBytes: config.maxStderrBytes ?? 256 * 1024,
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      killGraceMs: config.killGraceMs ?? 1_000,
    }
  }

  /** Start the worker once. The environment is an explicit allowlist. */
  start(): void {
    if (this.disposed) throw new Error('native runtime host is disposed')
    if (this.child !== undefined) return
    this.decoder = new NativeRuntimeJsonlDecoder(this.config.maxFrameBytes ?? 1024 * 1024)
    this.sequence = -1
    this.droppedSecretEvents = 0
    this.killRequested = false
    this.stderrBytes = 0
    const child = spawn(this.config.command, [...(this.config.args ?? [])], {
      cwd: this.config.cwd,
      env: this.config.env === undefined ? {} : { ...this.config.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.onStdout(chunk) })
    child.stderr.on('data', (chunk: string) => { this.onStderr(chunk) })
    child.on('error', (error) => { this.fail(new Error(`native runtime process error: ${redactRuntimeDetail(error.message)}`)) })
    // Without this listener, an in-flight stdin write racing a dead worker
    // emits an unhandled 'error' event (EPIPE/EOF) that terminates the Host.
    child.stdin.on('error', (error) => { this.fail(new Error(`native runtime stdin error: ${redactRuntimeDetail(error.message)}`)) })
    child.on('close', (code, signal) => {
      if (this.child === child) this.child = undefined
      this.fail(new Error(`native runtime exited (${code ?? 'null'}${signal === null ? '' : `, ${signal}`})`))
    })
  }

  request<T = unknown>(method: NativeRuntimeMethod, params: unknown, options: NativeRuntimeRequestOptions = {}): Promise<T> {
    if (!METHODS.has(method)) return Promise.reject(new Error(`unsupported native runtime method "${method}"`))
    if (this.disposed) return Promise.reject(new Error('native runtime host is disposed'))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (options.signal?.aborted) return Promise.reject(asError(options.signal.reason ?? new Error('native runtime turn interrupted')))
    try {
      // Two methods carry a payload whose *keys* are names rather than values,
      // and a key-name screen cannot tell a name from a credential.
      //
      // `bridge/respond` relays a tool RESULT back to the worker. Tool output
      // routinely echoes model-generated field names (`api_key` in a config
      // example); screening it by key name rejects the response, the bridge
      // promise is silently dropped, and the tool call hangs forever.
      //
      // `host/configure` relays the Host's tool *inventory*: `harnessTools` is
      // `ctx.tools.schemas(agent)`, so the payload carries every tool's JSON
      // schema, and `properties.password` is the name of a parameter. One
      // configured MCP server whose tool declares `password`, `token`, `cookie`,
      // or any key the substring rules catch (`secret`) refused the whole
      // request — and because `prepare` sends this before `session/create`, the
      // native session then could not open at all. Those names are the
      // model-facing contract of a tool the user chose to configure, and a
      // schema carries no credential, so refusing them protects nothing.
      //
      // The credential-shaped value screen still applies to both, so a secret
      // pasted into one of those payloads is still refused.
      if (method === 'bridge/respond' || method === 'host/configure') {
        const offending = findSecretLike(params)
        if (offending !== undefined) throw new Error(`native runtime message contains a credential-shaped field at ${offending}`)
      } else {
        assertNoSecrets(params)
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    this.start()
    const id = randomUUID()
    const request: NativeRuntimeRequest = { id, method, params }
    const child = this.child
    if (child === undefined || child.stdin.destroyed) return Promise.reject(new Error('native runtime stdin is unavailable'))
    const operation = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      child.stdin.write(encodeNativeRuntimeMessage(request), (error) => {
        if (error !== undefined && error !== null) this.rejectPending(id, new Error(`native runtime write failed: ${error.message}`))
      })
    })
    const timeoutMs = options.timeoutMs ?? (LONG_RUNNING_METHODS.has(method) ? Number.POSITIVE_INFINITY : this.options.requestTimeoutMs)
    const guarded = Number.isFinite(timeoutMs)
      ? withNativeRuntimeTimeout(operation, timeoutMs, `native runtime request "${method}" timed out`, () => { this.terminate(new Error(`native runtime request "${method}" timed out`)) })
      : operation
    return withNativeRuntimeAbort(guarded, options.signal ?? new AbortController().signal)
      .catch((error: unknown) => {
        this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
        if (options.signal?.aborted) this.terminate(error instanceof Error ? error : new Error(String(error)))
        throw error
      })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (child === undefined) {
      this.killRequested = false
      return
    }
    this.fail(new Error('native runtime disposed'))
    this.killTree(child, false)
    await new Promise<void>((resolve) => {
      // The escalation runs unconditionally: killRequested only marks that the
      // graceful attempt happened, it must not cancel the force step.
      const timer = setTimeout(() => { this.escalateKill(child) }, this.options.killGraceMs)
      // A worker whose stdio pipes are held open by an orphaned grandchild may
      // never emit 'close' even after two force kills; dispose must stay bounded
      // instead of hanging the teardown chain forever.
      const cap = setTimeout(resolve, this.options.killGraceMs + 5_000)
      child.once('close', () => { clearTimeout(timer); clearTimeout(cap); resolve() })
    })
    // On Windows, taskkill /f is asynchronous: the pid can outlive the
    // taskkill process, so wait for the worker's close event (bounded).
    if (!child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        child.once('close', () => { clearTimeout(timer); resolve() })
      })
    }
    this.killRequested = false
    this.child = undefined
  }

  private onStdout(chunk: string): void {
    let messages: NativeRuntimeMessage[]
    try { messages = this.decoder.push(chunk) } catch (error) { this.failAndKill(asError(error)); return }
    for (const message of messages) {
      try { this.dispatch(message) } catch (error) { this.failAndKill(asError(error)); return }
    }
  }

  private dispatch(message: NativeRuntimeMessage): void {
    assertNoSecrets(message.result)
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) throw new Error(`native runtime returned unknown request id "${message.id}"`)
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(redactRuntimeDetail(`${message.error.code}: ${message.error.message}`)))
      else pending.resolve(message.result)
      return
    }
    if (message.method === undefined || message.params === undefined || typeof message.params !== 'object' || message.params === null) throw new Error('native runtime event is missing method or params')
    const params = message.params as Record<string, unknown>
    const sequence = params.sequence
    if (typeof params.runtimeSessionId !== 'string' || typeof params.harnessSessionId !== 'string' || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('native runtime event has invalid correlation fields')
    if (sequence <= this.sequence) throw new Error(`native runtime event sequence ${sequence} is not monotonic`)
    this.sequence = sequence
    if (!PAYLOAD_PASSTHROUGH.has(message.method)) {
      const offending = findSecretLike(params)
      if (offending !== undefined) {
        this.droppedSecretEvents += 1
        if (this.droppedSecretEvents > MAX_DROPPED_SECRET_EVENTS) this.terminate(new Error('native runtime emitted secret-like fields'))
        return
      }
    }
    this.config.onEvent?.({ method: message.method, params: params as NativeRuntimeEvent['params'] })
  }

  private onStderr(chunk: string): void {
    this.stderrBytes += Buffer.byteLength(chunk)
    if (this.stderrBytes > this.options.maxStderrBytes) this.failAndKill(new Error('native runtime stderr exceeded the configured byte limit'))
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const [id, pending] of this.pending) { this.pending.delete(id); pending.reject(error) }
    // Rejecting the pending requests is not enough on its own: a worker that
    // dies between `turn/start` and the turn's terminal event leaves none, and
    // the caller is waiting on an event that will never come. `dispose()` marks
    // the host disposed before failing it, so a teardown reports nothing.
    if (this.disposed || this.failureNotified) return
    this.failureNotified = true
    this.config.onFailure?.(error)
  }

  /** Fail every pending request and kill the misbehaving worker; used for protocol violations. */
  private failAndKill(error: Error): void {
    this.fail(error)
    const child = this.child
    if (child === undefined || this.killRequested) return
    this.killTree(child, false)
    // The escalation must not consult killRequested: it is the second step of
    // the sequence begun above, not a new kill attempt.
    //
    // It is aimed by the child's *own* termination state, not by `this.child`
    // identity and not by `child.killed`. Identity was the previous guard and it
    // answers the wrong question: `this.child` is cleared on 'close', and 'close'
    // waits for the stdio pipes to drain — the worker whose pipes an orphaned
    // grandchild holds open is exactly the one whose 'close' never arrives. So the
    // guard can still read "this is still our child" for a process that died long
    // ago, and on Windows that means `taskkill /f` aimed at a pid the system may
    // have recycled. `exitCode`/`signalCode` are set on 'exit', which does not wait
    // for the pipes. `killed` is a third and worse option: it only records that a
    // signal was *sent*, so it is true for a worker that ignored the graceful
    // attempt — the one case this escalation exists for.
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) this.escalateKill(child)
    }, this.options.killGraceMs)
    // A teardown with nothing left to wait for must not be held open by this
    // fallback: it is best-effort, and the one thing it can do for a living child
    // is a kill that the graceful attempt above has already started.
    timer.unref()
    child.once('exit', () => { clearTimeout(timer) })
  }

  /** Stop admission immediately, then escalate if the worker ignores SIGTERM. */
  private terminate(error: Error): void {
    this.failAndKill(error)
  }

  private killTree(child: ChildProcessWithoutNullStreams, force: boolean): void {
    this.killRequested = true
    if (process.platform === 'win32' && child.pid !== undefined) {
      // taskkill without /f posts WM_CLOSE and never terminates workers without
      // windows, so the graceful attempt must still include /f.
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => undefined)
      return
    }
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
  }

  /** Force-kill escalation after the graceful attempt; bypasses killRequested. */
  private escalateKill(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => undefined)
      return
    }
    child.kill('SIGKILL')
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    pending.reject(error)
  }
}

function assertNoSecrets(value: unknown, path = '$'): void {
  if (value === null || value === undefined || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach((item, index) => { assertNoSecrets(item, `${path}[${index}]`) }); return }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`native runtime message contains a secret-like field at ${path}.${key}`)
    assertNoSecrets(child, `${path}.${key}`)
  }
}

/** Coerce an unknown thrown value into an Error without the lint-noisy ternary. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Credential-shaped value: long, whitespace-free, and credential-charset. */
function looksLikeSecretValue(value: unknown): boolean {
  return typeof value === 'string' && value.length >= 16 && !/\s/.test(value) && /^[A-Za-z0-9_\-.~+/=]{16,}$/.test(value)
}

/**
 * Lighter payload screen for non-passthrough events: a SECRET_KEY match only
 * trips when the value is credential-shaped. Returns the offending key, or
 * undefined when the event is acceptable.
 */
function findSecretLike(value: unknown, path = '$'): string | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretLike(item, `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && looksLikeSecretValue(child)) return `${path}.${key}`
    const found = findSecretLike(child, `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

/** Remove credentials from worker-originated diagnostic text before it crosses
 * the Host boundary. The rules themselves live in the protocol package, so this
 * boundary, both engine workers and the bridge producer cannot drift apart. */
function redactRuntimeDetail(value: string): string {
  return redactCredentialShapes(value)
}

export default NativeRuntimeHost
export * from './manifest.ts'
export * from './codex-runtime-manager.ts'
export * from './claude-runtime-manager.ts'
