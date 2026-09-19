/**
 * Output shaper — verbosity steering, ported from Headroom's
 * `headroom/proxy/output_verbosity_policy.py` (byte-stable L1-L4 steering
 * blocks, `</headroom_output_shaping>` sentinel contract) and effort-routing
 * turn classification from `headroom/proxy/output_shaper.py`, © Headroom
 * Maintainers, Apache-2.0.
 *
 * Everything here is OFF by default: the steering block is only registered as
 * a system-prompt section when the user sets `headroomVerbosityLevel` ≥ 1,
 * and effort routing only lowers an explicitly-set `reasoningEffort` when
 * `headroomOutputShaper` is enabled. Both follow the original's cache-safety
 * invariants: the steering text is byte-stable per level (prefix-cache
 * friendly), and effort routing is clamp-only (never injects where the client
 * didn't set it).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/output-shaper
 */

export const STEERING_SENTINEL = '<headroom_output_shaping>'
export const STEERING_SUFFIX = '</headroom_output_shaping>'

/**
 * Levels are cumulative: each includes everything above it. Text must stay
 * byte-stable across releases for prefix-cache friendliness — edits to these
 * strings are cache-busting changes (original contract).
 *
 * L3/L4 carry a completeness floor (never drop negations/task-critical
 * content) and a clarity exception (destructive actions, security warnings,
 * multi-step sequences) — the clauses the original measured to be
 * turn-count-neutral.
 */
export const VERBOSITY_LEVELS: Readonly<Record<number, string>> = {
  1: 'Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.',
  2: 'Skip preamble and postamble; start with the substance. Never restate code, file contents, diffs, or tool output that already appear in this conversation — reference them by path and line instead. After a tool call succeeds, continue without narrating the result.',
  3: 'Skip preamble and postamble. Never restate code, file contents, diffs, or tool output already in this conversation — cite the exact file path and line or symbol instead, always; a reference that omits the location is not a reference. Give conclusions only; omit rationale unless the user asks why. Prefer the smallest edit over rewriting whole files. Keep prose to the minimum needed to be unambiguous. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except) — shorten how you say it, not what you say. Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.',
  4: 'Minimum tokens. Fragments fine. No preamble, no postamble, no restating context, no rationale. Answer, smallest-possible edits, nothing else. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except). Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.',
}

/** The full steering block for a verbosity level, or undefined for level 0. */
export function steeringText(level: number): string | undefined {
  const text = VERBOSITY_LEVELS[level]
  if (text === undefined) return undefined
  return `${STEERING_SENTINEL}\n${text}\n${STEERING_SUFFIX}`
}

// ─── Effort routing: turn classification (structural only) ──────────────────

export type TurnKind = 'new-user-ask' | 'mechanical-continuation' | 'error-continuation' | 'unknown'

/**
 * Session event types that report a completed tool result to the model.
 *
 * Named rather than inline because this classifier was ported with the upstream
 * project's vocabulary — `tool/text` and `tool/code-dispatch` — and **neither is
 * an event this Harness writes**: `tool/text` appears nowhere in the repository,
 * and `tool/code-dispatch` survives only as the pre-v1 spelling that
 * `dsh-session-format-v0-to-v1` migrates away from (`tool/ptc-dispatch` is the
 * current one). The branch therefore never matched a live event, so
 * `mechanical-continuation` was unreachable and the effort clamp it exists to
 * trigger never fired. `KNOWN_SESSION_EVENT_TYPES`
 * (`dsh-session/known-event-types`) is the authority these names come from.
 */
const TOOL_OUTPUT_EVENT_KINDS: ReadonlySet<string> = new Set(['tool/result', 'tool/ptc-dispatch'])

/**
 * The kind a **failed** tool result is tracked under.
 *
 * Not a session event type: the Harness reports a tool failure as a
 * `tool/result` whose `message.isError` is true (`agent-loop/src/tool-calls.ts`
 * appends it), and this classifier is handed event **kinds alone**. Without a
 * distinct token for the failure the tail of a failed tool call and the tail of a
 * successful one are the same array — so `'error-continuation'` was a
 * `TurnKind` nothing could ever return, and the guarantee its own eval case
 * asserts ("the model is debugging and lowering its effort there is exactly the
 * wrong move") was never actually honoured: the request right after a failure was
 * classified `mechanical-continuation` and clamped. The caller is what knows the
 * verdict, so it is what writes this token, derived from the event it saw.
 */
export const ERROR_OUTPUT_EVENT_KIND = 'tool/error'

const ERROR_OUTPUT_EVENT_KINDS: ReadonlySet<string> = new Set([ERROR_OUTPUT_EVENT_KIND])

/**
 * Session event types that carry something a person said.
 *
 * `user/text` was the other half of the ported vocabulary and is likewise not an
 * event this Harness writes; `user/message` is the only one.
 */
const USER_ASK_EVENT_KINDS: ReadonlySet<string> = new Set(['user/message'])

/**
 * Session events the agent loop appends around a request rather than about the
 * work: `step/start` is appended immediately before the `agent/request`
 * waterfall (`packages/core/agent-loop/src/agent.ts`), so it is **always the
 * newest entry** when this classifier runs. Skipping them is what makes the
 * substantive tail reachable at all — before, the walk broke on `step/start` and
 * answered `unknown` on every real turn, which is the second reason the clamp
 * never fired.
 */
const FRAMING_EVENT_KINDS: ReadonlySet<string> = new Set(['step/start', 'step/end', 'request/header', 'request/context'])

/**
 * Classify a turn from the tail of session event kinds.
 *
 * A trailing run of tool output is a mechanical continuation; anything else is
 * `unknown`, and a user message — reached before any non-framing event — is a
 * fresh ask. Framing events are stepped over rather than treated as the end of
 * the tail, because the loop appends one after every tool result.
 *
 * The run's **newest** member decides it, which is what `'error-continuation'`
 * exists for: a failed tool result reaches the model as a `tool/result`, so a
 * tail that classified purely on "tool output happened" could not tell a failure
 * from a success and clamped after both. The caller writes
 * {@link ERROR_OUTPUT_EVENT_KIND} in place of `tool/result` for a failed one; a
 * later successful result supersedes it, so a model that recovers on its own is
 * clamped again.
 * @param lastEventKinds - the newest session event kinds, oldest first.
 * @returns the turn kind the effort clamp is allowed to act on.
 */
export function classifyTurnFromTail(lastEventKinds: readonly string[]): TurnKind {
  // Walk the tail: the newest tool-output event in the trailing run decides it.
  let newestToolOutput: string | undefined
  for (let i = lastEventKinds.length - 1; i >= 0; i -= 1) {
    const kind = lastEventKinds[i]
    if (kind === undefined) break
    if (FRAMING_EVENT_KINDS.has(kind)) continue
    if (TOOL_OUTPUT_EVENT_KINDS.has(kind) || ERROR_OUTPUT_EVENT_KINDS.has(kind)) {
      newestToolOutput ??= kind
      continue
    }
    if (USER_ASK_EVENT_KINDS.has(kind)) return 'new-user-ask'
    break
  }
  if (newestToolOutput === undefined) return 'unknown'
  return ERROR_OUTPUT_EVENT_KINDS.has(newestToolOutput) ? 'error-continuation' : 'mechanical-continuation'
}

/**
 * Clamp-only effort routing (original invariant): lower an EXPLICITLY-set
 * effort on mechanical continuations; never inject, never touch errors or
 * new asks. Returns the adjusted effort or the input unchanged.
 *
 * The ladder is this Harness's vocabulary, weakest first — the same set
 * `SupportedReasoningEffort` declares (`openai-compatible-adapter.ts`) and every
 * route is validated against (`GATEWAY_REASONING_EFFORTS`,
 * `DIRECT_REASONING_EFFORTS`).
 *
 * It was ported with Headroom's own ladder (`minimal … xhigh`), and
 * `ReasoningEffortId` is a branded string, so nothing rejected the port's floor:
 * a user level of `low` clamped to `minimal`, which no adapter here knows —
 * `thinkingBudget` (`anthropic-wire.ts`) matched no case and fell through to
 * `default: undefined`, so the clamp *disabled* thinking instead of moving the
 * level down one step. And because the port stopped at `xhigh`, `max` — the
 * level most worth lowering on a mechanical continuation — was absent, so
 * `indexOf` returned -1 and the clamp never fired on it at all.
 */
const EFFORT_LADDER: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

export function routeEffort(effort: string | undefined, turnKind: TurnKind, enabled: boolean): string | undefined {
  if (!enabled) return effort
  if (effort === undefined || turnKind !== 'mechanical-continuation') return effort
  const index = EFFORT_LADDER.indexOf(effort)
  if (index <= 0) return effort
  return EFFORT_LADDER[index - 1]
}
