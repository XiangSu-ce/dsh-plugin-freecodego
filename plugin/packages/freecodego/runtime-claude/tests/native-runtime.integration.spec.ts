import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openClaudeRootRuntime } from '../src/index.ts'

// The Claude runtime is an optional install, so the launching case self-skips when
// its artifact marker is absent — the same gate the other external-dependency
// suites use. The DSH home is resolved from this file rather than `process.cwd()`:
// vitest runs with the repository root as cwd, so a relative walk from cwd lands
// outside the checkout instead of on the deployment home that owns `runtimes/`.
const dshHome = process.env.DSH_HOME?.trim() || fileURLToPath(new URL('../../../../../', import.meta.url))
const claudeRuntimeRoot = join(dshHome, 'runtimes', 'claude')
const claudeRuntimeMarkerPath = join(claudeRuntimeRoot, 'claude-agent-sdk-runtime.json')
const claudeRuntimeInstalled = existsSync(claudeRuntimeMarkerPath)

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('Claude native runtime', () => {
  it('publishes every emitted ESM chunk required by the Runtime entrypoint', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { readonly files: readonly string[] }
    expect(manifest.files).toContain('lib/*.mjs')
  })

  it.skipIf(!claudeRuntimeInstalled)('launches the official CLI with the plugin gateway on Windows', async () => {
    const requests: string[] = []
    const payloads: Record<string, unknown>[] = []
    const routed: { readonly provider: string; readonly modelId: string; readonly reasoningEffort?: string }[] = []
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      if (request.method === 'HEAD' && request.url?.endsWith('/api/hello') === true) {
        request.resume()
        response.writeHead(200)
        response.end()
        return
      }
      if (request.method === 'POST' && request.url?.includes('/v1/messages') === true) {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
          payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
          const model = request.url?.includes('freecodego-hy3') ? 'hy3' : 'agnes-3.0-flash'
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end([
            sse('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
            sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
            sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning-visible' } }),
            sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
            sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: `native-runtime-${model}` } }),
            sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
            sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
            sse('message_stop', { type: 'message_stop' }),
          ].join(''))
        })
        return
      }
      request.resume()
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'not_found_error', message: 'unexpected test gateway route' } }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => { resolve() })) })
    const port = (server.address() as { readonly port: number }).port
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-claude-native-'))
    cleanups.push(async () => { await rm(stateDirectory, { recursive: true, force: true }) })
    const runtimeMarker = JSON.parse(await readFile(claudeRuntimeMarkerPath, 'utf8')) as { readonly executablePath: string }
    const events: { readonly method: string; readonly params: Record<string, unknown> }[] = []
    const session = await openClaudeRootRuntime({
      stateDirectory,
      environment: {
        FREECODEGO_CLAUDE_EXECUTABLE: join(claudeRuntimeRoot, runtimeMarker.executablePath).replaceAll('\\', '/'),
        FREECODEGO_CLAUDE_DEBUG: '1',
      },
      gatewayForRoute: async (route) => {
        routed.push(route)
        return {
          baseURL: `http://127.0.0.1:${port}/anthropic/${route.provider}-${route.modelId}`,
          apiKey: `sk-ant-api03-${'a'.repeat(96)}`,
        }
      },
      capabilitiesForTurn: () => ({
        mcpEnabled: false,
        skillEnabled: true,
        mcpTools: [],
        harnessTools: [{
          name: 'subagent',
          description: 'Create a Harness-managed child session.',
          parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' } }, required: ['description', 'prompt'] },
        }, {
          name: 'canvas_render',
          description: 'Render through a third-party Harness canvas plugin.',
          parameters: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'] },
        }],
      }),
      systemPromptForRoute: route => `Harness integration test for ${route.provider}/${route.modelId}.`,
    }, {
      harnessSessionId: 'harness-session',
      modelId: 'agnes-3.0-flash',
      provider: 'agnes',
      workspace: process.cwd(),
      artifactDigest: 'test-artifact',
      protocolAbi: 'freecodego-agent/1',
      onEvent: (event) => { events.push({ method: event.method, params: event.params }) },
    })
    cleanups.push(() => session.dispose())

    try {
      await session.prompt('hello', { modelId: 'agnes-3.0-flash', provider: 'agnes', reasoningEffort: 'high' })
      await session.prompt('switch model', { modelId: 'hy3', provider: 'freecodego', reasoningEffort: 'low' })
    } catch (error) {
      throw new Error(`native prompt failed: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}`)
    }

    expect(routed).toEqual([
      { provider: 'agnes', modelId: 'agnes-3.0-flash', reasoningEffort: 'high' },
      { provider: 'freecodego', modelId: 'hy3', reasoningEffort: 'low' },
    ])
    expect(requests).toContain('HEAD /anthropic/agnes-agnes-3.0-flash/api/hello')
    expect(requests).toContain('HEAD /anthropic/freecodego-hy3/api/hello')
    expect(requests.some(value => value.startsWith('POST /anthropic/agnes-agnes-3.0-flash/v1/messages'))).toBe(true)
    expect(requests.some(value => value.startsWith('POST /anthropic/freecodego-hy3/v1/messages'))).toBe(true)
    expect(payloads.some(payload => JSON.stringify(payload.system).includes('Harness integration test'))).toBe(true)
    expect(payloads.some(payload => JSON.stringify(payload.tools).includes('mcp__freecodego-host__freecodego_harness_subagent'))).toBe(true)
    expect(payloads.some(payload => JSON.stringify(payload.tools).includes('mcp__freecodego-host__freecodego_harness_canvas_render'))).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ method: 'assistant/reasoning/final', params: expect.objectContaining({ text: 'reasoning-visible' }) }))
    expect(events).toContainEqual(expect.objectContaining({ method: 'assistant/final', params: expect.objectContaining({ text: 'native-runtime-hy3' }) }))
  }, 30_000)
})

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}
