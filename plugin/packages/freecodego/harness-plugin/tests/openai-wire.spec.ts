import { describe, expect, it } from 'vitest'
import { serializeRequest, serializeRequestWithInlineImages, translate } from '../src/openai-wire.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const attachment = {
  attachmentId: 'att-generated' as never,
  mediaType: 'image/png' as const,
  bytes: 4,
  width: 1,
  height: 1,
}

describe('OpenAI-compatible history serialization', () => {
  it('downgrades generated image tool results to text instead of rejecting the next text turn', () => {
    const body = serializeRequest({
      provider: 'logfare', model: 'gpt-5.6-sol', messages: [{
        role: 'user', source: { kind: 'user' }, content: [
          { type: 'text', text: 'Continue the discussion.' },
          { type: 'tool-result', toolCallId: 'call-1' as never, content: [{ type: 'image', attachment }] },
        ],
      }],
    } as never)
    // Tool frames stay adjacent to their assistant tool_calls; trailing text
    // from the same Harness message follows as a later user turn.
    expect(body.messages).toEqual([{
      role: 'tool',
      tool_call_id: 'call-1',
      content: '[image attachment: att-generated]',
    }, {
      role: 'user',
      content: 'Continue the discussion.',
    }])
  })

  it('does not resolve historical tool-result images as new user uploads', async () => {
    const body = await serializeRequestWithInlineImages({
      provider: 'logfare', model: 'gpt-5.6-sol', messages: [{
        role: 'user', source: { kind: 'user' }, content: [
          { type: 'text', text: 'Continue.' },
          { type: 'tool-result', toolCallId: 'call-1' as never, content: [{ type: 'image', attachment }] },
        ],
      }],
    } as never, { resolveImage: async () => { throw new Error('historical images must not be uploaded again') } })
    expect(body.messages).toEqual([{
      role: 'tool',
      tool_call_id: 'call-1',
      content: '[image attachment: att-generated]',
    }, {
      role: 'user',
      content: 'Continue.',
    }])
  })
})

/**
 * The two ways this layer quotes the upstream into an `LlmError`.
 *
 * Every OpenAI-compatible adapter streams through here, so text that reaches an
 * error at this layer has already left the adapter's own redaction behind.
 */
describe('OpenAI-compatible SSE failures', () => {
  async function failureOf(payloads: readonly string[]): Promise<string> {
    async function* source(): AsyncGenerator<string> { for (const payload of payloads) yield payload }
    try {
      for await (const _ of translate(source())) void _
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('the stream was expected to fail')
  }

  it('masks a credential the provider error event carries', async () => {
    const leaked = `sk-ant-api03-${'z'.repeat(40)}`
    const message = await failureOf([JSON.stringify({ error: { message: `Incorrect API key provided: ${leaked}`, code: 'invalid_api_key' } })])
    expect(message).toContain('Incorrect API key provided:')
    expect(message).not.toContain(leaked)
  })

  it('masks a credential inside the malformed payload it quotes back', async () => {
    const leaked = `ghp_${'A'.repeat(36)}`
    const message = await failureOf([`{not json ${leaked}`])
    expect(message).toContain('malformed SSE payload')
    expect(message).not.toContain(leaked)
  })
})

/**
 * The frames this layer used to answer with silence.
 *
 * A dropped field is worse than a dropped frame: the caller cannot tell a
 * truncated answer from a short one, and a failure that arrives as a frame the
 * parser does not recognise leaves no trace at all. These probes pin the
 * *surfacing* half of each case, and the two tolerance cases below it, because
 * the point is to report the loss rather than to start refusing benign traffic.
 */
describe('OpenAI-compatible SSE frames that used to be swallowed', () => {
  async function collect(payloads: readonly string[]): Promise<StreamChunk[]> {
    async function* source(): AsyncGenerator<string> { for (const payload of payloads) yield payload }
    const chunks: StreamChunk[] = []
    for await (const chunk of translate(source())) chunks.push(chunk)
    return chunks
  }

  it('surfaces a mid-answer failure whose error frame carries a bare string', async () => {
    // OpenAI puts an object in `error`. A provider that sends a string had the
    // reason dropped, and because that frame carries no choices either, the
    // answer so far was reported as a short completed turn.
    await expect(collect([
      JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] }),
      JSON.stringify({ error: 'upstream overloaded' }),
    ])).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('upstream overloaded') })
  })

  it('refuses a frame that parses to something other than an object', async () => {
    // These parsed cleanly and then matched nothing, field by field; `null`
    // additionally threw a TypeError that the adapter reported as a transport
    // failure, naming the wrong layer.
    await expect(collect(['"rate limited"'])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect(['null'])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('reads a delta whose content is the multimodal part list instead of dropping it', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ])
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } })
  })

  it('reports a stream that stops mid-answer instead of passing the truncation off as a stop', async () => {
    // No [DONE] and no finish reason: the connection died after a partial
    // answer, and `stop` told the caller the turn was complete.
    await expect(collect([JSON.stringify({ choices: [{ delta: { content: 'half an ans' } }] })]))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('still accepts a final chunk with a finish reason when the sentinel is omitted', async () => {
    // The tolerance that must survive: a provider whose last chunk declares why
    // the turn ended needs no [DONE], and that is not a truncation.
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ])
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
