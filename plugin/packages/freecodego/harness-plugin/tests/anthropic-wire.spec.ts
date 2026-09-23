import { describe, expect, it } from 'vitest'
import { serializeAnthropicRequest, serializeAnthropicRequestWithInlineImages, translateAnthropic } from '../src/anthropic-wire.ts'
import { createToolResultMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

const attachment = {
  attachmentId: 'att-1' as never,
  mediaType: 'image/png' as const,
  bytes: 4,
  width: 1,
  height: 1,
}

/**
 * A fully-typed request-version image.
 *
 * The encoder contract carries more than the two fields the serializer reads
 * (`variantId`, `width`, `height`, `depth`, `space`, `hasAlpha`), so a two-field
 * stub only compiled because nobody had type-checked this file. Spelling the
 * whole version out keeps the fixture honest about what a resolver returns.
 */
function requestImage(data: Uint8Array): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: 1,
      height: 1,
    },
    data,
    mediaType: 'image/png',
    bytes: data.byteLength,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

async function collect(events: readonly unknown[]): Promise<StreamChunk[]> {
  async function* payloads(): AsyncGenerator<string> {
    for (const event of events) yield JSON.stringify(event)
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of translateAnthropic(payloads())) chunks.push(chunk)
  return chunks
}

describe('Anthropic Messages serialization', () => {
  it('maps system, tools, and stop sequences', async () => {
    const body = await serializeAnthropicRequest({
      provider: 'freecodego', model: 'claude-sonnet-5', system: 'SYS', maxTokens: 20_000, stop: ['END'],
      reasoningEffort: 'high' as never,
      tools: [{ name: 'read_files', description: 'Read', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.system).toBe('SYS')
    expect(body.stream).toBe(true)
    // The budget fits inside the caller's cap, so both are sent and the cap is
    // honoured exactly.
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 })
    expect(body.max_tokens).toBe(20_000)
    expect(body.stop_sequences).toEqual(['END'])
    expect(body.tools).toEqual([{ name: 'read_files', description: 'Read', input_schema: { type: 'object' } }])
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('drops the thinking step rather than raising an explicit caller cap', async () => {
    // Raising a 100-token request to 9,216 to make room for a thinking budget
    // silently multiplied both the reply's length and its cost. The caller's cap
    // wins, and the step that does not fit is the one that goes.
    const body = await serializeAnthropicRequest({
      provider: 'freecodego', model: 'claude-sonnet-5', maxTokens: 100,
      reasoningEffort: 'high' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)
    expect(body.max_tokens).toBe(100)
    expect('thinking' in body).toBe(false)
  })

  it('sizes a defaulted request for the thinking budget it asked for', async () => {
    const body = await serializeAnthropicRequest({
      provider: 'freecodego', model: 'claude-sonnet-5',
      reasoningEffort: 'low' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1_024 })
    expect(body.max_tokens).toBe(8_192)
  })

  it('always sends max_tokens and omits thinking when no effort is selected', async () => {
    const body = await serializeAnthropicRequest({
      provider: 'freecodego', model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)
    expect(body.max_tokens).toBe(8_192)
    expect('thinking' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('replays assistant tool calls as tool_use and tolerates malformed arguments', async () => {
    const body = await serializeAnthropicRequest({
      provider: 'freecodego', model: 'claude-sonnet-5',
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'call-1' as never, name: 'read_files', arguments: '{"path":"a.ts"}' },
          { type: 'tool-call', id: 'call-2' as never, name: 'grep', arguments: 'not json' },
        ] },
        // One result per message, as the log now holds it. Anthropic still
        // receives it as a `tool_result` block in a user turn, which is what the
        // expectation below pins.
        createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
      ],
    } as never)
    expect(body.messages).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'call-1', name: 'read_files', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'call-2', name: 'grep', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
    ])
  })

  it('drops turns that project to no Anthropic content', async () => {
    const body = await serializeAnthropicRequest({
      provider: 'freecodego', model: 'claude-sonnet-5',
      messages: [
        { role: 'user', content: [] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking only' }] },
        { role: 'user', content: [{ type: 'text', text: 'real turn' }] },
      ],
    } as never)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'real turn' }] }])
  })

  it('inlines user images as base64 sources and keeps tool-result images as text', async () => {
    const body = await serializeAnthropicRequestWithInlineImages({
      provider: 'freecodego', model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
    } as never, { resolveImage: async () => requestImage(new Uint8Array([1, 2, 3, 4])) })
    expect(body.messages).toEqual([{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } }],
    }])
  })
})

describe('Anthropic Messages SSE translation', () => {
  it('maps text deltas, usage, and end_turn into stream chunks', async () => {
    expect(await collect([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ])).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ' world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps thinking and tool_use blocks, including a tool-call finish', async () => {
    expect(await collect([
      { type: 'message_start', message: { usage: { input_tokens: 1, cache_read_input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_files' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'hmm' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'toolu_1', name: 'read_files', argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 1, id: 'toolu_1', name: 'read_files', argumentsDelta: '"a.ts"}' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu_1', name: 'read_files', arguments: '{"path":"a.ts"}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 5, cacheReadTokens: 3 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('ignores unknown block kinds and their deltas', async () => {
    expect(await collect([
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ])).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
  })

  it('throws on a provider error event', async () => {
    await expect(collect([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]))
      .rejects.toMatchObject({ message: 'Overloaded' })
  })

  it('throws on a malformed payload', async () => {
    async function* payloads(): AsyncGenerator<string> { yield '{not json' }
    await expect(async () => { for await (const _ of translateAnthropic(payloads())) void _ }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('masks a credential the provider error event carries', async () => {
    // The provider's own error text becomes an `LlmError`, and a provider does
    // quote the request it refused — including the key inside it. This layer is
    // shared by every Anthropic-shaped provider, so an adapter that redacts its
    // own failures never sees a message built here.
    const leaked = `sk-ant-api03-${'z'.repeat(40)}`
    const failure = await collect([{ type: 'error', error: { type: 'authentication_error', message: `Incorrect API key provided: ${leaked}` } }])
      .then(() => new Error('the provider error was expected to be thrown'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('Incorrect API key provided:')
    expect(failure.message).not.toContain(leaked)
  })

  it('masks a credential inside the malformed payload it quotes back', async () => {
    // The chunk is upstream text too: it is quoted to make the parse failure
    // diagnosable, which is exactly why it cannot be quoted verbatim.
    const leaked = `ghp_${'A'.repeat(36)}`
    async function* payloads(): AsyncGenerator<string> { yield `{not json ${leaked}` }
    const failure = await (async () => { for await (const _ of translateAnthropic(payloads())) void _ })()
      .then(() => new Error('the malformed payload was expected to be thrown'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('malformed SSE payload')
    expect(failure.message).not.toContain(leaked)
  })

  it('fails when the stream closes with no content and no usage', async () => {
    await expect(collect([{ type: 'ping' }])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

/**
 * The frames this layer used to answer with silence.
 *
 * Same rule as on the OpenAI wire: a dropped field makes a truncated answer look
 * like a short one, so each case here pins the surfacing rather than a new
 * refusal — the two tolerance cases are as load-bearing as the failures.
 */
describe('Anthropic Messages SSE frames that used to be swallowed', () => {
  it('keeps tool arguments a provider sent as a JSON value instead of dropping them', async () => {
    // Reading only `partial_json` strings left the call with an empty input,
    // which reads downstream as a deliberate no-argument call.
    expect(await collect([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: { path: 'a.ts' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'toolu_1', name: 'write_file', arguments: '{"path":"a.ts"}' } })
  })

  it('delivers text whose content_block_start never arrived instead of discarding it', async () => {
    // A dropped start frame used to take the whole block's text with it, and the
    // turn still looked complete. Text carries no metadata, so it is recovered.
    const chunks = await collect([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'recovered' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } })
  })

  it('does not invent a client tool call from a server tool block it skipped', async () => {
    // `server_tool_use` streams `input_json_delta` too, and it is executed
    // upstream. Recovering it would fabricate a nameless client call, so those
    // fragments stay dropped — the recovery above is limited to text/thinking.
    const chunks = await collect([
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toEqual([])
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports a stream that stops mid-answer instead of passing the truncation off as a stop', async () => {
    // No `message_stop` and no stop reason: the connection died after a partial
    // answer, and `stop` told the caller the turn was complete.
    await expect(collect([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } },
    ])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('still accepts a stream whose last message_delta declared the stop reason', async () => {
    // The tolerance that must survive: the sentinel is a formality once the
    // stop reason has arrived, and that is not a truncation.
    expect(await collect([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
