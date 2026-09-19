import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FreeCodeGoEngineeringCouncilDecision, FreeCodeGoEngineeringCouncilEngine, FreeCodeGoEngineeringCouncilRequest, FreeCodeGoEngineeringMemoryReviewDecision, FreeCodeGoEngineeringMemoryTrust, FreeCodeGoEngineeringVerificationStage, JsonValue } from './types.ts'

/**
 * The trust states durable engineering memory may carry, in review order.
 *
 * One list, three readers: the allow-set below, and the memory store's own
 * `TRUSTS` / `USER_VISIBLE_TRUSTS` reads, which used to be a second hand-written
 * copy of this same membership. The type in `types.ts` names the same states, and
 * a copy that drifts from it is silent in both directions: a state the store
 * writes but this validator refuses is one no caller can ask for, and one the
 * validator accepts but the store never writes is a filter that resolves to
 * nothing.
 */
export const ENGINEERING_MEMORY_TRUSTS: readonly FreeCodeGoEngineeringMemoryTrust[] = ['captured', 'draft', 'reviewed', 'rejected', 'superseded']
const ENGINEERING_MEMORY_TRUST_NAMES = new Set<FreeCodeGoEngineeringMemoryTrust>(ENGINEERING_MEMORY_TRUSTS)
/** The review outcomes a memory record may be moved to. Exported for the same reason as the trusts above. */
export const ENGINEERING_MEMORY_REVIEW_DECISIONS: readonly FreeCodeGoEngineeringMemoryReviewDecision[] = ['reviewed', 'rejected', 'superseded']
const ENGINEERING_MEMORY_REVIEW_DECISION_NAMES = new Set<FreeCodeGoEngineeringMemoryReviewDecision>(ENGINEERING_MEMORY_REVIEW_DECISIONS)

export function validateEngineeringMemoryListRequest(input: unknown): { readonly trusts?: readonly FreeCodeGoEngineeringMemoryTrust[]; readonly limit?: number; readonly cursor?: string } {
  if (input === undefined) return {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering memory list request is invalid')
  const value = input as Record<string, unknown>
  const trusts = value.trusts
  if (trusts !== undefined && (!Array.isArray(trusts) || trusts.length > ENGINEERING_MEMORY_TRUSTS.length || trusts.some(trust => typeof trust !== 'string' || !ENGINEERING_MEMORY_TRUST_NAMES.has(trust as FreeCodeGoEngineeringMemoryTrust)))) throw new Error('engineering memory trust filter is invalid')
  const limit = value.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('engineering memory list limit is invalid')
  const cursor = value.cursor
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 256)) throw new Error('engineering memory cursor is invalid')
  return {
    ...(trusts === undefined ? {} : { trusts: trusts as readonly FreeCodeGoEngineeringMemoryTrust[] }),
    ...(limit === undefined ? {} : { limit: limit }),
    ...(cursor === undefined ? {} : { cursor: cursor }),
  }
}

export function validateEngineeringMemoryTimelineRequest(input: unknown): { readonly id: string; readonly before?: number; readonly after?: number } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering memory timeline request is invalid')
  const value = input as Record<string, unknown>
  if (typeof value.id !== 'string' || !/^mem_[a-f0-9]{32}$/i.test(value.id)) throw new Error('engineering memory id is invalid')
  for (const key of ['before', 'after'] as const) {
    const count = value[key]
    if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 10)) throw new Error(`engineering memory ${key} count is invalid`)
  }
  return { id: value.id, ...(value.before === undefined ? {} : { before: value.before as number }), ...(value.after === undefined ? {} : { after: value.after as number }) }
}

export function validateEngineeringMemoryReviewRequest(input: unknown): { readonly id: string; readonly decision: FreeCodeGoEngineeringMemoryReviewDecision } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering memory review request is invalid')
  const value = input as Record<string, unknown>
  if (typeof value.id !== 'string' || !/^mem_[a-f0-9]{32}$/i.test(value.id)) throw new Error('engineering memory id is invalid')
  if (typeof value.decision !== 'string' || !ENGINEERING_MEMORY_REVIEW_DECISION_NAMES.has(value.decision as FreeCodeGoEngineeringMemoryReviewDecision)) throw new Error('engineering memory review decision is invalid')
  return { id: value.id, decision: value.decision as FreeCodeGoEngineeringMemoryReviewDecision }
}

export function validateEngineeringGraphRuntimeInstall(input: unknown): { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering Graphify Runtime install request is invalid')
  const value = input as Record<string, unknown>
  if (value.packageId !== 'managed-uv-python' && value.packageId !== 'existing-python') throw new Error('engineering Graphify Runtime package is invalid')
  if (value.pythonPath !== undefined && (typeof value.pythonPath !== 'string' || value.pythonPath.length > 4_096)) throw new Error('engineering Graphify Python path is invalid')
  if (value.packageId === 'existing-python' && (typeof value.pythonPath !== 'string' || value.pythonPath.trim() === '')) throw new Error('engineering Graphify existing Python path is required')
  return { packageId: value.packageId, ...(typeof value.pythonPath === 'string' ? { pythonPath: value.pythonPath.trim() } : {}) }
}

/**
 * Every verification stage the system knows, in the order a report reads best.
 *
 * One vocabulary, four readers: the validator below, the tier table that decides
 * which stages a change deserves, the default a caller gets when it names none,
 * and the executor's script aliases (typed against the public union, so a stage
 * added there fails to compile until something can run it).
 *
 * The list used to be written out in three modules while `types.ts` held a fourth
 * copy as a union, which meant a stage added to the public type was accepted
 * everywhere except the validator that stands in front of the remote call.
 */
export const VERIFICATION_STAGES: readonly FreeCodeGoEngineeringVerificationStage[] = ['scope', 'build', 'types', 'lint', 'tests']

export function validateEngineeringVerificationStages(input: unknown): readonly FreeCodeGoEngineeringVerificationStage[] | undefined {
  if (input === undefined) return undefined
  const allowed = new Set<FreeCodeGoEngineeringVerificationStage>(VERIFICATION_STAGES)
  if (!Array.isArray(input) || input.length > VERIFICATION_STAGES.length || input.some(stage => typeof stage !== 'string' || !allowed.has(stage as FreeCodeGoEngineeringVerificationStage))) throw new Error('engineering verification stages are invalid')
  return [...new Set(input as readonly FreeCodeGoEngineeringVerificationStage[])]
}

/**
 * Field bounds of an engineering council request.
 *
 * These sit beside the validator that enforces them because they *are* the
 * request contract, and `EngineCouncil` reads them from here rather than
 * restating the numbers: a bound written down twice is a bound that can
 * disagree with itself, and the disagreement shows up as one layer accepting a
 * request while the other refuses it. The plan bound is well below what a
 * conversation can hold because the plan is fed to participant models, whose
 * whole output budget is `engineeringCouncilMaxTokens`.
 */
/**
 * The engines that may participate in an engineering council, in the order the
 * council tool offers them.
 *
 * One list, five readers: the validator below, the council tool's schema
 * `enum`/`maxItems` (`agent-tools.ts`), `engine-council.ts`'s own roster default,
 * `councilPeersFor` below — which the automatic plan review in `index.ts` hands
 * straight to `engineCouncil.start` — and `latestSessionEngine`'s return type.
 * Before this each of them was a hand-written copy of
 * `['deepseek', 'codex', 'claude']`, and the automatic review was the one the
 * sentence claiming the copies were gone had missed. That is the whole hazard of
 * counting them by hand: a reader is not less of one for being missed, and an
 * engine added here would have been used by the explicit tool and silently
 * skipped by the automatic one.
 *
 * Deliberately narrower than `FreeCodeGoEngineId`, which also names the root
 * Agent's own engine: `'freecodego'` is not a delegation target.
 */
export const COUNCIL_ENGINES: readonly FreeCodeGoEngineeringCouncilEngine[] = ['deepseek', 'codex', 'claude']
const COUNCIL_ENGINE_NAMES = new Set<FreeCodeGoEngineeringCouncilEngine>(COUNCIL_ENGINES)

export const COUNCIL_MAX_OBJECTIVE_CHARS = 8_000
export const COUNCIL_MAX_PLAN_CHARS = 16_000
export const COUNCIL_MAX_CONSTRAINT_CHARS = 1_000

/**
 * Whether an approved plan is short enough for the council to review.
 *
 * The automatic path asks this before starting a review, so a plan the council
 * cannot read becomes one stated decision instead of an exception raised on
 * every turn for as long as the plan stays the latest approved one.
 * @param plan - the approved plan text, as stored in the session log.
 * @returns whether the council would accept it, judged by the same bound the
 * request validator enforces.
 */
export function councilCanReviewPlan(plan: string): boolean {
  return plan.trim().length <= COUNCIL_MAX_PLAN_CHARS
}

/**
 * The council roster for one session: every council engine except the one that
 * authored the plan under review.
 *
 * The automatic plan review in `index.ts` hands this straight to
 * `engineCouncil.start` — the same `engines` field the explicit council tool
 * fills and the validator above gates on `COUNCIL_ENGINES`. Deriving it here
 * rather than filtering a literal at the call site is what keeps those two
 * agreeing: a literal was the roster one reader short, so an engine added to
 * `COUNCIL_ENGINES` would have been offered by the explicit tool and silently
 * skipped by the automatic one. `engineering-auto-council.spec.ts` pins the
 * result for a known parent, so widening the roster is a visible edit.
 * @param parentEngine - the engine driving the session that approved the plan,
 * or `undefined` when the session has recorded no engine yet.
 * @returns the engines the council may start, in the council tool's order.
 */
export function councilPeersFor(parentEngine: FreeCodeGoEngineeringCouncilEngine | undefined): readonly FreeCodeGoEngineeringCouncilEngine[] {
  return COUNCIL_ENGINES.filter(engine => engine !== parentEngine)
}

export function normalizeEngineeringCouncilRequest(input: FreeCodeGoEngineeringCouncilRequest): FreeCodeGoEngineeringCouncilRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering council request is required')
  const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
  const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
  if (objective === '' || objective.length > COUNCIL_MAX_OBJECTIVE_CHARS) throw new Error('engineering council objective is invalid')
  if (plan === '' || plan.length > COUNCIL_MAX_PLAN_CHARS) throw new Error('engineering council plan is invalid')
  const constraints = input.constraints === undefined ? [] : input.constraints
  if (!Array.isArray(constraints) || constraints.length > 20 || constraints.some(item => typeof item !== 'string' || item.trim() === '' || item.length > COUNCIL_MAX_CONSTRAINT_CHARS)) throw new Error('engineering council constraints are invalid')
  const engines = input.engines === undefined ? undefined : [...new Set(input.engines)]
  // The allow-set is the list the council tool's schema offers, so a caller can
  // never name an engine no model was told about. It was an inline chain of
  // comparisons plus a hand-written `> 3`, which is a second copy of the type in
  // `types.ts` and of the schema's `enum`/`maxItems`.
  if (engines !== undefined && (engines.length === 0 || engines.length > COUNCIL_ENGINES.length || engines.some(engine => !COUNCIL_ENGINE_NAMES.has(engine)))) throw new Error('engineering council engines are invalid')
  if (input.maxRounds !== undefined && (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 3)) throw new Error('engineering council maxRounds is invalid')
  return {
    objective,
    plan,
    ...(constraints.length === 0 ? {} : { constraints: constraints.map(item => item.trim()) }),
    ...(engines === undefined ? {} : { engines: engines }),
    ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
  }
}

export function validateEngineeringCouncilDecisionRequest(input: unknown): { readonly id: string; readonly decision: FreeCodeGoEngineeringCouncilDecision['state'] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering council decision request is invalid')
  const value = input as { readonly id?: unknown; readonly decision?: unknown }
  if (typeof value.id !== 'string' || !/^council_[a-f0-9]{32}$/i.test(value.id)) throw new Error('engineering council job id is invalid')
  if (value.decision !== 'approved' && value.decision !== 'rejected') throw new Error('engineering council decision is invalid')
  return { id: value.id, decision: value.decision }
}

export function validateEngineeringCouncilVerificationRequest(input: unknown): { readonly id: string; readonly stages?: readonly FreeCodeGoEngineeringVerificationStage[] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering council verification request is invalid')
  const value = input as { readonly id?: unknown; readonly stages?: unknown }
  if (typeof value.id !== 'string' || !/^council_[a-f0-9]{32}$/i.test(value.id)) throw new Error('engineering council job id is invalid')
  const stages = validateEngineeringVerificationStages(value.stages)
  return { id: value.id, ...(stages === undefined ? {} : { stages }) }
}

export function workspaceForAgent(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('engineering verification requires a workspace-backed conversation')
  return cwd
}

/** Read the engine currently driving a session from its durable selection or
 * executor event. Automatic council uses this to delegate the other engines,
 * leaving the parent Agent as the decision-maker. The return type is the council
 * roster rather than a second spelling of it, because the only caller feeds it to
 * `councilPeersFor`. */
export function latestSessionEngine(events: readonly { readonly type: string; readonly data: unknown }[]): FreeCodeGoEngineeringCouncilEngine | undefined {
  const selected = [...events].reverse().find(event => event.type === 'agent-engine/selected')
  const executor = [...events].reverse().find(event => event.type === 'freecodego/engine-executor')
  for (const event of [selected, executor]) {
    if (event?.data === null || typeof event?.data !== 'object' || Array.isArray(event.data)) continue
    const value = event.data as { readonly engineId?: unknown; readonly engine?: unknown }
    const candidate = value.engineId ?? value.engine
    if (candidate === 'deepseek' || candidate === 'codex' || candidate === 'claude') return candidate
  }
  return undefined
}

/** How many automatic attempts one approved plan may cost: the first review plus
 * one retry for an attempt that established nothing. The bound is what keeps a
 * retryable failure from turning into an unbounded spend on every turn boundary. */
export const MAX_AUTO_COUNCIL_ATTEMPTS = 2

/** Council states that are still moving, or parked on the user's decision, so a
 * second automatic attempt would race the first. The council's own `isActiveState`
 * names the first four; the two waiting states are added here because this guard
 * answers "may a new attempt start", and a plan already parked on the user is not
 * one to start again. */
const AUTO_COUNCIL_HOLDING_STATES = new Set([
  'queued', 'running', 'implementing', 'verifying', 'awaiting_approval', 'awaiting_verification',
])

/** Report states that mean the engines actually reviewed the plan. The terminal
 * 'cancelled'/'failed' reports are the record of an attempt that established
 * nothing, which is the distinction the retry policy turns on. */
const REVIEWED_COUNCIL_REPORT_STATES = new Set(['completed', 'partial', 'blocked'])

/** Why the automatic council must not start for an approved plan. */
export type AutoCouncilSkipReason = 'reviewed' | 'in-flight' | 'cancelled' | 'exhausted'

/**
 * Why the automatic council must not start for this exact approved plan, when it
 * must not.
 *
 * Council tasks and their states are durable session events, so this guard also
 * survives a Host restart instead of relying on an in-memory set.
 *
 * The first attempt for a plan is always allowed. A later one is allowed only
 * when every earlier attempt *established nothing* — the council's deadline
 * expired, or the Host restarted mid-review — because then the plan the user
 * approved was never actually reviewed, and a single retry is what keeps the
 * promise the automatic path made. What still blocks a start:
 *
 * - a report saying the engines did review the plan (`completed`, `partial`,
 *   `blocked`): that is the review, with or without blockers, and re-running it
 *   is the user's call rather than the automatic path's;
 * - an attempt still holding the session (active, or waiting for a decision);
 * - a cancellation, which is the user's own decision to stop rather than a
 *   failure to retry — a deadline is not a cancellation (see the council's own
 *   `stopReason`), so an expired deadline is retryable while a cancelled one is not;
 * - the attempt budget above, which is what bounds the retry.
 */
export function autoCouncilSkipReason(
  events: readonly { readonly type: string; readonly data: unknown }[],
  plan: string,
): AutoCouncilSkipReason | undefined {
  const attempts = councilAttemptIdsForPlan(events, plan)
  if (attempts.length === 0) return undefined
  let reviewed = false
  let holding = false
  let cancelled = false
  for (const id of attempts) {
    const outcome = councilAttemptOutcome(events, id)
    if (outcome === 'reviewed') reviewed = true
    else if (outcome === 'holding') holding = true
    else if (outcome === 'cancelled') cancelled = true
  }
  if (reviewed) return 'reviewed'
  if (holding) return 'in-flight'
  if (cancelled) return 'cancelled'
  return attempts.length >= MAX_AUTO_COUNCIL_ATTEMPTS ? 'exhausted' : undefined
}

/** The council ids whose durable task event names this exact plan, in log order. */
function councilAttemptIdsForPlan(events: readonly { readonly type: string; readonly data: unknown }[], plan: string): string[] {
  const ids: string[] = []
  for (const event of events) {
    if (event.type !== 'freecodego/council-task') continue
    const request = recordOf(recordOf(event.data)?.request)
    if (request?.plan !== plan) continue
    const id = recordOf(recordOf(event.data)?.job)?.id
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

/** What one recorded attempt amounts to, as far as a *retry* is concerned. Folds
 * the attempt's durable report together with its last lifecycle state. */
function councilAttemptOutcome(
  events: readonly { readonly type: string; readonly data: unknown }[],
  id: string,
): 'reviewed' | 'holding' | 'cancelled' | 'nothing' {
  let reportState: string | undefined
  let latestState: string | undefined
  for (const event of events) {
    const data = recordOf(event.data)
    if (data?.id !== id) continue
    if (event.type === 'freecodego/council') {
      if (typeof data.state === 'string') reportState = data.state
      continue
    }
    if (event.type === 'freecodego/council-state' && typeof data.state === 'string') latestState = data.state
  }
  // The durable report is the wider fact, and it outranks the last state event:
  // a review that ended 'blocked' is evidence even if a later state event moved
  // the job on to its post-review lifecycle ('awaiting_approval', 'implementing').
  if (reportState !== undefined) {
    if (REVIEWED_COUNCIL_REPORT_STATES.has(reportState)) return 'reviewed'
    return reportState === 'cancelled' ? 'cancelled' : 'nothing'
  }
  if (latestState === 'cancelled') return 'cancelled'
  return latestState !== undefined && AUTO_COUNCIL_HOLDING_STATES.has(latestState) ? 'holding' : 'nothing'
}

/** An object as a plain record, or `undefined` for anything else. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * The call a `tool/result` answers: `message.source.callId`.
 *
 * `tool/result`'s data is `{ turn, step, message, error?, meta? }` — it carries no
 * top-level `callId`, and the session invariant resolves the id the same way this
 * does. Matching a result with `event.data.callId` therefore found nothing on any
 * live event, which silently disabled the failure guard in
 * {@link latestApprovedPlan}: a plan-mode exit the tool reported as failed was
 * still handed back as the approved plan.
 */
function toolResultCallId(data: unknown): string | undefined {
  const callId = recordOf(recordOf(recordOf(data)?.message)?.source)?.callId
  return typeof callId === 'string' ? callId : undefined
}

export function latestApprovedPlan(events: readonly { readonly type: string; readonly data: unknown }[]): string | undefined {
  const latestStart = [...events].reverse().find(event => event.type === 'turn/start')
  const currentTurn = latestStart !== undefined && typeof latestStart.data === 'object' && latestStart.data !== null && !Array.isArray(latestStart.data) && typeof (latestStart.data as { readonly turn?: unknown }).turn === 'number' ? (latestStart.data as { readonly turn: number }).turn : undefined
  const call = [...events].reverse().find(event => event.type === 'tool/call' && (currentTurn === undefined || (typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data) && (event.data as { readonly turn?: unknown }).turn === currentTurn)) && typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data) && (event.data as { readonly name?: unknown }).name === 'exit_plan_mode')
  if (call === undefined || typeof call.data !== 'object' || call.data === null || Array.isArray(call.data)) return undefined
  const raw = (call.data as { readonly arguments?: unknown }).arguments
  const callId = (call.data as { readonly callId?: unknown }).callId
  if (typeof callId === 'string') {
    // The result is found by the id the Harness actually stores on it, and the
    // verdict is read from where `createToolResultMessage` puts it — the
    // tool-result content block. `error` is the structured companion the invariant
    // only permits alongside a block that says `isError`.
    const result = [...events].reverse().find(event => event.type === 'tool/result' && toolResultCallId(event.data) === callId)
    const resultData = recordOf(result?.data)
    if (resultData !== undefined) {
      const content = recordOf(resultData.message)?.content
      const blockError = Array.isArray(content) && content.some(block => recordOf(block)?.isError === true)
      if (resultData.error !== undefined || blockError) return undefined
    }
  }
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return undefined }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const plan = (parsed as { readonly plan?: unknown }).plan
  return typeof plan === 'string' && /^#\s+\S/u.test(plan.trim()) ? plan.trim() : undefined
}

/**
 * Convert an arbitrary value into one the wire can carry.
 *
 * A cyclic value previously recursed until the stack overflowed, surfacing as
 * an opaque `RangeError` from deep inside the encoder. The cycle is now caught
 * and reported, because a value that cannot be serialised is a caller mistake
 * and the caller needs to know which one.
 *
 * The path is tracked in a closure rather than a second parameter: an exported
 * signature of `(value, seen)` collides with `Array.prototype.map`'s
 * `(value, index)` when the function is passed directly as a callback.
 *
 * @param value - the value to convert.
 * @returns the JSON-safe equivalent.
 * @throws when `value` contains a reference cycle.
 */
export function toJsonValue(value: unknown): JsonValue {
  const convert = (current: unknown, seen: readonly object[]): JsonValue => {
    if (current === null || typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') return current
    if (typeof current !== 'object') return String(current)
    if (seen.includes(current)) throw new Error('value contains a reference cycle and cannot be serialised')
    const path = [...seen, current]
    if (Array.isArray(current)) return current.map(item => convert(item, path))
    return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, nested]) => [key, convert(nested, path)]))
  }
  return convert(value, [])
}
