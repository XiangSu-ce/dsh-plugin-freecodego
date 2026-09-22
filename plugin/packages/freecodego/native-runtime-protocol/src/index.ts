/**
 * Newline-delimited JSON protocol for isolated Node native-agent workers, plus
 * the credential masker every side of that boundary shares.
 * Timeout helpers are derived from the MIT-licensed FreeCodeGo Claude runtime.
 *
 * @module @deepseek-ai/dsh-freecodego-native-runtime-protocol
 */

export * from './redact.ts'
export * from './deadline.ts'

/** A request sent from the Harness host to one native worker. */
export interface NativeRuntimeRequest {
  readonly id: string
  readonly method: NativeRuntimeMethod
  readonly params: unknown
}

/** Methods implemented by a managed native runtime worker. */
export type NativeRuntimeMethod =
  | 'initialize'
  | 'account/status'
  | 'account/login/start'
  | 'account/login/complete'
  | 'account/logout'
  | 'catalog/list'
  | 'session/create'
  | 'session/resume'
  | 'session/prompt'
  | 'session/cancel'
  | 'session/dispose'
  | 'permission/respond'
  | 'question/respond'
  | 'models/refresh'
  | 'host/configure'
  | 'bridge/respond'
  // Kept as aliases for early workers shipped before the stable names.
  | 'turn/start'
  | 'turn/cancel'

/** A worker response or unsolicited event. */
export interface NativeRuntimeMessage {
  readonly id?: string
  readonly method?: string
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly params?: unknown
}

/** A correlated runtime event emitted without a request id. */
export interface NativeRuntimeEvent {
  readonly method: string
  readonly params: {
    readonly runtimeSessionId: string
    readonly harnessSessionId: string
    readonly sequence: number
    readonly [key: string]: unknown
  }
}

/** Result required from initialize before a Host admits a native session. */
export interface NativeRuntimeInitializeResult {
  readonly protocolAbi: string
  readonly engines: readonly ('codex' | 'claude')[]
  readonly runtimeVersion: string
}

/**
 * The Harness file-effect policy vocabulary, restated at this boundary.
 *
 * Why it is restated instead of imported: this package is the contract two
 * separately built runtime artifacts implement, and they must agree on the
 * policy without importing the Harness sandbox package. The three names are the
 * Harness's own (`@deepseek-ai/dsh-sandbox`'s `SandboxMode`), and the Codex App
 * Server's `SandboxMode` enum is spelled identically, so the protocol carries
 * the Harness spelling verbatim — there is no translation table to drift.
 */
export type NativeSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Every {@link NativeSandboxMode}, for validating a value that arrived as JSON. Narrowest first. */
export const NATIVE_SANDBOX_MODES: readonly NativeSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Narrow one wire value to a sandbox mode. An unrecognized value is dropped, never guessed. 
 * @param value - a value decoded from the wire, of unknown shape.
 * @returns true when `value` is one of {@link NATIVE_SANDBOX_MODES}.
 */
export function isNativeSandboxMode(value: unknown): value is NativeSandboxMode {
  return typeof value === 'string' && (NATIVE_SANDBOX_MODES as readonly string[]).includes(value)
}

/** The two `session/create`/`session/resume` fields that carry the file policy. */
export interface NativeSessionSandboxFields {
  /** The caller's floor: a council child declares it and cannot be widened. */
  readonly readOnly?: unknown
  /** The Harness session's resolved mode, as it reads back from the sandbox policy. */
  readonly sandboxMode?: unknown
}

/**
 * The policy one native session must run under, from the two fields that carry
 * it. Both runtimes call this, so the two engines cannot disagree about which
 * mode applies.
 *
 * `readOnly` can only tighten. A council child declares the floor *and* logs the
 * Harness mode on its own session, so the two can disagree in exactly one
 * direction (a floor below a wider logged mode); a disagreement must resolve
 * toward the restriction the caller asked for, never toward wider access.
 *
 * `undefined` means no policy crossed this boundary. The caller then leaves the
 * engine's own default in place rather than inventing one — a value this
 * protocol cannot read must not become a restriction the user never chose.
 * @param fields - the `readOnly` floor and logged `sandboxMode` of one session.
 * @returns the policy to apply, or `undefined` when no policy crossed this boundary.
 */
export function effectiveSandboxMode(fields: NativeSessionSandboxFields): NativeSandboxMode | undefined {
  if (fields.readOnly === true) return 'read-only'
  return isNativeSandboxMode(fields.sandboxMode) ? fields.sandboxMode : undefined
}

/** Serialize one protocol message as exactly one JSONL frame. 
 * @param message - the protocol message or request to frame.
 * @returns one newline-terminated JSONL frame.
 */
export function encodeNativeRuntimeMessage(message: NativeRuntimeMessage | NativeRuntimeRequest): string {
  return `${JSON.stringify(message)}\n`
}

/** Reused byte counter so frame validation does not allocate on every push. */
const frameEncoder = new TextEncoder()

/** Incrementally parse JSONL worker output without accepting oversized frames. */
export class NativeRuntimeJsonlDecoder {
  private buffer = ''
  private pendingBytes = 0

  constructor(private readonly maxFrameBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error('maxFrameBytes must be a positive safe integer')
  }

  /**
   * Append streamed worker output and return all complete frames.
   * @param chunk - UTF-8 text decoded by the child-process transport.
   * @returns validated JSON object frames in arrival order.
   */
  push(chunk: string): NativeRuntimeMessage[] {
    this.buffer += chunk
    this.pendingBytes += frameEncoder.encode(chunk).byteLength
    const frames: NativeRuntimeMessage[] = []
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const raw = this.buffer.slice(0, newline)
      const line = raw.trim()
      this.buffer = this.buffer.slice(newline + 1)
      // Account for the consumed line (plus its newline) so pendingBytes
      // tracks only the still-unterminated tail.
      this.pendingBytes -= frameEncoder.encode(raw).byteLength + 1
      if (line === '') continue
      if (frameEncoder.encode(line).byteLength > this.maxFrameBytes) {
        this.buffer = ''
        this.pendingBytes = 0
        throw new Error('native runtime JSONL frame exceeds the configured byte limit')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('native runtime emitted invalid JSONL')
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('native runtime JSONL message must be an object')
      }
      frames.push(parsed)
    }
    // Only the unterminated tail remains here: a burst of complete valid
    // frames is always extracted first and never discarded wholesale.
    if (this.pendingBytes > this.maxFrameBytes) {
      this.buffer = ''
      this.pendingBytes = 0
      throw new Error('native runtime JSONL frame exceeds the configured byte limit')
    }
    return frames
  }
}

/**
 * Await a runtime operation or fail after its bounded deadline.
 *
 * A `timeoutMs` that is not a positive finite number is refused rather than
 * clamped. `setTimeout` turns a negative delay into an immediate timer and an
 * infinite one into a `TimeoutOverflowWarning` plus a 1 ms timer, so both used to
 * arrive at the caller as an unexplained instant failure; a caller that wants no
 * deadline has to say so by not using this function.
 * @param operation - the runtime call being bounded.
 * @param timeoutMs - the deadline in milliseconds.
 * @param message - the rejection message for a timed-out call.
 * @param onTimeout - optional cleanup run once the deadline passes.
 * @returns the operation's value, or a rejection naming the deadline.
 */
export function withNativeRuntimeTimeout<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void | Promise<void>,
): Promise<Value> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`native runtime timeout must be a positive finite number, got ${String(timeoutMs)}`))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Value>((_resolve, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout?.()).catch(() => undefined)
      reject(new Error(message))
    }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Coerce an unknown thrown value into an Error without the lint-noisy ternary. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Await a runtime operation until the supplied turn aborts. 
 * @param operation - the runtime operation to await.
 * @param signal - the abort signal of the turn that owns the operation.
 * @returns the operation's value, or a rejection carrying the abort cause once the turn aborts.
 */
export function withNativeRuntimeAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(asError(signal.reason ?? new Error('native runtime turn interrupted')))
  let abort: () => void = () => undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(asError(signal.reason ?? new Error('native runtime turn interrupted'))) }
    signal.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([operation, interrupted]).finally(() => { signal.removeEventListener('abort', abort) })
}
