import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeAnthropicRequest, translateAnthropic } from '../src/anthropic-wire.ts'
import { translate } from '../src/openai-wire.ts'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Tool-call arguments are the one part of a wire frame that a bad parse can
 * turn into a *different* instruction rather than a visible failure: `{}` reads
 * as a deliberate no-argument call. These probes pin down that the two wires
 * keep tolerating a bad frame but stop swallowing it.
 */
function captureWarnings(): string[] {
  const warnings: string[] = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
  return warnings
}

afterEach(() => { vi.restoreAllMocks() })

async function serializeAssistantToolCall(argumentsText: string): Promise<Record<string, unknown>> {
  return await serializeAnthropicRequest({
    provider: 'freecodego', model: 'claude-sonnet-5',
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1' as never, name: 'write_file', arguments: argumentsText }],
    }],
  } as never)
}

function toolUseOf(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as { readonly content: Record<string, unknown>[] }[]
  const block = messages[0]?.content.find(value => value.type === 'tool_use')
  if (block === undefined) throw new Error('the replayed assistant turn carried no tool_use block')
  return block
}

describe('Anthropic tool_use arguments that cannot be projected', () => {
  it('keeps the call but reports malformed arguments instead of swallowing them', async () => {
    const warnings = captureWarnings()
    const block = toolUseOf(await serializeAssistantToolCall('{"path": "a.ts"'))
    // The tolerance is deliberate and stays: one bad historical frame must not
    // kill the turn, and Anthropic rejects a non-object `input`.
    expect(block).toEqual({ type: 'tool_use', id: 'call-1', name: 'write_file', input: {} })
    // What must not stay is the silence, which is what let a lost argument list
    // pass as a deliberate no-argument call.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('write_file')
    expect(warnings[0]).toContain('not valid JSON')
    expect(warnings[0]).toContain('{"path": "a.ts"')
  })

  it('reports valid JSON that is not an object instead of replacing it in silence', async () => {
    const warnings = captureWarnings()
    const block = toolUseOf(await serializeAssistantToolCall('["a.ts", "b.ts"]'))
    expect(block.input).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not a JSON object')
  })

  it('masks a credential inside the arguments it quotes back', async () => {
    const leaked = `sk-ant-api03-${'z'.repeat(40)}`
    const warnings = captureWarnings()
    await serializeAssistantToolCall(`{"token": "${leaked}"`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('write_file')
    expect(warnings[0]).not.toContain(leaked)
  })

  it('leaves an empty arguments frame unreported because {} is a legal input', async () => {
    const warnings = captureWarnings()
    const block = toolUseOf(await serializeAssistantToolCall(''))
    expect(block.input).toEqual({})
    expect(warnings).toEqual([])
  })

  it('leaves a well-formed arguments frame unreported and parsed', async () => {
    const warnings = captureWarnings()
    const block = toolUseOf(await serializeAssistantToolCall('{"path": "a.ts"}'))
    expect(block.input).toEqual({ path: 'a.ts' })
    expect(warnings).toEqual([])
  })
})

async function collectAnthropic(events: readonly unknown[]): Promise<StreamChunk[]> {
  async function* payloads(): AsyncGenerator<string> { for (const event of events) yield JSON.stringify(event) }
  const chunks: StreamChunk[] = []
  for await (const chunk of translateAnthropic(payloads())) chunks.push(chunk)
  return chunks
}

async function collectOpenai(events: readonly unknown[]): Promise<StreamChunk[]> {
  async function* payloads(): AsyncGenerator<string> { for (const event of events) yield JSON.stringify(event) }
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(payloads())) chunks.push(chunk)
  return chunks
}

function closedToolCall(chunks: readonly StreamChunk[]): Extract<ContentBlock, { type: 'tool-call' }> {
  const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  if (end === undefined || end.type !== 'block-end' || end.block.type !== 'tool-call') throw new Error('no tool-call block was closed')
  return end.block
}

describe('streamed tool-call arguments', () => {
  it('streams a malformed Anthropic partial_json as raw text, never as an empty object', async () => {
    const chunks = await collectAnthropic([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    // The consumer parses the arguments, so this layer must not pre-empt it by
    // substituting `{}`: raw text keeps the failure where it can be seen.
    expect(closedToolCall(chunks)).toEqual({ type: 'tool-call', id: 'toolu_1', name: 'write_file', arguments: '{"path": ' })
  })

  it('keeps arguments a provider sent as a JSON value instead of dropping them', async () => {
    const chunks = await collectOpenai([{
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: { path: 'a.ts' } } }] }, finish_reason: 'tool_calls' }],
    }])
    // Reading only strings used to leave this call with no arguments at all.
    expect(closedToolCall(chunks).arguments).toBe('{"path":"a.ts"}')
  })

  it('keeps the string-fragment accumulation unchanged', async () => {
    const chunks = await collectOpenai([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
    ])
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.argumentsDelta)).toEqual(['{"path":', '"a.ts"}'])
    expect(closedToolCall(chunks).arguments).toBe('{"path":"a.ts"}')
  })

  it('passes a malformed OpenAI arguments string through unchanged', async () => {
    const chunks = await collectOpenai([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: 'tool_calls' }] },
    ])
    expect(closedToolCall(chunks).arguments).toBe('{"path":')
  })
})
