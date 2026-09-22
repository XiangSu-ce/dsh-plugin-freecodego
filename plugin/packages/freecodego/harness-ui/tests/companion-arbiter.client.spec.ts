/**
 * The companion's decision layer is pure, so its whole contract is assertable
 * without a DOM, a clock, or an engine: which state a session's activity calls
 * for, when a state may be interrupted, and when a one-shot may play again.
 *
 * The dwell floors are the interesting part. The engine declares `minDuration`
 * for exactly those states where cutting the animation short leaves the body
 * mid-morph, so the arbiter's floor is not a taste decision — these tests pin
 * that the engine's number wins over the ladder's preference.
 */

import { describe, expect, it } from 'vitest'
import { CompanionArbiter, FLOURISHES, IDLE_SIGNALS, type CompanionSignals } from '../src/client/companion/arbiter.ts'
import {
  COMPLETION_HOLD_MS,
  FAILURE_HOLD_MS,
  FLOURISH_PERIOD_MS,
  FLOURISH_WINDOW_MS,
  IDLE_AFTER_MS,
  NOTICE_HOLD_MS,
  START_HOLD_MS,
  emptyMemory,
  projectSignals,
  type CompanionObservation,
} from '../src/client/companion/signals.ts'
import { STATE_BY_ID, type StateId } from '../src/client/companion/engine/states.ts'

const signals = (over: Partial<CompanionSignals> = {}): CompanionSignals => ({ ...IDLE_SIGNALS, ...over })

const observation = (over: Partial<CompanionObservation> = {}): CompanionObservation => ({
  running: false,
  liveJobs: 0,
  failedJob: false,
  failedJobKey: undefined,
  awaitingInteraction: false,
  ...over,
})

/** A session whose job list holds one failed job, and the key that identifies it. */
const failure = (key: string, over: Partial<CompanionObservation> = {}): CompanionObservation =>
  observation({ failedJob: true, failedJobKey: key, ...over })

describe('companion arbiter: which state the activity calls for', () => {
  it('rests with no signals at all', () => {
    expect(new CompanionArbiter().requested(signals())).toBe('idle')
  })

  it('maps each rung to its own state', () => {
    const arbiter = new CompanionArbiter()
    expect(arbiter.requested(signals({ longIdle: true }))).toBe('sleep')
    expect(arbiter.requested(signals({ restless: true }))).toBe('egg')
    expect(arbiter.requested(signals({ notified: true }))).toBe('notify')
    expect(arbiter.requested(signals({ justCompleted: true }))).toBe('burst')
    expect(arbiter.requested(signals({ streaming: true }))).toBe('comet')
    expect(arbiter.requested(signals({ starting: true }))).toBe('play')
    expect(arbiter.requested(signals({ thinking: true }))).toBe('thinking')
    expect(arbiter.requested(signals({ working: true }))).toBe('orbit')
    expect(arbiter.requested(signals({ failed: true }))).toBe('exclaim')
    expect(arbiter.requested(signals({ awaitingApproval: true }))).toBe('alert')
  })

  it('ranks every phase inside a turn above the turn itself', () => {
    // The list reports `running` for the whole turn, so `thinking` is true beside
    // every in-turn phase. A rung below it could never be observed for the length of
    // a turn at all — which is exactly the defect this pins: `streaming` and
    // `notified` used to sit under `thinking`, so the two poses with their own
    // signals never appeared. Raising one of them under `thinking` again fails here.
    const arbiter = new CompanionArbiter()
    expect(arbiter.requested(signals({ thinking: true, working: true }))).toBe('orbit')
    expect(arbiter.requested(signals({ thinking: true, streaming: true }))).toBe('comet')
    expect(arbiter.requested(signals({ thinking: true, starting: true }))).toBe('play')
    expect(arbiter.requested(signals({ thinking: true, notified: true }))).toBe('notify')
  })

  it('plays the greeting once, then hands the turn to its phases', () => {
    const arbiter = new CompanionArbiter()
    expect(arbiter.decide(signals({ starting: true, thinking: true }), 0).state).toBe('play')
    // The start is still news when the reply begins: the greeting yields to the
    // turn's own phase once its beat is over, rather than holding the row.
    expect(arbiter.decide(signals({ starting: true, thinking: true, streaming: true }), 1_700).state).toBe('comet')
  })

  it('plays the whole resting catalogue before the session powers down', () => {
    // The two halves driven together, on one clock, the way a seat drives them: the
    // period decides when a flourish is due and which step it is, and the arbiter
    // reads the pose out of that step. One pose per period, then round again, and the
    // catalogue is short enough to finish inside a quiet stretch — the last entry is
    // reachable, and a fifth period finds the session powered down instead.
    const arbiter = new CompanionArbiter()
    /** The catalogue as a rotation starting at a step: what a stretch of rest plays. */
    const rotation = (from: number): StateId[] => [...FLOURISHES.slice(from), ...FLOURISHES.slice(0, from)]
    const played: StateId[] = []
    // The first window a session can be in is the end of its first full period of rest.
    let memory = emptyMemory(0)
    for (let period = 1; period <= FLOURISHES.length; period += 1) {
      const at = FLOURISH_PERIOD_MS * period
      const due = projectSignals(observation(), at, memory)
      memory = due.memory
      expect(due.signals.restless).toBe(true)
      expect(due.signals.restlessStep).toBe(period)
      played.push(arbiter.decide(due.signals, at).state)
      // The pose serves its floor and then falls through to rest, while the window is
      // still open — a held rung must not walk a catalogue it has not played.
      expect(arbiter.decide(due.signals, at + 2_200).state).toBe('idle')
      expect(arbiter.decide(due.signals, at + 2_200).state).toBe('idle')
      // The window closes inside the period, which is what releases the one-shot
      // latch: a level signal would be latched away after the first flourish.
      const closed = projectSignals(observation(), at + FLOURISH_WINDOW_MS, memory)
      memory = closed.memory
      expect(closed.signals.restless).toBe(false)
      expect(closed.signals.restlessStep).toBe(0)
      expect(arbiter.decide(closed.signals, at + FLOURISH_WINDOW_MS).state).toBe('idle')
    }
    // The step is the clock's period index, so the rotation starts wherever the phase
    // happened to be and runs in catalogue order from there — four windows, four
    // poses, none repeated.
    expect(played).toEqual(rotation(1))
    expect(new Set(played).size).toBe(FLOURISHES.length)
    // And the wrap is the catalogue's own length, so a fifth window — were one
    // reachable — would open on the first entry again.
    const wrapping = new CompanionArbiter()
    expect(wrapping.requested(signals({ restless: true, restlessStep: FLOURISHES.length }))).toBe(FLOURISHES[0])

    const asleepAt = FLOURISH_PERIOD_MS * (FLOURISHES.length + 1)
    const asleep = projectSignals(observation(), asleepAt, memory)
    expect(asleep.signals.longIdle).toBe(true)
    expect(asleep.signals.restless).toBe(false)
    expect(arbiter.decide(asleep.signals, asleepAt).state).toBe('sleep')
  })

  it('lets the most urgent simultaneous signal win', () => {
    const arbiter = new CompanionArbiter()
    expect(arbiter.requested(signals({
      awaitingApproval: true, failed: true, working: true, thinking: true, streaming: true, justCompleted: true,
    }))).toBe('alert')
    expect(arbiter.requested(signals({ working: true, thinking: true }))).toBe('orbit')
  })

  it('starts on the state the signals call for, and reports the change', () => {
    const arbiter = new CompanionArbiter()
    expect(arbiter.decide(signals({ thinking: true }), 0)).toEqual({ state: 'thinking', changed: true, elapsedMs: 0 })
  })
})

describe('companion arbiter: dwell', () => {
  it('holds a state past a lower-urgency request until its floor passes', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ thinking: true }), 0)
    // thinking's floor is its own 600ms preference — the engine declares no floor.
    expect(arbiter.decide(signals(), 100).state).toBe('thinking')
    expect(arbiter.decide(signals(), 700).state).toBe('idle')
  })

  it('puts no floor under rest, so any activity shows on the next decision', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ working: true }), 0)
    arbiter.decide(signals(), 3_000)
    // The very next frame after falling back to rest may leave it again: a turn
    // starting must not wait out a floor on the pose it starts from.
    expect(arbiter.decide(signals({ thinking: true }), 3_001).state).toBe('thinking')
  })

  it("honours the engine's own minDuration over the rung's preference", () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ working: true }), 0)
    // orbit's rung asks for 800ms, but the engine declares minDuration 2.5s.
    expect(arbiter.decide(signals(), 1_000).state).toBe('orbit')
    expect(arbiter.decide(signals(), 2_600).state).toBe('idle')
  })

  it('does not repeat a change that is already on screen', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ thinking: true }), 0)
    expect(arbiter.decide(signals({ thinking: true }), 1_000)).toEqual({ state: 'thinking', changed: false, elapsedMs: 1_000 })
  })
})

describe('companion arbiter: preemption', () => {
  it('lets a more urgent request break the floor', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ thinking: true }), 0)
    // A waiting human outranks a running turn, immediately.
    expect(arbiter.decide(signals({ thinking: true, awaitingApproval: true }), 50).state).toBe('alert')
  })

  it('does not let a less urgent request break it', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ awaitingApproval: true }), 0)
    // Streaming ranks below the approval prompt, so it waits its turn.
    expect(arbiter.decide(signals({ awaitingApproval: true, streaming: true }), 50).state).toBe('alert')
  })
})

describe('companion arbiter: one-shot states', () => {
  it('plays a completion once, then falls through while the signal stays true', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ justCompleted: true }), 0)
    expect(arbiter.decide(signals({ justCompleted: true }), 1_000).state).toBe('burst')
    // Its floor is the engine's 2.4s, so the fall-through waits for it.
    expect(arbiter.decide(signals({ justCompleted: true }), 2_500).state).toBe('idle')
    expect(arbiter.decide(signals({ justCompleted: true }), 9_000).state).toBe('idle')
  })

  it('plays again once the signal clears and returns', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ justCompleted: true }), 0)
    arbiter.decide(signals({ justCompleted: true }), 2_500)
    expect(arbiter.requested(signals({ justCompleted: true }))).toBe('idle')
    expect(arbiter.requested(signals())).toBe('idle')
    expect(arbiter.requested(signals({ justCompleted: true }))).toBe('burst')
  })

  it('releases a latch that a more urgent rung stopped the scan before reaching', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ justCompleted: true }), 0)
    // The burst serves its floor and latches the completion...
    arbiter.decide(signals({ justCompleted: true }), 2_500)
    // ...then a new turn starts inside the completion's hold window. The signals
    // module withdraws `justCompleted` the moment `running` returns and raises
    // `thinking`, so the ladder stops at `thinking` — above the one-shot rung.
    expect(arbiter.decide(signals({ thinking: true }), 2_600).state).toBe('thinking')
    expect(arbiter.decide(signals({ thinking: true }), 3_000).state).toBe('thinking')
    // That turn's own completion must still play: a latch cleared only by the
    // scan that reaches it would have survived the whole turn and swallowed it.
    expect(arbiter.requested(signals({ justCompleted: true }))).toBe('burst')
    expect(arbiter.decide(signals({ justCompleted: true }), 4_000).state).toBe('burst')
  })

  it('latches nothing when the completing signal has already cleared', () => {
    const arbiter = new CompanionArbiter()
    arbiter.decide(signals({ justCompleted: true }), 0)
    // The signal is gone by the time the floor passes: the fall-through must not
    // latch a signal that is not asking for anything.
    expect(arbiter.decide(signals(), 2_500).state).toBe('idle')
    expect(arbiter.requested(signals({ justCompleted: true }))).toBe('burst')
  })
})

describe('companion signals: session facts to activity', () => {
  it('reads a running turn as thinking and keeps the companion awake', () => {
    const { signals: out, memory } = projectSignals(observation({ running: true }), 0, emptyMemory(0))
    expect(out.thinking).toBe(true)
    expect(out.working).toBe(false)
    expect(out.longIdle).toBe(false)
    expect(memory).toEqual({
      running: true,
      lastActivityMs: 0,
      completionUntilMs: 0,
      failedJobKey: undefined,
      failureUntilMs: 0,
      startKey: undefined,
      startUntilMs: 0,
      turnFailureKey: undefined,
      turnFailureUntilMs: 0,
      noticeKey: undefined,
      noticeUntilMs: 0,
    })
  })

  it('reads a tool in flight and a reply being written as the work they are', () => {
    // The event log's two facts for the inside of a turn: the turn is running in
    // both cases, so neither reading is a different *turn* state — they are the
    // phases the session list cannot separate.
    const tool = projectSignals(observation({ running: true, toolRunning: true }), 0, emptyMemory(0)).signals
    expect(tool.working).toBe(true)
    expect(tool.streaming).toBe(false)
    const writing = projectSignals(observation({ running: true, streaming: true }), 0, emptyMemory(0)).signals
    expect(writing.streaming).toBe(true)
    expect(writing.working).toBe(false)
  })

  it('counts a tool in flight as activity, so it never powers down mid-call', () => {
    const idle = projectSignals(observation(), IDLE_AFTER_MS, emptyMemory(0))
    expect(idle.signals.longIdle).toBe(true)
    const calling = projectSignals(observation({ toolRunning: true }), IDLE_AFTER_MS + 1, idle.memory)
    expect(calling.signals.longIdle).toBe(false)
  })

  it('offers a turn start once, for its own window, and again for the next turn', () => {
    const started = projectSignals(observation({ startKey: '12' }), 0, emptyMemory(0))
    expect(started.signals.starting).toBe(true)
    const held = projectSignals(observation({ startKey: '12' }), START_HOLD_MS - 1, started.memory)
    expect(held.signals.starting).toBe(true)
    expect(projectSignals(observation({ startKey: '12' }), START_HOLD_MS, held.memory).signals.starting).toBe(false)
    // A turn that starts before the previous window closed is still a new start.
    const again = projectSignals(observation({ startKey: '40' }), START_HOLD_MS, held.memory)
    expect(again.signals.starting).toBe(true)
  })

  it('draws a failed turn, which no job list could report', () => {
    // The measured gap: a turn that fails ends with an error and no job, so the
    // job-derived `failed` was silent for exactly the failure the reader saw on
    // screen. The failure identity is the event's own sequence number.
    const failed = projectSignals(observation({ failureKey: '31' }), 0, emptyMemory(0))
    expect(failed.signals.failed).toBe(true)
    const settled = projectSignals(observation({ failureKey: '31' }), FAILURE_HOLD_MS, failed.memory)
    expect(settled.signals.failed).toBe(false)
  })

  it('announces a message injected from outside the turn, and not the prompt itself', () => {
    const injected = projectSignals(observation({ noticeKey: '7' }), 0, emptyMemory(0))
    expect(injected.signals.notified).toBe(true)
    expect(projectSignals(observation({ noticeKey: '7' }), NOTICE_HOLD_MS, injected.memory).signals.notified).toBe(false)
  })

  it('stirs a resting session on a period, and leaves it alone mid-turn', () => {
    const early = projectSignals(observation(), FLOURISH_PERIOD_MS - 1, emptyMemory(0))
    expect(early.signals.restless).toBe(false)
    expect(early.signals.restlessStep).toBe(0)
    const due = projectSignals(observation(), FLOURISH_PERIOD_MS, early.memory)
    expect(due.signals.restless).toBe(true)
    expect(due.signals.restlessStep).toBe(1)
    // The window closes inside the period, which is what lets the next one offer
    // the next pose: a level signal would be latched by the first flourish forever.
    const closed = projectSignals(observation(), FLOURISH_PERIOD_MS + FLOURISH_WINDOW_MS, due.memory)
    expect(closed.signals.restless).toBe(false)
    // A second period offers it again, and work cancels it outright.
    expect(projectSignals(observation(), FLOURISH_PERIOD_MS * 2, closed.memory).signals.restless).toBe(true)
    const busy = projectSignals(observation({ running: true }), FLOURISH_PERIOD_MS * 3, closed.memory)
    expect(busy.signals.restless).toBe(false)
  })

  it('stops stirring once the session has powered down', () => {
    // `restless` and `sleep` are the two quiet ends of the ladder, and the powered-down
    // one is the end of the other: a mark that kept stirring would never sleep. The
    // instant is deliberately one that a flourish window falls on, so this pins that
    // the power-down wins over the window rather than that the phase happened to miss.
    const inWindow = FLOURISH_PERIOD_MS * 5
    expect(inWindow % FLOURISH_PERIOD_MS).toBe(0)
    const quiet = projectSignals(observation(), inWindow, emptyMemory(0))
    expect(quiet.signals.longIdle).toBe(true)
    expect(quiet.signals.restless).toBe(false)
    expect(quiet.signals.restlessStep).toBe(0)
  })

  it('reads the resting phase from the clock, not from a seat’s own quiet history', () => {
    // Seats do not mount together, so each one's quiet time is its own; the phase must
    // not be, or two seats of one character would stir at different moments and ask
    // for different poses out of the same catalogue. Two histories that both qualify
    // as rested, one of them a period longer than the other, at the same instant.
    const rested = projectSignals(observation(), FLOURISH_PERIOD_MS * 3, emptyMemory(0))
    const alsoRested = projectSignals(observation(), FLOURISH_PERIOD_MS * 3, emptyMemory(FLOURISH_PERIOD_MS))
    expect(rested.signals.restless).toBe(true)
    expect(alsoRested.signals.restless).toBe(true)
    expect(rested.signals.restlessStep).toBe(3)
    expect(alsoRested.signals.restlessStep).toBe(3)

    // And the step is 0 outside a window, whatever the period count: a pose is only
    // ever read out of a real window, never out of a held signal.
    const closed = projectSignals(observation(), FLOURISH_PERIOD_MS * 3 + FLOURISH_WINDOW_MS, rested.memory)
    expect(closed.signals.restless).toBe(false)
    expect(closed.signals.restlessStep).toBe(0)
  })

  it('reads live jobs as work and a failed job as a failure', () => {
    const { signals: out } = projectSignals(failure('job-1', { liveJobs: 2 }), 0, emptyMemory(0))
    expect(out.working).toBe(true)
    expect(out.failed).toBe(true)
  })

  it('offers a failure until its window closes, though the job stays listed', () => {
    // The session's job list drains nothing until its agent is disposed, so the
    // fact behind this signal never goes false on its own — which is why the
    // offer is bounded rather than level-triggered.
    const landed = projectSignals(failure('job-1'), 0, emptyMemory(0))
    expect(landed.signals.failed).toBe(true)
    const held = projectSignals(failure('job-1'), FAILURE_HOLD_MS - 1, landed.memory)
    expect(held.signals.failed).toBe(true)
    const expired = projectSignals(failure('job-1'), FAILURE_HOLD_MS, held.memory)
    expect(expired.signals.failed).toBe(false)
  })

  it('announces a second failure, which a boolean over the list could not', () => {
    const first = projectSignals(failure('job-1'), 0, emptyMemory(0))
    const settled = projectSignals(failure('job-1'), FAILURE_HOLD_MS, first.memory)
    expect(settled.signals.failed).toBe(false)
    const second = projectSignals(failure('job-2'), FAILURE_HOLD_MS + 1, settled.memory)
    expect(second.signals.failed).toBe(true)
  })

  it('does not draw a later turn as the failure the session never cleared', () => {
    // The measured defect: one failed job stayed in the list for the rest of the
    // session, and `failed` (rank 90) outranks working, thinking and completion,
    // so the companion said "failed" while the agent was running two jobs. The
    // window is what makes the pose a report about a failure instead of a state
    // the session is stuck in.
    const arbiter = new CompanionArbiter()
    const landed = projectSignals(failure('job-1'), 0, emptyMemory(0))
    expect(arbiter.decide(landed.signals, 0).state).toBe('exclaim')
    const turn = projectSignals(failure('job-1', { running: true, liveJobs: 2 }), 60_000, landed.memory)
    expect(turn.signals.failed).toBe(false)
    expect(arbiter.decide(turn.signals, 60_000).state).toBe('orbit')
  })

  it('reads a pending interaction as a request for the user', () => {
    const { signals: out } = projectSignals(observation({ awaitingInteraction: true }), 0, emptyMemory(0))
    expect(out.awaitingApproval).toBe(true)
    expect(out.thinking).toBe(false)
  })

  it('passes the finer facts through, and reports them false when absent', () => {
    const inferred = projectSignals(observation(), 0, emptyMemory(0)).signals
    expect(inferred.streaming).toBe(false)
    expect(inferred.notified).toBe(false)
    const given = projectSignals(observation({ streaming: true, notified: true }), 0, emptyMemory(0)).signals
    expect(given.streaming).toBe(true)
    expect(given.notified).toBe(true)
  })

  it('sees a turn ending as the completion edge and restarts the quiet timer', () => {
    const before = projectSignals(observation({ running: true }), 0, emptyMemory(0))
    const after = projectSignals(observation(), 5_000, before.memory)
    expect(after.signals.justCompleted).toBe(true)
    expect(after.signals.longIdle).toBe(false)
    expect(after.memory.lastActivityMs).toBe(5_000)
  })

  it('powers down only after the quiet window, and not while work continues', () => {
    const quiet = projectSignals(observation(), IDLE_AFTER_MS - 1, emptyMemory(0))
    expect(quiet.signals.longIdle).toBe(false)
    const asleep = projectSignals(observation(), IDLE_AFTER_MS, quiet.memory)
    expect(asleep.signals.longIdle).toBe(true)
    const busy = projectSignals(observation({ running: true }), IDLE_AFTER_MS * 2, asleep.memory)
    expect(busy.signals.longIdle).toBe(false)
  })

  it('keeps offering a completion past the pose it interrupted, then stops', () => {
    const ended = projectSignals(observation({ running: true }), 0, emptyMemory(0))
    const edge = projectSignals(observation(), 100, ended.memory)
    expect(edge.signals.justCompleted).toBe(true)
    // Held while whatever was on screen serves out its floor...
    const held = projectSignals(observation(), 2_500, edge.memory)
    expect(held.signals.justCompleted).toBe(true)
    // ...and dropped once the window closes, so it cannot outrank rest forever.
    const expired = projectSignals(observation(), 100 + COMPLETION_HOLD_MS, held.memory)
    expect(expired.signals.justCompleted).toBe(false)
  })

  it('withdraws an unspent completion when a new turn starts', () => {
    const ended = projectSignals(observation({ running: true }), 0, emptyMemory(0))
    const edge = projectSignals(observation(), 100, ended.memory)
    expect(edge.signals.justCompleted).toBe(true)
    const restarted = projectSignals(observation({ running: true }), 200, edge.memory)
    expect(restarted.signals.justCompleted).toBe(false)
    expect(restarted.signals.thinking).toBe(true)
  })

  it('offers nothing before anything has finished', () => {
    expect(projectSignals(observation(), 5_000, emptyMemory(0)).signals.justCompleted).toBe(false)
  })

  it('outlives every floor the engine declares, so no completion is ever swallowed', () => {
    // The one coupling between a number in this module and the vendored engine: a
    // completion landing 100ms into a pose waits for that pose's `minDuration`, and
    // a window shorter than the longest of them would drop the news entirely.
    // Raising the engine's floors without raising the window fails here.
    const declared = [...STATE_BY_ID.values()]
      .map(state => state.minDuration)
      .filter((value): value is number => value !== undefined)
    expect(declared).toContain(2.5)
    expect(Math.max(...declared) * 1000).toBeLessThan(COMPLETION_HOLD_MS)
  })
})
