import { describe, expect, it, vi } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  AssistantLoopDetector,
  AssistantLoopGuard,
  isBoxBorderLine,
  renderAssistantLoopReminder,
} from '../src/assistant-loop-guard.ts'

/** One `text-delta` frame, the only frame kind the guard reads text from. */
function textFrame(text: string): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } }
}

const startFrame = { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 1 } as AssistantStreamFrame
// A committed `end` frame carries `index` and a full `outcome`; the guard reads
// none of it, so the fixture states the minimum and the cast records that the
// omitted fields are deliberate rather than an oversight.
const endFrame = { type: 'end', attemptId: 'a' as never, revision: 1 } as unknown as AssistantStreamFrame

/** Agent stub carrying only what the guard touches. */
function stubAgent() {
  return {
    session: { id: 's1' },
    inject: vi.fn(),
    cancel: vi.fn(),
  } as never as Parameters<AssistantLoopGuard['accept']>[0] & { inject: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
}

function guardFor(agent: unknown, enabled = true) {
  const guard = new AssistantLoopGuard({ enabled: () => enabled, onStop: () => { (agent as { cancel: (c: unknown) => void }).cancel({ kind: 'hook' }) } })
  return guard
}

describe('AssistantLoopDetector', () => {
  it('confirms a single-line loop once the period repeats enough and carries enough characters', () => {
    const detector = new AssistantLoopDetector()
    // A 2-character period repeated 50 times: 100 characters, which is exactly
    // the prose cost floor, and far past the repetition floor.
    expect(detector.add('ab'.repeat(50))).toMatchObject({ kind: 'single-line', period: 2 })
  })

  it('does not flag a short repetition that a bare repetition count would catch', () => {
    const detector = new AssistantLoopDetector()
    // `0,0,0` repeats three times but costs three characters, so the dual
    // threshold keeps it clean: this is the case the p*k floor exists for.
    expect(detector.add('0,0,0\n')).toBeUndefined()
  })

  it('confirms a multi-line loop only once the repeated block carries real text', () => {
    const detector = new AssistantLoopDetector()
    const line = 'the same reasonably long line of prose repeated back'
    expect(detector.add(`${line}\n`.repeat(4))).toMatchObject({ kind: 'multi-line', period: 1 })
  })

  it('ignores two short identical lines, which are a coincidence rather than a loop', () => {
    const detector = new AssistantLoopDetector()
    expect(detector.add('ok\nok\n')).toBeUndefined()
  })

  it('widens every threshold inside a code fence, where repetition is legitimate', () => {
    const body = `${'ab'.repeat(50)}\n`
    const prose = new AssistantLoopDetector().add(body)
    // 100 characters is the prose floor; the fenced floor is 200, so the very
    // same text must stay clean once it is inside a fence.
    const fenced = new AssistantLoopDetector().add(['```', body, '```'].join('\n'))
    expect(prose).toMatchObject({ kind: 'single-line' })
    expect(fenced).toBeUndefined()
  })

  it('never treats a drawn table border as repeated content', () => {
    expect(isBoxBorderLine('+-------+-------+')).toBe(true)
    expect(isBoxBorderLine('| name  | value |')).toBe(false)
    const detector = new AssistantLoopDetector()
    // A table body of borders and short rows must not trip the line detector.
    expect(detector.add(['+------+------+', '| a    | b    |', '+------+------+', '| a    | b    |', '+------+------+'].join('\n'))).toBeUndefined()
  })

  it('stops auditing once the time budget is gone instead of stalling the stream', () => {
    const detector = new AssistantLoopDetector()
    const now = vi.spyOn(performance, 'now')
    let clock = 0
    // Fast-forward past the 500ms budget on the first sampled period.
    now.mockImplementation(() => (clock += 10_000))
    try {
      detector.add('x'.repeat(4_000))
      expect(detector.timedOut).toBe(true)
    } finally {
      now.mockRestore()
    }
  })
})

describe('AssistantLoopGuard ladder', () => {
  it('reminds on the first loop and cancels only on the second in the same attempt', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)

    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.cancel).not.toHaveBeenCalled()
    // The reminder names the axis so the model can act on it, and tells it not
    // to explain the machinery to a user who never saw it.
    const injected = (agent.inject.mock.calls[0]?.[0] as { content: readonly { text: string }[] }).content[0]?.text
    // The model is told what it did in prose, not our enum name for it.
    expect(injected).toContain('inside one line')
    expect(injected).not.toContain('single-line')
    expect(injected).toContain('Do not mention this reminder')

    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(guard.stats()).toMatchObject({ detections: 2, reminders: 1, stops: 1 })
  })

  it('cancels once per attempt, however many chunks arrive after the stop', () => {
    // The stream keeps delivering chunks until the abort takes effect, and the
    // detector latches its finding for the rest of the message. Without a stop
    // latch every later chunk re-reported the same loop: the Host's stop counter
    // grew with the chunk count and the turn was cancelled again and again.
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('ab'.repeat(50)))
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.cancel).toHaveBeenCalledTimes(1)

    guard.accept(agent, textFrame('cd'.repeat(50)))
    guard.accept(agent, textFrame('ef'.repeat(50)))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(guard.stats()).toMatchObject({ reminders: 1, stops: 1 })

    // A new attempt starts a new audit, so the latch does not silence the next one.
    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('gh'.repeat(50)))
    guard.accept(agent, textFrame('gh'.repeat(50)))
    expect(agent.cancel).toHaveBeenCalledTimes(2)
  })

  it('resets the ladder per attempt, so an old warning never turns a later first loop into a stop', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)

    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.inject).toHaveBeenCalledTimes(1)

    // A new attempt is a new audit: this loop is again a first detection.
    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(agent.inject).toHaveBeenCalledTimes(2)
  })

  it('counts a start-less attempt as a fresh audit, so its first loop is a reminder', () => {
    // Two boundaries end an audit: the `start` frame and the `end` frame. The
    // test below ('forgets a session when its attempt ends') only ever reaches
    // the second one with an empty ladder, so it stayed green while `end`
    // released two thirds of the attempt state: after an attempt that had warned,
    // the ladder's next value was still on file, and the first loop of the next
    // attempt — arriving as a chunk with no `start` frame, which the detector
    // fallback exists to serve — read as a second detection. The turn was then
    // cancelled without a reminder, which is the exact outcome the ladder is
    // there to prevent.
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('ab'.repeat(50)))
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.cancel).toHaveBeenCalledTimes(1)

    guard.accept(agent, endFrame)

    guard.accept(agent, textFrame('cd'.repeat(50)))
    expect(agent.inject).toHaveBeenCalledTimes(2)
    expect(agent.cancel).toHaveBeenCalledTimes(1)
  })

  it('ignores reasoning deltas, because re-deriving a step is not this failure', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    const reasoning = { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'ab'.repeat(50) } } as unknown as AssistantStreamFrame
    guard.accept(agent, reasoning)
    expect(agent.inject).not.toHaveBeenCalled()
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('does nothing at all when the guard is switched off', () => {
    const agent = stubAgent()
    const guard = guardFor(agent, false)
    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.inject).not.toHaveBeenCalled()
    expect(guard.stats()).toMatchObject({ detections: 0 })
  })

  it('counts one abandoned message once, however many chunks delivered it', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    const now = vi.spyOn(performance, 'now')
    let clock = 0
    // Every sampled deadline check fast-forwards past the 500ms budget, so the
    // first sample exhausts the detector and every later chunk sees it exhausted.
    now.mockImplementation(() => (clock += 10_000))
    try {
      for (let index = 0; index < 8; index += 1) guard.accept(agent, textFrame('x'.repeat(4_000)))
    } finally {
      now.mockRestore()
    }
    // `unaudited` counts messages. Counting per frame multiplied it by the chunk
    // count and made the audit look eight times more abandoned than it was.
    expect(guard.stats().unaudited).toBe(1)
  })

  it('drops every view of a session on forget', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    guard.accept(agent, textFrame('ab'.repeat(50)))

    guard.forget('s1')

    // Nothing of that session is left to decide the next attempt.
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.inject).toHaveBeenCalledTimes(2)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('forgets a session when its attempt ends', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    guard.accept(agent, endFrame)
    // No detector survives, so the next chunk starts one without a `start` frame.
    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.inject).toHaveBeenCalledTimes(1)
    guard.clear()
    expect(guard.stats()).toMatchObject({ reminders: 1 })
  })
})

describe('renderAssistantLoopReminder', () => {
  it('describes the multi-line axis, including the singular case', () => {
    expect(renderAssistantLoopReminder({ kind: 'multi-line', repetitions: 4, period: 1 })).toContain('1 line repeated 4 times')
    expect(renderAssistantLoopReminder({ kind: 'multi-line', repetitions: 4, period: 2 })).toContain('2 lines repeated 4 times')
  })
})
