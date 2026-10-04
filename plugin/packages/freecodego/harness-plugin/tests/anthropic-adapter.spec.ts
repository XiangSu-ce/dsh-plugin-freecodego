import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { OpenAiCompatibleAdapter, wireForProtocol } from '../src/openai-compatible-adapter.ts'
import { parseGroupPin } from '../src/model-catalog.ts'

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

  it('sends the bare wire model for a group-pinned Anthropic selection', async () => {
    // The picker's selection value carries the group pin (`id@group:N`) and the
    // route key carries the same pin to the backend; the Messages body has to
    // name the bare model. Sending the pin made the gateway look for an account
    // whose model mapping contains `claude-opus-5-5@group:7`, which none does — so
    // every selectable Claude row answered `503 No available accounts` while the
    // OpenAI row for the same group worked, because only this path ignored the
    // connection's wire model.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      ANTHROPIC_SSE,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: async provider => [{ provider, id: 'claude-opus-5-5', name: 'claude opus 5 5' }],
      // Mirrors the gateway's own resolver (`managed-catalogs.ts`), which strips
      // the pin into the connection for the wire and keeps it in the route key.
      resolveConnection: async model => {
        const { modelId, groupId } = parseGroupPin(model)
        return {
          baseURL: 'https://gw.example/v1',
          apiKey: 'gw-token',
          wire: 'anthropic' as const,
          headers: { 'X-FreeCodeGo-Route-Key': `group:${String(groupId)}:${modelId}` },
          ...(modelId === model ? {} : { model: modelId }),
        }
      },
    })
    for await (const _chunk of adapter.stream({ provider: 'freecodego', model: 'claude-opus-5-5@group:7', messages: [userMessage('hello')] })) { /* consume the stream */ }

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request.model).toBe('claude-opus-5-5')
    // The pin stays where the backend reads it: the route-key header.
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-FreeCodeGo-Route-Key': 'group:7:claude-opus-5-5' })
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

  it('bounds the wait for a provider that never answers, independently of the caller signal', async () => {
    const caller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => { reject(requestSignal?.reason) }, { once: true })
    }))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'FreeCodeGo',
      listModels: async provider => [{ provider, id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' }],
      resolveConnection: async () => ({ baseURL: 'https://gw.example/v1', apiKey: 'gw-token' }),
      // The route's own idle deadline. It is the whole point of the spec that
      // this cannot be replaced by (or fall back to) the caller's signal.
      streamIdleMs: 40,
    })
    const iterator = adapter.stream({ provider: 'freecodego', model: 'gpt-5.6-terra', messages: [userMessage('hello')], signal: caller.signal })[Symbol.asyncIterator]()
    // The rejection is produced by the adapter's timer, not by the lines below,
    // so it is claimed here: an unclaimed rejection would surface as an unhandled
    // one before the assertion below ever runs.
    const settled = iterator.next().then(() => undefined, (error: unknown) => error)
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      // A caller that never cancels must not be able to leave the turn hanging
      // on a provider that answers nothing: the adapter's own deadline ends the
      // wait and tears the request down.
      expect(String(await settled)).toMatch(/timed out/u)
      expect(requestSignal?.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
    } finally {
      caller.abort()
      await settled
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
