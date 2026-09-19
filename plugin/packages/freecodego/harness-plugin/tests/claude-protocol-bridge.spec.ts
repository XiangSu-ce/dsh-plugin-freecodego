import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ClaudeProtocolBridge, encodeCodexBridgeRoute } from '../src/claude-protocol-bridge.ts'

const bridges: ClaudeProtocolBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.dispose()))
})

describe('ClaudeProtocolBridge', () => {
  it('preserves Anthropic system blocks and serves count_tokens for the SDK', async () => {
    const requests: unknown[] = []
    const bridge = new ClaudeProtocolBridge({
      async *stream(input) {
        requests.push(input)
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('freecodego', 'claude-sonnet-4-6')
    expect(endpoint.apiKey).toMatch(/^sk-ant-api03-/)

    const response = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        stream: false,
        system: [{ type: 'text', text: 'system one' }, { type: 'text', text: 'system two' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }),
    })

    await expect(response.json()).resolves.toMatchObject({ type: 'message', content: [{ type: 'text', text: 'ok' }] })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ system: 'system one\n\nsystem two' })

    const count = await fetch(endpoint.baseURL + '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + endpoint.apiKey },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'estimate this request' }] }),
    })

    await expect(count.json()).resolves.toMatchObject({ input_tokens: expect.any(Number) })
  })

  it('forwards the selected reasoning depth and emits valid thinking blocks', async () => {
    const requests: unknown[] = []
    const bridge = new ClaudeProtocolBridge({
      async *stream(input) {
        requests.push(input)
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'plan first' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan first' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash', 'high')

    const response = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })

    const body = await response.text()
    expect(requests[0]).toMatchObject({ provider: 'agnes', model: 'agnes-3.0-flash', reasoningEffort: 'high' })
    expect(body).toContain('"type":"thinking","thinking":"","signature":""')
    expect(body).toContain('"type":"thinking_delta","thinking":"plan first"')
  })

  it('streams Anthropic tool_use blocks with the provider call id and name', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call_real_1'), name: 'read_file', argumentsDelta: '{"path":' }
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call_real_1'), name: 'read_file', argumentsDelta: '"a.ts"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call_real_1'), name: 'read_file', arguments: '{"path":"a.ts"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')

    const response = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'read it' }] }),
    })

    const body = await response.text()
    const start = body.split('\n').filter(line => line.startsWith('data: ')).find(line => line.includes('"type":"content_block_start"'))
    expect(start).toContain('"type":"tool_use","id":"call_real_1","name":"read_file"')
    expect(body).toContain('"type":"input_json_delta","partial_json":"{\\"path\\":"')
    expect(body).toContain('"type":"input_json_delta","partial_json":"\\"a.ts\\"}"')
  })

  it('delivers the buffered arguments of a tool call whose id never arrives', async () => {
    // Host providers (llm-deepseek, llm-pi-ai) stream `id: ''` and may never
    // reveal a call id at all. The id gets a substitute; the arguments must
    // still reach the client, or Claude Code runs the tool with no arguments.
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        // `ToolCallId('')` is the point, not a placeholder: Host providers stream an
        // empty id and may never reveal one, and the bridge has to substitute it.
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId(''), name: 'read_file', argumentsDelta: '{"path":' }
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId(''), name: 'read_file', argumentsDelta: '"a.ts"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(''), name: 'read_file', arguments: '{"path":"a.ts"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')

    const response = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'read it' }] }),
    })

    const body = await response.text()
    const start = body.split('\n').filter(line => line.startsWith('data: ')).find(line => line.includes('"type":"content_block_start"'))
    // The id is invented because the provider never supplied one.
    expect(start).toContain('"type":"tool_use"')
    expect(start).toContain('"name":"read_file"')
    // ...and the arguments survive as the opening json delta rather than being
    // dropped on the floor. Everything buffered before the id arrived is
    // flushed at once, so the whole call arrives as a single delta.
    expect(body).toContain('"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"')
    expect(body.split('"type":"input_json_delta"')).toHaveLength(2)
  })

  it('returns a Responses-shaped non-streaming object on the /responses route', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.openAIEndpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(endpoint.baseURL + '/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: 'agnes-3.0-flash', stream: false, input: [{ role: 'user', content: 'hi' }] }),
    })

    await expect(response.json()).resolves.toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 3, output_tokens: 5 } })
  })

  it('uses Codex per-turn route tags instead of pinning the startup provider', async () => {
    const requests: unknown[] = []
    const bridge = new ClaudeProtocolBridge({
      async *stream(input) {
        requests.push(input)
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.openAIEndpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(endpoint.baseURL + '/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: encodeCodexBridgeRoute('freecodego', 'hy3', 'low'),
        stream: false,
        input: [{ role: 'user', content: 'switch route' }],
      }),
    })

    expect(response.ok).toBe(true)
    expect(requests[0]).toMatchObject({ provider: 'freecodego', model: 'hy3', reasoningEffort: 'low' })
  })
})

describe('a stream that fails after it started', () => {
  /** POST a streaming turn and read the whole body. */
  async function streamTurn(bridge: ClaudeProtocolBridge, body: Record<string, unknown> = {}): Promise<string> {
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }], ...body }),
    })
    return await response.text()
  }

  it('reports a provider throw as an Anthropic error event instead of a truncated turn', async () => {
    // The defect: the exception left `streamResponse`, the response had already
    // been written with `200 text/event-stream`, and the client received half a
    // turn with no terminal event at all.
    const body = await streamTurn(new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'half' }
        throw new Error('provider exploded mid-stream')
      },
    }))

    expect(body).toContain('"text":"half"')
    expect(body).toContain('event: error')
    expect(body).toContain('provider exploded mid-stream')
    // One terminal event, and it is the failure one.
    expect(body).not.toContain('message_stop')
  })

  it('tells a rate limit apart from a generic failure, because the client retries on it', async () => {
    const body = await streamTurn(new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '' }
        throw Object.assign(new Error('slow down'), { status: 429 })
      },
    }))

    expect(body).toContain('"type":"rate_limit_error"')
  })

  it('turns silence into a retryable timeout rather than leaving the request open', async () => {
    // The provider answered once and then went silent without closing. Without a
    // deadline the client waits forever; the structured way to fail that is the
    // one the client can retry, not a cancellation it caused itself.
    let released = false
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        try {
          yield { type: 'text-delta', index: 0, text: 'start' }
          await new Promise(() => undefined)
        } finally {
          released = true
        }
      },
    }, 40)
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })

    const body = await response.text()
    expect(body).toContain('"text":"start"')
    expect(body).toContain('sent nothing for 40ms')
    expect(body).toContain('"type":"api_error"')
    expect(body).not.toContain('message_stop')
    // The upstream was told to stop and not waited for. Its `finally` cannot run
    // while it is parked inside its own pending `await`, so a released-flag here
    // would be a lie by construction — and that is the point: the client gets its
    // answer whether or not the provider ever acknowledges. Change this to wait,
    // and this case stops completing at all rather than flipping a boolean.
    expect(released).toBe(false)
  })

  it('fails the Responses turn on the OpenAI route as well, and still ends it', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'half' }
        throw new Error('codex route dropped')
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.openAIEndpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(endpoint.baseURL + '/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: 'agnes-3.0-flash', stream: true, input: [{ role: 'user', content: 'hi' }] }),
    })

    const body = await response.text()
    expect(body).toContain('"type":"response.failed"')
    expect(body).toContain('codex route dropped')
    // The client reads `[DONE]` as the end of the event stream; a failed
    // response without it looks like a dropped connection instead.
    expect(body).toContain('[DONE]')
    expect(body).not.toContain('"type":"response.completed"')
  })

  it('keeps serving after a client cancels a turn mid-stream', async () => {
    // A cancelled turn must not take the bridge down, and its later chunks must
    // not be written into a response that is already gone.
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        for (let index = 0; index < 200; index += 1) {
          yield { type: 'text-delta', index: 0, text: `chunk ${String(index)} ` }
          await new Promise((resolve) => { setTimeout(resolve, 2) })
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    const controller = new AbortController()
    const cancelled = fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
      signal: controller.signal,
      // Whether the abort lands before the headers or while the body is being
      // read, the client's own view is "gone"; both shapes are accepted here
      // because the bridge cannot choose which one the network produces.
    }).then(async response => await response.text().catch(() => 'cancelled mid-body'), () => 'cancelled before headers')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    controller.abort()
    expect(await cancelled).toMatch(/^cancelled/u)

    // The upstream keeps producing for a while after the abort; the bridge has to
    // absorb that and still answer the next turn normally.
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    const after = await fetch(endpoint.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'again' }] }),
    })
    expect(await after.text()).toContain('message_stop')
  })

  it('serves again after a dispose instead of handing out a route that answers nothing', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'second life' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const first = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    await bridge.dispose()

    // The cached readiness used to outlive the server it described, so this URL
    // was built from an `undefined` address: a route the caller could hand to a
    // CLI and that could never answer. Probing it is the only way to tell the two
    // apart, which is why the assertion is a request rather than a string shape.
    const second = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(second.baseURL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': second.apiKey },
      body: JSON.stringify({ model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(await response.text()).toContain('second life')
    expect(first.baseURL).not.toBe(second.baseURL)
  })

  it('ends a completed Responses turn with exactly one terminal frame', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.openAIEndpoint('agnes', 'agnes-3.0-flash')
    const response = await fetch(endpoint.baseURL + '/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: 'agnes-3.0-flash', stream: true, input: [{ role: 'user', content: 'hi' }] }),
    })

    const body = await response.text()
    // The sentinel is the terminal frame and is now delivered through the writer,
    // so it appears once: a second copy would mean two sources ended one stream.
    expect(body.split('[DONE]')).toHaveLength(2)
    expect(body).toContain('"type":"response.completed"')
  })
})
