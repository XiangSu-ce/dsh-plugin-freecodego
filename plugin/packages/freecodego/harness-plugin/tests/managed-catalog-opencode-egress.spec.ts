/**
 * OpenCode's free tier carries its own rule, stated only in the failure body:
 * the route is free for OpenCode's own client, and an egress that does not
 * qualify answers `403` with `FreeTierError`. The bare status sends the user
 * looking at the model, the key, or the plugin — none of which is the cause —
 * so the adapter has to say which lever to pull.
 *
 * These pins drive the adapter the class actually registers for `opencode`
 * against a stubbed fetch: the hint is a property of that registration, and a
 * re-derived copy of it would be free to drift from the one users get.
 *
 * The distinction they hold is narrow on purpose. `403` alone is not enough to
 * explain: the same route answers it for a row that was retired upstream, and
 * appending an IP suggestion there would send the user to change a network
 * setting that is not the problem. Both directions are pinned below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'

import { FreeCodeGoManagedCatalogs, OPENCODE_FREE_TIER_HINT, RATE_LIMIT_PROXY_HINT, isOpenCodeFreeTierRefusal } from '../src/managed-catalogs.ts'
import { OPENCODE_AUTO_MODEL } from '../src/managed-catalog-utils.ts'

/** The public directory, as the adapter's `auto` route resolves through it. */
const freeRows = [{ id: 'big-pickle', name: 'Big Pickle' }]

/** The refusal OpenCode answered with, taken from a real 403 response body. */
const freeTierBody = JSON.stringify({
  type: 'FreeTierError',
  message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
})

const request = { provider: 'opencode', model: OPENCODE_AUTO_MODEL.id, messages: [{ id: MessageId('m1'), role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

let home = ''
let created: string[] = []
let previousHome: string | undefined

beforeEach(async () => {
  // The directory read caches what it fetched under the active home; a temp home
  // keeps this spec from writing to (or being answered by) the real one.
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'fcg-opencode-egress-'))
  process.env.DSH_HOME = home
  created.push(home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * The adapter the class registers for `opencode`, as the Host's `llm` service
 * would hold it — read through the known-directory decorator's `connector`, so
 * the stream under test is the connector's own.
 */
function registeredOpenCodeAdapter(): { readonly stream: (options: typeof request) => AsyncIterable<unknown> } {
  const registered: Record<string, unknown> = {}
  const catalogs = new FreeCodeGoManagedCatalogs({
    ctx: {
      emit: () => undefined,
      on: () => undefined,
      get: (name: string) => name === 'llm'
        ? { registerAdapter: (providers: readonly string[], adapter: unknown) => { for (const provider of providers) registered[provider] = adapter } }
        : undefined,
    },
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
  catalogs.registerOpenCodeAdapter()
  return (registered.opencode as { connector: { stream: (options: typeof request) => AsyncIterable<unknown> } }).connector
}

/** Answer the model directory, then fail the completion with `failure`. */
function stubEgress(failure: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => String(url).includes('/models')
    ? new Response(JSON.stringify({ data: freeRows }), { status: 200, headers: { 'content-type': 'application/json' } })
    : failure()))
}

/** The failure one stream produces, as the caller sees it. */
async function failureOf(adapter: { readonly stream: (options: typeof request) => AsyncIterable<unknown> }): Promise<unknown> {
  const drain = async (): Promise<undefined> => {
    for await (const _chunk of adapter.stream(request)) { /* drain */ }
    return undefined
  }
  return drain().then(() => new Error('the request was expected to fail'), (error: unknown) => error)
}

describe('opencode free-tier egress refusal', () => {
  it('explains a FreeTierError 403 in both languages, naming the exit IP', async () => {
    stubEgress(() => new Response(freeTierBody, { status: 403, headers: { 'content-type': 'application/json' } }))
    const failure = await failureOf(registeredOpenCodeAdapter())

    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('RATE_LIMIT')
    // The status alone is what the user could already read; the hint is the half
    // that says what to do about it, in Chinese and in English.
    expect((failure as LlmError).message).toContain('HTTP 403')
    expect((failure as LlmError).message).toContain('更换节点 IP')
    expect((failure as LlmError).message).toContain('Switch to a different node IP')
    expect((failure as LlmError).message).toContain(OPENCODE_FREE_TIER_HINT)
  })

  it('keeps the shared rate-limit hint for a 429 and does not borrow the free-tier one', async () => {
    stubEgress(() => new Response('upstream busy', { status: 429, headers: { 'content-type': 'text/plain' } }))
    const failure = await failureOf(registeredOpenCodeAdapter())

    expect((failure as LlmError).message).toContain(RATE_LIMIT_PROXY_HINT)
    expect((failure as LlmError).message).not.toContain('free tier can only be used')
  })

  it('leaves a 403 that is not the free-tier refusal unexplained', async () => {
    // A retired row answers the same status. Handing the user an IP suggestion
    // there would name a cause that is not the cause.
    stubEgress(() => new Response(JSON.stringify({ error: { message: 'this model is no longer available' } }), { status: 403, headers: { 'content-type': 'application/json' } }))
    const failure = await failureOf(registeredOpenCodeAdapter())

    expect((failure as LlmError).code).toBe('RATE_LIMIT')
    expect((failure as LlmError).message).toContain('HTTP 403')
    expect((failure as LlmError).message).not.toContain(OPENCODE_FREE_TIER_HINT)
    expect((failure as LlmError).message).not.toContain(RATE_LIMIT_PROXY_HINT)
  })

  it('reads the marker only on a 403, from either spelling the provider uses', () => {
    expect(isOpenCodeFreeTierRefusal(403, freeTierBody)).toBe(true)
    // The type is enough on its own: the prose beside it is what a human reads
    // and the provider is free to reword it.
    expect(isOpenCodeFreeTierRefusal(403, '{"type":"FreeTierError"}')).toBe(true)
    expect(isOpenCodeFreeTierRefusal(403, '{"error":{"message":"forbidden"}}')).toBe(false)
    // The same body on another status is not this failure.
    expect(isOpenCodeFreeTierRefusal(429, freeTierBody)).toBe(false)
    expect(isOpenCodeFreeTierRefusal(200, freeTierBody)).toBe(false)
  })
})

/**
 * The refusal above is what an egress that fails the check reads. This pins the
 * check itself, so a later refactor cannot quietly walk the route back into it.
 *
 * Since 2026-09-16 the free tier admits only requests that look like OpenCode's
 * own client, and the request identity is the half the plugin owns:
 *
 * - `user-agent` must read `<product>/<version>`. The plugin's former
 *   `opencode/freecodego` — a product tag with no version — was answered with
 *   `403 FreeTierError` on every free model, while `opencode/1.18.31` passed.
 * - `x-opencode-session` must match OpenCode's `ses_` id shape: 12 hex
 *   timestamp characters followed by 14 Base62. Only the shape is checked, so
 *   the value is generated locally rather than echoed from the client.
 *
 * The third condition — the body must declare the five core agent tools
 * (`bash`, `edit`, `glob`, `grep`, `read`) — belongs to the caller that builds
 * the body, not to this identity, and is not asserted here.
 */
describe('opencode free-tier request identity', () => {
  it('sends a versioned User-Agent and an OpenCode-shaped session id', async () => {
    let sent: Record<string, string> | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: freeRows }), { status: 200, headers: { 'content-type': 'application/json' } })
      sent = init?.headers ?? {}
      // The reply is not what this pin is about; any completed stream will do.
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))

    const adapter = registeredOpenCodeAdapter()
    try {
      for await (const _chunk of adapter.stream(request)) { /* drain */ }
    } catch { /* the stub's reply is irrelevant to the headers under test */ }

    // The completion must have been attempted, or there are no headers to read.
    expect(sent).toBeDefined()
    const headers = sent ?? {}
    // A product tag with no version is exactly what the upstream refuses.
    expect(headers['user-agent']).toMatch(/^opencode\/\d/)
    expect(headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(headers['x-opencode-request']).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(headers['authorization']).toBe('Bearer public')
    expect(headers['x-opencode-project']).toBe('global')
  })

  it('appends the core agent tools a narrow caller did not declare, and leaves a tool-less caller alone', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: freeRows }), { status: 200, headers: { 'content-type': 'application/json' } })
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))

    const adapter = registeredOpenCodeAdapter()
    const failures: unknown[] = []
    const drain = async (options: Record<string, unknown>): Promise<void> => {
      try {
        // Bound on purpose: the connector's `stream` reads its own config, so a
        // detached reference fails before the request is ever built.
        for await (const _chunk of adapter.stream(options as typeof request)) { /* drain */ }
      } catch (error) {
        // A request that never reached the stub is a failure of this pin, not a
        // detail of it: record it rather than let it read as an empty body.
        failures.push(error)
      }
    }

    // The Advisor reviewer's own tool set, which is narrower than the free
    // tier's fingerprint: it offers no `bash` and no `edit`.
    await drain({
      ...request,
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
        { name: 'glob', description: 'Find files', parameters: { type: 'object' } },
        { name: 'grep', description: 'Search files', parameters: { type: 'object' } },
      ],
    })
    // A caller that deliberately sends no tools must stay that way.
    await drain({ ...request, tools: [] })

    expect(failures.map(error => String(error))).toEqual([])
    expect(bodies.length).toBe(2)
    const namesOf = (body: Record<string, unknown>): string[] =>
      (Array.isArray(body.tools) ? body.tools : [])
        .map(entry => String((entry as { readonly function?: { readonly name?: unknown } }).function?.name ?? ''))
        .sort()
    // The three the caller declared survive, and the two it did not are added —
    // otherwise the upstream answers 403 for a reason the caller never raised.
    expect(namesOf(bodies.at(0) ?? {})).toEqual(['bash', 'edit', 'glob', 'grep', 'read'])
    // Nothing is invented for a request that declared nothing: an added
    // definition would offer the model a capability its caller never granted.
    expect(namesOf(bodies.at(1) ?? {})).toEqual([])
  })
})
