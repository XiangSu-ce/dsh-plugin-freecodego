import { describe, expect, it } from 'vitest'
import { mcpToolResult } from '../src/mcp-tool-result.ts'
import { MAX_TOOL_RESULT_TEXT_BYTES } from '../src/frame-budget.ts'

/**
 * These pin the *transport* behaviour, not the Claude-side one: bytes cannot
 * cross this worker's 1 MB JSONL frame, so an image here can only ever be a
 * reference. What matters is that a text result arrives as its own text — not as
 * one JSON document wrapping another — and that a failed call stays flagged.
 */
describe('mcpToolResult', () => {
  it('passes a text block through as text rather than re-encoding the envelope', () => {
    const result = mcpToolResult({ content: [{ type: 'text', text: 'hello' }] })

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    // The regression this replaced stringified the whole result, so the model
    // received `{"content":[{"type":"text",...}]}` as the tool's output.
    expect(result.content[0]?.text).not.toContain('"type"')
    expect(result.isError).toBeUndefined()
  })

  it('keeps the failure flag of a failed Harness call', () => {
    expect(mcpToolResult({ content: [{ type: 'text', text: 'denied' }], isError: true }).isError).toBe(true)
    // Only a literal `true` marks a failure; a falsy value must not add the flag.
    expect(mcpToolResult({ content: [{ type: 'text', text: 'ok' }], isError: false }).isError).toBeUndefined()
  })

  it('reads every affirmative failure shape the bridge can send, not only `true`', () => {
    // The bridge is another process's JSON, so the flag arrives as whatever it
    // serialized. `=== true` is what this module used to read, and that re-opened
    // the exact hole it exists to close: a failed call looking like a success.
    expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], isError: 1 }).isError).toBe(true)
    expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], isError: 'true' }).isError).toBe(true)
    expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], isError: 'yes' }).isError).toBe(true)
    // A failure reported as an `error` payload and no flag at all is still a failure.
    expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], error: { message: 'boom' } }).isError).toBe(true)
    expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], error: 'boom' }).isError).toBe(true)
    // And the empty shapes stay successes, so the flag cannot become noise.
    for (const empty of [false, 0, '', null, undefined]) {
      expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], isError: empty }).isError).toBeUndefined()
    }
    expect(mcpToolResult({ content: [{ type: 'text', text: 'x' }], error: '' }).isError).toBeUndefined()
  })

  it('bounds a result too large for the transport, and says what it dropped', () => {
    // The frame layer can only answer a whole frame with an error, so a big result
    // would lose everything; its prefix plus a marker is the answer the model can
    // act on. `frame-budget.spec.ts` pins the budget itself.
    const result = mcpToolResult({ content: [{ type: 'text', text: 'h'.repeat(MAX_TOOL_RESULT_TEXT_BYTES + 10_000) }] })
    const text = result.content[0]?.text ?? ''
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
    expect(text).toContain('[result truncated')
  })

  it('concatenates every block in order', () => {
    const result = mcpToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })

    expect(result.content.map(block => block.text)).toEqual(['a', 'b'])
  })

  it('renders an image as a reference, because bytes cannot fit this frame', () => {
    const result = mcpToolResult({
      content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }],
    })

    expect(result.content).toEqual([{ type: 'text', text: 'Generated image attachment: att-1' }])
  })

  it('says so when an image has no reachable reference', () => {
    expect(mcpToolResult({ content: [{ type: 'image' }] }).content).toEqual([
      { type: 'text', text: 'Generated image (unavailable to this transport)' },
    ])
  })

  it('does not drop an unrecognized block', () => {
    const result = mcpToolResult({ content: [{ type: 'resource', uri: 'file:///x' }] })

    expect(result.content).toEqual([{ type: 'text', text: '{"type":"resource","uri":"file:///x"}' }])
  })

  it('falls back to the whole value when a bridge answers without content blocks', () => {
    // A Skill listing is a plain object, not a host-rendered `{ content }`.
    expect(mcpToolResult({ name: 'review' }).content).toEqual([{ type: 'text', text: '{"name":"review"}' }])
    expect(mcpToolResult(null).content).toEqual([{ type: 'text', text: 'null' }])
    expect(mcpToolResult('plain').content).toEqual([{ type: 'text', text: 'plain' }])
  })

  it('never returns an empty content list', () => {
    // An empty result reads as a failed call to some models.
    expect(mcpToolResult({ content: [] }).content).toEqual([{ type: 'text', text: '{"content":[]}' }])
  })
})
