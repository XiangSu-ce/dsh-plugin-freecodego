/**
 * The pose pools: which pose draws a state, and the rules a pool obeys.
 *
 * The module is pure and clock-derived, so everything here is asserted without
 * mounting anything. Three properties are worth stating in a test rather than only
 * in a comment, because each is a thing that would otherwise fail silently:
 *
 *  - **The rotation is a function of the clock**, so two seats asking at the same
 *    instant agree. Asserted by asking twice, and by asking at the two instants a
 *    seat could hold at once.
 *  - **The interval never cuts a pose short.** It is derived from the engine's own
 *    table, and this file compares it against that table rather than against a
 *    number, which is what makes it hold when a pool gains a longer pose.
 *  - **A pool claims nothing.** A busy state may not flicker through a pose that
 *    reads as an outcome — the words stay semantic, so a rotation into `burst` or
 *    `exclaim` would be the drawing arguing with the label.
 */

import { describe, expect, it } from 'vitest'
import {
  POSE_POOLS,
  poseAt,
  poseFor,
  poseIntervalMs,
  posePoolIntervalMs,
} from '../src/client/companion/poses.ts'
import { STATES, STATE_BY_ID, type StateId } from '../src/client/companion/engine/states.ts'

/** Every state the engine knows, in its own reading order. */
const STATE_IDS = STATES.map(state => state.id)

/**
 * Poses a rotation may not contain.
 *
 * Each one is a claim the words would contradict: an outcome (`burst`, `exclaim`),
 * a request for the reader (`alert`), a state of rest (`sleep`, `idle`), or a beat
 * of news (`notify`, `play`) — plus `swirl`, which is an interface transition
 * rather than a catalogue animation and is never in `SEQUENCE`.
 */
const CLAIMING: readonly StateId[] = [
  'idle', 'sleep', 'burst', 'exclaim', 'alert', 'notify', 'play', 'swirl',
]

/** The states whose pools rotate, as the fixture this file reasons against. */
const ROTATING = STATE_IDS.filter(state => POSE_POOLS[state].length > 1)

describe('a pool covers every state the engine can show', () => {
  it('answers for every state, and names only states that exist', () => {
    // Totality is enforced by the record's type, and asserted here anyway: the
    // failure it prevents — a state drawn by no pose, or a pose that is a typo —
    // is one a cast would otherwise smuggle past the compiler.
    expect(Object.keys(POSE_POOLS).sort()).toStrictEqual([...STATE_IDS].sort())
    for (const state of STATE_IDS) {
      for (const pose of POSE_POOLS[state]) {
        expect(STATE_BY_ID.get(pose), `${state}'s pool names ${pose}`).toBeDefined()
      }
    }
  })

  it('does not rotate a state that says something a rotation would change', () => {
    for (const state of CLAIMING) {
      expect(POSE_POOLS[state], `${state} must not rotate`).toStrictEqual([state])
    }
  })

  it('keeps the states that are on screen for a whole turn rotating', () => {
    // The report this module answers was "thinking is always one face", so the
    // three long-lived busy states are the ones that must have a pool. A refactor
    // that quietly left one of them single-pose would leave the complaint intact.
    expect(ROTATING).toEqual(expect.arrayContaining(['thinking', 'orbit', 'comet']))
  })
})

describe('the interval cannot cut a pose short', () => {
  it('is the longest pose of the pool, in milliseconds', () => {
    for (const state of ROTATING) {
      const pool = POSE_POOLS[state]
      const longest = Math.max(...pool.map(pose => STATE_BY_ID.get(pose)!.duration))
      expect(poseIntervalMs(state), `${state} rotates at`).toBe(Math.round(longest * 1000))
    }
  })

  it('is at least every pose\u2019s declared floor as well as its duration', () => {
    // `minDuration` is the engine saying "cutting here leaves the body mid-morph",
    // so the interval has to clear it even where it exceeds the duration.
    for (const state of ROTATING) {
      for (const pose of POSE_POOLS[state]) {
        const definition = STATE_BY_ID.get(pose)!
        expect(poseIntervalMs(state)).toBeGreaterThanOrEqual(definition.duration * 1000)
        expect(poseIntervalMs(state)).toBeGreaterThanOrEqual((definition.minDuration ?? 0) * 1000)
      }
    }
  })

  it('derives from the table rather than from a declared number', () => {
    // Stated over a synthetic pool, so this is a property of the function and not
    // of the current table: the interval follows whatever the longest pose is.
    expect(posePoolIntervalMs(['hexagon'])).toBe(1600)
    expect(posePoolIntervalMs(['thinking', 'hexagon'])).toBe(2600)
    expect(posePoolIntervalMs(['alert'])).toBe(2400)
  })
})

describe('the pose is a function of the clock, not of an instance', () => {
  it('answers the same at the same instant, twice', () => {
    // What several seats drawing one character depend on: two callers at one
    // instant get one pose, and neither is a step behind the other.
    for (const state of STATE_IDS) {
      expect(poseFor(state, 12_345)).toBe(poseFor(state, 12_345))
    }
  })

  it('holds one pose for the whole interval and advances by one after it', () => {
    const interval = poseIntervalMs('thinking')
    const start = 7 * interval
    const first = poseFor('thinking', start)
    expect(poseFor('thinking', start + interval - 1)).toBe(first)
    const second = poseFor('thinking', start + interval)
    expect(second).not.toBe(first)
    // In the pool, and the *next* entry in it (wrapping at the end): the catalogue
    // plays in order rather than jumping, which is what makes a rotation read as
    // one continuous animation. The start below is deliberately not the first
    // entry, so this case covers the wrap rather than only the middle.
    const pool = POSE_POOLS.thinking
    expect(first).toBe(pool[3])
    expect(pool[(pool.indexOf(first) + 1) % pool.length]).toBe(second)
  })

  it('wraps to the start of the pool rather than stopping', () => {
    const interval = poseIntervalMs('thinking')
    const pool = POSE_POOLS.thinking
    expect(poseFor('thinking', 0)).toBe(pool[0])
    expect(poseFor('thinking', interval * pool.length)).toBe(pool[0])
    expect(poseFor('thinking', interval * (pool.length + 1))).toBe(pool[1])
  })

  it('returns the state itself for a pool that does not rotate', () => {
    // Including at large times, so "one pose long" is not accidentally a function
    // of the clock that happens to agree at zero.
    for (const state of CLAIMING) {
      expect(poseFor(state, 0)).toBe(state)
      expect(poseFor(state, 9_999_999)).toBe(state)
    }
  })

  it('never returns a pose outside the pool it was asked about', () => {
    for (const state of STATE_IDS) {
      for (const nowMs of [0, 1, 1_600, 2_600, 5_201, 123_456, 9_999_999]) {
        expect(POSE_POOLS[state]).toContain(poseFor(state, nowMs))
      }
    }
  })

  it('treats a negative time as the start rather than as a pool index', () => {
    // A negative modulus would land outside the pool; the clock is monotonic so
    // this cannot happen in the app, and the guard is asserted so the modulo is
    // never the thing standing between a bug and an undefined pose.
    expect(poseFor('thinking', -1)).toBe(POSE_POOLS.thinking[0])
  })
})

describe('the reduced-motion preference freezes the rotation', () => {
  it('draws the state itself when motion is not wanted, at any instant', () => {
    // Asserted here rather than through a mounted seat on purpose: a frozen
    // companion redraws only when the words change, so an ungated rotation would be
    // hidden by that short-circuit and the seat test would pass either way. This is
    // the assertion that can actually fail when the gate is removed.
    for (const state of STATE_IDS) {
      for (const nowMs of [0, 1_600, 2_600, 5_201, 123_456]) {
        expect(poseAt(state, nowMs, false), `${state} at ${nowMs}ms`).toBe(state)
      }
    }
  })

  it('still rotates when motion is wanted, so the gate is a gate and not a switch', () => {
    // The other half, which is what keeps the case above from passing for the wrong
    // reason: if `poseAt` ignored its flag and always returned the state, the case
    // above would be green and this one red.
    const interval = poseIntervalMs('thinking')
    expect(poseAt('thinking', interval, true)).toBe(POSE_POOLS.thinking[1])
    expect(poseAt('thinking', interval, false)).not.toBe(POSE_POOLS.thinking[1])
  })
})
