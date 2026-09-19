import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { OpenAiCompatibleAdapter } from '../src/openai-compatible-adapter.ts'

afterEach(() => vi.restoreAllMocks())

describe('OpenAI-compatible route', () => {
  it('rejects a protected provider before the model can be selected', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Protected provider',
      listModels: async provider => [{ provider, id: 'protected-model', name: 'Protected Model' }],
      assertSelectable: async () => { throw new Error('OPENROUTER_API_KEY_REQUIRED: configure an OpenRouter API key in Settings first') },
      resolveConnection: async () => ({ baseURL: 'https://example.invalid/v1', apiKey: 'not-used' }),
    })
    await expect(adapter.resolveModel('openrouter', 'protected-model')).rejects.toThrow('OPENROUTER_API_KEY_REQUIRED')
  })

  it('allows metadata discovery to render an unconfigured row', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'OpenRouter',
      listModels: async provider => [{ provider, id: 'free-model', name: 'Free Model', availability: 'unavailable', unavailableReason: 'OPENROUTER_API_KEY_REQUIRED' }],
      assertSelectableOnResolve: false,
      assertSelectable: async () => { throw new Error('OPENROUTER_API_KEY_REQUIRED') },
      resolveConnection: async () => ({ baseURL: 'https://example.invalid/v1', apiKey: 'not-used' }),
    })
    await expect(adapter.resolveModel('openrouter', 'free-model')).resolves.toMatchObject({ id: 'free-model', name: 'Free Model' })
  })

  it('uses the versioned OpenAI endpoint and strips the provider alias from the wire model', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Wire route',
      listModels: async provider => [{ provider, id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }],
      includeUsage: false,
      resolveConnection: async model => ({
        baseURL: 'https://example.invalid/v1',
        apiKey: 'test-key',
        model: model.replace(/^wire\//u, ''),
      }),
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'wire',
      model: 'wire/glm-5.3-flash', maxTokens: 1000,
      messages: [{ id: MessageId('m1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(fetchMock).toHaveBeenCalledWith('https://example.invalid/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
      body: expect.stringContaining('"model":"glm-5.3-flash"'),
    }))
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request.max_tokens).toBe(1000)
    expect(request.stream_options).toBeUndefined()
  })

  it('serializes a visual-model attachment as an OpenAI image data URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const attachment = {
      attachmentId: 'image-1' as never,
      mediaType: 'image/png' as const,
      bytes: 4,
      width: 1,
      height: 1,
    }
    const attachments = {
      readImageRequest: vi.fn(async () => ({
        variantId: 'variant-1' as never,
        attachment,
        data: new Uint8Array([137, 80, 78, 71]),
        mediaType: 'image/png' as const,
        bytes: 4,
        width: 1,
        height: 1,
        depth: 'uchar' as const,
        space: 'srgb' as const,
        hasAlpha: true,
      })),
    }
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Visual provider',
      listModels: async provider => [{ provider, id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'] }],
      resolveAttachments: () => attachments as never,
      resolveConnection: async () => ({ baseURL: 'https://example.invalid/v1', apiKey: 'test-key' }),
    })
    for await (const _chunk of adapter.stream({
      provider: 'visual', model: 'gpt-4o',
      messages: [{
        id: MessageId('image-message'), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image', attachment }],
      }],
    })) { /* consume */ }
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: { content: unknown }[] }
    expect(request.messages[0]?.content).toEqual([
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
    ])
    // Harness 0.1.6 replaced the attachment service's pixel-budget policy with an
    // explicit request target, so the route projects the 6MP ceiling onto the
    // 1x1 source geometry instead of handing the ceiling over as-is.
    expect(attachments.readImageRequest).toHaveBeenCalledWith(attachment, { width: 1, height: 1, maxBytes: 10 * 1024 * 1024 }, undefined)
  })

  it('omits optional OpenAI fields that Logfare does not document', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Mystery Provider',
      listModels: async provider => [{ provider, id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
      resolveConnection: async () => ({ baseURL: 'https://logfare.ai/v1', apiKey: 'logfare-test-key', model: 'claude-opus-4-6' }),
      reasoningWire: 'standard',
      reasoningEffortsForModel: () => ['off'],
      normalizeReasoningEffort: () => undefined,
      includeUsage: false,
    })
    for await (const _chunk of adapter.stream({
      provider: 'logfare',
      model: 'claude-opus-4-6',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [{ id: MessageId('m2'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    })) { /* consume the stream */ }
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request.stream_options).toBeUndefined()
    expect(request.reasoning_effort).toBeUndefined()
  })

  it('keeps the canonical Logfare Auto wire id when the selector uses its alias', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'logfare',
      listModels: async provider => [{ provider, id: 'logfare/auto', name: 'Auto' }],
      resolveConnection: async model => ({ baseURL: 'https://logfare.ai/v1', apiKey: 'key', model: model.toLowerCase() === 'auto' ? 'logfare/auto' : model }),
      reasoningEffortsForModel: () => ['off'],
      normalizeReasoningEffort: () => undefined,
    })
    for await (const _chunk of adapter.stream({
      provider: 'logfare', model: 'auto',
      messages: [{ id: MessageId('m3'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    })) { /* consume */ }
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('"model":"logfare/auto"')
  })

  it('caps explicit output tokens at the adapter safety limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Public route',
      listModels: async provider => [{ provider, id: 'auto', name: 'Auto' }],
      resolveConnection: async () => ({ baseURL: 'https://example.invalid/v1', apiKey: 'test-key' }),
      maxOutputTokens: 16_384,
    })
    for await (const _chunk of adapter.stream({
      provider: 'public', model: 'auto', maxTokens: 256_000,
      messages: [{ id: MessageId('m4'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    })) { /* consume */ }
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request.max_tokens).toBe(16_384)
  })

  it('can defer the output budget to a provider with dynamic limits', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new OpenAiCompatibleAdapter({
      providerName: 'Dynamic route',
      listModels: async provider => [{ provider, id: 'auto', name: 'Auto' }],
      resolveConnection: async () => ({ baseURL: 'https://example.invalid/v1', apiKey: 'test-key' }),
      omitDefaultMaxTokens: true,
      omitMaxTokens: true,
    })
    await expect(adapter.resolveModel('dynamic', 'auto')).resolves.not.toHaveProperty('defaultMaxTokens')
    for await (const _chunk of adapter.stream({
      provider: 'dynamic', model: 'auto', maxTokens: 256_000,
      messages: [{ id: MessageId('m5'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    })) { /* consume */ }
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(request.max_tokens).toBeUndefined()
  })

})
