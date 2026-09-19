/**
 * Which companion state the current session activity calls for.
 *
 * This module is pure: `decide(signals, now)` in, a state id out. It holds no
 * clock, no DOM, and no engine, which is what lets the whole event → animation
 * mapping be asserted in unit tests without mounting anything.
 *
 * Three rules keep the picture from flickering, and each exists for an observed
 * failure rather than for symmetry:
 *
 * - **A dwell floor.** Entering a state commits to it for at least its floor, so a
 *   burst of tool calls cannot strobe the picture between `orbit` and `thinking`.
 *   The floor is the engine's own `minDuration` where the state has one — that
 *   value is measured from the source material and means "cutting here leaves the
 *   body mid-morph", so it is a hard constraint, not a preference.
 * - **Urgency preemption.** A more urgent signal does break the floor. Waiting for
 *   a permission prompt or an error must never be hidden behind the tail of a
 *   decorative completion.
 * - **One-shot latching.** `burst` and friends play once and then fall through to
 *   whatever else is true. The signal is latched when its state finishes so a
 *   level-triggered `justCompleted` cannot replay it on every frame; the latch
 *   clears when the signal goes false, so the next completion plays again.
 */
import { STATE_BY_ID, type StateId } from './engine/states.ts'

/** What the session is doing, as the arbiter sees it. */
export interface CompanionSignals {
  /** A human decision is pending: a permission prompt or a question. Blocks everything. */
  awaitingApproval: boolean
  /** The most recent turn ended in a failure. */
  failed: boolean
  /** Tools or subagents are executing right now. */
  working: boolean
  /** A turn is open but nothing has been emitted yet — the model is thinking. */
  thinking: boolean
  /** A turn just finished. Consumed once, then latched until it clears. */
  justCompleted: boolean
  /** The reply is streaming. */
  streaming: boolean
  /** A message arrived from outside the current turn. Consumed like a completion. */
  notified: boolean
  /** Nothing has happened for long enough to power down. */
  longIdle: boolean
}

/** Every signal false: the resting pose. */
export const IDLE_SIGNALS: CompanionSignals = {
  awaitingApproval: false,
  failed: false,
  working: false,
  thinking: false,
  justCompleted: false,
  streaming: false,
  notified: false,
  longIdle: false,
}

/** One rung of the ladder. */
interface Rule {
  /** The signal that selects this state. */
  signal: keyof CompanionSignals
  /** The engine state it selects. */
  state: StateId
  /**
   * Urgency. A request only preempts a state already on screen when its rank is
   * strictly higher, so equal urgency waits out the dwell instead of flapping.
   */
  rank: number
  /** Plays to completion once, then falls through to the next satisfied rule. */
  once?: boolean
  /** Dwell floor in milliseconds, used when the engine declares no `minDuration`. */
  floorMs: number
}

/**
 * The ladder, most urgent first. `idle` is the implicit floor and is not listed:
 * it is what remains when nothing is true.
 */
const LADDER: readonly Rule[] = [
  // A waiting human outranks everything: this is the one state that is a request
  // for action, not a description of work.
  { signal: 'awaitingApproval', state: 'alert', rank: 100, floorMs: 2000 },
  { signal: 'failed', state: 'exclaim', rank: 90, floorMs: 1200 },
  { signal: 'working', state: 'orbit', rank: 70, floorMs: 800 },
  { signal: 'thinking', state: 'thinking', rank: 60, floorMs: 600 },
  { signal: 'justCompleted', state: 'burst', rank: 50, once: true, floorMs: 800 },
  { signal: 'streaming', state: 'comet', rank: 40, floorMs: 800 },
  { signal: 'notified', state: 'notify', rank: 30, once: true, floorMs: 1000 },
  { signal: 'longIdle', state: 'sleep', rank: 20, floorMs: 2000 },
]

const IDLE_STATE: StateId = 'idle'

/**
 * The dwell floor of a state: the engine's own `minDuration` when it declares one
 * (that is a measured "do not cut here"), otherwise the rung's preference.
 * @param state - state whose floor is wanted.
 * @param floorMs - the rung's own preference, in milliseconds.
 * @returns the floor in milliseconds.
 */
function dwellFloorMs(state: StateId, floorMs: number): number {
  const declared = STATE_BY_ID.get(state)?.minDuration
  return declared === undefined ? floorMs : Math.max(floorMs, declared * 1000)
}

/**
 * Urgency of a state, read from the ladder so the two can never drift. A state
 * with no rung — `idle`, or one this companion never calls for — ranks lowest.
 * @param state - state to rank.
 * @returns its rank; 0 when it has no rung.
 */
function rankOf(state: StateId): number {
  return LADDER.find(rule => rule.state === state)?.rank ?? 0
}

/** A decision: the state to show, and why it is allowed to change now. */
export interface CompanionDecision {
  /** The state to render. */
  state: StateId
  /** True when this call is the one that changed the state. */
  changed: boolean
  /** How long the state has been on screen, in milliseconds. */
  elapsedMs: number
}

/**
 * Holds the current state across calls and applies the dwell, urgency, and
 * one-shot rules. One instance drives one companion.
 */
export class CompanionArbiter {
  private current: StateId = IDLE_STATE
  private sinceMs = 0
  private started = false
  /** One-shot signals whose state has played out and must not replay. */
  private readonly latched = new Set<keyof CompanionSignals>()

  /**
   * The state the signals ask for, ignoring everything already on screen.
   * @param signals - the current session activity.
   * @returns the first satisfied rung, or `idle`.
   */
  requested(signals: CompanionSignals): StateId {
    // Clearing first, over the whole ladder, is what makes a latch release
    // reliable. Clearing it inside the selection loop below would only reach the
    // one-shot rungs when no more urgent rule matched first, and a latch that
    // outlives its signal swallows the next completion: a turn that starts inside
    // the previous completion's hold window stops the scan at `thinking`, so the
    // burst that follows that turn would never play.
    for (const rule of LADDER) if (!signals[rule.signal]) this.latched.delete(rule.signal)
    for (const rule of LADDER) {
      if (!signals[rule.signal]) continue
      if (rule.once === true && this.latched.has(rule.signal)) continue
      return rule.state
    }
    return IDLE_STATE
  }

  /**
   * Advance to the state the signals call for, subject to the dwell rules.
   * @param signals - the current session activity.
   * @param nowMs - monotonic milliseconds.
   * @returns the state to render and whether this call changed it.
   */
  decide(signals: CompanionSignals, nowMs: number): CompanionDecision {
    const wanted = this.requested(signals)
    if (!this.started) {
      this.started = true
      this.current = wanted
      this.sinceMs = nowMs
      return { state: this.current, changed: true, elapsedMs: 0 }
    }

    const elapsedMs = nowMs - this.sinceMs
    const currentRank = rankOf(this.current)
    const wantedRank = rankOf(wanted)
    const finishedOnce = this.isOnce(this.current) && elapsedMs >= this.floorOf(this.current)

    // A one-shot that has played out stops asking for itself: latch its signal so
    // the ladder falls through to whatever else is true.
    if (finishedOnce) {
      const rule = LADDER.find(candidate => candidate.state === this.current)
      if (rule !== undefined && signals[rule.signal]) this.latched.add(rule.signal)
      const fallback = this.requested(signals)
      return this.commit(fallback, nowMs)
    }

    if (wanted === this.current) return { state: this.current, changed: false, elapsedMs }

    const dwellMs = this.floorOf(this.current)
    // Below the floor, only a strictly more urgent request gets through.
    if (elapsedMs < dwellMs && wantedRank <= currentRank) {
      return { state: this.current, changed: false, elapsedMs }
    }
    return this.commit(wanted, nowMs)
  }

  /**
   * @param state - state whose floor is wanted.
   * @returns the dwell floor in milliseconds.
   */
  private floorOf(state: StateId): number {
    const rule = LADDER.find(candidate => candidate.state === state)
    // A state with no rung — `idle`, above all — has no floor. Resting is not a
    // pose worth protecting: a turn starting must be visible on the next frame.
    // What keeps a *busy* state on screen is its own floor, not a floor under
    // the state it falls back to.
    if (rule === undefined) return 0
    return dwellFloorMs(state, rule.floorMs)
  }

  /** @returns true when the state plays to completion once. */
  private isOnce(state: StateId): boolean {
    return LADDER.find(candidate => candidate.state === state)?.once === true
  }

  /**
   * Commit to a different state. Both call sites have already established that
   * the state is changing, so this always reports a change.
   * @param state - the state to commit to.
   * @param nowMs - monotonic milliseconds.
   * @returns the decision for the new state.
   */
  private commit(state: StateId, nowMs: number): CompanionDecision {
    this.current = state
    this.sinceMs = nowMs
    return { state, changed: true, elapsedMs: 0 }
  }
}
