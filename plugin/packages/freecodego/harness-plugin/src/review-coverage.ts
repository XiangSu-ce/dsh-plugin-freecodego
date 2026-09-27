/**
 * Coverage for the two shapes the Harness's own Auto review gate documents and
 * leaves open — covered here only when the user configured this plugin's
 * reviewer, and never as a second verdict on an action the Harness already
 * judged.
 *
 * The official gate is `@deepseek-ai/dsh-experimental-auto-review`, the module
 * the optional Auto-review bundle mounts. It classifies one pending call at
 * `tools/pre-execute`, and its own doc comment states both of the gaps this
 * module exists for:
 *
 * 1. **The outer script transport is excluded on purpose.**
 *    `exec.parent === undefined && exec.name === RUN_CODE_NAME` returns `next()`
 *    before the preset is even read, because the gate reviews a program's *inner*
 *    calls and treats the outer `run_code` as transport. Nothing then reads the
 *    program itself, so a session on the Auto preset can run a script body that
 *    no reviewer ever sees. This module reads that one shape — and only that
 *    shape — through this plugin's reviewer, which is otherwise stood down under
 *    Auto (`action-reviewer.ts` says why). No action ever carries two verdicts:
 *    the Harness's gate owns every native and PTC call, and this owns the single
 *    shape the Harness's gate declines by construction.
 *
 * 2. **A reviewer failure is reported as a refusal.** That module's `failed()`
 *    returns `{ kind: 'deny' }` with the reason `Auto review of tool "x" failed;
 *    its body was not executed: <message>`, which is indistinguishable from a
 *    considered denial to everything downstream. A transient transport error
 *    therefore blocks a call no reviewer actually judged, and the user is never
 *    offered the decision. This module turns that outcome back into `ask`, the
 *    direction every other uncertain path in this plugin takes: an unjudged
 *    action is the user's to allow or refuse.
 *
 * Both halves key on the gate's own vocabulary where it exists. A considered
 * refusal carries `info: { name: 'AutoReviewDeniedError', code:
 * 'AUTO_REVIEW_DENIED' }`; a failure carries no `info` at all. That is the
 * distinction used here, and `tests/review-coverage.spec.ts` pins the code, the
 * failure prefix, and the excluded call shape against the Harness's own module,
 * so an upstream rename fails a test in this repository rather than silently
 * disabling this coverage.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review-coverage
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { ActionReviewState, type ReviewOutcome } from './action-review.ts'
import {
  createActionReviewer,
  historyVersionOf,
  renderTranscriptEntries,
  resolveAction,
  type ActionReviewAgentLike,
  type ActionReviewerLlm,
} from './action-reviewer.ts'

/**
 * The structured code the Harness's own gate attaches to a *considered* refusal.
 *
 * Spelled as a literal rather than imported because the gate does not export it
 * and this module has to read it off a decision that crossed the waterfall. Held
 * in one place so the contract test can pin it.
 */
export const HARNESS_AUTO_DENIAL_CODE = 'AUTO_REVIEW_DENIED'

/** The code this module attaches to its own refusal, so it is not read as a failure. */
export const FREECODEGO_DENIAL_CODE = 'FREECODEGO_AUTO_REVIEW_DENIED'

/**
 * The prefix of the Harness gate's reviewer-failure message.
 *
 * The gate builds a failure as `Auto review of tool "x" failed; its body was not
 * executed: <message>` and a considered refusal as `Auto review rejected tool
 * "x"; its body was not executed`. Both strings are pinned by the contract test.
 */
export const HARNESS_AUTO_FAILURE_PREFIX = 'Auto review of tool'

/** Name of the outer script tool, which is the shape the official gate excludes. */
export const OUTER_SCRIPT_TOOL = 'run_code'

/**
 * The refusal member of {@link PreToolDecisionLike}, named rather than inlined.
 *
 * Both readers below narrow to it, and a named interface is what makes that
 * narrowing carry the `reason` their callers read off the decision; an `Extract<>`
 * of the union resolves to the same members but not to a usable property type.
 */
export interface DenialDecision {
  readonly kind: 'deny'
  readonly reason: string
  readonly info?: { readonly name?: unknown; readonly code?: unknown; readonly reason?: unknown } | undefined
}

/** One pre-execute decision, as the waterfall carries it. */
export type PreToolDecisionLike =
  | { readonly kind: 'allow' }
  | DenialDecision
  | { readonly kind: 'cancel' }
  | {
    readonly kind: 'ask'
    readonly reason?: string
    readonly displayReason?: Readonly<Record<string, string>>
  }

/** The pending call, as this module reads it. */
export interface PendingToolCallLike {
  readonly name: string
  readonly agent?: ActionReviewAgentLike | undefined
  /** The nested-dispatch parent; absent for the root call, which is the shape read here. */
  readonly parent?: unknown
  /** The call identity `resolveAction` matches against the session's `tool/call` event. */
  readonly callId?: unknown
  readonly reason?: string
}

/** The tool-execution event host this module subscribes on. */
export interface ReviewCoverageHost {
  on(
    event: 'tools/pre-execute',
    handler: (exec: PendingToolCallLike, next: () => Promise<PreToolDecisionLike>) => Promise<PreToolDecisionLike>,
  ): unknown
}

/** What the coverage needs from the Host and the user's settings. */
export interface ReviewCoverageDeps {
  /** Whether the user enabled this plugin's action reviewer. */
  readonly enabled: () => boolean
  /** The route to review on; an empty provider or model means there is none. */
  readonly route: () => { readonly provider: string; readonly model: string }
  readonly llm: ActionReviewerLlm | undefined
  /**
   * Whether the Harness's own Auto reviewer owns this session, which is when
   * these two gaps exist at all. Every other session's decisions are left exactly
   * as they are: the gaps belong to that gate, and so does this coverage.
   */
  readonly harnessOwnsSession: (agent: unknown) => boolean
  /** Called once per observation, for the audit trail. */
  readonly audit?: (line: string) => void
}

/**
 * Whether this call is the outer script transport the Harness's gate excludes.
 *
 * `parent === undefined` is the gate's own test for "the root call rather than a
 * nested PTC dispatch", and `run_code` is the tool it names — so this coverage is
 * active on exactly the calls the gate skipped, and on no others.
 * @param exec - the pending call.
 * @returns whether the Harness's gate declined to judge this call.
 */
export function isUnreviewedOuterScript(exec: PendingToolCallLike): boolean {
  return exec.parent === undefined && exec.name === OUTER_SCRIPT_TOOL
}

/**
 * Whether a refusal came from a reviewer's considered verdict.
 *
 * Two codes count: the Harness gate's own, and this module's. Anything else that
 * denies is either the reviewer failing (no code at all) or a different gate's
 * refusal, and this module has to tell those apart before rewriting either.
 * @param decision - the decision the waterfall produced.
 * @returns whether a reviewer actually judged this action.
 */
export function isReviewerVerdict(decision: PreToolDecisionLike): decision is DenialDecision {
  if (decision.kind !== 'deny') return false
  const code = decision.info?.code
  return code === HARNESS_AUTO_DENIAL_CODE || code === FREECODEGO_DENIAL_CODE
}

/**
 * Whether a refusal is the Harness gate reporting that its reviewer could not run.
 *
 * Both facts are checked together because either alone is ambiguous: the prefix
 * names the gate, and the absence of a code is what separates "could not read the
 * action" from "read the action and refused it".
 * @param decision - the decision the waterfall produced.
 * @returns whether this is the gate's reviewer-failure outcome.
 */
export function isReviewerFailure(decision: PreToolDecisionLike): decision is DenialDecision {
  if (decision.kind !== 'deny' || decision.info !== undefined) return false
  return decision.reason.startsWith(HARNESS_AUTO_FAILURE_PREFIX)
}

/** The user-facing detail for a decision that needs the user, in the gate's own two locales. */
export function needsUserDetail(reason: string): Readonly<Record<string, string>> {
  return {
    en: `The automatic reviewer did not clear this call, so it needs your decision: ${reason}`,
    zh: `自动审查未能通过此调用，需要你来决定：${reason}`,
  }
}

/** A denial this module produces, marked so {@link isReviewerVerdict} recognises it. */
function deny(exec: PendingToolCallLike, reason: string): PreToolDecisionLike {
  return {
    kind: 'deny',
    reason: `Auto review rejected tool "${exec.name}"; its body was not executed`,
    info: { name: 'FreeCodeGoAutoReviewDeniedError', code: FREECODEGO_DENIAL_CODE, reason },
  }
}

/** The session view `resolveAction` and the transcript renderer both read. */
interface CoveredSession {
  readonly id: SessionId
  readonly events: readonly { readonly type: string; readonly data: unknown }[]
}

/** The calling session, or `undefined` when it cannot be read. */
function sessionOf(agent: ActionReviewAgentLike | undefined): CoveredSession | undefined {
  if (agent === undefined) return undefined
  const id: unknown = agent.session.id
  if (typeof id !== 'string') return undefined
  try {
    return { id: id as SessionId, events: agent.session.snapshotEvents() }
  } catch {
    // A session whose log cannot be read is a session whose action cannot be
    // reviewed, and the caller's answer to that is to leave the call alone.
    return undefined
  }
}

/**
 * Install the coverage on the Host's pre-execute waterfall.
 *
 * Two listeners, and the order they are registered in is what makes them one
 * pipeline: the degrading listener is registered first so it wraps the reviewing
 * one, which is what lets it see — and rewrite — a decision the reviewing one (or
 * the Harness's own, which prepends) produced.
 *
 * @param host - the event host to subscribe on; disposed with the plugin context.
 * @param deps - the switch, the route, the transport, and the ownership test.
 * @param state - the per-session budget and cursor; injectable for tests.
 */
export function installReviewCoverage(
  host: ReviewCoverageHost,
  deps: ReviewCoverageDeps,
  state: ActionReviewState = new ActionReviewState(),
): void {
  const owned = (exec: PendingToolCallLike): boolean => {
    if (!deps.enabled()) return false
    try {
      return deps.harnessOwnsSession(exec.agent)
    } catch {
      // An unreadable session is not an owned one: guessing here would let this
      // module answer for a gate that never ran.
      return false
    }
  }
  const route = (): { readonly provider: string; readonly model: string } | undefined => {
    if (deps.llm === undefined) return undefined
    const resolved = deps.route()
    const provider = resolved.provider.trim()
    const model = resolved.model.trim()
    if (provider === '' || model === '') return undefined
    return { provider, model }
  }

  // Registered first, so it wraps the listener below and can read its outcome.
  host.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!isReviewerFailure(decision)) return decision
    const failure: DenialDecision = decision
    const reason: string = failure.reason
    if (!owned(exec) || isReviewerVerdict(failure)) return decision
    // The call was never judged, so it is the user's to decide. Rewriting the
    // outcome rather than the reason keeps the gate's own diagnostic in the
    // prompt, which is the only place its cause is visible.
    deps.audit?.(`freecodego: the Harness Auto reviewer could not judge ${exec.name}; asking the user instead of refusing`)
    return { kind: 'ask', reason, displayReason: needsUserDetail(reason) }
  })

  host.on('tools/pre-execute', async (exec, next) => {
    if (!isUnreviewedOuterScript(exec) || !owned(exec)) return next()
    const resolvedRoute = route()
    const session = sessionOf(exec.agent)
    const action = session === undefined
      ? undefined
      : resolveAction(session.events, {
        toolName: exec.name,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
      })
    if (resolvedRoute === undefined || session === undefined || action === undefined) {
      // No reviewer, no readable session, or no resolvable call: the script is
      // left exactly as the Harness's gate left it, and the omission is written
      // down rather than turned into a verdict this module cannot support.
      deps.audit?.(`freecodego: the outer script tool ran on the Auto preset unreviewed (${resolvedRoute === undefined ? 'no reviewer configured' : session === undefined ? 'no readable session' : 'the call could not be resolved'})`)
      return next()
    }
    const reviewed = await state.review({
      sessionId: session.id,
      action,
      reason: exec.reason ?? 'the program this call runs is the one shape the Harness Auto gate leaves unreviewed',
      transcript: renderTranscriptEntries(session.events),
      historyVersion: historyVersionOf(session.events),
    }, createActionReviewer({ llm: deps.llm as ActionReviewerLlm, route: resolvedRoute, sessionId: session.id }))
    return outcomeOf(exec, reviewed.outcome, deps)
  })
}

/** One reviewed outcome as a pre-execute decision, with the audit line for each. */
function outcomeOf(
  exec: PendingToolCallLike,
  outcome: ReviewOutcome,
  deps: ReviewCoverageDeps,
): PreToolDecisionLike {
  if (outcome.kind === 'allow') {
    deps.audit?.(`freecodego: the unreviewed outer script of ${exec.name} was allowed by this plugin's reviewer`)
    return { kind: 'allow' }
  }
  if (outcome.kind === 'deny') {
    deps.audit?.(`freecodego: the outer script of ${exec.name} was refused by this plugin's reviewer: ${outcome.rationale}`)
    return deny(exec, outcome.rationale)
  }
  // `ask-user` in all its reasons — a reviewer that failed, ran out of budget, or
  // was never configured — ends at the prompt the user already had available.
  deps.audit?.(`freecodego: the outer script of ${exec.name} needs the user's decision (${outcome.why})`)
  return { kind: 'ask', displayReason: needsUserDetail('the program this call runs was not cleared automatically') }
}
