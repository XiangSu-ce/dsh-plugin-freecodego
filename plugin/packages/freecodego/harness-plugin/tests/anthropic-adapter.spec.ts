import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { OpenAiCompatibleAdapter, wireForProtocol } from '../src/openai-compatible-adapter.ts'

afterEach(() => vi.restoreAllMocks())

const userMessage = (text: string) => ({
  id: MessageId('m1'),
  role: 'user' as const,
  source: { kind: 'user' as const },
  content: [{ type: 'text' as const, text }],
})

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

describe('OpenAiCompatibleAdapter wire selection', () => {
  it('posts an Anthropic Messages body to /v1/messages with x-api-key and anthropic-version', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      ANTHROPIC_SSE,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: async provider => [{ provider, id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
      resolveConnection: async () => ({
        baseURL: 'https://gw.example/v1',
        apiKey: 'gw-token',
        wire: 'anthropic',
        headers: { 'X-FreeCodeGo-Route-Key': 'group:7:claude-sonnet-5' },
      }),
    })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'freecodego', model: 'claude-sonnet-5', messages: [userMessage('hello')] })) chunks.push(chunk)

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hi' })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(new URL(url).pathname).toBe('/v1/messages')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-api-key': 'gw-token',
      'anthropic-version': '2023-06-01',
      'X-FreeCodeGo-Route-Key': 'group:7:claude-sonnet-5',
    })
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      stream: true,
      max_tokens: 8_192,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    // The OpenAI-only envelope must not leak into an Anthropic request.
    expect(request).not.toHaveProperty('stream_options')
    expect(request).not.toHaveProperty('thinking')
  })

  it('keeps the OpenAI chat-completions path when no wire is set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: async provider => [{ provider, id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' }],
      resolveConnection: async () => ({ baseURL: 'https://gw.example/v1', apiKey: 'gw-token' }),
    })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'freecodego', model: 'gpt-5.6-terra', messages: [userMessage('hello')] })) chunks.push(chunk)

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(new URL(url).pathname).toBe('/v1/chat/completions')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer gw-token' })
  })

  it('sends an openai_responses group over the chat-completions wire', async () => {
    // The router resolves a group's protocol through the transport's own wire
    // mapping, so the dialect the backend labels the group with and the body
    // that goes out cannot disagree. A Responses-shaped body (`input`) would be
    // the wrong contract on this endpoint.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    // The dialect has to have a wire at all, or the router would be offering a
    // route this transport cannot send.
    const wire = wireForProtocol('openai_responses')
    if (wire === undefined) throw new Error('openai_responses has no wire')
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: async provider => [{ provider, id: 'gpt-5.6', name: 'GPT 5.6' }],
      resolveConnection: async () => ({
        baseURL: 'https://gw.example/v1',
        apiKey: 'gw-token',
        wire,
        headers: { 'X-FreeCodeGo-Route-Key': 'model:openai_responses:gpt-5.6' },
      }),
    })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'freecodego', model: 'gpt-5.6', messages: [userMessage('hello')] })) chunks.push(chunk)

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe('/v1/chat/completions')
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request).toHaveProperty('messages')
    expect(request).not.toHaveProperty('input')
  })

  it('keeps the provider timeout when the caller supplies a cancellation signal', async () => {
    const deadline = new AbortController()
    const caller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => { reject(requestSignal?.reason) }, { once: true })
    }))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: async provider => [{ provider, id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' }],
      resolveConnection: async () => ({ baseURL: 'https://gw.example/v1', apiKey: 'gw-token' }),
    })
    const iterator = adapter.stream({ provider: 'freecodego', model: 'gpt-5.6-terra', messages: [userMessage('hello')], signal: caller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      expect(timeout).toHaveBeenCalledWith(120_000)
      deadline.abort(new Error('provider deadline elapsed'))
      await expect(pending).rejects.toThrow(/request failed/u)
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      deadline.abort()
      caller.abort()
      await pending.catch(() => undefined)
    }
  })

  it('surfaces the provider 429 hint and onRateLimited callback on rate limiting', async () => {
    // The spy is the point (it is what makes `fetch` answer 429); the handle is
    // not read, so it is not bound.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'upstream busy',
      { status: 429, headers: { 'content-type': 'text/plain' } },
    ))
    const onRateLimited = vi.fn()
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'OpenCode Zen',
      listModels: async provider => [{ provider, id: 'auto', name: 'Auto' }],
      resolveConnection: async () => ({ baseURL: 'https://oc.example/v1', apiKey: 'public' }),
      onRateLimited,
      rateLimitedHint: () => '请尝试关闭本地/全局代理后重试。\nTry disabling your local/global proxy and retry.',
    })
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'opencode', model: 'auto', messages: [userMessage('hello')] })) void _
    }).rejects.toThrow(expect.objectContaining({
      code: 'RATE_LIMIT',
      message: expect.stringContaining('请尝试关闭本地/全局代理后重试。'),
    }) as object)
    // The bilingual hint rides along in the thrown error message.
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'opencode', model: 'auto', messages: [userMessage('hello')] })) void _
    }).rejects.toThrow(/Try disabling your local\/global proxy/)
    expect(onRateLimited).toHaveBeenCalledWith('OpenCode Zen', 429)
  })

  it('masks a credential the provider echoes back in its failure body', async () => {
    // The trust boundary the masking inventory names: the caller of this adapter
    // sees whatever text it throws, so the provider detail has to be masked here
    // rather than where a caller happens to build a message.
    const leaked = `ghp_${'A'.repeat(36)}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: `invalid request: ${leaked}` } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'OpenCode Zen',
      listModels: async provider => [{ provider, id: 'auto', name: 'Auto' }],
      resolveConnection: async () => ({ baseURL: 'https://oc.example/v1', apiKey: 'public' }),
    })
    const failure = await (async () => {
      for await (const _ of adapter.stream({ provider: 'opencode', model: 'auto', messages: [userMessage('hello')] })) void _
    })().then(() => new Error('the request was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('invalid request')
    expect(failure.message).not.toContain(leaked)
  })
})
