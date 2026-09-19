/**
 * Inlining a media tool's attachment so a native engine can render it.
 *
 * A Harness tool result carries an image as a reference to durable attachment
 * storage, but the model transports take a tool result as MCP content, which
 * carries an image only as bytes. Without this step `freecodego_generate_image`
 * reaches a native engine as an attachment id inside a text blob and nobody can
 * see the picture — which is the whole point of the tool.
 *
 * Every case below is a *fallback*, because the conversion is deliberately
 * incapable of failing a call: a missing reader, an unreadable attachment, an
 * oversized file, or a block without a media type all keep the original
 * reference block instead.
 */

import { describe, expect, it } from 'vitest'
import { INLINE_IMAGE_MAX_BYTES, inlineImageAttachmentBlocks } from '../src/capabilities.ts'

const attachment = (overrides: Record<string, unknown> = {}) => ({
  type: 'image',
  attachment: { attachmentId: 'abc123', mediaType: 'image/png', bytes: 4, width: 1, height: 1, ...overrides },
})

const bytes = (size: number) => new Uint8Array(size).fill(7)

const reader = (value: Uint8Array | undefined) => async () => value

describe('inlineImageAttachmentBlocks', () => {
  it('replaces a readable attachment with image bytes', async () => {
    const content = [{ type: 'text', text: '{"model":"x"}' }, attachment()]
    const result = await inlineImageAttachmentBlocks(content, reader(bytes(4)))
    // The text block is untouched and the image block now carries the bytes.
    expect(result[0]).toEqual({ type: 'text', text: '{"model":"x"}' })
    expect(result[1]).toEqual({ type: 'image', data: Buffer.from(bytes(4)).toString('base64'), mimeType: 'image/png' })
  })

  it('keeps the reference when nothing can read the bytes', async () => {
    for (const value of [undefined, bytes(0)]) {
      const content = [attachment()]
      const result = await inlineImageAttachmentBlocks(content, reader(value))
      expect(result[0], String(value?.byteLength)).toEqual(content[0])
    }
  })

  it('keeps the reference when the store throws instead of failing the call', async () => {
    const content = [attachment()]
    const result = await inlineImageAttachmentBlocks(content, async () => { throw new Error('attachment store offline') })
    expect(result[0]).toEqual(content[0])
  })

  it('refuses to inline an image above the transport cap', async () => {
    // The cap exists so base64 expansion cannot cross the per-image limit the
    // model API enforces; over it, the reference is what travels.
    const content = [attachment({ bytes: INLINE_IMAGE_MAX_BYTES + 1 })]
    expect(await inlineImageAttachmentBlocks(content, reader(bytes(INLINE_IMAGE_MAX_BYTES + 1)))).toEqual(content)
    const fitting = [attachment({ bytes: INLINE_IMAGE_MAX_BYTES })]
    const inlined = await inlineImageAttachmentBlocks(fitting, reader(bytes(INLINE_IMAGE_MAX_BYTES)))
    expect(inlined[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
  })

  it('leaves every block it cannot inline exactly as the Host produced it', async () => {
    const content = [
      { type: 'text', text: 'summary' },
      { type: 'image' },
      { type: 'image', attachment: { mediaType: 'image/png' } },
      { type: 'image', attachment: { attachmentId: 'abc', mediaType: '' } },
      { type: 'reasoning', text: 'internal' },
      'not a block',
    ]
    let reads = 0
    const result = await inlineImageAttachmentBlocks(content, async () => { reads += 1; return bytes(4) })
    expect(result).toEqual(content)
    // A block without both an id and a media type is never looked up.
    expect(reads).toBe(0)
  })

  it('preserves block order across concurrent reads', async () => {
    const content = [attachment({ attachmentId: 'one' }), { type: 'text', text: 'middle' }, attachment({ attachmentId: 'two' })]
    const result = await inlineImageAttachmentBlocks(content, async () => bytes(2))
    expect(result.map(block => (block as { type: string }).type)).toEqual(['image', 'text', 'image'])
    expect(result[1]).toEqual({ type: 'text', text: 'middle' })
  })
})
