/**
 * One writer per stream, one terminal frame.
 *
 * The defects these cases pin: a deadline timer and a chunk loop both writing to
 * the same response, so the client received `message_stop` and an error frame in
 * whichever order the race resolved — or a write landed after `end()` and Node
 * raised `ERR_STREAM_WRITE_AFTER_END` on a socket nobody was listening to.
 */

import { describe, expect, it } from 'vitest'

import { StreamWriter, type StreamWriteTarget } from '../src/stream-writer.ts'

/**
 * A target that records everything, and can be ended from outside.
 *
 * `writableEnded` is mutable here even though the writer only ever reads it:
 * the case that matters is a socket destroyed behind the writer's back, and the
 * test is the thing that has to do the destroying.
 */
interface RecordingTarget extends StreamWriteTarget {
  readonly chunks: string[]
  ended: number
  writableEnded: boolean
}

function target(): RecordingTarget {
  const chunks: string[] = []
  const state = {
    chunks,
    ended: 0,
    writableEnded: false,
    write(chunk: string) { chunks.push(chunk); return true },
    end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); state.ended += 1; state.writableEnded = true },
  }
  return state
}

describe('frame ordering', () => {
  it('delivers frames in the order they were written', () => {
    const sink = target()
    const writer = new StreamWriter(sink)
    writer.write('a')
    writer.write('b')
    writer.write('c')
    expect(sink.chunks).toEqual(['a', 'b', 'c'])
    expect(writer.written).toBe(3)
  })

  it('writes the terminal frame and ends the target exactly once', () => {
    const sink = target()
    const writer = new StreamWriter(sink)
    writer.write('a')
    expect(writer.finish('done')).toBe(true)
    expect(sink.chunks).toEqual(['a', 'done'])
    expect(sink.ended).toBe(1)
    expect(writer.finished).toBe(true)
    expect(writer.hasTerminalFrame).toBe(true)
  })

  it('ends without a terminal frame when the protocol has none', () => {
    const sink = target()
    const writer = new StreamWriter(sink)
    writer.finish()
    expect(sink.chunks).toEqual([])
    expect(sink.ended).toBe(1)
    expect(writer.hasTerminalFrame).toBe(false)
  })
})

describe('the second writer', () => {
  it('is refused a terminal frame, because the first one stated the outcome', () => {
    const sink = target()
    const writer = new StreamWriter(sink)
    writer.finish('event: message_stop\n\n')
    // The losing source is usually a timer winding down or a loop resuming; its
    // frame says the opposite of the one already sent.
    expect(writer.finish('event: error\n\n')).toBe(false)
    expect(sink.chunks).toEqual(['event: message_stop\n\n'])
    expect(sink.ended).toBe(1)
  })

  it('cannot append a frame after the end, and every attempt is counted', () => {
    const sink = target()
    const writer = new StreamWriter(sink)
    writer.finish('done')
    expect(writer.write('late')).toBe(false)
    expect(writer.write('later')).toBe(false)
    expect(sink.chunks).toEqual(['done'])
    // The count is the evidence that two producers raced, and which one lost.
    expect(writer.refusedWrites).toBe(2)
  })

  it('stops accepting frames when something else ended the response', () => {
    // A server shutdown or a destroyed socket ends the response behind the
    // writer's back; the write-after-end is the failure this prevents, so the
    // target's own flag has to be enough on its own.
    const sink = target()
    const writer = new StreamWriter(sink)
    sink.writableEnded = true
    expect(writer.write('anything')).toBe(false)
    expect(writer.finish('done')).toBe(false)
    expect(sink.chunks).toEqual([])
    expect(writer.refusedWrites).toBe(2)
  })
})
