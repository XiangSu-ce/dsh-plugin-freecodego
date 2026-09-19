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
 * The facts here are the ones a root-scoped slot can actually read. Two rungs of
 * the ladder — `streaming` and `notified` — need to know what the *inside* of a
 * turn is doing, which the session list does not separate: a session reports
 * `running` for the whole turn, whether the model is thinking, a tool is
 * executing, or the reply is streaming. Those two facts are therefore carried as
 * optional inputs with a defined home, and the caller that has a finer feed
 * (the host half sees every agent event) can start supplying them without this
 * module changing.
 */
import type { CompanionSignals } from './arbiter.ts'

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
   * The reply is streaming. Absent (or false) means "not known to be streaming",
   * which is what the session list can honestly say.
   */
  readonly streaming?: boolean | undefined
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

/** The memory of a companion that has not observed anything yet. */
export function emptyMemory(nowMs: number): CompanionSignalMemory {
  return { running: false, lastActivityMs: nowMs, completionUntilMs: nowMs, failedJobKey: undefined, failureUntilMs: nowMs }
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
  const working = observation.liveJobs > 0
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
  return {
    signals: {
      awaitingApproval: observation.awaitingInteraction,
      failed: observation.failedJob && nowMs < failureUntilMs,
      working,
      // A running turn means the agent is producing something; the session list
      // does not say which part of the turn, so thinking is the honest reading.
      thinking: observation.running,
      justCompleted: nowMs < completionUntilMs,
      streaming: observation.streaming === true,
      notified: observation.notified === true,
      longIdle: !busy && quietMs >= IDLE_AFTER_MS,
    },
    memory: {
      running: observation.running,
      lastActivityMs,
      completionUntilMs,
      failedJobKey: observation.failedJobKey,
      failureUntilMs,
    },
  }
}
