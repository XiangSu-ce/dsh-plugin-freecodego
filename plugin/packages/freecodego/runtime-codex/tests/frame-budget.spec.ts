import { describe, expect, it } from 'vitest'
import {
  MIN_FRAME_CEILING,
  MAX_TOOL_RESULT_TEXT_BYTES,
  MAX_WORKER_FRAME_BYTES,
  boundToolResultText,
  workerFrame,
} from '../src/frame-budget.ts'

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')

describe('workerFrame', () => {
  it('writes an ordinary frame unchanged, newline included', () => {
    const frame = workerFrame({ id: '1', result: { ok: true } })
    expect(frame.replaced).toBe(false)
    expect(frame.line).toBe('{"id":"1","result":{"ok":true}}\n')
    expect(frame.originalBytes).toBe(bytesOf(frame.line))
  })

  it('gives a reply over the ceiling an error it can act on, not a truncated line', () => {
    const huge = 'x'.repeat(MAX_WORKER_FRAME_BYTES + 10)
    const frame = workerFrame({ id: '7', result: { content: [{ type: 'text', text: huge }] } })
    expect(frame.replaced).toBe(true)
    expect(frame.originalBytes).toBeGreaterThan(MAX_WORKER_FRAME_BYTES)
    expect(bytesOf(frame.line)).toBeLessThanOrEqual(MAX_WORKER_FRAME_BYTES)
    // A partial JSON line is the failure this module prevents: the substitute has
    // to parse, and has to name the sizes so the caller can narrow the call.
    const parsed = JSON.parse(frame.line) as { id: string; error: { code: string; message: string } }
    expect(parsed.id).toBe('7')
    expect(parsed.error.code).toBe('FRAME_TOO_LARGE')
    expect(parsed.error.message).toContain(String(MAX_WORKER_FRAME_BYTES))
  })

  it('keeps the method of an oversized event and says its payload was dropped', () => {
    const frame = workerFrame({ method: 'item/completed', params: { item: { text: 'y'.repeat(MAX_WORKER_FRAME_BYTES + 10) } } })
    expect(frame.replaced).toBe(true)
    const parsed = JSON.parse(frame.line) as { method: string; params: { truncated: boolean; originalBytes: number } }
    // The Host dispatches on `method`; dropping it would turn a visible oversize
    // into an event nobody can route.
    expect(parsed.method).toBe('item/completed')
    expect(parsed.params.truncated).toBe(true)
    expect(parsed.params.originalBytes).toBeGreaterThan(MAX_WORKER_FRAME_BYTES)
    expect(bytesOf(frame.line)).toBeLessThanOrEqual(MAX_WORKER_FRAME_BYTES)
  })

  it('clamps an impossible ceiling instead of writing a line it cannot bound', () => {
    // No substitute fits in 40 bytes, and a module that wrote the original anyway
    // would produce the over-budget frame it exists to prevent. The floor is the
    // honest answer: it is documented, and the result is visible in `line`.
    const frame = workerFrame({ id: '1', result: 'z'.repeat(500) }, 40)
    expect(bytesOf(frame.line)).toBeLessThanOrEqual(MIN_FRAME_CEILING)
    expect(bytesOf(frame.line)).toBeGreaterThan(40)
    const parsed = JSON.parse(frame.line) as { error: { code: string } }
    expect(parsed.error.code).toBe('FRAME_TOO_LARGE')
    // The text budget has the same floor, because the marker itself has a size.
    expect(bytesOf(boundToolResultText('m'.repeat(10_000), 40))).toBeLessThanOrEqual(MIN_FRAME_CEILING)
  })
})

describe('boundToolResultText', () => {
  it('leaves text inside the budget alone', () => {
    expect(boundToolResultText('short')).toBe('short')
  })

  it('marks what it dropped instead of cutting silently', () => {
    const text = 'a'.repeat(MAX_TOOL_RESULT_TEXT_BYTES + 5_000)
    const bounded = boundToolResultText(text)
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
    expect(bounded).toContain('[result truncated')
    expect(bounded.startsWith('aaa')).toBe(true)
  })

  it('never splits a multi-byte character', () => {
    // A byte slice through a CJK character produces a replacement character, which
    // reads like corruption rather than a truncated result.
    const text = '记'.repeat(MAX_TOOL_RESULT_TEXT_BYTES)
    const bounded = boundToolResultText(text)
    expect(bounded).not.toContain('\uFFFD')
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
  })

  it('keeps the tool-result budget below the frame ceiling, so the frame backstop stays unreachable', () => {
    // If these ever meet, a full-size result becomes a FRAME_TOO_LARGE error that
    // loses everything instead of the tail.
    expect(MAX_TOOL_RESULT_TEXT_BYTES).toBeLessThan(MAX_WORKER_FRAME_BYTES)
    const worstCase = workerFrame({ id: '1', result: { content: [{ type: 'text', text: boundToolResultText('w'.repeat(MAX_TOOL_RESULT_TEXT_BYTES * 2)) }] } })
    expect(worstCase.replaced).toBe(false)
  })
})
