import { describe, expect, it } from 'vitest'
import {
  computeNextCronRun,
  cronFixedRateSeconds,
  describeCronExpression,
  nextCronOccurrences,
  parseCronExpression,
} from '../src/scheduler/cron.ts'

/** A local-time timestamp, so assertions read in the same clock as the parser. */
function local(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('cron expression parsing', () => {
  it('parses each supported field form', () => {
    const every = parseCronExpression('* * * * *')
    expect(every.minute).toHaveLength(60)
    expect(every.hour).toHaveLength(24)
    expect(every.dayOfMonth).toHaveLength(31)
    expect(every.month).toHaveLength(12)
    expect(every.dayOfWeek).toHaveLength(7)
    expect(every.dayOfMonthRestricted).toBe(false)
    expect(every.dayOfWeekRestricted).toBe(false)

    // A step over an explicit range.
    expect(parseCronExpression('0 9-17/4 * * *').hour).toEqual([9, 13, 17])
    // A step over `*`.
    expect(parseCronExpression('*/15 * * * *').minute).toEqual([0, 15, 30, 45])
    // A comma list mixing forms.
    expect(parseCronExpression('0,30 1,2 * * *').minute).toEqual([0, 30])
    // A bare value with a step runs to the end of the field.
    expect(parseCronExpression('* 5/6 * * *').hour).toEqual([5, 11, 17, 23])
    // A single value selects only itself.
    expect(parseCronExpression('7 * * * *').minute).toEqual([7])
    expect(parseCronExpression(' 0  9  *  *  *  ').source).toBe('0 9 * * *')
  })

  it('normalizes Sunday written as 7 onto 0', () => {
    expect(parseCronExpression('0 0 * * 7').dayOfWeek).toEqual([0])
    expect(parseCronExpression('0 0 * * 0').dayOfWeek).toEqual([0])
  })

  it('marks only the day fields as restricted when they are not a wildcard', () => {
    const restricted = parseCronExpression('0 0 1 * 1')
    expect(restricted.dayOfMonthRestricted).toBe(true)
    expect(restricted.dayOfWeekRestricted).toBe(true)
    expect(parseCronExpression('0 0 1 * *').dayOfWeekRestricted).toBe(false)
  })

  it('expands the named aliases and rejects an unknown one', () => {
    expect(parseCronExpression('@daily').source).toBe('0 0 * * *')
    expect(parseCronExpression('@hourly').source).toBe('0 * * * *')
    expect(parseCronExpression('@weekly').source).toBe('0 0 * * 0')
    expect(parseCronExpression('@monthly').source).toBe('0 0 1 * *')
    expect(parseCronExpression('@yearly').source).toBe('0 0 1 1 *')
    expect(parseCronExpression('@annually').source).toBe('0 0 1 1 *')
    expect(parseCronExpression('@midnight').source).toBe('0 0 * * *')
    expect(() => parseCronExpression('@fortnightly')).toThrow(/unknown schedule alias: @fortnightly/)
  })

  it('rejects an empty or miscounted expression', () => {
    expect(() => parseCronExpression('   ')).toThrow(/expression is empty/)
    expect(() => parseCronExpression('0 9 * *')).toThrow(/expected 5 fields but found 4/)
    expect(() => parseCronExpression('0 9 * * * *')).toThrow(/expected 5 fields but found 6/)
  })

  it('rejects a value that is not a number or is out of range', () => {
    expect(() => parseCronExpression('x * * * *')).toThrow(/minute field has a non-numeric value: x/)
    expect(() => parseCronExpression('0 24 * * *')).toThrow(/hour field value 24 is outside 0-23/)
    expect(() => parseCronExpression('0 0 0 * *')).toThrow(/day-of-month field value 0 is outside 1-31/)
    expect(() => parseCronExpression('0 0 * 13 *')).toThrow(/month field value 13 is outside 1-12/)
    // Three digits cannot be a valid field value anywhere.
    expect(() => parseCronExpression('100 * * * *')).toThrow(/minute field has a non-numeric value: 100/)
  })

  it('rejects malformed lists, steps, and ranges', () => {
    expect(() => parseCronExpression('0,,5 * * * *')).toThrow(/minute field has an empty list entry/)
    expect(() => parseCronExpression('0/5/5 * * * *')).toThrow(/minute field has more than one step: 0\/5\/5/)
    expect(() => parseCronExpression('*/x * * * *')).toThrow(/minute field has a non-numeric step: x/)
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(/minute field has a zero step/)
    expect(() => parseCronExpression('/ * * * *')).toThrow(/minute field has a non-numeric step/)
    expect(() => parseCronExpression('1-2-3 * * * *')).toThrow(/minute field has a malformed range: 1-2-3/)
    expect(() => parseCronExpression('-5 * * * *')).toThrow(/minute field has a malformed range: -5/)
    expect(() => parseCronExpression('5- * * * *')).toThrow(/minute field has a malformed range: 5-/)
    expect(() => parseCronExpression('30-10 * * * *')).toThrow(/minute field range 30-10 runs backwards/)
  })
})

describe('cron next-run computation', () => {
  it('returns the next minute for a wildcard rule', () => {
    const expression = parseCronExpression('* * * * *')
    expect(computeNextCronRun(expression, local(2026, 3, 10, 8, 30))).toBe(local(2026, 3, 10, 8, 31))
    // Seconds are discarded: a rule never fires mid-minute.
    expect(computeNextCronRun(expression, local(2026, 3, 10, 8, 30) + 45_000)).toBe(local(2026, 3, 10, 8, 31))
  })

  it('rolls to the next allowed hour and then to the next day', () => {
    const hourly = parseCronExpression('0 * * * *')
    expect(computeNextCronRun(hourly, local(2026, 3, 10, 8, 30))).toBe(local(2026, 3, 10, 9, 0))
    const daily = parseCronExpression('0 9 * * *')
    // Later the same day.
    expect(computeNextCronRun(daily, local(2026, 3, 10, 8, 30))).toBe(local(2026, 3, 10, 9, 0))
    // Past today's only slot, so tomorrow.
    expect(computeNextCronRun(daily, local(2026, 3, 10, 9, 30))).toBe(local(2026, 3, 11, 9, 0))
  })

  it('skips a minute inside the current hour before accepting the hour', () => {
    const expression = parseCronExpression('15,45 * * * *')
    // 8:20 is past :15 but before :45 on the same hour, so :45 wins.
    expect(computeNextCronRun(expression, local(2026, 3, 10, 8, 20))).toBe(local(2026, 3, 10, 8, 45))
    // 8:50 is past both, so the next hour's :15.
    expect(computeNextCronRun(expression, local(2026, 3, 10, 8, 50))).toBe(local(2026, 3, 10, 9, 15))
  })

  it('applies the month field', () => {
    const expression = parseCronExpression('0 0 1 6 *')
    // 2026-03-10 -> the 1st of June.
    expect(computeNextCronRun(expression, local(2026, 3, 10, 8, 30))).toBe(local(2026, 6, 1, 0, 0))
    // Already past June, so next year's June.
    expect(computeNextCronRun(expression, local(2026, 7, 1, 0, 0))).toBe(local(2027, 6, 1, 0, 0))
  })

  it('combines day-of-month and day-of-week with OR when both are restricted', () => {
    const expression = parseCronExpression('0 0 1 * 1')
    // 2026-03-10 is a Tuesday, so the next Monday is the 16th.
    expect(computeNextCronRun(expression, local(2026, 3, 10, 8, 0))).toBe(local(2026, 3, 16, 0, 0))
    // From the end of March the 1st of April is the nearer match.
    const fromMarch = computeNextCronRun(expression, local(2026, 3, 30, 23, 59))
    expect(fromMarch).toBe(local(2026, 4, 1, 0, 0))
  })

  it('requires both day fields when only one is restricted', () => {
    // Day-of-week restricted, day-of-month wildcard: only Mondays qualify, and
    // the wildcard day-of-month must not turn the match into an OR.
    const mondays = parseCronExpression('0 9 * * 1')
    expect(computeNextCronRun(mondays, local(2026, 3, 10, 8, 0))).toBe(local(2026, 3, 16, 9, 0))
    // Sunday is weekday 0 and must not match Monday.
    expect(computeNextCronRun(mondays, local(2026, 3, 15, 8, 0))).toBe(local(2026, 3, 16, 9, 0))
  })

  it('returns undefined for an expression with no occurrence', () => {
    // February never has a 30th.
    expect(computeNextCronRun(parseCronExpression('0 0 30 2 *'), local(2026, 3, 10, 8, 0))).toBeUndefined()
  })

  it('finds a leap-day rule across a century year, where two leap days are eight years apart', () => {
    // The other half of the pair above: `0 0 29 2 *` is the rule the label calls
    // "day 29 of February", so the search has to be able to find it — otherwise
    // the two readings of one expression disagree, and the reachable one is
    // reported as having no occurrence at all. 2100 is not a leap year, so the
    // gap between 29 February 2096 and 29 February 2104 is eight years, not the
    // four a horizon sized to one leap cycle assumed.
    const leapDay = parseCronExpression('0 0 29 2 *')
    expect(computeNextCronRun(leapDay, local(2096, 3, 1, 0, 0))).toBe(local(2104, 2, 29, 0, 0))
  })
})

describe('cron fixed rate', () => {
  const seconds = (source: string): number | undefined => cronFixedRateSeconds(parseCronExpression(source))

  it('answers "every N minutes" from the same rule the label reads', () => {
    // The label and the interval are two readings of one expression, so a rule
    // the label calls "every N minutes" has to be fixed-rate and vice versa.
    // A bare count was how `*/9 * * * *` was labelled "every 9 minutes" while
    // the interval answered undefined: that set closes at :54 and restarts at
    // the next hour's :00, so one gap in every hour is six minutes.
    for (const source of ['*/15 * * * *', '0,30 * * * *', '1,31 * * * *', '*/4 * * * *']) {
      const label = describeCronExpression(parseCronExpression(source))
      expect(seconds(source), source).toBeDefined()
      expect(label, source).toBe(`every ${seconds(source)! / 60} minutes`)
    }
    for (const source of ['*/7 * * * *', '*/9 * * * *', '5,35,55 * * * *']) {
      expect(seconds(source), source).toBeUndefined()
      expect(describeCronExpression(parseCronExpression(source)), source).toBe(`cron ${source}`)
    }
  })

  it('never labels a cadence the occurrences do not keep', () => {
    // Differential rather than by hand: the label and the interval answer are two
    // readings of one expression, and the fact they can both be checked against is
    // the gap the rule actually keeps. Sampled past a day boundary, because a
    // cadence claim is only false once a day, a week, or a month ends — 400 firings
    // of `*/15 * * * 1` covers four Mondays and finds the six silent days.
    //
    // Gaps are measured on the *wall clock*, not on elapsed milliseconds: a rule
    // answered as a fixed rate is still a wall-clock rule, so a machine in a zone
    // that shifts its clock must run this the same way a machine in a fixed-offset
    // zone does (see the duration caveat on `cronFixedRateSeconds`).
    const start = local(2026, 1, 1, 0, 0)
    const wallClockMs = (ms: number): number => {
      const at = new Date(ms)
      return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes())
    }
    const firings = (source: string): number[] => {
      const expression = parseCronExpression(source)
      const at: number[] = []
      let cursor = start
      for (let index = 0; index < 400; index += 1) {
        const next = computeNextCronRun(expression, cursor)
        expect(next, source).toBeDefined()
        at.push(next!)
        cursor = next!
      }
      return at
    }
    const cadence = [
      '*/15 * * * *', '0,30 * * * *', '1,31 * * * *', '*/15 * * 6 *',
      '0 * * * *', '0 9 * * *', '0 */4 * * *', '0 1,7,13,19 * * *',
      '*/15 * * * 1', '0,30 * * * 1', '*/15 * 15 * *', '1,31 * * * 0',
      '*/15 * 15 6 1', '*/7 * * * *', '5,35,55 * * * *',
    ]
    for (const source of cadence) {
      const expression = parseCronExpression(source)
      const label = describeCronExpression(expression)
      const claimed = /^every (\d+) minutes/u.exec(label)
      const interval = cronFixedRateSeconds(expression)
      if (claimed !== null) {
        // The claim is only honest while no day field narrows the rule; a month may
        // travel beside it as the qualifier this label already emits.
        expect(expression.dayOfMonth.length, `${source} (${label})`).toBe(31)
        expect(expression.dayOfWeek.length, `${source} (${label})`).toBe(7)
      }
      const expected = interval !== undefined ? interval * 1000 : claimed === null ? undefined : Number(claimed[1]) * 60_000
      if (expected === undefined) continue
      const at = firings(source)
      // An interval is answered only for a rule nothing narrows, so its gaps are
      // constant throughout. A labelled cadence may carry a month qualifier, and the
      // measure of it is then the firings inside one month.
      const namedMonths = / in [A-Z][a-z]+/u.test(label)
      for (let index = 1; index < at.length; index += 1) {
        const before = new Date(at[index - 1]!)
        const after = new Date(at[index]!)
        if (namedMonths && (before.getMonth() !== after.getMonth() || before.getFullYear() !== after.getFullYear())) continue
        expect(wallClockMs(at[index]!) - wallClockMs(at[index - 1]!), `${source} gap before ${after.toISOString()}`).toBe(expected)
      }
    }
  })

  it('answers the interval only for shapes that are provably constant', () => {
    expect(seconds('*/5 * * * *')).toBe(300)
    expect(seconds('0,30 * * * *')).toBe(1_800)
    expect(seconds('0 * * * *')).toBe(3_600)
    expect(seconds('0 9 * * *')).toBe(86_400)
    // Hours spread across the day are just as constant as minutes: `0 */N * * *`
    // was answered undefined, so a user's "every four hours" could never become
    // one recurring reminder — only a chain of five one-shots that stop firing
    // if nothing re-arms them.
    expect(seconds('0 */4 * * *')).toBe(14_400)
    expect(seconds('0 1,7,13,19 * * *')).toBe(21_600)
    expect(seconds('1,31 * * * *')).toBe(1_800)
  })

  it('refuses an interval a step does not actually produce', () => {
    // :00, :07 … :56, then the next hour's :00 — one gap in every hour is four
    // minutes, so no single `every_seconds` carries this rule.
    expect(seconds('*/7 * * * *')).toBeUndefined()
    // A calendar day is not a fixed rate, however regular it looks on a weekday.
    expect(seconds('0 9 * * 1-5')).toBeUndefined()
    expect(seconds('0 9 1 * *')).toBeUndefined()
    expect(seconds('0 9 * 6 *')).toBeUndefined()
    // Two hours but one minute is not constant either: 17:00 to 02:00 is 9h.
    expect(seconds('0 1,2 * * *')).toBeUndefined()
    // Five hours from :00 closes at :20, so the last gap of the day is four.
    expect(seconds('0 */5 * * *')).toBeUndefined()
  })
})

describe('cron occurrences', () => {
  it('lists occurrences in order, each in both selector forms', () => {
    const occurrences = nextCronOccurrences(parseCronExpression('0 9 * * *'), local(2026, 3, 10, 8, 0), 3)
    expect(occurrences.map(occurrence => new Date(occurrence.atMs).getDate())).toEqual([10, 11, 12])
    for (const occurrence of occurrences) {
      expect(new Date(occurrence.rfc3339).getTime()).toBe(occurrence.atMs)
      expect(occurrence.local.time).toBe('09:00:00')
      expect(occurrence.local.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
      expect(occurrence.local.time_zone).not.toBe('')
    }
  })

  it('returns nothing rather than throwing when a rule never falls', () => {
    // 30 February: a valid parse that has no occurrence inside the horizon.
    expect(nextCronOccurrences(parseCronExpression('0 0 30 2 *'), local(2026, 3, 10, 8, 0), 3)).toEqual([])
  })
})

describe('cron weekday description', () => {
  it('does not name one half of an OR-combined day rule', () => {
    // `0 9 1,15 * 3` fires on the 1st, the 15th, *and* every Wednesday. Naming
    // just the weekday reads as the whole rule, which is the defect naming the
    // weekday set (rather than its lowest member) already fixed.
    expect(describeCronExpression(parseCronExpression('0 9 1,15 * 3'))).toBe('cron 0 9 1,15 * 3')
    expect(describeCronExpression(parseCronExpression('0 0 1 * 1'))).toBe('cron 0 0 1 * 1')
    // One restricted day field is still named exactly.
    expect(describeCronExpression(parseCronExpression('0 9 * * 1,3'))).toBe('Monday, Wednesday at 09:00')
    expect(describeCronExpression(parseCronExpression('0 9 1,15 * *'))).toBe('day 1, 15 of the month at 09:00')
  })
  it('names a weekday set as the set, not as its lowest member', () => {
    expect(describeCronExpression(parseCronExpression('0 9 * * 1-5'))).toBe('weekdays at 09:00')
    expect(describeCronExpression(parseCronExpression('0 9 * * 0,6'))).toBe('weekends at 09:00')
    expect(describeCronExpression(parseCronExpression('0 9 * * 1,3'))).toBe('Monday, Wednesday at 09:00')
  })

  it('does not name a month the expression never restricted', () => {
    expect(describeCronExpression(parseCronExpression('0 8 1,15 * *'))).toBe('day 1, 15 of the month at 08:00')
    expect(describeCronExpression(parseCronExpression('0 8 1 6,7 *'))).toBe('day 1 of June, July at 08:00')
  })

  it('carries a restricted month into whatever shape it names', () => {
    // The month is the only restriction left standing once both day fields are
    // wildcards, and dropping it read `0 9 * 6 *` as "daily at 09:00" — a rule
    // that fires every day of the year. `cronFixedRateSeconds` already refuses
    // that same expression precisely because of the month, so a label that
    // ignores it contradicts the interval answer beside it.
    expect(describeCronExpression(parseCronExpression('0 9 * 6 *'))).toBe('daily in June at 09:00')
    expect(describeCronExpression(parseCronExpression('0 9 * 1,7 *'))).toBe('daily in January, July at 09:00')
    // Same defect against a weekday set: `0 9 * 6 3` is Wednesdays in June.
    expect(describeCronExpression(parseCronExpression('0 9 * 6 3'))).toBe('Wednesday in June at 09:00')
    expect(describeCronExpression(parseCronExpression('0 9 * 6 1-5'))).toBe('weekdays in June at 09:00')
    // And against the fixed-rate label, whose month is now the only qualifier.
    expect(describeCronExpression(parseCronExpression('*/15 * * 6 *'))).toBe('every 15 minutes in June')
    // An unrestricted month leaves every existing shape unchanged.
    expect(describeCronExpression(parseCronExpression('0 9 * * *'))).toBe('daily at 09:00')
    expect(describeCronExpression(parseCronExpression('*/15 * * * *'))).toBe('every 15 minutes')
  })

  it('does not name a cadence a day field narrows', () => {
    // `*/15 * * * 1` fires ninety-six times on a Monday and then not again for six
    // days: no single interval carries it (the answer beside it already says so),
    // and "every 15 minutes" reads as a rule that runs all week. The month used to
    // travel into a qualifier here while the day fields were dropped, which is the
    // one narrowing left that the label did not name.
    //
    // Mutation: without the shared day predicate these read "every 15 minutes".
    for (const source of ['*/15 * * * 1', '0,30 * * * 6', '*/15 * 15 * *', '1,31 * * * 0', '*/15 * * * 6']) {
      expect(cronFixedRateSeconds(parseCronExpression(source)), source).toBeUndefined()
      expect(describeCronExpression(parseCronExpression(source)), source).toBe(`cron ${source}`)
    }
    // The day fields are read as *sets*, not as their `restricted` switches, so a
    // spelled-out full set still names every day and keeps the cadence.
    expect(describeCronExpression(parseCronExpression('*/15 * * * 0-6'))).toBe('every 15 minutes')
    expect(describeCronExpression(parseCronExpression('*/15 * 1-31 * *'))).toBe('every 15 minutes')
    // A month is the one narrowing that still travels: it is a qualifier the label
    // can name exactly, which the day sets are not.
    expect(describeCronExpression(parseCronExpression('*/15 * * 6 *'))).toBe('every 15 minutes in June')
  })

  it('does not name a schedule no calendar day can satisfy', () => {
    // `0 0 30 2 *` parses — every field is in range — and its day never arrives:
    // February has no 30th, in a leap year or any other. Naming the schedule would
    // advertise the one outcome this module exists to prevent, a rule that can be
    // written down and never run, and the label is the text a reader checks the
    // expression against. The expression is echoed instead, which is this function's
    // answer for every shape it cannot name exactly.
    //
    // Mutation: without the reachability test these read "day 30 of February at
    // 00:00", which a reader cannot tell apart from a schedule that fires.
    expect(describeCronExpression(parseCronExpression('0 0 30 2 *'))).toBe('cron 0 0 30 2 *')
    expect(describeCronExpression(parseCronExpression('0 0 31 4 *'))).toBe('cron 0 0 31 4 *')
    expect(describeCronExpression(parseCronExpression('0 0 31 2,4 *'))).toBe('cron 0 0 31 2,4 *')
    // The neighbouring shapes are reachable and keep their names: the 31st exists in
    // seven months, and 29 February exists in every leap year.
    expect(describeCronExpression(parseCronExpression('0 0 31 * *'))).toBe('day 31 of the month at 00:00')
    expect(describeCronExpression(parseCronExpression('0 0 29 2 *'))).toBe('day 29 of February at 00:00')
    expect(describeCronExpression(parseCronExpression('0 0 29 2,4 *'))).toBe('day 29 of February, April at 00:00')
    // A rule with both day fields restricted is OR-combined, so its weekday half
    // fires whatever its day of month asks for: not unreachable, and refused by the
    // OR rule for the same reason it always was.
    expect(describeCronExpression(parseCronExpression('0 0 30 2 1'))).toBe('cron 0 0 30 2 1')
  })
})
