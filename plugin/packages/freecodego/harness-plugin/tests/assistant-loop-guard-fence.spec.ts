import { describe, expect, it, vi } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantLoopDetector, AssistantLoopGuard } from '../src/assistant-loop-guard.ts'

/** One `text-delta` frame, the only frame kind the guard reads text from. */
function textFrame(text: string): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } }
}

const startFrame = { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 1 } as AssistantStreamFrame

/** Agent stub carrying only what the guard touches. */
function stubAgent() {
  return {
    session: { id: 's1' },
    inject: vi.fn(),
    cancel: vi.fn(),
  } as never as Parameters<AssistantLoopGuard['accept']>[0] & { inject: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
}

function guardFor(agent: unknown) {
  return new AssistantLoopGuard({
    enabled: () => true,
    onStop: () => { (agent as { cancel: (c: unknown) => void }).cancel({ kind: 'hook' }) },
  })
}

/** A two-line repeating unit of 20 characters per line. */
const ROW_A = 'row alpha 0123456789\n'
const ROW_B = 'row beta  9876543210\n'
/** Four rows: two repetitions, which is a loop in prose and clean inside a fence. */
const TWO_REPS = [ROW_A, ROW_B, ROW_A, ROW_B]
/** Six rows: three repetitions, which is a loop even inside a fence. */
const THREE_REPS = [ROW_A, ROW_B, ROW_A, ROW_B, ROW_A, ROW_B]

const FENCE_OPEN = '```\n'

describe('AssistantLoopDetector fence context', () => {
  it('measures a message that opens inside a fence by the fence bar', () => {
    // The reminder replaces the detector mid-message, and the replacement only
    // sees what follows it. A fenced table does not become prose because the
    // detector was swapped, so the replacement has to be told where it is.
    const inherited = new AssistantLoopDetector({ startsInsideFence: true })
    let found: unknown
    for (const chunk of TWO_REPS) {
      const result = inherited.add(chunk)
      if (result !== undefined) found = result
    }
    expect(found).toBeUndefined()

    // The same rows are a loop when nothing says the reader is inside a fence,
    // which is what makes carrying the flag a behavioural change rather than a
    // no-op.
    const bare = new AssistantLoopDetector()
    let bareFound: unknown
    for (const chunk of TWO_REPS) {
      const result = bare.add(chunk)
      if (result !== undefined) bareFound = result
    }
    expect(bareFound).toMatchObject({ kind: 'multi-line', repetitions: 2 })
  })

  it('reports the fence it is in, and leaves the fence on its own opener', () => {
    const detector = new AssistantLoopDetector()
    expect(detector.insideFence).toBe(false)
    detector.add(FENCE_OPEN)
    expect(detector.insideFence).toBe(true)
    detector.add(FENCE_OPEN)
    expect(detector.insideFence).toBe(false)
  })
})

describe('AssistantLoopGuard keeps the fence bar across a reminder', () => {
  it('does not cancel a fenced table that only repeats twice after the warning', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)

    // Six rows inside a fence reach the fence bar, so this is the first rung.
    for (const chunk of [FENCE_OPEN, ...THREE_REPS]) guard.accept(agent, textFrame(chunk))
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.cancel).not.toHaveBeenCalled()

    // The model keeps printing the same fenced table. Two more repetitions are
    // clean by the fence bar — the bar that exists so a fenced table is not a
    // loop — so the ladder must not spend its second rung on them.
    for (const chunk of TWO_REPS) guard.accept(agent, textFrame(chunk))
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(guard.stats()).toMatchObject({ detections: 1, reminders: 1, stops: 0 })
  })

  it('still cancels when the fenced repetition passes the fence bar again', () => {
    // The counterpart to the case above: carrying the fence bar must not neuter
    // the ladder inside a fence, only make it demand what it always demanded.
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    for (const chunk of [FENCE_OPEN, ...THREE_REPS]) guard.accept(agent, textFrame(chunk))
    expect(agent.inject).toHaveBeenCalledTimes(1)

    for (const chunk of THREE_REPS) guard.accept(agent, textFrame(chunk))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(guard.stats()).toMatchObject({ detections: 2, reminders: 1, stops: 1 })
  })

  it('cancels prose that repeats only twice after the warning', () => {
    // Control: outside a fence two repetitions always were a loop and still are.
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    for (const chunk of ['ab'.repeat(50)]) guard.accept(agent, textFrame(chunk))
    expect(agent.inject).toHaveBeenCalledTimes(1)

    guard.accept(agent, textFrame('ab'.repeat(50)))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
  })

  it('leaves the fence when the model closes it, so prose gets the prose bar', () => {
    const agent = stubAgent()
    const guard = guardFor(agent)
    guard.accept(agent, startFrame)
    for (const chunk of [FENCE_OPEN, ...THREE_REPS]) guard.accept(agent, textFrame(chunk))
    expect(agent.inject).toHaveBeenCalledTimes(1)

    // The fence closes and the model loops in prose: two repetitions are enough.
    guard.accept(agent, textFrame(FENCE_OPEN))
    for (const chunk of TWO_REPS) guard.accept(agent, textFrame(chunk))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
  })
})
