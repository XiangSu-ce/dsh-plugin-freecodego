/**
 * The hook runtime: documents in, handler executions out, and one seam per event.
 *
 * The split from `surface.ts`
 * --------------------------
 * `surface.ts` is the *contract* — what a hook file may say, which events exist,
 * what a decision means — and it is pure. This module is the part that touches
 * the world: it reads hook documents, spawns commands and performs HTTP calls,
 * and turns a dispatch result into the shape each seam needs. Keeping the two
 * apart is what lets the contract be tested exhaustively without a process, and
 * it is why the fail-open rules can be stated once and relied on here.
 *
 * The rules, restated where they are implemented
 * ---------------------------------------------
 * - **Only an explicit `deny` blocks.** A timeout, a non-zero exit, malformed
 *   output, an unreachable handler: each is recorded and the turn continues.
 *   Every one of those has a test, and so does the fact that a *throwing* runner
 *   is one of them.
 * - **`updatedInput` is refused loudly.** This host froze the call's arguments
 *   before hook policy ran — history, audit and the approval prompt have all
 *   read them — so a rewrite cannot be honored, and pretending otherwise would
 *   let a hook that redacted a secret appear to have redacted it.
 * - **Every handler sees the original payload.** No handler observes another's
 *   output, so two rules cannot compose into something neither author wrote.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hooks/runtime
 */

import { spawn } from 'node:child_process'

import {
  MAX_HOOK_OUTPUT_CHARS,
  collectHookHandlers,
  defaultHookTimeoutMs,
  dispatchHooks,
  selectHookHandlers,
  type HookDispatchResult,
  type HookDocument,
  type HookEvent,
  type HookHandler,
  type HookInvocation,
  type HookRunner,
} from './surface.ts'

/**
 * Append a chunk, refusing to grow past the cap.
 *
 * The cap is not about politeness: concatenating past V8's maximum string length
 * throws inside the stream's `data` handler, which is outside every promise here, so
 * it becomes an uncaught exception that ends the process. See
 * {@link MAX_HOOK_OUTPUT_CHARS}.
 * @param current - what has been collected so far.
 * @param chunk - the next piece of output.
 * @returns the collection, never longer than the cap.
 */
function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_HOOK_OUTPUT_CHARS) return current
  if (current.length + chunk.length <= MAX_HOOK_OUTPUT_CHARS) return current + chunk
  return current + chunk.slice(0, MAX_HOOK_OUTPUT_CHARS - current.length)
}

/**
 * Read a response body without ever holding more than the cap.
 *
 * `await response.text()` is not a capped read: it decodes the entire body into
 * one string before anyone can look at its length, which is the buffering this
 * cap exists to prevent. Measured against a local endpoint streaming 64 MiB, that
 * path pulled all 64 MiB into memory and *then* sliced it — and a body past V8's
 * maximum string length would throw inside the decode instead of being cut
 * short, which is the crash the cap is for. So the body is read chunk by chunk
 * and the reader is cancelled as soon as the cap is reached: the sender is told
 * to stop rather than made to finish.
 * @param response - the response to read.
 * @param cap - the most characters to keep.
 * @returns the text (at most the cap) and whether the rest was discarded.
 */
async function readCappedBody(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const body: ReadableStream<Uint8Array> | null = response.body
  // A response without a stream — a 204, or a mock that only implements `text`:
  // read it whole rather than pretend the handler printed nothing.
  if (body === null || body === undefined) {
    const whole = await response.text()
    return whole.length > cap ? { text: whole.slice(0, cap), truncated: true } : { text: whole, truncated: false }
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let truncated = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done === true) break
      if (chunk.value === undefined) continue
      const piece = decoder.decode(chunk.value, { stream: true })
      const next = appendCapped(text, piece)
      const overran = next.length !== text.length + piece.length
      // Kept before the break either way: when a single chunk overruns the cap,
      // the capped prefix of *that* chunk is the only body there is, and dropping
      // it reports a handler that printed a decision as one that printed nothing.
      text = next
      if (overran) {
        truncated = true
        break
      }
    }
  } finally {
    // Dropping the reader is the part that stops the transfer; a sender that is
    // already gone is not an error worth reporting here.
    try { await reader.cancel() } catch { /* the connection is already closed */ }
  }
  // Flush a trailing multi-byte character, but only for a body that ended on its
  // own: a truncated read stopped mid-stream, where the leftover bytes are the
  // discarded ones.
  return truncated ? { text, truncated } : { text: text + decoder.decode(), truncated }
}

/** The error a runner rejects with when the guarded call was cancelled. */
function hookCancelledError(): Error {
  // `AbortError` so a caller that only knows about deadlines still treats it as a
  // non-blocking stop, with a message that says which stop it was.
  return Object.assign(new Error('the call this hook guarded was cancelled, so the hook was stopped'), { name: 'AbortError' })
}

/** What a seams implementation needs from the runtime. */
export interface HookRuntimeOptions {
  /**
   * The documents to read handlers from.
   *
   * Asynchronous and keyed by workspace, deliberately. Reading hooks means
   * reading files, and a synchronous reader would have to answer from a cache
   * that the *first* dispatch of a session has not filled yet — which is a
   * silent way to run a session's first tool call without its project hooks.
   * Waiting for the read is cheap (the files are small and cached by the OS) and
   * it is the only version whose first call behaves like its second.
   * @param workspaceRoot - the session's workspace, when it has one.
   */
  readonly documents: (workspaceRoot?: string) => Promise<readonly HookDocument[]>
  /** Injected execution, so tests never spawn anything. */
  readonly run?: HookRunner
  /**
   * Called once for each handler invocation, with what was asked and what came
   * back. Injected because it writes session events, which is the caller's
   * business — the runtime must stay usable from a test with no session.
   */
  readonly record?: (entry: HookRecord) => void
  /** Whether hooks are enabled at all; a disabled runtime dispatches nothing. */
  readonly enabled?: () => boolean
  /** Extra environment for command handlers. */
  readonly environment?: () => Readonly<Record<string, string>>
}

/** One recorded invocation, for the session log and for `doctor`. */
export interface HookRecord {
  readonly phase: 'invoked' | 'result'
  readonly event: HookEvent
  readonly matcher: string
  readonly sources: readonly string[]
  readonly command: string
  readonly status?: string
  readonly exitCode?: number
  readonly message?: string
  readonly durationMs?: number
}

/** What a seam passes in: which subject is being matched, and its tool name. */
export interface HookSubject {
  /** The value the matcher is compared against. */
  readonly subject: string
  /** Tool name, when the event is a tool event; drives the alias table. */
  readonly toolName?: string
  /** The session's workspace, which selects which hook files apply. */
  readonly workspaceRoot?: string
  readonly agent?: unknown
  readonly sessionId?: string
  /**
   * Cancellation of the thing being guarded, when there is one.
   *
   * A `PreToolUse` hook guards a tool call, and this host's `ToolExecution`
   * documents `signal` as "required caller-owned cancellation" for exactly that
   * call — while also stating that the registry "rechecks cancellation after
   * [listeners] settle but never abandons their promise". So a hook that ignores
   * this signal is not politely abbreviated when the user stops the turn: it
   * holds the call for its full deadline, which for the gating events is ten
   * minutes. Passing it is what makes the stop mean something.
   */
  readonly signal?: AbortSignal
}

/**
 * Where a command handler's payload goes: stdin, and the environment.
 *
 * Both, because the two dialects in the wild disagree. Claude Code's hooks read
 * the JSON on stdin; the older shell-style hooks read `$CLAUDE_*` variables. A
 * hook written for either must work, and a hook writer should not have to learn
 * which one this host picked.
 */
function handlerEnvironment(base: Readonly<Record<string, string>>, event: HookEvent, subject?: HookSubject): Record<string, string> {
  return {
    ...base,
    FREECODEGO_HOOK_EVENT: event,
    CLAUDE_HOOK_EVENT: event,
    ...(subject?.toolName === undefined ? {} : { FREECODEGO_HOOK_TOOL: subject.toolName, CLAUDE_TOOL_NAME: subject.toolName }),
    ...(subject?.sessionId === undefined ? {} : { FREECODEGO_SESSION_ID: subject.sessionId, CLAUDE_SESSION_ID: subject.sessionId }),
  }
}

/**
 * End a handler that has run out of time, children included.
 *
 * `child.kill()` reaches the shell this module spawned, and on Windows that is
 * all it reaches: `cmd.exe` does not `exec`-replace itself, so the `pnpm lint`
 * behind it keeps running — and a hook that ignored its deadline would outlive
 * the turn it was gating while this code reported it stopped. `taskkill /t` is
 * the only thing that walks the tree, so it is what a timeout uses there. POSIX
 * shells `exec` a single command, so the direct kill already lands on it, and
 * SIGKILL is used because a hook past its deadline is not owed a graceful window.
 * @param child - the spawned shell.
 */
function terminateHookProcess(child: { pid?: number | undefined; kill(signal?: NodeJS.Signals | number): boolean }): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      // `unref` so a taskkill that outlives its usefulness cannot hold the
      // process open; its own failure is the child's problem, not the turn's.
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        .once('error', () => { try { child.kill() } catch { /* already gone */ } })
        .unref()
      return
    } catch { /* taskkill unavailable: fall through to the direct kill */ }
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/**
 * The real runner for a `command` handler.
 *
 * `shell: true` because a hook is a shell command by definition — a user writing
 * `pnpm lint` is writing one, and quoting it into argv would break exactly the
 * hooks people have already written. The payload is passed on stdin, and a
 * timeout ends the child — its whole tree, see {@link terminateHookProcess} —
 * rather than leaving it running.
 * Two ways a handler ends early, and they are different facts: a deadline is
 * about the hook, a cancellation is about the turn. Both kill the tree; only the
 * deadline is reported as a timeout.
 * @param handler - the handler to run.
 * @param payload - the event payload, as JSON.
 * @param timeoutMs - the deadline after which the child is killed.
 * @param extraEnvironment - environment additions from the runtime.
 * @param signal - the guarded call's cancellation. An already-aborted one does
 *   not spawn at all: a shell started only to be killed a moment later is a
 *   process the user's stop did not ask for, and on a busy machine it is a
 *   process that can outlive the turn it was never part of.
 * @returns the invocation, with a synthesized exit code for a kill.
 */
export function commandHookRunner(
  handler: HookHandler,
  payload: unknown,
  timeoutMs: number,
  extraEnvironment: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<HookInvocation> {
  if (signal?.aborted === true) return Promise.reject(hookCancelledError())
  return new Promise<HookInvocation>((resolve, reject) => {
    const child = spawn(handler.command, {
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...extraEnvironment },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    /** Set once either stream hit the cap, so the truncation is reported once. */
    let truncated = false
    let settled = false
    /** The note that turns a silently shortened output into a stated one. */
    const truncationNote = (): string => truncated
      ? `\n[freecodego: this handler produced more than ${MAX_HOOK_OUTPUT_CHARS} characters; the rest was discarded]`
      : ''
    /** First caller wins; every later outcome is already spoken for. */
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      return true
    }
    const finish = (value: HookInvocation): void => {
      if (!settle()) return
      resolve(value)
    }
    const timer = setTimeout(() => {
      // A kill is reported as a timeout, not as a failure: the distinction is the
      // whole point of having a deadline, and both fail open anyway.
      if (!settle()) return
      terminateHookProcess(child)
      reject(Object.assign(new Error(`hook timed out after ${timeoutMs}ms`), { name: 'AbortError' }))
    }, timeoutMs)
    // The turn being cancelled ends the hook on the same terms as a deadline,
    // except for what it is called: nothing here is the hook's fault.
    const onAbort = (): void => {
      if (!settle()) return
      terminateHookProcess(child)
      reject(hookCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const next = appendCapped(stdout, chunk)
      if (next.length !== stdout.length + chunk.length) truncated = true
      stdout = next
    })
    child.stderr.on('data', (chunk: string) => {
      const next = appendCapped(stderr, chunk)
      if (next.length !== stderr.length + chunk.length) truncated = true
      stderr = next
    })
    child.on('error', (error) => {
      // `error` fires for a shell that cannot be started at all. It is not a
      // rejection of the hook's decision, so it is reported as a non-zero exit.
      finish({ exitCode: 127, stdout, stderr: `${stderr}${truncationNote()}${String(error)}`, truncated })
    })
    child.on('close', (code) => { finish({ exitCode: code ?? 0, stdout, stderr: `${stderr}${truncationNote()}`, truncated }) })
    child.stdin.on('error', () => undefined)
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}))
  })
}

/**
 * The real runner for an `http` handler.
 *
 * A non-2xx response is a failure (fail open), not a deny: an unreachable
 * policy service must not become a way to stop every tool call.
 * The body is capped *while* it is read — see {@link readCappedBody} for why
 * calling `text()` and slicing afterwards is not the same thing.
 * @param handler - the handler, whose `command` is the URL.
 * @param payload - the event payload.
 * @param timeoutMs - the deadline.
 * @param fetchImpl - the fetch to use; injected so tests do not reach the network.
 * @param signal - the guarded call's cancellation; aborts the request in flight
 *   and skips an already-cancelled one instead of issuing it.
 * @returns the invocation, with the response body as stdout.
 */
export async function httpHookRunner(
  handler: HookHandler,
  payload: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HookInvocation> {
  if (signal?.aborted === true) throw hookCancelledError()
  const controller = new AbortController()
  // Both ends of the same channel: whichever fires first aborts the request, and
  // the caller's cancellation is not reported as the hook's own deadline.
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(handler.command, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    })
    const { text, truncated } = await readCappedBody(response, MAX_HOOK_OUTPUT_CHARS)
    return response.ok
      ? { exitCode: 0, stdout: text, stderr: truncated ? `[freecodego: the endpoint returned more than ${MAX_HOOK_OUTPUT_CHARS} characters; the rest was discarded]` : '', truncated }
      : { exitCode: 1, stdout: '', stderr: `hook endpoint answered ${response.status}: ${text.slice(0, 400)}`, ...(truncated ? { truncated } : {}) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Runs project hook handlers on the Harness's events, with timeouts and audit. */
export class FreeCodeGoHookRuntime {
  private readonly options: HookRuntimeOptions
  private readonly fetchImpl: typeof fetch
  /**
   * Dispatches that are running but not awaited by their seam.
   *
   * The observing seams are deliberately fire-and-forget: a `Notification` hook
   * that takes two seconds must not hold a turn open, and a hook that hangs must
   * not be able to. But "not awaited" is not "not happening", so the ones in
   * flight are kept here — which is what lets a shutdown wait for them, and what
   * lets a test observe one without sleeping.
   */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(options: HookRuntimeOptions, fetchImpl: typeof fetch = fetch) {
    this.options = options
    this.fetchImpl = fetchImpl
  }

  /**
   * Wait for every observing-seam dispatch that has not finished.
   *
   * Used by the plugin's disposal path and by tests. It cannot hang: each
   * dispatch is already bounded by its handler timeouts.
   */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /**
   * Run one observing dispatch without blocking the caller, tracking it.
   * @param work - the dispatch to run.
   */
  observe(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => { this.inFlight.delete(tracked) })
    this.inFlight.add(tracked)
  }

  /** How many observing dispatches are still running. */
  get outstanding(): number {
    return this.inFlight.size
  }

  /** Whether the runtime will dispatch at all. */
  get enabled(): boolean {
    return this.options.enabled?.() ?? true
  }

  /**
   * The handlers currently selected for one event and subject.
   *
   * Matching lives in `surface.ts` so the alias table and the matcher semantics
   * have exactly one implementation; this supplies the subject and nothing else.
   * @param event - the event being dispatched.
   * @param subject - the value to match, plus the tool name when it is a tool event.
   * @returns the selected handlers, or none when hooks are off or unreadable.
   */
  async selected(event: HookEvent, subject: HookSubject): Promise<readonly HookHandler[]> {
    if (!this.enabled) return []
    let documents: readonly HookDocument[]
    try {
      documents = await this.options.documents(subject.workspaceRoot)
    } catch {
      // A workspace whose hook files cannot be read costs the hooks, not the
      // session: the turn continues with no hooks rather than failing.
      return []
    }
    let handlers: readonly HookHandler[]
    try {
      handlers = collectHookHandlers(documents).handlers
    } catch {
      // An unreadable or malformed document set costs the hooks, not the session.
      return []
    }
    return selectHookHandlers(handlers, event, subject.subject, subject.toolName).handlers
  }

  /**
   * Dispatch one event and record every invocation.
   *
   * The records are written whether the dispatch blocked or not: a hook that
   * denied a call and a hook that timed out are both things the user will want to
   * find afterwards, and a log that only holds successes is the log that is
   * always empty when something goes wrong.
   * @param event - the event.
   * @param payload - the payload every handler sees, unmodified.
   * @param subject - how handlers are matched, and what is recorded.
   * @returns the dispatch result.
   */
  async dispatch(event: HookEvent, payload: unknown, subject: HookSubject): Promise<HookDispatchResult> {
    // A call that was cancelled before it got here runs nothing, and nothing is
    // even looked up: reading the hook files in order to then decline every
    // handler is work whose only product is a log line saying we declined.
    if (subject.signal?.aborted === true) {
      return { results: [], blocked: false, escalated: false, additionalContexts: [], warnings: [] }
    }
    const handlers = await this.selected(event, subject)
    if (handlers.length === 0) {
      return { results: [], blocked: false, escalated: false, additionalContexts: [], warnings: [] }
    }
    const baseEnvironment = this.options.environment?.() ?? {}
    const run: HookRunner = this.options.run ?? (async (handler, value, timeoutMs, signal) => {
      const environment = handlerEnvironment(baseEnvironment, event, subject)
      return handler.kind === 'http'
        ? await httpHookRunner(handler, value, timeoutMs, this.fetchImpl, signal)
        : await commandHookRunner(handler, value, timeoutMs, environment, signal)
    })
    for (const handler of handlers) {
      this.options.record?.({
        phase: 'invoked',
        event,
        matcher: handler.matcher,
        sources: handler.sources,
        command: handler.command,
      })
    }
    const started = Date.now()
    const result = await dispatchHooks({ handlers, event, payload, run, ...(subject.signal === undefined ? {} : { signal: subject.signal }) })
    const durationMs = Date.now() - started
    for (const entry of result.results) {
      this.options.record?.({
        phase: 'result',
        event,
        matcher: entry.handler.matcher,
        sources: entry.handler.sources,
        command: entry.handler.command,
        status: entry.status,
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        ...(entry.message === undefined ? {} : { message: entry.message }),
        durationMs,
      })
    }
    return { ...result, warnings: [...result.warnings] }
  }

  /** The timeout a handler would get, exposed for `doctor` and for tests.
   * @param event - the hook event the handler runs on.
   * @param handler - the handler whose own timeout, when it set one, wins.
   * @returns the effective timeout in milliseconds.
   */
  timeoutFor(event: HookEvent, handler?: HookHandler): number {
    return handler?.timeoutMs ?? defaultHookTimeoutMs(event)
  }
}

