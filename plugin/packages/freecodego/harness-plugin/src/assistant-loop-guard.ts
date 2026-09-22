/**
 * Streaming repetition guard for the model's own assistant text.
 *
 * The Host already refuses a tool call repeated with identical arguments
 * (`tool-guards.ts`). That covers one failure mode; it does not cover the other,
 * which is the model looping inside its own prose — emitting the same line,
 * the same table row, or the same paragraph until the context window is gone.
 * Until now nothing observed assistant text at all, so a runaway answer was
 * only ever stopped by the token budget.
 *
 * This guard reads `agent/assistant-stream` while the answer is still being
 * written and answers in two tiers, because the two failure modes need
 * different treatment:
 *
 *   1. **Remind.** A loop is often a local derailment. Injecting a reminder
 *      costs one message and frequently recovers the turn, so the first
 *      detection warns the model and lets it continue.
 *   2. **Stop.** If it loops again after being told (or loops a second time in
 *      the same session), the turn is cancelled. A model that repeats text it
 *      has just been warned about is not going to recover on its own, and every
 *      further token is paid for twice: once to generate it and once to carry
 *      it in the history.
 *
 * ## Why the detector is shaped this way
 *
 * Repetition is not the same as redundancy. Code fences repeat by nature,
 * tables are made of near-identical rows, and a diff of a wide file repeats a
 * prefix on every line. A detector that flags those is worse than none, so:
 *
 * - **Dual thresholds.** A period `p` repeated `k` times only counts when
 *   `k >= minRepetitions` **and** `p * k >= minPeriodTimesRepetitions`. A bare
 *   repetition count flags `0,0,0`; multiplying by the period makes the
 *   threshold scale with how much text actually repeated.
 * - **Wider thresholds inside a code fence.** A fence is where legitimate
 *   repetition lives, so it gets a higher bar than prose.
 * - **Box-drawing lines are never counted.** A table border is almost entirely
 *   `─│┌┐└┘`-class characters; treating it as a line makes every rendered
 *   table a loop.
 * - **A hard time budget.** Detection runs on the streaming path, so it can
 *   delay output. The deadline is checked every few periods, and exceeding it
 *   **fails open**: the stream wins over the audit. A guard that can stall the
 *   model is a worse failure than the loop it prevents.
 *
 * Only `text-delta` chunks are observed. Reasoning deltas are ignored outright:
 * a model re-deriving the same intermediate step is not the failure this guard
 * exists for, and feeding them in would flag ordinary chain-of-thought.
 *
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Longest line the detector will accumulate; past this a line stops growing. */
const MAX_LINE_LENGTH = 10_000
/** Lines of history kept for multi-line matching. */
const LINE_QUEUE_FACTOR = 50
/** Wall-clock ceiling for one `addText` call before the detector fails open. */
const MAX_CHECK_TIME_MS = 500
/** Upper bound on the period searched for a single-line loop. */
const MAX_PERIOD = 256

/** Repetitions of one line that constitute a multi-line loop in prose. */
const MULTI_LINE_MIN_REPETITIONS = 2
/** Same, inside a code fence, where repeated lines are expected. */
const MULTI_LINE_MIN_REPETITIONS_IN_FENCE = 3
/** Repetitions of a character-level period that constitute a single-line loop. */
const SINGLE_LINE_MIN_REPETITIONS = 3
/** Same, inside a code fence. */
const SINGLE_LINE_MIN_REPETITIONS_IN_FENCE = 4
/** Character cost a single-line loop must reach, scaling the repetition count by the period. */
const SINGLE_LINE_MIN_PERIOD_TIMES_REPETITIONS = 100
/** Same, inside a code fence. */
const SINGLE_LINE_MIN_PERIOD_TIMES_REPETITIONS_IN_FENCE = 200
/** Line cost a multi-line loop must reach. */
const MULTI_LINE_MIN_PERIOD_TIMES_REPETITIONS = 3
/** Same, inside a code fence. */
const MULTI_LINE_MIN_PERIOD_TIMES_REPETITIONS_IN_FENCE = 4
/** Characters a multi-line loop must repeat in total, so two short lines do not trip it. */
const MULTI_LINE_MIN_TOTAL_CHARS = 50
/** Same, inside a code fence. */
const MULTI_LINE_MIN_TOTAL_CHARS_IN_FENCE = 100

/**
 * Characters that make up a drawn line. A line that is at least
 * {@link BOX_BORDER_SHARE} of these is a border, not prose.
 */
const BOX_BORDER_CHARS = new Set([
  '─', '━', '═', '-', '_',
  '│', '┃', '║', '|',
  '┌', '┐', '└', '┘', '╔', '╗', '╚', '╝', '┏', '┓', '┗', '┛', '╓', '╖', '╙', '╜',
  '├', '┤', '┬', '┴', '┼', '╟', '╢', '╤', '╧', '╫', '╠', '╣', '╦', '╩', '╬', '╞', '╡', '╥', '╨', '╪',
  '+',
])
const BOX_BORDER_SHARE = 0.8

/** Which axis a detected loop sits on. Drives the wording of the reminder. */
export type AssistantLoopKind = 'single-line' | 'multi-line'

/** One detected repetition, described well enough to log and to explain. */
export interface AssistantLoopFinding {
  readonly kind: AssistantLoopKind
  /** The repeated unit: a character run for single-line, joined lines for multi-line. */
  readonly pattern: string
  readonly repetitions: number
  /** Period in characters for a single-line loop, in lines for a multi-line one. */
  readonly period: number
}

//
// ─── Detector ────────────────────────────────────────────────────────────────
//

/**
 * How a detector starts, for the one case where a message is picked up midway.
 *
 * A caller that begins a detector partway through a message (the guard does this
 * when it replaces one behind a reminder) sees only the text that follows, but
 * where that text sits has not changed: a fenced table does not become prose
 * because the reader changed. Without this flag the replacement measured fenced
 * content by the prose bar and cancelled a turn for repetition the module's own
 * rules treat as legitimate.
 */
export interface AssistantLoopDetectorOptions {
  /** Whether the picked-up text is already inside a ``` fence. */
  readonly startsInsideFence?: boolean
}

/**
 * Streaming repetition detector for one assistant message.
 *
 * Stateful and single-message: feeding two interleaved messages would let one
 * message's lines satisfy the other's period search, so a caller starts a fresh
 * detector per attempt (see {@link AssistantLoopGuard}).
 *
 * Not thread-safe and not intended to be: it is driven synchronously from one
 * stream's chunk delivery.
 */
export class AssistantLoopDetector {
  /** Ring buffer of completed lines, newest last. */
  private readonly lines: string[] = []
  /** The line currently being streamed. */
  private partial = ''
  /** Whether the reader is inside a ``` fence, which widens every threshold. */
  private inFence: boolean

  constructor(options: AssistantLoopDetectorOptions = {}) {
    this.inFence = options.startsInsideFence ?? false
  }
  /** Set once the time budget is exhausted; all later checks are skipped. */
  private exhausted = false
  /** Longest period whose character match is still running, per period. */
  private readonly singleLineRuns = new Array<number>(MAX_PERIOD + 1).fill(0)
  /** Longest run of matching lines at each period, per period. */
  private readonly multiLineRuns = new Map<number, number>()
  private finding: AssistantLoopFinding | undefined

  /** The loop found so far, or `undefined` while the message looks clean. */
  get result(): AssistantLoopFinding | undefined {
    return this.finding
  }

  /** Whether the time budget ran out, which means this message is unaudited. */
  get timedOut(): boolean {
    return this.exhausted
  }

  /**
   * Whether the reader is inside a ``` fence right now.
   *
   * Exposed so a detector that picks a message up midway can be told where the
   * message was: the flag is context about the surrounding text, not a finding,
   * so it is the one piece of state a replacement has to inherit.
   */
  get insideFence(): boolean {
    return this.inFence
  }

  /**
   * Feed the next slice of assistant text.
   *
   * @param text - A `text-delta` chunk's text. May be empty.
   * @returns the finding the moment it is confirmed, else `undefined`.
   */
  add(text: string): AssistantLoopFinding | undefined {
    if (this.finding !== undefined || this.exhausted) return this.finding
    if (text.length === 0) return undefined
    const deadline = performance.now() + MAX_CHECK_TIME_MS
    for (const char of text) {
      if (char === '\n') {
        this.endLine(deadline)
        if (this.exhausted || this.finding !== undefined) return this.finding
        continue
      }
      if (this.partial.length >= MAX_LINE_LENGTH) continue
      this.partial += char
      if (char === ' ' || char === '\t') continue
      const found = this.checkSingleLine(deadline)
      if (found !== undefined) return found
      if (this.exhausted) return undefined
    }
    return undefined
  }

  /** Close the open line into history and run the multi-line search. */
  private endLine(deadline: number): void {
    const line = this.partial
    this.partial = ''
    this.singleLineRuns.fill(0)
    if (line.trim().length === 0) return
    this.toggleFenceOn(line)
    if (isBoxBorderLine(line)) return
    this.lines.push(line)
    const maxLines = LINE_QUEUE_FACTOR * MULTI_LINE_MIN_REPETITIONS
    if (this.lines.length > maxLines) this.lines.splice(0, this.lines.length - maxLines)
    this.checkMultiLine(deadline)
  }

  /**
   * Search for a short character period repeating across the open line.
   *
   * `singleLineRuns[p]` counts how many character positions in a row have
   * matched their counterpart `p` places back, so the run length is maintained
   * in O(1) per position and only costs a period scan per character.
   */
  private checkSingleLine(deadline: number): AssistantLoopFinding | undefined {
    const line = this.partial
    const pos = line.length - 1
    const maxPeriod = Math.min(MAX_PERIOD, pos)
    const minRepetitions = this.inFence ? SINGLE_LINE_MIN_REPETITIONS_IN_FENCE : SINGLE_LINE_MIN_REPETITIONS
    const minCost = this.inFence
      ? SINGLE_LINE_MIN_PERIOD_TIMES_REPETITIONS_IN_FENCE
      : SINGLE_LINE_MIN_PERIOD_TIMES_REPETITIONS
    for (let period = 1; period <= maxPeriod; period++) {
      // The deadline is sampled on a stride so the clock is not read per period.
      if ((period & 31) === 0 && this.exhaust(deadline)) return undefined
      if (line[pos] !== line[pos - period]) {
        this.singleLineRuns[period] = 0
        continue
      }
      const run = (this.singleLineRuns[period] = (this.singleLineRuns[period] ?? 0) + 1)
      const repetitions = Math.floor(run / period) + 1
      if (repetitions < minRepetitions || period * repetitions < minCost) continue
      this.finding = {
        kind: 'single-line',
        pattern: line.slice(line.length - period),
        repetitions,
        period,
      }
      return this.finding
    }
    return undefined
  }

  /** Search for a run of identical lines, the multi-line counterpart. */
  private checkMultiLine(deadline: number): void {
    const current = this.lines.at(-1)
    if (current === undefined) return
    const maxPeriod = this.lines.length - 1
    const minRepetitions = this.inFence ? MULTI_LINE_MIN_REPETITIONS_IN_FENCE : MULTI_LINE_MIN_REPETITIONS
    const minCost = this.inFence
      ? MULTI_LINE_MIN_PERIOD_TIMES_REPETITIONS_IN_FENCE
      : MULTI_LINE_MIN_PERIOD_TIMES_REPETITIONS
    const minChars = this.inFence ? MULTI_LINE_MIN_TOTAL_CHARS_IN_FENCE : MULTI_LINE_MIN_TOTAL_CHARS
    for (let period = 1; period <= maxPeriod; period++) {
      if ((period & 7) === 0 && this.exhaust(deadline)) return
      if (this.lines[this.lines.length - 1 - period] !== current) {
        this.multiLineRuns.set(period, 0)
        continue
      }
      const run = (this.multiLineRuns.get(period) ?? 0) + 1
      this.multiLineRuns.set(period, run)
      const repetitions = Math.floor(run / period) + 1
      if (repetitions < minRepetitions || period * repetitions < minCost) continue
      const pattern = this.lines.slice(this.lines.length - period)
      // Two short identical lines are a coincidence; a loop has to carry text.
      if (pattern.reduce((sum, line) => sum + line.length, 0) * repetitions < minChars) continue
      this.finding = { kind: 'multi-line', pattern: pattern.join('\n'), repetitions, period }
      return
    }
  }

  /** Mark the detector exhausted once the wall-clock budget is gone. */
  private exhaust(deadline: number): boolean {
    if (this.exhausted) return true
    if (performance.now() < deadline) return false
    this.exhausted = true
    return true
  }

  /** Flip fence state on an odd number of fence openers; even keeps it. */
  private toggleFenceOn(line: string): void {
    const matches = line.match(/```+(?!`)/gu)
    if (matches === null || matches.length === 0) return
    if (matches.length % 2 === 1) this.inFence = !this.inFence
  }
}

//
// ─── Escalation ──────────────────────────────────────────────────────────────
//

/** The invariant part of what a reminder says, split out so tests can assert it. */
export interface AssistantLoopReminderInput {
  readonly kind: AssistantLoopKind
  readonly repetitions: number
  readonly period: number
}

/**
 * Render the first-tier reminder for one finding.
 *
 * The wording names the axis, because "you repeated a line" and "you repeated a
 * block" describe different mistakes and a model told the wrong one cannot act
 * on it. The closing sentence keeps the reminder from leaking into the answer:
 * the model must not explain the machinery to a user who never saw it.
 *
 * @param finding - the repetition that was detected.
 * @returns the reminder text to inject.
 */
export function renderAssistantLoopReminder(finding: AssistantLoopReminderInput): string {
  const what = finding.kind === 'single-line'
    ? `a ${finding.period}-character run repeated ${finding.repetitions} times inside one line`
    : `${finding.period} line${finding.period === 1 ? '' : 's'} repeated ${finding.repetitions} times`
  return [
    '<system_reminder>',
    `Your output has been flagged as looping: ${what}. Stop repeating it and continue with the next distinct step.`,
    'If you are retrying a failed action, change the approach instead of repeating it. If you are stuck, say so and ask for guidance.',
    'Do not mention this reminder in your reply; the user is already aware.',
    '</system_reminder>',
  ].join('\n')
}

/** Counters the Host can surface; the guard's activity is otherwise invisible. */
export interface AssistantLoopGuardStats {
  /** Confirmed repetitions, including the ones that only produced a reminder. */
  readonly detections: number
  /** Times a reminder was injected. */
  readonly reminders: number
  /** Times a turn was cancelled. */
  readonly stops: number
  /** Messages whose audit was abandoned because the time budget ran out. */
  readonly unaudited: number
}

/** Collaborators the guard needs; all injected so the guard stays testable. */
export interface AssistantLoopGuardDeps {
  /** Whether the guard runs at all; read per frame so a settings change applies at once. */
  readonly enabled: () => boolean
  /** Reports a cancelled turn with the finding that caused it. */
  readonly onStop: (agent: Agent, finding: AssistantLoopFinding) => void
}

/**
 * Per-agent streaming repetition guard with a reminder-then-stop ladder.
 *
 * State is keyed by session and reset on every assistant attempt, so the ladder
 * is scoped to one answer: a warning 50 turns ago must not turn today's first
 * loop into an immediate cancellation.
 */
export class AssistantLoopGuard {
  /** Live detector per session, replaced after a reminder so the next finding is a reoccurrence. */
  private readonly detectors = new Map<string, AssistantLoopDetector>()
  /** Findings seen so far in the current attempt, which is what separates warn from stop. */
  private readonly findingsThisAttempt = new Map<string, number>()
  /**
   * Attempts whose turn has already been cancelled for looping.
   *
   * The detector latches its finding for the rest of the message, and the stream
   * keeps delivering chunks until the abort takes effect, so without this latch
   * every later chunk re-reported the same loop: the Host's `stops` counter grew
   * with the chunk count and the same turn was cancelled over and over.
   */
  private readonly stopped = new Set<string>()
  /**
   * Detectors whose abandoned audit has already been counted.
   *
   * Keyed on the detector rather than the session because a detector *is* one
   * audit: `unaudited` counts messages, and one message arrives as many chunks,
   * so counting per frame multiplied the figure by the chunk count. A detector
   * replaced after a reminder is a new key, which is correct — that audit really
   * was abandoned a second time.
   */
  private readonly countedAbandoned = new WeakSet<AssistantLoopDetector>()
  private detections = 0
  private reminders = 0
  private stops = 0
  private unaudited = 0

  constructor(private readonly deps: AssistantLoopGuardDeps) {}

  /** Current activity counters. 
   * @returns the assistant Loop Guard Stats.
   */
  stats(): AssistantLoopGuardStats {
    return { detections: this.detections, reminders: this.reminders, stops: this.stops, unaudited: this.unaudited }
  }

  /** Release every per-session view; a disposed Host must not retain one per conversation. */
  clear(): void {
    this.detectors.clear()
    this.findingsThisAttempt.clear()
    this.stopped.clear()
  }

  /**
   * Release one session's views.
   *
   * `clear()` above runs at Host teardown, which is not the same boundary: within
   * one Host a session comes and goes, and nothing else revisits a disposed one.
   * The detector is the entry worth releasing — it holds the attempt's accumulated
   * text — and a session disposed mid-attempt never delivers the `end` frame that
   * would have dropped it.
   * @param sessionId - the Harness session this operation acts on.
   */
  forget(sessionId: string): void {
    this.detectors.delete(sessionId)
    this.findingsThisAttempt.delete(sessionId)
    this.stopped.delete(sessionId)
  }

  /**
   * Observe one assistant stream frame.
   *
   * @param agent - the streaming Agent, used for the session key and for the ladder.
   * @param frame - the frame as `agent/assistant-stream` delivered it.
   */
  accept(agent: Agent, frame: AssistantStreamFrame): void {
    if (!this.deps.enabled()) return
    const key = String(agent.session.id)
    if (frame.type === 'end') {
      // The whole attempt state, not two thirds of it: `findingsThisAttempt` is
      // what separates a warning from a cancellation, so leaving it behind made
      // the next start-less chunk count as another finding in an attempt that had
      // already ended (see the fallback below, which is the case that reaches it).
      this.forget(key)
      return
    }
    if (frame.type === 'start') {
      // One attempt is one audit: a fresh detector, a fresh ladder, and no stop
      // latch from the attempt before it.
      this.detectors.set(key, new AssistantLoopDetector())
      this.findingsThisAttempt.delete(key)
      this.stopped.delete(key)
      return
    }
    // Only prose is audited. A reasoning delta re-deriving a step is not this
    // guard's business, and feeding it in would flag ordinary deliberation.
    if (frame.chunk.type !== 'text-delta') return
    let detector = this.detectors.get(key)
    if (detector === undefined) {
      // A chunk with no `start` frame is the opening of an attempt this guard was
      // not there for, so it gets a fresh audit like any other opening. Only the
      // detector used to be replaced here, which meant a session whose previous
      // attempt had warned kept its count: the first loop of the new attempt read
      // as the second and the turn was cancelled with nothing ever reported to the
      // model — the no-reminder cancellation the ladder exists to avoid.
      this.findingsThisAttempt.delete(key)
      this.stopped.delete(key)
      detector = new AssistantLoopDetector()
      this.detectors.set(key, detector)
    }
    const finding = detector.add(frame.chunk.text)
    if (finding === undefined) {
      if (detector.timedOut && !this.countedAbandoned.has(detector)) {
        this.countedAbandoned.add(detector)
        this.unaudited += 1
      }
      return
    }
    // Already cancelled once for this attempt: the same latched finding arriving
    // with the next chunk is not a second loop.
    if (this.stopped.has(key)) return
    this.detections += 1
    const seen = (this.findingsThisAttempt.get(key) ?? 0) + 1
    this.findingsThisAttempt.set(key, seen)
    if (seen > 1) {
      this.stopped.add(key)
      this.stops += 1
      this.deps.onStop(agent, finding)
      return
    }
    // First loop in this attempt: warn and keep going. The detector is replaced
    // rather than reset so its latched finding cannot re-fire on the next chunk,
    // while the *ladder* remembers that this attempt has already been warned.
    // The replacement inherits the fence the model is standing in: everything
    // after this point is still that fence's content, and dropping the flag made
    // the prose bar — which exists precisely to keep fenced repetition out of the
    // ladder — apply to it, so the *second* rung fired on a fenced table and
    // cancelled the turn.
    this.reminders += 1
    this.detectors.set(key, new AssistantLoopDetector({ startsInsideFence: detector.insideFence }))
    this.injectReminder(agent, finding)
  }

  /**
   * Deliver the reminder, and never let it break the stream.
   *
   * The guard is an audit of a running turn, so a failure to warn must leave the
   * turn exactly as it was: the loop is a lesser harm than a stream killed by the
   * plugin that was supposed to protect it.
   */
  private injectReminder(agent: Agent, finding: AssistantLoopFinding): void {
    try {
      agent.inject(createUserMessage({
        source: { kind: 'plugin', plugin: 'freecodego-assistant-loop-guard' },
        content: [{ type: 'text', text: renderAssistantLoopReminder(finding) }],
      }))
    } catch {
      // Fail open: the audit is advisory here, and the next finding still stops the turn.
    }
  }
}

/** Whether a line is a drawn border rather than content.
 * @param line - the line to inspect.
 * @returns true when the line is a drawn border.
 */
export function isBoxBorderLine(line: string): boolean {
  let drawn = 0
  let visible = 0
  for (const char of line) {
    if (char !== ' ' && char !== '\t') visible += 1
    if (BOX_BORDER_CHARS.has(char)) drawn += 1
  }
  if (visible === 0) return false
  return drawn / visible >= BOX_BORDER_SHARE
}
