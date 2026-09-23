/**
 * Session facts → companion signals.
 *
 * Pure, like the arbiter it feeds: session facts and the previous call's memory
 * in, signals and the next memory out. The memory exists only for the facts a
 * snapshot cannot carry: an edge (`running` going false is a completion), the
 * deadline that edge opens, and how long nothing has happened.
 *
 * The two hold windows are the judgement here, and both exist for the same
 * reason: a fact about the past is offered as news for a bounded time instead of
 * being presented as the present. A completion has to survive the state it
 * interrupts — the arbiter may be holding a pose, and a one-frame edge would be
 * dropped behind that pose's floor — so it is offered for `COMPLETION_HOLD_MS`
 * rather than one frame, and a new turn withdraws it immediately. A failure has
 * to outlive nothing, but it arrives from a list that never drains, so it is
 * offered for `FAILURE_HOLD_MS` from the moment it is *first seen* and keyed by
 * the failed job's identity: see {@link CompanionObservation.failedJobKey}.
 *
 * The facts here are the ones a root-scoped slot can actually read, plus the share
 * that only the session's own event log can answer, which `./activity.ts` supplies:
 * a session list reports `running` for the whole turn, whether the model is thinking,
 * a tool is executing, or the reply is streaming, and the phases inside a turn are
 * exactly what the poses are for. Those inputs stay optional here — the list-only
 * reading of a session is still a complete observation — so a seat without a feed of
 * its own degrades to the summary rather than to nothing.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { JobView, JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CompanionSignals } from './arbiter.ts'

/**
 * Reading one fact out of the Session list snapshot.
 *
 * These live here, as plain functions over the snapshot, rather than inside the
 * selectors that call them, because the facts have two readers: the React seats
 * read them through the standard Hooks the framework hands a slot, and the
 * transcript's running row (an injected root outside the slot system, see
 * `./running-row.tsx`) reads them off the same snapshots directly. One spelling
 * of each question is what keeps those two surfaces from disagreeing about what
 * the agent is doing — the property `./bar.tsx` and `./companion.tsx` already
 * depend on for their own pair.
 */

/** Stable empty job list, so a reader never returns a fresh array. */
export const NO_JOBS: readonly JobView[] = []

/**
 * @param job - one Session's background job.
 * @returns whether the job is still open, following the jobs surface's own reading.
 */
export function isLiveJob(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * The Session the main view is showing.
 *
 * alpha.2 dropped the selection from the list state, so this is read as local
 * retention by the `mainView` reference source — the rule the renderer itself
 * applies in `UiSession#publishMain`. That method has a fast path this cannot
 * see (the private `current` binding) and falls back to the first row in `byId`
 * order retained by the main view; this is that fallback, in that order, so the
 * two agree whenever the fast path does not apply. `./current-session.ts` reads
 * the same rule for surfaces outside a Session scope.
 * @param state - the Session list snapshot.
 * @returns the displayed Session id, or undefined while no Session is shown.
 */
export function mainViewSessionId(state: SessionListState): SessionId | undefined {
  return Object.values(state.byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * @param state - the Session list snapshot.
 * @param sessionId - the Session to read.
 * @returns whether that Session reports a turn in progress.
 */
export function sessionRunning(state: SessionListState, sessionId: SessionId | undefined): boolean {
  return sessionId !== undefined && state.byId[sessionId]?.running === true
}

/**
 * @param jobs - the client jobs snapshot.
 * @param sessionId - the Session to read.
 * @returns how many of that Session's background jobs are still open.
 */
export function liveJobCount(jobs: JobsSnapshot, sessionId: SessionId | undefined): number {
  if (sessionId === undefined) return 0
  let live = 0
  for (const job of jobs.rows[sessionId] ?? NO_JOBS) if (isLiveJob(job)) live += 1
  return live
}

/**
 * The newest failed background job of one Session, by identity.
 *
 * The host's list is append-ordered and drains nothing, so the last failed entry
 * is the most recently started one, and its id is what changes when another job
 * fails. See `CompanionObservation.failedJobKey` for why a boolean cannot stand
 * in for this.
 * @param jobs - the client jobs snapshot.
 * @param sessionId - the Session to read.
 * @returns the newest failed job's id, or undefined when the roster holds none.
 */
export function newestFailedJobKey(jobs: JobsSnapshot, sessionId: SessionId | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  let newest: string | undefined
  for (const job of jobs.rows[sessionId] ?? NO_JOBS) {
    if (job.status === 'failed') newest = job.id
  }
  return newest
}

/**
 * @param statuses - the unified Session UI status snapshot.
 * @param sessionId - the Session to read.
 * @returns whether a domain-owned request is waiting on the user there.
 */
export function awaitingInteraction(
  statuses: SessionStatusSnapshot,
  sessionId: SessionId | undefined,
): boolean {
  return sessionId !== undefined && statuses.get(sessionId)?.pendingInteraction !== undefined
}

/**
 * Everything a root-scoped companion can observe about the selected session.
 *
 * The first four come from the session list and the pending-interaction map; the
 * last two are the seam for a finer feed.
 */
export interface CompanionObservation {
  /** The selected session reports a turn in progress. */
  readonly running: boolean
  /** Background jobs of the selected session that are still live. */
  readonly liveJobs: number
  /** A background job of the selected session ended in failure. */
  readonly failedJob: boolean
  /**
   * Identity of the newest failed background job in that list, if there is one.
   *
   * A level boolean cannot be this module's `failed` signal, and not because of
   * flicker: the session's job list is not a queue that drains. `jobs-local`
   * prunes nothing until the owning agent is disposed, so a job that failed once
   * stays listed for the rest of the session — which, as a signal, means the
   * arbiter would hold the failure pose (rank 90, above working, thinking and a
   * completion) until the session ends. Measured: with one failed job still
   * listed, a turn started a minute later was drawn as `exclaim` while `working`
   * and `thinking` were both true.
   *
   * The identity is what makes a *second* failure news again, which no boolean
   * over that list can do. `undefined` means the list holds no failure.
   */
  readonly failedJobKey: string | undefined
  /** A domain-owned interaction is waiting on the user in the selected session. */
  readonly awaitingInteraction: boolean
  /**
   * A tool or command call is executing right now.
   *
   * Comes from the session's own event log (`./activity.ts`), not from the job list:
   * a job is background work the user may not be looking at, while this is the tool
   * the running turn is waiting on — which is the more precise reading of "working".
   */
  readonly toolRunning?: boolean | undefined
  /**
   * The reply is streaming. Absent (or false) means "not known to be streaming",
   * which is what the session list can honestly say.
   */
  readonly streaming?: boolean | undefined
  /**
   * Identity of the newest turn that started, as news.
   *
   * An identity rather than a flag because a start is an instant, and the event that
   * records it stays in the log for the rest of the session: a level reading would
   * announce the first turn forever and the fiftieth never.
   */
  readonly startKey?: string | undefined
  /**
   * Identity of the newest turn that ended in failure, as news.
   *
   * The list's job failures cannot stand in for this — a turn that fails is not a
   * job — and {@link CompanionObservation.failedJobKey} explains why the identity
   * is the field rather than a boolean.
   */
  readonly failureKey?: string | undefined
  /** Identity of the newest message injected from outside the turn, as news. */
  readonly noticeKey?: string | undefined
  /** A message or subagent result arrived outside the current turn. */
  readonly notified?: boolean | undefined
}

/** What the projection remembers between calls. */
export interface CompanionSignalMemory {
  /** Previous `running`, so a turn ending can be seen as an edge. */
  readonly running: boolean
  /** When activity was last observed, in milliseconds. */
  readonly lastActivityMs: number
  /** Until when a completion is still offered, in milliseconds. */
  readonly completionUntilMs: number
  /** The failure already announced, so only a different one is announced again. */
  readonly failedJobKey: string | undefined
  /** Until when a failure is still offered, in milliseconds. */
  readonly failureUntilMs: number
  /** The turn start already announced, so only a different turn is announced. */
  readonly startKey: string | undefined
  /** Until when a turn start is still offered, in milliseconds. */
  readonly startUntilMs: number
  /** The failed turn already announced, so only a different one is news. */
  readonly turnFailureKey: string | undefined
  /** Until when a failed turn is still offered, in milliseconds. */
  readonly turnFailureUntilMs: number
  /** The outside message already announced, so only a different one is news. */
  readonly noticeKey: string | undefined
  /** Until when an outside message is still offered, in milliseconds. */
  readonly noticeUntilMs: number
}

/** Quiet time after which the companion powers down. */
export const IDLE_AFTER_MS = 90_000

/**
 * How long a completion keeps being offered.
 *
 * A completion must outlive the dwell of whatever state was on screen when it
 * landed: a turn that ends 100ms into a `thinking` pose is suppressed by that
 * pose's floor, and a single-frame edge would simply be thrown away. The largest
 * floor in the ladder is `orbit`'s 2.5s, which it takes from the engine's own
 * `minDuration` rather than from its rung, so this window is longer than any of
 * them while still being bounded — the flag has to expire, or a finished turn
 * would outrank the quiet pose forever.
 */
export const COMPLETION_HOLD_MS = 4_000

/**
 * How long a failure keeps being offered.
 *
 * The same judgement as the completion window, for a fact with the opposite life:
 * the failure is offered long enough to be seen whatever the arbiter was holding
 * when it landed (the rung asks for 1 200 ms, and the engine's own floor can be
 * longer than that), and then it stops being the answer, because the fact behind
 * it never goes away on its own. Without this the pose is a status line that says
 * "failed" for the rest of the session, whichever session it is in.
 */
export const FAILURE_HOLD_MS = 4_000

/**
 * How long a turn start keeps being offered.
 *
 * Same judgement as the two windows above, for the shortest-lived fact of the three:
 * a start is over as soon as the model produces anything, so the window only has to
 * outlive the pose it plays (`play`, 2 s) plus its own entry morph. It is also what
 * keeps the greeting from replaying: the window closes on its own, and the next turn
 * carries a different identity.
 */
export const START_HOLD_MS = 2_800

/**
 * How long an outside message keeps being offered.
 *
 * Shorter than a failure's, longer than a start's: a message injected into the turn
 * is worth noticing but is not a request for action, so it announces itself without
 * holding the row.
 */
export const NOTICE_HOLD_MS = 3_200

/**
 * How long a session rests before the character stirs again.
 *
 * The resting character is a living mark, not a still one: a session waiting for its
 * next prompt is where the companion is seen most, and a mark that never moves in
 * that time reads as broken rather than as calm. So the quiet poses are interrupted
 * by a short flourish from the engine's catalogue on this period.
 *
 * It is shorter than a quarter of {@link IDLE_AFTER_MS} on purpose. The period and
 * the power-down are the two ends of the same stretch of quiet, and the catalogue has
 * four poses in it: at this rate a session that is left alone plays all four and
 * *then* powers down, where a longer period would put the last pose past the
 * power-down and make it unreachable — a catalogue entry no session could ever show.
 */
export const FLOURISH_PERIOD_MS = 20_000

/**
 * How long a flourish is offered at each period.
 *
 * The signal is a window inside each period rather than a level, which is what makes
 * the rotation repeat: the arbiter's one-shot latch releases while the window is
 * closed, and the next period offers the next pose in the catalogue. The periods are
 * counted on the shared clock rather than from each seat's own quiet time, so every
 * seat opens the same window at the same instant and reads the same step out of it —
 * the character stirs once, in every place it is drawn.
 */
export const FLOURISH_WINDOW_MS = 2_600

/**
 * The memory of a companion that has not observed anything yet.
 * @param nowMs - monotonic milliseconds from the arbiter's clock.
 * @returns the companion Signal Memory.
 */
export function emptyMemory(nowMs: number): CompanionSignalMemory {
  return {
    running: false,
    lastActivityMs: nowMs,
    completionUntilMs: nowMs,
    failedJobKey: undefined,
    failureUntilMs: nowMs,
    startKey: undefined,
    startUntilMs: nowMs,
    turnFailureKey: undefined,
    turnFailureUntilMs: nowMs,
    noticeKey: undefined,
    noticeUntilMs: nowMs,
  }
}

/** One projection step. */
export interface ProjectedSignals {
  /** What the arbiter should see. */
  readonly signals: CompanionSignals
  /** Memory to pass to the next call. */
  readonly memory: CompanionSignalMemory
}

/**
 * Project session facts into arbiter signals.
 * @param observation - the session facts available at this scope.
 * @param nowMs - monotonic milliseconds from the same clock the arbiter uses.
 * @param memory - the previous call's memory.
 * @returns the signals to feed the arbiter and the memory for the next call.
 */
export function projectSignals(
  observation: CompanionObservation,
  nowMs: number,
  memory: CompanionSignalMemory,
): ProjectedSignals {
  // Two independent readings of "working": a background job the session is running
  // (the list's own field) and the tool the running turn is waiting on (the event
  // log's). Either one is work, so the row says working for either.
  const working = observation.liveJobs > 0 || observation.toolRunning === true
  const busy = observation.running || working || observation.awaitingInteraction
  // The edge is what restarts the quiet timer; the offered window below is what
  // the arbiter sees, and the two are not the same fact.
  const edge = memory.running && !observation.running
  const lastActivityMs = busy || edge ? nowMs : memory.lastActivityMs
  const quietMs = nowMs - lastActivityMs
  // A new turn withdraws any completion still on offer; otherwise the window is
  // opened by the edge and left to expire on its own.
  const completionUntilMs = observation.running
    ? nowMs
    : (edge ? nowMs + COMPLETION_HOLD_MS : memory.completionUntilMs)
  // A failure the list is still holding is not the same fact as a failure that
  // just happened, and only the second one is a signal. The window is opened by a
  // *different* failed job than the one already offered, so a second failure is
  // news too; a seat that mounts (or switches sessions) while the list already
  // holds a failure announces it once, briefly, rather than never.
  const failureIsNew = observation.failedJobKey !== undefined && observation.failedJobKey !== memory.failedJobKey
  const failureUntilMs = failureIsNew ? nowMs + FAILURE_HOLD_MS : memory.failureUntilMs
  // The three news windows of the event log, all opened the same way and for the
  // same reason: the fact is durable and stays in the log, so only a *different*
  // one is news, and only for as long as its pose needs.
  const startIsNew = observation.startKey !== undefined && observation.startKey !== memory.startKey
  const startUntilMs = startIsNew ? nowMs + START_HOLD_MS : memory.startUntilMs
  const turnFailureIsNew = observation.failureKey !== undefined && observation.failureKey !== memory.turnFailureKey
  const turnFailureUntilMs = turnFailureIsNew ? nowMs + FAILURE_HOLD_MS : memory.turnFailureUntilMs
  const noticeIsNew = observation.noticeKey !== undefined && observation.noticeKey !== memory.noticeKey
  const noticeUntilMs = noticeIsNew ? nowMs + NOTICE_HOLD_MS : memory.noticeUntilMs
  // Powered down is the end of the resting state, not a pose that competes with it:
  // a session left alone stirs a few times and then goes to sleep, rather than
  // stirring forever and never powering down.
  const longIdle = !busy && quietMs >= IDLE_AFTER_MS
  // The resting periods are counted from the clock, not from this seat's quiet time:
  // several seats draw the one character, they do not share a mounting instant, and a
  // phase derived from when this seat happened to open would have them stirring at
  // different moments with different poses. A quiet session must also have rested a
  // whole period first, so the flourish never lands on the heels of a turn.
  const period = Math.floor(nowMs / FLOURISH_PERIOD_MS)
  const flourishDue = !busy && !longIdle && quietMs >= FLOURISH_PERIOD_MS
    && nowMs % FLOURISH_PERIOD_MS < FLOURISH_WINDOW_MS
  return {
    signals: {
      awaitingApproval: observation.awaitingInteraction,
      failed: (observation.failedJob && nowMs < failureUntilMs)
        || (observation.failureKey !== undefined && nowMs < turnFailureUntilMs),
      working,
      // A running turn means the agent is producing something; the phases inside it
      // arrive separately (a tool executing, the reply being written), and this is
      // the reading for the part of the turn that has neither — the model thinking.
      thinking: observation.running,
      justCompleted: nowMs < completionUntilMs,
      starting: observation.startKey !== undefined && nowMs < startUntilMs,
      streaming: observation.streaming === true,
      notified: observation.notified === true
        || (observation.noticeKey !== undefined && nowMs < noticeUntilMs),
      // A flourish is offered inside each period, not from the period onwards. A
      // level signal would be latched by the first flourish and never released,
      // because the quiet time it is derived from only ever grows. The step is 0
      // whenever none is due, so a pose is only ever read out of it in a window.
      restless: flourishDue,
      restlessStep: flourishDue ? period : 0,
      longIdle,
    },
    memory: {
      running: observation.running,
      lastActivityMs,
      completionUntilMs,
      failedJobKey: observation.failedJobKey,
      failureUntilMs,
      startKey: observation.startKey,
      startUntilMs,
      turnFailureKey: observation.failureKey,
      turnFailureUntilMs,
      noticeKey: observation.noticeKey,
      noticeUntilMs,
    },
  }
}
