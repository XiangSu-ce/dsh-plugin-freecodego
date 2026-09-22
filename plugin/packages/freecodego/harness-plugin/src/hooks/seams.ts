/**
 * The fifteen places a hook can attach, and what each one may do.
 *
 * One column per row, deliberately: which host event carries the hook event,
 * whether the seam can refuse anything, and what the payload contains. The table
 * is the module — every other line here is bookkeeping for it.
 *
 * | hook event | host seam | can it refuse? |
 * |---|---|---|
 * | `SessionStart` | `agent/created` | no |
 * | `UserPromptSubmit` | `agent/pre-step` (waterfall) | yes — the prompt never enters the history |
 * | `PreToolUse` | `tools/pre-execute` (waterfall) | yes — deny, or ask |
 * | `PostToolUse` | `tools/post-execute` (waterfall) | replaces the model-visible content |
 * | `PostToolUseFailure` | `tools/post-execute`, `isError` | no |
 * | `PermissionDenied` | `approval/request`, and the deny path above | no |
 * | `Stop` | `agent/turn-stopping` + `agent.steer()` | continues the turn |
 * | `StopFailure` | `agent/request-error` (waterfall) | no |
 * | `StopCancelled` | `agent/status` | no |
 * | `Notification` | derived: `approval/request`, `agent/status` | no |
 * | `SubagentStart` | `subagent/start` | no |
 * | `SubagentStop` | `subagent/end` | no |
 * | `PreCompact` | session event `compaction/start` | no |
 * | `PostCompact` | session event `compaction/end` | no |
 * | `SessionEnd` | `session/disposed` | no |
 *
 * Three decisions worth stating rather than leaving in the code
 * ------------------------------------------------------------
 * **`agent/pre-step` is observed, not claimed.** The seam is a waterfall several
 * listeners share, and rejecting unconditionally to "take control" would let a
 * hook silently outrank the harness's own step admission. So the listener calls
 * `next()` first and turns the result into a rejection **only when a hook denied
 * the prompt**; everything else passes through untouched.
 *
 * **`tools/post-execute` runs after whatever else is on the seam.** A hook is a
 * rule the user wrote; the built-in compressor on the same seam is a default the
 * user did not. Running second means the user's rule wins — and the test asserts
 * the ordering, because it is invisible from either side alone.
 *
 * **An observer on a waterfall calls `next()` and returns what it answered.**
 * A waterfall composes its listeners around the built-in behaviour, and a
 * listener that returns *without* calling `next()` vetoes every listener behind
 * it — `vendor/cordis/src/events.ts` states that as the rule ("a listener that
 * does not call `next()` vetoes the rest of the chain, including the built-in
 * behavior"). So the two observers on `approval/request` pass the chain on and
 * hand back its answer. "Observe" has to be written as "observe and continue";
 * an observer that returns early does not stay neutral, it answers the question.
 *
 * Two limits, stated because they are not enforced
 * ------------------------------------------------
 * **`PreToolUse` cannot inject context.** This Host's `PreToolDecision` has no
 * `additionalContexts` field — the call has not run, so there is no result to
 * attach context to — so a hook that returns one on that event is recorded and
 * its text is dropped. `PostToolUse` is the tool event that can carry it.
 * **A `Stop` hook's words are the hook's words.** The steering message is built
 * here with this Host's message factory, so it carries an id and a plugin
 * source; anything that reads the inbox can tell it from a user's own typing.
 *
 * **`workspaceRoot` is not optional in practice, and it is not a per-seam
 * choice.** `hooks/files.ts` reads the project tier (`.freecodego/hooks.json`,
 * `.claude/settings.json`, `.cursor/hooks.json`) only when it is handed a
 * workspace, and the user tier regardless — so a seam that omits it silently
 * serves a *different file set* than its siblings. Exactly one did,
 * `PermissionDenied`, while the `Notification` listener on the same
 * `approval/request` event passed the workspace: project hooks for that event
 * parsed, matched and never ran, and nothing could notice, because a hook that is
 * never selected raises nothing. Every seam that has a workspace now passes it,
 * and `hook-seams.spec.ts` asserts that the two listeners on one host event ask
 * with the same value rather than trusting the next author to remember.
 *
 * **A hook that guards a call inherits that call's cancellation.** The two tool
 * seams sit on the critical path of an execution the user can stop, and the host
 * states the rule for what that means: it "rechecks cancellation after
 * [listeners] settle but never abandons their promise". A hook that never hears
 * about the stop therefore holds the call — up to the gating deadline, which is
 * ten minutes — for a session that has already been stopped. `exec.signal` is
 * passed down for exactly that reason; the observing seams have no such signal
 * to pass, and say so by passing none.
 *
 * **Nothing here writes to the harness's own `hook/*` log.** `hook-protocol`
 * documents that log as the bridge's; this host is not a bridge, so its records
 * go to `freecodego/hook-invoked` and `freecodego/hook-result` instead. A user
 * migrating a Claude configuration reads about it in the docs, not by finding
 * two logs that disagree.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hooks/seams
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import type { HookRecord } from './runtime.ts'
import type { FreeCodeGoHookRuntime } from './runtime.ts'
import { HOOK_EVENTS, type HookEvent } from './surface.ts'
import { isRecord } from '../untrusted-json.ts'

/** The slice of the host this module installs listeners on. */
export interface HookSeamHost {
  on(event: string, handler: (...args: never[]) => unknown, options?: { readonly global?: boolean }): unknown
  effect?(install: () => unknown, label: string): unknown
}

/** One seam's record, plus the session it belongs to. */
export interface HookSeamRecord extends HookRecord {
  readonly sessionId?: string
}

/** What a seam needs from the plugin: the runtime, and where records go. */
export interface HookSeamDeps {
  readonly runtime: FreeCodeGoHookRuntime
  /**
   * Called when a child agent finishes, with its run info.
   *
   * Separate from the dispatch because it is not a hook: it is where the plugin
   * checks a persona's output contract, which is a plugin concern the seams must
   * not learn about. The seam offers the moment; the plugin decides what to do
   * with it.
   */
  readonly subagentEnd?: (info: unknown) => void
  /**
   * The workspace behind a session id, when the plugin can resolve one.
   *
   * Needed by exactly two seams, and for a stated reason: `subagent/start` and
   * `subagent/end` are handed `SubagentRunInfo` / `SubagentRunEndInfo`, whose
   * fields are `runId`, `provider`, `id` (the **child's** session id), `local`
   * and, at the end, the stop reason and final message. There is no workspace in
   * either payload and no parent — the emitter passes the delegating parent only
   * as the scoped-dispatch carrier, and listeners are called with `info` alone.
   * Without this resolver `cwdOf(info)` answered `undefined` for both, which is
   * not "no project hooks for a subagent run" but a different file set from every
   * sibling seam: a project-tier `SubagentStart` handler parsed, matched and never
   * ran, raising nothing. The child's own session is the right source — it is the
   * tree the child actually ran in, and the host copies the parent's `cwd` into
   * its header when it starts the child.
   */
  readonly sessionCwd?: (sessionId: string) => string | undefined
  /**
   * Write one record.
   *
   * The plugin supplies this so the runtime stays free of session plumbing;
   * see `hooks/runtime.ts`.
   */
  readonly record: (entry: HookSeamRecord) => void
}

/** Read a nested field without asserting a shape the host may change. */
function field(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const step of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[step]
  }
  return current
}

/** A string field, or `''` when it is missing. */
function text(value: unknown, ...path: readonly string[]): string {
  const found = field(value, ...path)
  return typeof found === 'string' ? found : ''
}

/** The session id behind whatever shape the host handed us. */
function sessionIdOf(value: unknown): string | undefined {
  const direct = field(value, 'session', 'id')
  if (typeof direct === 'string' && direct !== '') return direct
  const id = field(value, 'id')
  if (typeof id === 'string' && id !== '') return id
  const agentId = field(value, 'agent', 'session', 'id')
  return typeof agentId === 'string' && agentId !== '' ? agentId : undefined
}

/**
 * The workspace behind a session, when the shape carries one.
 *
 * Three arms because three shapes reach these seams: an `agent/created` or
 * `agent/pre-step` payload nests the session, the tool seams nest it under
 * `agent`, and the session seams (`session/event`, `session/disposed`) are
 * handed **the session itself** — whose own `header.cwd` is the one the other
 * two arms were reading through. Without the last arm those seams asked with
 * `undefined`, which is not "no project hooks for this event" but "a different
 * file set from every sibling seam", and it is silent: a project-tier
 * `PreCompact`, `PostCompact` or `SessionEnd` handler parses, matches and never
 * runs, raising nothing.
 */
/**
 * The workspace a subagent run happened in, from the child session it names.
 *
 * The second arm of the two subagent seams, and only of those: every other seam's
 * payload carries a session whose header has a `cwd` (see {@link cwdOf}), while
 * these two carry a session **id** and nothing else. Fail-open in the honest
 * direction: an unresolvable id — a child that never registered, a plugin with no
 * resolver — leaves the answer `undefined`, which is what these seams had before.
 *
 * @param deps - the seam's plugin surface, for the session lookup.
 * @param info - the run info the seam received.
 * @returns the child's workspace, or undefined when it cannot be read.
 */
function childWorkspaceOf(deps: HookSeamDeps, info: unknown): string | undefined {
  if (deps.sessionCwd === undefined) return undefined
  const id = text(info, 'id')
  return id === '' ? undefined : deps.sessionCwd(id)
}

function cwdOf(value: unknown): string | undefined {
  const cwd = field(value, 'agent', 'session', 'header', 'cwd')
    ?? field(value, 'session', 'header', 'cwd')
    ?? field(value, 'header', 'cwd')
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** The payload every handler of an event receives. */
function envelope(event: HookEvent, subject: string, extras: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { hook_event_name: event, event, subject, ...extras }
}

/**
 * Build a match subject without keys whose value is undefined.
 *
 * `exactOptionalPropertyTypes` is on in this workspace, and it is right to be: a
 * present-but-undefined `sessionId` is a different value from an absent one, and
 * the recorder distinguishes them.
 * @param subject - the value the matcher is compared against.
 * @param toolName - tool name for the tool events.
 * @param sessionId - the session, when one is known.
 * @returns the subject, with only the keys it has values for.
 */
function subjectOf(
  subject: string,
  toolName?: string,
  sessionId?: string,
  workspaceRoot?: string,
  signal?: AbortSignal,
): { readonly subject: string; readonly toolName?: string; readonly sessionId?: string; readonly workspaceRoot?: string; readonly signal?: AbortSignal } {
  return {
    subject,
    ...(toolName === undefined ? {} : { toolName }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * The guarded call's own cancellation, when the payload carries one.
 *
 * A structural check rather than `instanceof AbortSignal`: this reads a field out
 * of a payload the host owns, and a signal produced in another realm would fail
 * an `instanceof` while still being exactly the thing the runners need to listen
 * to. The shape asked for is the part they use — `aborted` and
 * `addEventListener` — so a payload that has those is accepted and one that does
 * not is left alone rather than passed on as though it were a signal.
 * @param value - the host payload a tool seam received.
 * @returns the signal, or undefined when the payload carries none.
 */
function hookSignalOf(value: unknown): AbortSignal | undefined {
  const candidate = field(value, 'signal')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const shape = candidate as { aborted?: unknown; addEventListener?: unknown }
  return typeof shape.aborted === 'boolean' && typeof shape.addEventListener === 'function'
    ? candidate as AbortSignal
    : undefined
}

/**
 * One hook-supplied context as the message the model is shown.
 *
 * Built here rather than in the dispatch because this is where this Host's
 * message contract lives: a message carries an id, a frozen body and a source,
 * and a bare object spliced into the inbox would have none of them.
 * `plugin` is the honest source — the text came from a file the user wrote, not
 * from the model and not from the user's own typing — and it is the same kind
 * `advisor.ts` and the Host's own hook packages already use.
 * @param text - the hook's context text.
 * @returns an identified, frozen user message.
 */
function hookContextMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    source: { kind: 'plugin', plugin: 'freecodego-hooks' },
    content: [{ type: 'text', text }],
  })
}

/**
 * The contexts a decision already carries.
 *
 * A guard rather than a cast: the field belongs to a decision shape this module
 * does not declare, so this is what makes the read a typed `unknown[]` instead of
 * an `any` that would then be spread into a value the Host consumes.
 * @param decision - a value already established to be an object.
 * @returns the existing contexts, or none.
 */
function existingHookContexts(decision: Record<string, unknown>): readonly unknown[] {
  const contexts = decision['additionalContexts']
  return Array.isArray(contexts) ? contexts as readonly unknown[] : []
}

/**
 * Attach hook contexts to a `PostToolUse` decision without displacing whoever
 * else decided it.
 *
 * `PostToolDecision` is the one place this Host lets a hook inject context, so
 * the contexts are merged into the decision `next()` produced rather than
 * replacing it: a hook that only adds context must not become the listener that
 * overrode the compressor standing in front of it.
 * @param decision - what the rest of the chain decided.
 * @param contexts - hook contexts for this call.
 * @returns the decision, with the contexts added.
 */
function withHookContexts(decision: unknown, contexts: readonly string[]): unknown {
  if (contexts.length === 0) return decision
  if (!isRecord(decision)) return decision
  return {
    ...decision,
    additionalContexts: [...existingHookContexts(decision), ...contexts.map(hookContextMessage)],
  }
}

/** Turn a dispatch result into the record entries, and report whether it blocked. */
async function run(
  deps: HookSeamDeps,
  event: HookEvent,
  payload: unknown,
  subject: { readonly subject: string; readonly toolName?: string; readonly sessionId?: string; readonly workspaceRoot?: string; readonly signal?: AbortSignal },
): Promise<{ readonly blocked: boolean; readonly reason?: string; readonly escalated: boolean; readonly replacement?: string; readonly contexts: readonly string[] }> {
  const result = await deps.runtime.dispatch(event, payload, subject)
  // An `ask` carries its explanation on the handler's own result rather than on
  // the dispatch, so it is recovered here: the reason is what the user reads in
  // the approval prompt, and "a hook asked" without why is not reviewable.
  const escalation = result.escalated
    ? result.results.find(entry => entry.status === 'ok' && entry.message !== undefined)?.message
    : undefined
  // Computed once, then spread conditionally. Written as one expression this is
  // a precedence trap: `a ?? b === undefined` parses as `a ?? (b === undefined)`,
  // so a defined `a` selects the *empty* branch and the reason is silently lost.
  const reason = result.blockReason ?? escalation
  return {
    blocked: result.blocked,
    ...(reason === undefined ? {} : { reason }),
    escalated: result.escalated,
    ...(result.replacement === undefined ? {} : { replacement: result.replacement }),
    contexts: result.additionalContexts,
  }
}

/**
 * Dispatch an observing seam without holding the caller open.
 *
 * The turn does not wait for a notification hook, and a hook that hangs must not
 * be able to hold it — but the dispatch is tracked, so a shutdown can wait for
 * the ones in flight rather than abandoning a handler mid-write.
 * @param deps - the runtime and the record sink.
 * @param event - the hook event.
 * @param payload - the payload its handlers receive.
 * @param subject - how handlers are matched.
 */
function observe(deps: HookSeamDeps, event: HookEvent, payload: unknown, subject: { readonly subject: string; readonly toolName?: string; readonly sessionId?: string }): void {
  deps.runtime.observe(run(deps, event, payload, subject))
}

/**
 * The four ways a session can begin, as this Host names them.
 *
 * `'fork'` is deliberately absent even though a child session is a kind of
 * begin: this Host's `SessionStartSource` has no such value, so emitting one
 * would be a subject no matcher could ever have been written against from the
 * source of truth. The four here are the ones `agent/created` can carry.
 */
export type HookSessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/**
 * The event a session-start hook is matched against.
 *
 * Distinguished from a resume because the two want different hooks: seeding
 * project context belongs on a start, and re-reading a workspace on every resume
 * is how a hook turns into a startup cost nobody asked for.
 *
 * The source is read from the payload's own `source`, which is where
 * `agent/created` declares it — an earlier draft read it off the session header,
 * where it does not live, and so reported every resume, clear and compact as a
 * fresh start. The header fields are kept as a fallback rather than as the
 * answer, because a payload that has neither still has to produce something a
 * matcher can be tested against.
 * @param payload - the `agent/created` payload.
 * @returns the source, defaulting to `'startup'` when the payload names none.
 */
export function sessionStartSource(payload: unknown): HookSessionStartSource {
  const declared = field(payload, 'source') ?? field(payload, 'agent', 'session', 'header', 'source') ?? field(payload, 'agent', 'session', 'header', 'startSource')
  return declared === 'resume' || declared === 'clear' || declared === 'compact' ? declared : 'startup'
}

/**
 * Whether a compaction was asked for by a slash command, as `manual` / `auto`.
 *
 * The host's payload is `{ compactionId, sourceCommandId?, turn }` — it carries no
 * `reason` and no `trigger`, so the previous read of those two fields produced
 * `'auto'` for every compaction and **every matcher written against `manual` was
 * dead**: the hook parsed, matched nothing, and nothing in the record said so.
 * `sourceCommandId` is the one discriminator the payload does have (a `CommandId` is
 * present exactly when a command asked for the compaction), and `manual` / `auto` is
 * Claude Code's own vocabulary for that distinction, so both sides name the same
 * thing.
 *
 * @param event - the `session/event` payload.
 * @returns `'manual'` when a command requested the compaction, otherwise `'auto'`.
 */
function compactionTrigger(event: unknown): string {
  return text(event, 'data', 'sourceCommandId') === '' ? 'auto' : 'manual'
}

/**
 * The subject a `SessionEnd` hook matches on, as a constant.
 *
 * The disposal event's payload is the session object itself and carries no reason,
 * so the field this used to read (`disposedReason`) is one nothing in this
 * repository ever writes: the expression looked like a read and behaved like a
 * constant, which is the worst of both — a matcher written against any other reason
 * looked supported and could never fire. The constant says what the host can answer.
 */
const SESSION_END_SUBJECT = 'disposed'

/**
 * Install every seam.
 *
 * Returns the names it installed, so a test can assert the table and the code
 * have not drifted — the failure mode being a hook event that parses, matches,
 * and is never dispatched because nobody wired it.
 * @param host - the context to install listeners on.
 * @param deps - the runtime and the record sink.
 * @returns the hook events that now have a seam.
 */
export function installHookSeams(host: HookSeamHost, deps: HookSeamDeps): readonly HookEvent[] {
  // What this run wired, collected from the install calls themselves rather than
  // restated in a list beside them: a parallel constant cannot notice a seam that
  // was never installed, which made the coverage assertion in `hook-seams.spec.ts`
  // compare `HOOK_EVENTS` against `HOOK_EVENTS` and pass whatever happened to the
  // install sites. The events are what the site *dispatches* — one site may serve
  // two events, chosen by the payload — so they are declared at the site.
  const wired = new Set<HookEvent>()
  const install = (events: HookEvent | readonly HookEvent[], label: string, event: string, handler: (...args: never[]) => unknown, options?: { readonly global?: boolean }): void => {
    for (const name of typeof events === 'string' ? [events] : events) wired.add(name)
    if (host.effect !== undefined) host.effect(() => { host.on(event, handler, options) }, label)
    else host.on(event, handler, options)
  }

  // 1. SessionStart — observe only. Steering a session's first turn from a hook
  //    would be indistinguishable from the user having typed it.
  install('SessionStart', 'freecodego: hooks SessionStart', 'agent/created', ((payload: unknown) => {
    const source = sessionStartSource(payload)
    observe(deps, 'SessionStart', envelope('SessionStart', source, { sessionId: sessionIdOf(payload), cwd: cwdOf(payload) }), subjectOf(source, undefined, sessionIdOf(payload), cwdOf(payload)))
  }))

  // 2. UserPromptSubmit — observed, then responsible only for our own rejection.
  install('UserPromptSubmit', 'freecodego: hooks UserPromptSubmit', 'agent/pre-step', (async (payload: unknown, next: () => Promise<unknown>) => {
    const decision = await next()
    const sessionId = sessionIdOf(payload)
    const prompt = text(payload, 'messages', '0', 'content', '0', 'text') || text(payload, 'message', 'content', '0', 'text')
    const verdict = await run(deps, 'UserPromptSubmit', envelope('UserPromptSubmit', 'prompt', { sessionId, prompt }), subjectOf('prompt', undefined, sessionId, cwdOf(payload)))
    if (verdict.blocked) return { kind: 'reject' }
    return decision
  }))

  // 3, 6. PreToolUse, and the deny path PermissionDenied observes. One seam,
  //    because the review request must be judged once: a second listener on
  //    `tools/pre-execute` would be a second answer to the same question.
  install(['PreToolUse', 'PermissionDenied'], 'freecodego: hooks PreToolUse', 'tools/pre-execute', (async (exec: unknown, next: () => Promise<unknown>) => {
    const toolName = text(exec, 'name')
    const sessionId = sessionIdOf(exec)
    const payload = envelope('PreToolUse', toolName, { toolName, toolInput: field(exec, 'arguments'), sessionId, cwd: cwdOf(exec) })
    // The call's cancellation goes with it: this seam is on the critical path of
    // a call the user can stop, and the host rechecks that stop only after the
    // listener settles.
    const verdict = await run(deps, 'PreToolUse', payload, subjectOf(toolName, toolName, sessionId, cwdOf(exec), hookSignalOf(exec)))
    if (verdict.reason !== undefined) {
      deps.record({
        phase: 'result',
        event: verdict.escalated ? 'PermissionDenied' : 'PreToolUse',
        matcher: toolName,
        sources: [],
        command: '',
        status: verdict.escalated ? 'asked' : 'denied',
        message: verdict.reason,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
    }
    // `ask` is routed to the host's own approval path rather than answered here:
    // an approval prompt this plugin raised would not be the one the user's
    // settings describe.
    if (verdict.escalated && !verdict.blocked) return { kind: 'ask', ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) }
    if (verdict.blocked) return { kind: 'deny', reason: verdict.reason ?? 'denied by a FreeCodeGo hook' }
    return await next()
  }))

  // 4, 5. PostToolUse and PostToolUseFailure — one seam, two events, chosen by
  //     `isError`. Deliberately after `next()`: see the module header.
  install(['PostToolUse', 'PostToolUseFailure'], 'freecodego: hooks PostToolUse', 'tools/post-execute', (async (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
    const base = await next()
    const toolName = text(exec, 'name')
    const isError = field(result, 'isError') === true || field(result, 'error') !== undefined
    const event: HookEvent = isError ? 'PostToolUseFailure' : 'PostToolUse'
    const sessionId = sessionIdOf(exec)
    const verdict = await run(deps, event, envelope(event, toolName, {
      toolName,
      toolInput: field(exec, 'arguments'),
      toolResponse: field(result, 'value') ?? field(result, 'content'),
      isError,
      sessionId,
    }), subjectOf(toolName, toolName, sessionId, cwdOf(exec), hookSignalOf(exec)))
    // Context is merged into `base` on both paths, because it is the one thing
    // this event can inject and the one thing the compressor ahead of it cannot
    // supply on the hook's behalf.
    if (verdict.replacement !== undefined && !isError) {
      return withHookContexts({ kind: 'accept', content: [{ type: 'text', text: verdict.replacement }] }, verdict.contexts)
    }
    return withHookContexts(base, verdict.contexts)
  }))

  // 6. PermissionDenied — the approvals this host raises, observed so a hook can
  //    log or notify. It passes the chain on with `next()`: returning without it
  //    would not leave the approval alone, it would *answer* it, because the
  //    outermost listener's return value is the waterfall's result. What keeps
  //    this an observer is that it returns whatever came back, not an outcome of
  //    its own.
  install('PermissionDenied', 'freecodego: hooks PermissionDenied', 'approval/request', ((request: unknown, next: () => Promise<unknown>) => {
    const sessionId = sessionIdOf(request)
    observe(deps, 'PermissionDenied', envelope('PermissionDenied', text(request, 'toolName') || text(request, 'subject'), {
      toolName: text(request, 'toolName'),
      reason: text(request, 'reason'),
      sessionId,
    }), subjectOf(text(request, 'toolName') || text(request, 'subject'), undefined, sessionId, cwdOf(request)))
    return next()
  }))

  // 7. Stop — the one seam that continues a turn. Steering is how a host says
  //    "run another step", which is what a `Stop` hook means.
  install('Stop', 'freecodego: hooks Stop', 'agent/turn-stopping', (async (payload: unknown) => {
    const sessionId = sessionIdOf(payload)
    const verdict = await run(deps, 'Stop', envelope('Stop', 'turn', { sessionId, turn: field(payload, 'turn') }), subjectOf('turn', undefined, sessionId, cwdOf(payload)))
    if (!verdict.blocked) return
    const contexts = verdict.contexts.length > 0 ? verdict.contexts : [verdict.reason ?? 'a Stop hook asked for another step']
    const agent = field(payload, 'agent')
    const steer = field(agent, 'steer')
    if (typeof steer === 'function') {
      // A real message, not a bare object: `agent.steer()` splices straight into
      // the inbox, so whatever is passed has to already be the thing the inbox
      // stores — id, frozen body and source included — or the next reader of
      // that list is looking at a shape nothing else in the process produces.
      // Carrying the hook's own words so the model sees the instruction rather
      // than an anonymous nudge. A steer into an agent that is already gone is
      // not the turn's problem, so it is caught here.
      //
      // Bound to the agent it was read off, because `steer` is a prototype
      // method and its body is `this.send(...)`: reading the function out of the
      // object and calling it bare left `this` undefined, so every `Stop` hook
      // threw `Cannot read properties of undefined (reading 'send')` — and the
      // `catch` below, whose whole job is to tolerate a disposed agent, ate it.
      // The event that exists to continue a turn could therefore never continue
      // one, and nothing in the record said so.
      try {
        ;(steer as (message: unknown) => void).call(agent, hookContextMessage(contexts.join('\n\n')))
      } catch { /* the agent left between the event and this call */ }
    }
  }))

  // 8. StopFailure — observed through the error waterfall, with `next()` called
  //    so the host's own retry policy stays in charge.
  install('StopFailure', 'freecodego: hooks StopFailure', 'agent/request-error', (async (payload: unknown, next: () => Promise<unknown>) => {
    const sessionId = sessionIdOf(payload)
    // `LlmFailure` documents its routing field as `code`, and has no `kind` at
    // all — so reading `kind` made the subject the constant `'error'` for every
    // failure, and a matcher written against the code (the only field the type
    // offers) could never fire. `kind` stays first for a host that sends one.
    const kind = String(field(payload, 'failure', 'kind') ?? field(payload, 'failure', 'code') ?? 'error')
    observe(deps, 'StopFailure', envelope('StopFailure', kind, {
      sessionId,
      error: field(payload, 'failure'),
      provider: field(payload, 'provider'),
    }), subjectOf(kind, undefined, sessionId, cwdOf(payload)))
    return await next()
  }))

  // 9, 10. StopCancelled and the idle half of Notification, both derived from the
  //        status transition — there is no cancellation event to listen to.
  install(['StopCancelled', 'Notification'], 'freecodego: hooks StopCancelled and idle Notification', 'agent/status', ((payload: unknown) => {
    const status = text(payload, 'status')
    const sessionId = sessionIdOf(payload)
    if (status === 'idle') {
      observe(deps, 'StopCancelled', envelope('StopCancelled', 'idle', { sessionId, reason: 'idle' }), subjectOf('idle', undefined, sessionId, cwdOf(payload)))
      observe(deps, 'Notification', envelope('Notification', 'idle', { sessionId, type: 'idle' }), subjectOf('idle', undefined, sessionId, cwdOf(payload)))
    }
  }))

  // 10. Notification, the pending-approval half. Same waterfall, same rule: the
  //     chain is passed on with `next()` and its answer handed back.
  install('Notification', 'freecodego: hooks idle Notification', 'approval/request', ((request: unknown, next: () => Promise<unknown>) => {
    const sessionId = sessionIdOf(request)
    observe(deps, 'Notification', envelope('Notification', 'permission', { sessionId, type: 'permission' }), subjectOf('permission', undefined, sessionId, cwdOf(request)))
    return next()
  }))

  // 11. SubagentStart — observe, and name the child so a hook can match on it.
  install('SubagentStart', 'freecodego: hooks SubagentStart', 'subagent/start', ((info: unknown) => {
    const agentType = text(info, 'agentType') || text(info, 'provider') || 'subagent'
    // The child's id *is* the session id here (`SubagentRunInfo.id`), so it is
    // reported as the session as well as used to find the workspace: the two
    // reads are the same field, and a matcher that names a session must match
    // the run it was handed.
    const childId = text(info, 'id')
    observe(deps, 'SubagentStart', envelope('SubagentStart', agentType, { agentType, runId: text(info, 'runId'), sessionId: sessionIdOf(info) || childId || undefined }), subjectOf(agentType, undefined, sessionIdOf(info) || childId || undefined, cwdOf(info) ?? childWorkspaceOf(deps, info)))
  }))

  // 12. SubagentStop — observe the end, and check the persona's output contract,
  //     which is the one thing here that reports rather than dispatches.
  install('SubagentStop', 'freecodego: hooks SubagentStop', 'subagent/end', ((info: unknown) => {
    // The same chain the start seam uses, and for a stated reason: the host
    // documents `SubagentRunEndInfo.provider` as "the same provider name carried
    // by the paired start event". Dropping that arm here made the two halves of
    // one subagent run disagree — `SubagentStart` matched the child's name and
    // `SubagentStop` matched the constant `'subagent'`, so a matcher written
    // against the name fired on the way in and never on the way out.
    const agentType = text(info, 'agentType') || text(info, 'provider') || 'subagent'
    const childId = text(info, 'id')
    observe(deps, 'SubagentStop', envelope('SubagentStop', agentType, { agentType, runId: text(info, 'runId'), sessionId: sessionIdOf(info) || childId || undefined }), subjectOf(agentType, undefined, sessionIdOf(info) || childId || undefined, cwdOf(info) ?? childWorkspaceOf(deps, info)))
    // The persona output contract is checked here rather than after the
    // dispatch: both are "the child has finished", and a second listener on the
    // same event would be a second answer to when that happened.
    try {
      deps.subagentEnd?.(info)
    } catch {
      // A contract check that throws must not stop the hook observers.
    }
  }))

  // 13, 14. PreCompact / PostCompact — session events, because the compaction
  //         engine already logs them and the plugin already listens here.
  install('PreCompact', 'freecodego: hooks PreCompact', 'session/event', ((session: unknown, event: unknown) => {
    if (text(event, 'type') !== 'compaction/start') return
    const trigger = compactionTrigger(event)
    observe(deps, 'PreCompact', envelope('PreCompact', trigger, { sessionId: sessionIdOf(session), trigger }), subjectOf(trigger, undefined, sessionIdOf(session), cwdOf(session)))
  }))

  install('PostCompact', 'freecodego: hooks PostCompact', 'session/event', ((session: unknown, event: unknown) => {
    if (text(event, 'type') !== 'compaction/end') return
    const trigger = compactionTrigger(event)
    observe(deps, 'PostCompact', envelope('PostCompact', trigger, { sessionId: sessionIdOf(session), trigger }), subjectOf(trigger, undefined, sessionIdOf(session), cwdOf(session)))
  }))

  // 15. SessionEnd — the plugin already listens for disposal to release per-session
  //     views; this is the hook half of the same moment.
  install('SessionEnd', 'freecodego: hooks SessionEnd', 'session/disposed', ((session: unknown) => {
    const sessionId = sessionIdOf(session)
    const reason = SESSION_END_SUBJECT
    observe(deps, 'SessionEnd', envelope('SessionEnd', reason, { sessionId, reason }), subjectOf(reason, undefined, sessionId, cwdOf(session)))
  }))

  // Canonical order, so the coverage assertion compares like with like; the set
  // is what this function actually registered.
  return HOOK_EVENTS.filter(event => wired.has(event))
}
