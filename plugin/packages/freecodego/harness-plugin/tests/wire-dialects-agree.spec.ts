/**
 * The two wire dialects must agree on what they build.
 *
 * `translate` and `translateAnthropic` read different payload shapes and produce
 * the same chunks: text and reasoning blocks in stream order, a tool call whose
 * id falls back to the block index when the provider sent none, the same
 * terminal sequence — every open block, then usage, then one finish reason — and
 * an empty stream reported as a failure rather than an empty successful turn.
 * Those rules lived in both files, kept equal by hand; `wire-shared.ts` is now
 * their single home, and this file binds the two halves that genuinely differ.
 *
 * The source half of the gate is deliberate. The duplication was invisible in
 * behaviour — the two copies agreed, which is why it survived — so nothing but
 * the shape of the source catches a re-introduced copy.
 */

import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { translate } from '../src/openai-wire.ts'
import { translateAnthropic } from '../src/anthropic-wire.ts'
import { sourceFiles } from './support/source-files.ts'

/**
 * The chunks a dialect produces from a payload list.
 *
 * Payloads are handed over the way the framer hands them over: parsed objects
 * serialized back, and raw strings — the `[DONE]` sentinel — as they arrived.
 */
async function chunksFrom(iterate: (payloads: AsyncIterable<string>) => AsyncGenerator<StreamChunk>, payloads: readonly unknown[]): Promise<readonly StreamChunk[]> {
  async function* source(): AsyncGenerator<string> {
    for (const payload of payloads) yield typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of iterate(source())) chunks.push(chunk)
  return chunks
}

const blocksOf = (chunks: readonly StreamChunk[]): readonly ContentBlock[] =>
  chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])

const finishOf = (chunks: readonly StreamChunk[]): StreamChunk | undefined =>
  chunks.find(chunk => chunk.type === 'finish')

/** The same answer on both wires: one text block, then a tool call with no id. */
const OPENAI_FRAMES: readonly unknown[] = [
  { choices: [{ delta: { content: 'hi' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '{}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  '[DONE]',
]

const ANTHROPIC_FRAMES: readonly unknown[] = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'read' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  '[DONE]',
]

describe('the two wire dialects agree', () => {
  it('builds the same blocks, including the call id both sides synthesize', async () => {
    const openai = blocksOf(await chunksFrom(translate, OPENAI_FRAMES))
    const anthropic = blocksOf(await chunksFrom(translateAnthropic, ANTHROPIC_FRAMES))
    expect(anthropic).toEqual(openai)
    // Spelled out as well as compared: the fallback id is the rule that was
    // written twice, so a stream that shifts block order has to fail here rather
    // than agree with a copy of itself.
    expect(openai).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' },
    ])
  })

  it('ends the same way, and calls an empty stream a failure on both wires', async () => {
    expect(finishOf(await chunksFrom(translateAnthropic, ANTHROPIC_FRAMES))).toEqual(finishOf(await chunksFrom(translate, OPENAI_FRAMES)))
    // A sentinel with nothing behind it: reporting `stop` here would record an
    // empty answer as a completed turn, which is the rule both wires share.
    const openaiEmpty = await chunksFrom(translate, ['[DONE]'])
    expect(openaiEmpty).toEqual(await chunksFrom(translateAnthropic, ['[DONE]']))
    expect(finishOf(openaiEmpty)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: 'model returned no content', code: EMPTY_RESPONSE_CODE } } })
  })

  it('declares the sentinel and the terminal sequence in exactly one module', async () => {
    const files = await sourceFiles()
    expect(files.length, 'the source tree was not read').toBeGreaterThan(100)
    const declaring = files.filter(file => file.text.includes("'[DONE]'")).map(file => file.path)
    expect(declaring, 'the sentinel belongs to one module, not one per dialect').toEqual(['wire-shared.ts'])
    for (const name of ['openai-wire.ts', 'anthropic-wire.ts']) {
      const dialect = files.find(file => file.path === name)
      expect(dialect, name).toBeDefined()
      expect(dialect?.text, name).toContain('closeStream(')
      // The terminal rule itself: neither dialect may build its own finish chunk.
      expect(dialect?.text, name).not.toContain("kind: 'error', failure: { message: 'model returned no content'")
    }
  })
})
