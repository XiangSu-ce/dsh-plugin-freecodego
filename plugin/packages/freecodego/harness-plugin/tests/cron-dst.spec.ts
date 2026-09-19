/**
 * Wall-clock rules across a DST transition.
 *
 * `scheduler/cron.ts` documents `computeNextCronRun` as "the first occurrence
 * **strictly after** `fromMs`", and every consumer depends on it in the same way:
 * the caller turns the answer into the Harness's `at` selector, and
 * `nextCronOccurrences` walks it by feeding each answer back as the next cursor.
 *
 * A *repeated* local hour breaks that, because `new Date(y, m, d, h, mm)`
 * resolves an ambiguous wall-clock time to the **first** of its two instants. When
 * the cursor sits in the second pass and the rule names a later minute of the same
 * ambiguous hour, the "next" occurrence came back an hour before the cursor — and
 * inside a chain, in the past. That is the case this file pins.
 *
 * The zone is switched in-process because Git Bash on this host does not forward a
 * `TZ=` command prefix to the child; Node re-reads `TZ` and invalidates its cached
 * zone, so a spec file (its own forked worker) can own the zone for its duration.
 * Dates are built with `Date.UTC` and explicit offsets rather than the host's local
 * zone, so the expectations read the same on every machine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computeNextCronRun, nextCronOccurrences, parseCronExpression } from '../src/scheduler/cron.ts'

const PROBE_ZONE = 'America/New_York'
const previousZone = process.env.TZ

beforeAll(() => { process.env.TZ = PROBE_ZONE })
afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ
  else process.env.TZ = previousZone
})

/** US Eastern 2026: spring forward 03-08 02:00 → 03:00, fall back 11-01 02:00 → 01:00. */
const FALL_BACK_FIRST_PASS = Date.UTC(2026, 10, 1, 5, 30) // 01:30 EDT, UTC-4
const FALL_BACK_SECOND_PASS = Date.UTC(2026, 10, 1, 6, 30) // 01:30 EST, UTC-5
const FALL_BACK_SECOND_PASS_ANSWER = Date.UTC(2026, 10, 1, 6, 45) // 01:45 EST, UTC-5

describe('a cron rule on the day its zone repeats an hour', () => {
  it('answers with an instant strictly after a cursor in the first pass', () => {
    const expression = parseCronExpression('45 1 * * *')
    const next = computeNextCronRun(expression, FALL_BACK_FIRST_PASS)
    expect(next).toBe(Date.UTC(2026, 10, 1, 5, 45))
  })

  it('answers with an instant strictly after a cursor in the second pass', () => {
    const expression = parseCronExpression('45 1 * * *')
    const next = computeNextCronRun(expression, FALL_BACK_SECOND_PASS)
    expect(next).toBeGreaterThan(FALL_BACK_SECOND_PASS)
    // The later pass of the same wall-clock minute — not the earlier one, which is
    // 45 minutes *behind* the cursor and would hand the Harness a past instant.
    expect(next).toBe(FALL_BACK_SECOND_PASS_ANSWER)
  })

  it('keeps a chained run strictly increasing across the repeated hour', () => {
    const expression = parseCronExpression('45 1 * * *')
    const occurrences = nextCronOccurrences(expression, FALL_BACK_SECOND_PASS, 3)
    expect(occurrences).toHaveLength(3)
    expect(occurrences[0]!.atMs).toBe(FALL_BACK_SECOND_PASS_ANSWER)
    let previous = FALL_BACK_SECOND_PASS
    for (const occurrence of occurrences) {
      expect(occurrence.atMs).toBeGreaterThan(previous)
      previous = occurrence.atMs
    }
  })

  it('never answers a past instant for every minute of the repeated hour', () => {
    // The whole ambiguous window, both passes, for a minute rule inside it: no
    // cursor may be answered with an instant at or before itself.
    const expression = parseCronExpression('45 1 * * *')
    for (let minute = 0; minute < 60; minute += 1) {
      for (const offsetHours of [4, 5]) {
        const cursor = Date.UTC(2026, 10, 1, minute + offsetHours, 30)
        const next = computeNextCronRun(expression, cursor)
        expect(next).toBeDefined()
        expect(next!).toBeGreaterThan(cursor)
      }
    }
  })

  it('skips the day whose local hour the zone erased, instead of firing an hour late', () => {
    // 02:30 does not exist on 2026-03-08 in this zone: the clock goes 02:00 → 03:00.
    // `new Date(2026, 2, 8, 2, 30)` silently normalizes to 03:30, so the old answer
    // ran the rule an hour after the wall clock it was written for. The decision is
    // that a time which does not exist is not an occurrence: the rule misses that
    // day and the search finds the next day that has the reading.
    const expression = parseCronExpression('30 2 * * *')
    const cursor = Date.UTC(2026, 2, 8, 6, 30) // 01:30 EST, the hour before the jump
    const next = computeNextCronRun(expression, cursor)
    expect(next).toBe(Date.UTC(2026, 2, 9, 6, 30)) // 02:30 EST on 03-09
    const chosen = new Date(next!)
    expect(chosen.getHours()).toBe(2)
    expect(chosen.getMinutes()).toBe(30)
    expect(chosen.getDate()).toBe(9)
  })

  it('still fires a rule whose hour exists on the same day', () => {
    // The gap only removes the readings it erased; it must not push the rest of the
    // day forward.
    const cursor = Date.UTC(2026, 2, 8, 6, 30) // 01:30 EST
    expect(computeNextCronRun(parseCronExpression('0 3 * * *'), cursor)).toBe(Date.UTC(2026, 2, 8, 7, 0))
    expect(computeNextCronRun(parseCronExpression('30 4 * * *'), cursor)).toBe(Date.UTC(2026, 2, 8, 8, 30))
  })

  it('stays monotonic on the day a local hour is skipped', () => {
    // 02:30 does not exist on 2026-03-08 in this zone. Whether such a rule should
    // fire at 03:30, be skipped, or be refused is F-06's open question; what is
    // pinned here is only that the answer is never behind the cursor.
    const cursor = Date.UTC(2026, 2, 8, 6, 30) // 01:30 EST
    const next = computeNextCronRun(parseCronExpression('30 2 * * *'), cursor)
    expect(next).toBeDefined()
    expect(next!).toBeGreaterThan(cursor)
  })
})
