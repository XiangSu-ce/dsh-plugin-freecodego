// @vitest-environment jsdom
/**
 * The faces a state rotates through, and the schedule that walks them.
 *
 * This is the fix for the report the pose pools could not answer — a session that spent
 * a minute thinking wore one expression, and one that spent ten minutes waiting wore
 * another. So the assertions here are about the two properties that make the difference
 * visible and the two that keep it from becoming a defect of its own:
 *
 * - **It moves.** A rotating pool draws a different outline from one interval to the
 *   next, and over a long window draws all of them.
 * - **It is one picture.** The choice is a function of the shared clock and the state's
 *   own name, so two seats asking at one instant get one answer — the property
 *   `../src/client/companion/poses.ts` gets from stepping its pools the same way.
 * - **It never repeats itself.** The same outline two intervals in a row is the
 *   complaint this module exists to remove, in miniature, so it is asserted directly
 *   rather than left to the hash being good.
 * - **It cannot contradict the state.** Every pool's first entry is the state's own face
 *   from `EYE_FACES`, and a state that does not rotate keeps exactly the face it had.
 * - **A working session looks busier than a waiting one.** Both currency halves of that are
 *   asserted: the busy interval is a fraction of the resting one, and the busy pools are
 *   longer — variety and pace, not just pace.
 */

import { describe, expect, it } from 'vitest'
import { STATES, type StateId } from '../src/client/companion/engine/states.ts'
import { EYE_FACES } from '../src/client/companion/eyes/faces.ts'
import {
  BUSY_FACE_INTERVAL_MS,
  FACE_POOLS,
  RESTING_FACE_INTERVAL_MS,
  faceIntervalMs,
  facePoolAt,
} from '../src/client/companion/eyes/pools.ts'
import { EYE_EXPRESSIONS } from '../src/client/companion/eyes/faces.ts'
import { RINGS, type RingName } from '../src/client/companion/eyes/rings.ts'

/**
 * How many times a state changes its face inside one window.
 *
 * Counted from the schedule rather than from the constants, because the count is what a
 * reader sees: an interval can be short while the pool walks in a way that keeps landing on
 * the shape just left.
 * @param state - the state to walk.
 * @param windowMs - how long to watch for, in milliseconds.
 * @returns the number of interval boundaries where the face changed.
 */
function faceChanges(state: StateId, windowMs: number): number {
  const interval = faceIntervalMs(state)
  let changes = 0
  for (let at = interval; at <= windowMs; at += interval) {
    if (facePoolAt(state, at, true) !== facePoolAt(state, at - interval, true)) changes += 1
  }
  return changes
}

/** Every state the engine has, by id. */
const STATE_IDS = STATES.map(state => state.id)

/** The states a session actually sits in, which are the ones that rotate. */
const ROTATING: readonly StateId[] = ['idle', 'thinking', 'orbit', 'comet']

describe('which faces a state may wear', () => {
  it('names a pool for every state the engine has, and for nothing else', () => {
    expect(Object.keys(FACE_POOLS).sort()).toStrictEqual([...STATE_IDS].sort())
  })

  it('starts every pool on the state\'s own face', () => {
    // The invariant that makes the pools a widening rather than a rewrite: a state enters
    // wearing the face it always wore, and the rotation is what happens next. A pool that
    // dropped this would be a state whose face changed meaning on arrival.
    for (const state of STATE_IDS) {
      expect(FACE_POOLS[state].faces[0], state).toBe(EYE_FACES[state])
    }
  })

  it('draws only outlines the vocabulary has, and never the same one twice in a pool', () => {
    // A repeated outline is a rotation that spends an interval to show the reader nothing;
    // an unknown name is a pool no renderer can draw.
    for (const state of STATE_IDS) {
      const faces = FACE_POOLS[state].faces
      expect(new Set(faces).size, state).toBe(faces.length)
      for (const face of faces) expect(RINGS[face], `${state} → ${face}`).toBeDefined()
    }
  })

  it('rotates the states a session sits in, and leaves the rest still', () => {
    for (const state of STATE_IDS) {
      const rotates = FACE_POOLS[state].faces.length > 1
      expect(rotates, state).toBe(ROTATING.includes(state))
    }
    // `burst` is the case worth naming: "Done" is an outcome a reader acts on, and its
    // face *is* the message, so a pool that rotated it would be arguing with the label.
    expect(FACE_POOLS.burst.faces).toStrictEqual([EYE_FACES.burst])
  })

  it('holds the resting face longer than a working one', () => {
    // The resting floor is what a user reads next to; a face that moved at working speed
    // would pull their attention off their own work.
    expect(faceIntervalMs('idle')).toBe(RESTING_FACE_INTERVAL_MS)
    for (const state of ['thinking', 'orbit', 'comet'] as const) expect(faceIntervalMs(state)).toBe(BUSY_FACE_INTERVAL_MS)
    expect(RESTING_FACE_INTERVAL_MS).toBeGreaterThan(BUSY_FACE_INTERVAL_MS)
    // A ratio, not a pair of numbers: the two constants are only meaningful together, and a
    // later edit that halved the resting interval while leaving the busy one alone would
    // make a waiting session as busy as a working one without either number looking wrong.
    expect(RESTING_FACE_INTERVAL_MS / BUSY_FACE_INTERVAL_MS).toBeGreaterThanOrEqual(2)
  })

  it('gives a working state more shapes than the resting one', () => {
    // The other half of "busier": pace alone would be one shape flashing, which is the
    // monotony this module exists to remove, at a higher frequency.
    for (const state of ['thinking', 'orbit', 'comet'] as const) {
      expect(FACE_POOLS[state].faces.length, state).toBeGreaterThan(FACE_POOLS.idle.faces.length)
      expect(FACE_POOLS[state].faces.length, state).toBeGreaterThanOrEqual(5)
    }
  })

  it('draws no ring that nothing wears, from a pose, a request, or a pool', () => {
    // The invariant `./rings.ts` states about its own table — "a shape nothing draws is a
    // shape nobody has looked at" — enforced rather than promised. It is what keeps a new
    // outline from being added here without the face that uses it.
    const worn = new Set<RingName>([
      ...Object.values(EYE_FACES),
      ...Object.values(EYE_EXPRESSIONS),
      ...STATE_IDS.flatMap(state => FACE_POOLS[state].faces),
    ])
    for (const name of Object.keys(RINGS) as RingName[]) expect(worn.has(name), name).toBe(true)
  })
})

describe('the schedule that walks a pool', () => {
  it('is one answer for one instant, whatever else is going on', () => {
    // The property three seats depend on: no instance history, no per-seat counter.
    for (const state of STATE_IDS) {
      for (const nowMs of [0, 1, 1_599, 1_600, 40_000, 999_999]) {
        expect(facePoolAt(state, nowMs, true), `${state} at ${nowMs}`).toBe(facePoolAt(state, nowMs, true))
      }
    }
  })

  it('advances with the clock rather than with a counter', () => {
    // Same instant, same face; one interval later, a different one. Asserted through the
    // pool's own interval so a change to either constant keeps this true.
    const interval = faceIntervalMs('thinking')
    const first = facePoolAt('thinking', interval, true)
    expect(facePoolAt('thinking', interval, true)).toBe(first)
    expect(facePoolAt('thinking', interval * 2, true)).not.toBe(first)
  })

  it('never shows the same outline twice in a row', () => {
    // The whole point, and the one thing a hash alone would get wrong occasionally. Six
    // hundred intervals is far past the point where a coincidence would show up as a
    // flicker, and covers every pool's step phase at the same time.
    for (const state of ROTATING) {
      const interval = faceIntervalMs(state)
      for (let step = 1; step < 600; step += 1) {
        const before = facePoolAt(state, interval * (step - 1), true)
        const now = facePoolAt(state, interval * step, true)
        expect(now, `${state} step ${step}`).not.toBe(before)
      }
    }
  })

  it('draws every outline of a rotating pool, given a long enough window', () => {
    // A pool entry the schedule never picks is a shape nobody has looked at, which is the
    // failure the rings module warns about from the other side.
    for (const state of ROTATING) {
      const interval = faceIntervalMs(state)
      const seen = new Set<RingName>()
      for (let step = 0; step < 200; step += 1) seen.add(facePoolAt(state, interval * step, true))
      expect([...seen].sort(), state).toStrictEqual([...FACE_POOLS[state].faces].sort())
    }
  })

  it('changes a working face more often than a waiting one in the same minute', () => {
    // The property the two constants exist for, stated as the reader experiences it: watch
    // the strip for a minute while a turn runs, then for a minute while the session waits.
    const waiting = faceChanges('idle', 60_000)
    expect(waiting).toBeGreaterThan(0)
    for (const state of ['thinking', 'orbit', 'comet'] as const) {
      expect(faceChanges(state, 60_000), state).toBeGreaterThanOrEqual(2 * waiting)
    }
  })

  it('wears the state\'s own face when motion is not wanted', () => {
    // A rotation is motion, so reduced motion gets the face the state always had — the
    // same rule `poseAt` applies to a pose pool, applied to the one thing about a rotation
    // a reader would still see.
    for (const state of STATE_IDS) {
      for (const nowMs of [0, 1_600, 33_333, 999_999]) {
        expect(facePoolAt(state, nowMs, false), state).toBe(EYE_FACES[state])
      }
    }
  })

  it('keeps a state that does not rotate still at every instant', () => {
    for (const state of STATE_IDS) {
      if (ROTATING.includes(state)) continue
      for (const nowMs of [0, 1_600, 90_000]) expect(facePoolAt(state, nowMs, true), state).toBe(EYE_FACES[state])
    }
  })

  it('reads a clock before zero as the first interval rather than as an error', () => {
    // `nowMs` is a clamped subtraction at the call site, so a negative cannot arrive from
    // the seat — and a hash of a negative step would still be an index, not a crash.
    for (const state of STATE_IDS) {
      expect(facePoolAt(state, -1_000, true), state).toBe(facePoolAt(state, 0, true))
    }
  })
})
