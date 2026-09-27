/**
 * A third-party direct route reports its token counts only when the request asks
 * for them (`stream_options.include_usage`). Without that envelope the provider
 * says nothing, and `buildLocalTokenUsageSnapshot` then records the turn as an
 * unreported attempt with every bucket at zero — so the route is listed on the
 * token panel as unused however much traffic it serves. That is exactly what the
 * ledger held for these two routes:
 *
 *   - `vyce/vyce/deepseek-v4.1` — 12 attempts, 12 unreported, 0 tokens
 *   - `logfare/grok-4.6`        — 99 attempts, 99 unreported, 0 tokens
 *
 * while the routes that do report (`cline`, `workbuddy`, the FreeCodeGo gateway)
 * carried real numbers beside them. The cause was in the two registrations
 * pinned here: each carried a bare `includeUsage: false` with no recorded
 * refusal behind it, unlike the one adapter that had a documented reason and was
 * therefore deleted with its provider.
 *
 * These pins drive the adapters the class actually registers, because the body
 * is a property of that registration — a re-derived copy of the request would be
 * free to drift from the one users get.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'

type StreamRequest = { readonly provider: string; readonly model: string; readonly messages: readonly unknown[] }
type RegisteredAdapter = { readonly stream: (options: StreamRequest) => AsyncIterable<unknown> }

const message = [{ id: MessageId('m1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
/** The route label and model id the token panel showed, as the account holds them. */
const vyceRequest: StreamRequest = { provider: 'vyce', model: 'vyce/deepseek-v4.1', messages: message }
const logfareRequest: StreamRequest = { provider: 'logfare', model: 'grok-4.6', messages: message }

/** A completed stream that reports usage, as an asked-for provider answers. */
const usageReply = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\ndata: [DONE]\n\n'

afterEach(() => vi.unstubAllGlobals())

/**
 * The adapter the class registers for one provider, as the Host's `llm` service
 * holds it — read through the known-directory decorator's `connector`, so the
 * stream under test is the connector's own.
 * @param register - registers the route on a fresh catalog instance.
 * @param provider - the provider id to read back.
 * @returns the registered adapter's inner stream.
 */
function registeredAdapter(register: (catalogs: FreeCodeGoManagedCatalogs) => void, provider: string): RegisteredAdapter {
  const registered: Record<string, unknown> = {}
  const catalogs = new FreeCodeGoManagedCatalogs({
    ctx: {
      emit: () => undefined,
      on: () => undefined,
      get: (name: string) => name === 'llm'
        ? { registerAdapter: (providers: readonly string[], adapter: unknown) => { for (const id of providers) registered[id] = adapter } }
        : undefined,
    },
    // A configured key is what makes a direct route resolvable at all.
    credentials: () => ({ resolve: async () => ({ value: 'sk-test' }) }),
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
  register(catalogs)
  return (registered[provider] as { connector: RegisteredAdapter }).connector
}

/** Answer the provider's model directory, then the completion. */
function stubProvider(): string[] {
  const bodies: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    bodies.push(String(init?.body))
    return new Response(usageReply, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }))
  return bodies
}

/** Every chunk one registered route produces for a request. */
async function streamedChunks(adapter: RegisteredAdapter, request: StreamRequest): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

describe('third-party direct routes ask for their usage', () => {
  it('sends the usage envelope on the VyceAI route', async () => {
    const bodies = stubProvider()
    const chunks = await streamedChunks(registeredAdapter(catalogs => catalogs.registerVyceAdapter(), 'vyce'), vyceRequest)

    expect(bodies).toHaveLength(1)
    const request = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    expect(request.stream_options).toEqual({ include_usage: true })
    // The envelope only matters because of where the answer lands: the ledger
    // reads usage off the assistant stream, so a chunk that never arrives is a
    // turn recorded with no numbers at all.
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } })
  })

  it('sends the usage envelope on the Logfare route', async () => {
    const bodies = stubProvider()
    const chunks = await streamedChunks(registeredAdapter(catalogs => catalogs.registerLogfareAdapter(), 'logfare'), logfareRequest)

    expect(bodies).toHaveLength(1)
    const request = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    expect(request.stream_options).toEqual({ include_usage: true })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } })
  })
})
