/**
 * Reading a five-field cron expression: parse it, say when it next falls, and
 * say whether one fixed-rate reminder can carry it.
 *
 * Why this exists rather than the Harness `schedule` service
 * ---------------------------------------------------------
 * `dsh-schedule` owns reminders — after, at, and fixed-rate — and it owns them
 * well. What it has no vocabulary for is a **wall-clock calendar rule**: "every
 * weekday at 09:00", "the first of the month". Those are what a user writes down
 * when they want a recurring job, and the three shapes that service accepts
 * cannot express a calendar day at all.
 *
 * This module is therefore *arithmetic only*. It parses and it answers; it stores
 * no reminder and runs no timer. Delivery, durability, the projection, and the
 * model-facing tools all belong to the Harness, and the caller hands this
 * module's answer over as an `at` or `every_seconds` selector. An earlier version
 * of the plugin owned a second scheduler beside that one — a workspace-local
 * store with its own fire loop — and the loop had no caller, so a rule could be
 * created and then never fire. The part that was actually unique is the calendar
 * reading, which is what is left.
 *
 * The parser follows the usual Vixie semantics, including the two rules that are
 * easy to get wrong:
 *
 * 1. **Day-of-month and day-of-week combine with OR when both are restricted**,
 *    and with AND otherwise. `0 0 1 * 1` therefore means "the first of the
 *    month *or* any Monday", not "a Monday that is also the first".
 * 2. **Sunday is both 0 and 7.** A file written by a person who thinks in
 *    ISO weekdays must not silently never fire.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/scheduler/cron
 */

/** A parsed, validated cron expression. Sets are sorted at parse time. */
export interface CronExpression {
  /** The original text, echoed back in reports. */
  readonly source: string
  /** Minutes past the hour, 0-59. */
  readonly minute: readonly number[]
  /** Hours, 0-23. */
  readonly hour: readonly number[]
  /** Days of the month, 1-31. */
  readonly dayOfMonth: readonly number[]
  /** Months, 1-12. */
  readonly month: readonly number[]
  /** Weekdays, 0-6 with 0 = Sunday (7 is normalized to 0). */
  readonly dayOfWeek: readonly number[]
  /**
   * Whether the field was anything other than `*`. Both restricted switches
   * change the day match from AND to OR, so they are part of the parse result
   * rather than re-derived from the value set.
   */
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

/**
 * Search horizon for the next occurrence, in days.
 *
 * Eight years, not the four a leap-year cycle suggests. The two day-of-month
 * shapes that are legal but sparse are 29 and 31, and 29 February is the one that
 * can be further away than a cycle: a century year that is not divisible by 400
 * skips its leap day, so 29 February 2096 is followed by 29 February 2104 — an
 * eight-year gap. A four-year horizon ran out inside it and answered `undefined`
 * for a rule {@link describeCronExpression} names as "day 29 of February", which
 * is exactly the disagreement between the two readings this module refuses
 * everywhere else. No larger gap exists: leap years are four apart and only one
 * century year in a row can skip, so {@link CRON_SEARCH_HORIZON_YEARS} * 366 + 1
 * days always contains the next occurrence of any satisfiable day field.
 *
 * The cost is paid only by the expressions that never fire (`0 0 30 2 *`), which
 * run the loop to the end: one cheap `Date` and a set membership test per day.
 */

/**
 * How many years ahead a search looks, as the number a report can quote.
 *
 * Exported because a caller has to *say* the horizon to a user or a model — the
 * schedule tool's "nothing to schedule" guidance does — and a hand-written
 * sentence beside this constant is how the number came to be quoted as four
 * after the search had left that behind.
 */
export const CRON_SEARCH_HORIZON_YEARS = 8

const MAX_DAY_SEARCH = 366 * CRON_SEARCH_HORIZON_YEARS + 1

const MINUTE = 60_000

/** Named aliases, expanded before parsing so one code path serves both forms. */
const ALIASES: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

interface FieldSpec {
  readonly min: number
  readonly max: number
  readonly label: string
  /** Applied to every parsed value, so `7` in the weekday field becomes `0`. */
  readonly normalize?: (value: number) => number
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59, label: 'minute' },
  { min: 0, max: 23, label: 'hour' },
  { min: 1, max: 31, label: 'day-of-month' },
  { min: 1, max: 12, label: 'month' },
  { min: 0, max: 7, label: 'day-of-week', normalize: value => (value === 7 ? 0 : value) },
]

function parseNumber(text: string, spec: FieldSpec): number {
  if (!/^\d{1,2}$/u.test(text)) throw new Error(`cron: ${spec.label} field has a non-numeric value: ${text}`)
  const value = Number(text)
  if (value < spec.min || value > spec.max) {
    throw new Error(`cron: ${spec.label} field value ${value} is outside ${spec.min}-${spec.max}`)
  }
  return value
}

/**
 * Parse one field, returning its values and whether it was restricted.
 *
 * Supported grammar: a wildcard, a single value, a range, a value or range
 * followed by a slash and a step, and any comma-separated list of those. A step
 * of zero is rejected rather than treated as one, because a silent
 * reinterpretation of an obviously wrong expression is worse than a refusal at
 * write time.
 */
function parseField(text: string, spec: FieldSpec): { readonly values: readonly number[]; readonly restricted: boolean } {
  const values = new Set<number>()
  const restricted = text !== '*'
  for (const part of text.split(',')) {
    if (part === '') throw new Error(`cron: ${spec.label} field has an empty list entry`)
    const segments = part.split('/')
    if (segments.length > 2) throw new Error(`cron: ${spec.label} field has more than one step: ${part}`)
    const range = segments[0]!
    const stepText = segments[1]
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/u.test(stepText)) throw new Error(`cron: ${spec.label} field has a non-numeric step: ${stepText}`)
      step = Number(stepText)
      if (step === 0) throw new Error(`cron: ${spec.label} field has a zero step`)
    }
    let from: number
    let to: number
    if (range === '*') {
      from = spec.min
      to = spec.max
    } else if (range.includes('-')) {
      const segments = range.split('-')
      if (segments.length > 2 || segments[0] === '' || segments[1] === '') {
        throw new Error(`cron: ${spec.label} field has a malformed range: ${part}`)
      }
      from = parseNumber(segments[0]!, spec)
      to = parseNumber(segments[1]!, spec)
      if (from > to) throw new Error(`cron: ${spec.label} field range ${part} runs backwards`)
    } else {
      from = parseNumber(range, spec)
      // A bare value with a step (`5/10`) means "from 5 to the end of the field",
      // which is the reading every cron implementation shares.
      to = stepText === undefined ? from : spec.max
    }
    for (let value = from; value <= to; value += step) values.add(spec.normalize === undefined ? value : spec.normalize(value))
  }
  // Every branch above adds at least its own start value, so the set is never
  // empty; there is no "selects no values" case to report.
  return { values: [...values].sort((left, right) => left - right), restricted }
}

/** Parse a 5-field expression or a `@daily`-style alias. Throws on malformed input. */
export function parseCronExpression(source: string): CronExpression {
  const trimmed = source.trim()
  if (trimmed === '') throw new Error('cron: expression is empty')
  const alias = ALIASES[trimmed]
  if (alias !== undefined) return parseCronExpression(alias)
  if (trimmed.startsWith('@')) throw new Error(`cron: unknown schedule alias: ${trimmed}`)
  const parts = trimmed.split(/\s+/u)
  if (parts.length !== 5) throw new Error(`cron: expected 5 fields but found ${parts.length} in ${JSON.stringify(source)}`)
  const parsed = parts.map((part, index) => parseField(part, FIELDS[index]!))
  return {
    // Canonical single-space form, so a report echoing `source` shows the same
    // text for `0  9  *  *  *` and `0 9 * * *`.
    source: parts.join(' '),
    minute: parsed[0]!.values,
    hour: parsed[1]!.values,
    dayOfMonth: parsed[2]!.values,
    month: parsed[3]!.values,
    dayOfWeek: parsed[4]!.values,
    dayOfMonthRestricted: parsed[2]!.restricted,
    dayOfWeekRestricted: parsed[4]!.restricted,
  }
}

/** Whether a calendar day satisfies the (possibly OR-combined) day fields. */
function dayMatches(expression: CronExpression, day: Date): boolean {
  const monthOk = expression.month.includes(day.getMonth() + 1)
  if (!monthOk) return false
  const dayOfMonthOk = expression.dayOfMonth.includes(day.getDate())
  const dayOfWeekOk = expression.dayOfWeek.includes(day.getDay())
  if (expression.dayOfMonthRestricted && expression.dayOfWeekRestricted) return dayOfMonthOk || dayOfWeekOk
  return dayOfMonthOk && dayOfWeekOk
}

/**
 * The instant one wall-clock reading names, resolved to the pass the cursor is in.
 *
 * `new Date(y, m, d, h, mm)` answers an *ambiguous* local time with its earlier
 * pass, and on the day a zone repeats an hour that is the wrong pass whenever the
 * cursor already sits in the later one: the answer is then an hour in the past,
 * which breaks this module's own contract ("strictly after `fromMs`") and hands a
 * caller's `at` selector an instant that has already elapsed. Rebuilding the same
 * reading with the *cursor's* offset gives the later pass, which is the
 * occurrence the cursor was asking for.
 *
 * Only an ambiguous reading can land at or before the cursor: every other one
 * resolves to a single instant, and the search has already skipped the readings
 * the cursor passed. `getTimezoneOffset` is minutes west of UTC, so adding it to
 * the reading treated as UTC converts it into that offset's instant.
 *
 * @param year - calendar year of the reading.
 * @param monthIndex - 0-based month of the reading.
 * @param day - day of the month of the reading.
 * @param hour - hour of the reading.
 * @param minute - minute of the reading.
 * @param fromMs - the cursor the answer has to follow.
 * @returns the instant, which may still be at or before `fromMs` defensively.
 */
function resolveWallClock(year: number, monthIndex: number, day: number, hour: number, minute: number, fromMs: number): number {
  const candidate = new Date(year, monthIndex, day, hour, minute, 0, 0).getTime()
  if (candidate > fromMs) return candidate
  return Date.UTC(year, monthIndex, day, hour, minute, 0, 0) + new Date(fromMs).getTimezoneOffset() * MINUTE
}

/**
 * Whether an instant reads back as the wall clock it was built from.
 *
 * `new Date(y, m, d, h, min)` does not honour a local time that does not exist:
 * during a spring-forward jump the clock goes 02:00 → 03:00, and an instant built
 * from 02:30 silently reads back as 03:30. A rule that fired then would run an
 * hour later than it was written to — and a rule written for 02:30 usually has a
 * reason (a window, a market, a maintenance slot).
 */
function readsRequestedWallClock(atMs: number, year: number, monthIndex: number, day: number, hour: number, minute: number): boolean {
  const at = new Date(atMs)
  return at.getFullYear() === year && at.getMonth() === monthIndex && at.getDate() === day
    && at.getHours() === hour && at.getMinutes() === minute
}

/**
 * The first occurrence strictly after `fromMs`, in local time.
 *
 * `undefined` means no occurrence exists inside the search horizon
 * ({@link CRON_SEARCH_HORIZON_YEARS} years), which only happens for a
 * self-contradictory expression such as `0 0 30 2 *`.
 */
export function computeNextCronRun(expression: CronExpression, fromMs: number): number | undefined {
  const start = new Date((Math.floor(fromMs / MINUTE) + 1) * MINUTE)
  const startDay = start.getDate()
  const startHour = start.getHours()
  const startMinute = start.getMinutes()
  for (let offset = 0; offset <= MAX_DAY_SEARCH; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), startDay + offset)
    if (!dayMatches(expression, day)) continue
    const firstHour = offset === 0 ? startHour : 0
    const firstMinute = offset === 0 ? startMinute : 0
    for (const hour of expression.hour) {
      if (hour < firstHour) continue
      for (const minute of expression.minute) {
        if (hour === firstHour && minute < firstMinute) continue
        const resolved = resolveWallClock(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, fromMs)
        // A reading the cursor has already passed is not an answer: in a repeated
        // hour the fallback above can still name the earlier pass, and returning it
        // would move a caller backwards. Searching on is what finds the later
        // reading instead of hiding the failure.
        if (resolved <= fromMs) continue
        // A local time the zone skipped does not exist, so it is not an occurrence.
        // `Date` normalizes it forward instead of refusing, which would fire the job
        // at a wall clock the expression never named; skipping the reading lets the
        // day loop find the next day that has it. The user sees the rule miss one
        // day rather than run an hour late, and `cronOccurrence` still reports the
        // instant it actually chose.
        if (!readsRequestedWallClock(resolved, day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)) continue
        return resolved
      }
    }
  }
  return undefined
}

/**
 * One upcoming occurrence, rendered in the two selector forms the Harness accepts.
 *
 * Both are emitted from the same instant rather than computed separately: the
 * Harness's `schedule_create` takes either a strict offset RFC 3339 string or a
 * structured local date/time with an explicit IANA zone, and a caller that had
 * to choose between two independently derived values could hand over two
 * different moments.
 */
export interface CronOccurrence {
  /** Epoch milliseconds, as the local wall clock the expression was written in. */
  readonly atMs: number
  /** Strict offset RFC 3339 UTC form. */
  readonly rfc3339: string
  /** Structured local selector: calendar date, wall-clock time, and IANA zone. */
  readonly local: { readonly date: string; readonly time: string; readonly time_zone: string }
}

/** The IANA zone this process's local time is in, for the structured selector. */
export function cronLocalTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // A runtime that resolves no zone cannot express a local target, and silently
  // substituting UTC would move every occurrence by the offset. `UTC` is the
  // only honest answer, and it is also a zone the Harness accepts.
  return zone === undefined || zone === '' ? 'UTC' : zone
}

/** Render one instant in both selector forms. */
export function cronOccurrence(atMs: number): CronOccurrence {
  const date = new Date(atMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    atMs,
    rfc3339: date.toISOString(),
    local: {
      date: `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      time_zone: cronLocalTimeZone(),
    },
  }
}

/**
 * The next `count` occurrences strictly after `fromMs`, earliest first.
 *
 * Fewer than `count` are returned when the rule stops having occurrences inside
 * the search horizon — a self-contradictory expression such as `0 0 30 2 *`
 * yields none. Returning what exists rather than throwing is deliberate: the
 * caller's job is to hand the Harness the occurrences it can, and an empty list
 * is a fact about the rule, not an error in the call.
 */
export function nextCronOccurrences(expression: CronExpression, fromMs: number, count: number): readonly CronOccurrence[] {
  const occurrences: CronOccurrence[] = []
  let cursor = fromMs
  for (let index = 0; index < count; index += 1) {
    const next = computeNextCronRun(expression, cursor)
    if (next === undefined) break
    occurrences.push(cronOccurrence(next))
    cursor = next
  }
  return occurrences
}

/**
 * The rule's interval in seconds when it fires at a genuinely fixed rate.
 *
 * This is the difference between one Harness schedule and many: `every_seconds`
 * is a real fixed-rate reminder, while a rule that is not fixed-rate ("weekdays
 * at 09:00") can only be delivered as a chain of one-shots, because the
 * Harness's rule set is after/at/every and none of the three expresses a
 * calendar day.
 *
 * Answers only for the shapes that are provably constant, which is why the day
 * fields must be unrestricted and the minute set must divide the hour evenly.
 * A seven-minute step is deliberately *not* fixed-rate: it fires at :00, :07, up
 * to :56, and then at the next hour's :00, so one gap in every hour is four
 * minutes. Returning `undefined` for it is the whole point — a caller that
 * trusted a wrong interval would schedule a rule that drifts.
 *
 * The answer is a *duration*, while a cron rule is wall-clock: in a zone that
 * shifts its clock, two consecutive local 09:00 firings are 23 and 25 hours apart
 * once a year, so a fixed-rate reminder stays where it was put instead of
 * following the rule. Whether that is acceptable is not this module's to decide —
 * `every_seconds` is the only shape the Harness offers for a recurring reminder —
 * so the cadence is reported and the difference is recorded here rather than
 * hidden behind a claim of equivalence.
 */
export function cronFixedRateSeconds(expression: CronExpression): number | undefined {
  const everyDay = expression.dayOfMonth.length === 31 && expression.month.length === 12 && expression.dayOfWeek.length === 7
  if (!everyDay) return undefined
  const minutes = expression.minute
  const hours = expression.hour
  // Minutes spread across every hour: `*/N * * * *`. One minute per firing.
  if (hours.length === 24) {
    if (minutes.length === 1) return 60 * 60
    const minuteStep = evenStep(minutes, 60)
    return minuteStep === undefined ? undefined : minuteStep * 60
  }
  // Hours spread across the day at one minute past: `0 */N * * *`. A single
  // hour is the step that closes the whole day, which is `0 0 * * *`.
  if (minutes.length === 1) {
    const hourStep = hours.length === 1 ? 24 : evenStep(hours, 24)
    return hourStep === undefined ? undefined : hourStep * 60 * 60
  }
  return undefined
}

/**
 * The constant step of an evenly spaced set that closes its cycle, or `undefined`.
 *
 * This is the exact test for "every N", and it is shared so the fixed-rate answer
 * and the human label cannot disagree about the same rule. Two accepted sets are
 * spelled with a non-zero origin (`1,31 * * * *` is every thirty minutes: :01,
 * :31, :01), so the origin is echoed rather than required to be zero. A set that
 * closes early (`5,35,55`) fails the count, and one whose step leaves a remainder
 * in its cycle (a 7-minute or 9-minute step) fails the division — both are
 * genuinely uneven, once per cycle.
 */
function evenStep(values: readonly number[], cycle: number): number | undefined {
  if (values.length < 2) return undefined
  const step = values[1]! - values[0]!
  if (step <= 0 || cycle % step !== 0) return undefined
  if (values.length !== cycle / step) return undefined
  const origin = values[0]!
  return values.every((value, index) => value === origin + index * step) ? step : undefined
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The days each month has, at its longest.
 *
 * February is 29 because a leap year is a calendar year too: `0 0 29 2 *` fires,
 * once every four years, and a rule that names it must keep its name.
 */
const LONGEST_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Whether no calendar day can satisfy the day fields.
 *
 * Structural rather than a search: the answer must not depend on the clock, or the
 * same expression would be described two ways on two calls. Only one combination of
 * the two day fields can be empty. With both restricted the rule is OR-combined and
 * a weekday falls inside every allowed month. With the day of month unrestricted
 * every day matches. What is left is a restricted day of month that must also be a
 * day the month has — and `0 0 30 2 *` asks for one February does not have in any
 * year, which is a rule that can be written down and never run.
 * @param expression - the parsed rule.
 * @returns whether the rule can never fire, whatever the clock.
 */
function dayOfMonthIsUnreachable(expression: CronExpression): boolean {
  if (expression.dayOfWeekRestricted || !expression.dayOfMonthRestricted) return false
  return expression.month.every(month => expression.dayOfMonth.every(day => day > LONGEST_MONTH_DAYS[month - 1]!))
}

/**
 * A short human label for a rule, for the settings surface.
 *
 * Deliberately conservative: it only claims the shapes it can name exactly and
 * otherwise echoes the expression, rather than inventing a description for a
 * rule a reader would then not be able to compare against the file.
 */
export function describeCronExpression(expression: CronExpression): string {
  const minutes = expression.minute
  const hours = expression.hour
  // A restricted month narrows every shape named below, so it travels with the
  // label instead of being dropped. `0 9 * 6 *` is not "daily" and
  // `0 9 * 6 3` is not "Wednesday at 09:00": each names a firing schedule the
  // rule does not have. The fixed-rate answer already refuses both expressions
  // for the same reason, and a label that disagrees with it is the defect this
  // module keeps fixing rather than a second opinion.
  const months = expression.month.map(month => MONTHS[month - 1]!)
  const monthQualifier = expression.month.length === 12 ? '' : ` in ${months.join(', ')}`
  if (minutes.length === 1 && hours.length === 1) {
    const time = `${pad(hours[0]!)}:${pad(minutes[0]!)}`
    // Indexing is safe: every field is non-empty by construction and both
    // indices are already range-checked by the parser.
    if (expression.dayOfMonthRestricted && expression.dayOfWeekRestricted) {
      // Both day fields restricted means the two are OR-combined, so naming one
      // of them names a subset of the firings: `0 9 1,15 * 3` fires on the 1st
      // and 15th *as well as* every Wednesday, and "Wednesday at 09:00" reads as
      // the whole rule. Same defect the day-of-week set naming below fixed; the
      // only honest label for the combination is the expression itself.
      return `cron ${expression.source}`
    }
    if (expression.dayOfWeekRestricted) {
      // Named as a set, not by its lowest member. Reading `${days[0]}` was how
      // `0 9 * * 1-5` came out as "Monday at 09:00" — a label that names one
      // firing out of five, which is worse than no label for a rule a reader is
      // meant to check against the expression beside it.
      const days = expression.dayOfWeek
      if (days.length === 5 && days.every(day => day >= 1 && day <= 5)) return `weekdays${monthQualifier} at ${time}`
      if (days.length === 2 && days.includes(0) && days.includes(6)) return `weekends${monthQualifier} at ${time}`
      return `${days.map(day => WEEKDAYS[day]!).join(', ')}${monthQualifier} at ${time}`
    }
    if (expression.dayOfMonthRestricted) {
      // Naming the day would advertise a schedule no reader can tell from one that
      // fires; the expression is echoed instead, which is this function's answer for
      // every shape it cannot name exactly.
      if (dayOfMonthIsUnreachable(expression)) return `cron ${expression.source}`
      const days = `day ${expression.dayOfMonth.join(', ')}`
      // "of January" would be a claim about a month the expression never named.
      return expression.month.length === 12
        ? `${days} of the month at ${time}`
        : `${days} of ${months.join(', ')} at ${time}`
    }
    return `daily${monthQualifier} at ${time}`
  }
  if (minutes.length > 1 && hours.length === 24) {
    // The same "every N" test the fixed-rate answer uses. A bare count was how
    // `*/7 * * * *` came out as "every 7 minutes": that set closes at :56 and
    // restarts at the next hour's :00, so one gap in every hour is four minutes,
    // and the module's own fixed-rate rule already refuses it.
    const step = evenStep(minutes, 60)
    if (step !== undefined && step > 1) return `every ${step} minutes${monthQualifier}`
  }
  return `cron ${expression.source}`
}
