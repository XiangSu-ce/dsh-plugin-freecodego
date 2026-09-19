/**
 * Every error exit that quotes upstream text must mask the credentials it
 * quotes.
 *
 * Why this file exists as its own spec
 * -----------------------------------
 * The redaction itself is covered by `secret-scan.spec.ts`, and one exit is
 * covered by `account-remotes-redaction.spec.ts`. That is exactly the shape of
 * the bug: the shared mask works, and each *caller* has to remember to call it.
 * A missed caller is invisible — the error message still reads well, it just
 * carries a live token into a UI status, an HTTP error frame, or a persisted
 * snapshot. So every exit is asserted here against a real vendor-shaped
 * credential, and each assertion also pins the readable part of the message so
 * a "fix" that blanks the error cannot pass.
 *
 * @module tests/credential-redaction-exits
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { backendBootstrap, backendQuota, backendRuntimeHealth, backendUsage } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'
import { tokenUsageGateway } from '../src/payment-remotes.ts'
import type { PaymentRemotesHost } from '../src/payment-remotes.ts'
import { ClaudeProtocolBridge } from '../src/claude-protocol-bridge.ts'
import { FreeCodeGoPluginUpdateService } from '../src/plugin-update.ts'

/**
 * The credential shapes an upstream can echo.
 *
 * Vendor-prefixed on purpose: `redactCredentialShapes` is built around
 * distinctive prefixes, and a token it was told about proves nothing about the
 * one an arbitrary provider sends back.
 */
const GITHUB_PAT = `ghp_${'B'.repeat(36)}`
const ANTHROPIC_KEY = `sk-ant-api03-${'A'.repeat(40)}`
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

describe('account backend remotes', () => {
  const exits = [
    { name: 'backendBootstrap', method: 'getBootstrap', call: (host: AccountRemotesHost) => backendBootstrap(host) },
    { name: 'backendQuota', method: 'getQuota', call: (host: AccountRemotesHost) => backendQuota(host) },
    { name: 'backendRuntimeHealth', method: 'getRuntimeHealth', call: (host: AccountRemotesHost) => backendRuntimeHealth(host) },
    { name: 'backendUsage', method: 'getUsage', call: (host: AccountRemotesHost) => backendUsage(host, 30) },
  ]

  it.each(exits)('$name masks the credential the backend echoed', async ({ method, call }) => {
    const host = {
      api: { [method]: async () => { throw new Error(`backend rejected Authorization: Bearer ${GITHUB_PAT} (HTTP 502)`) } },
      account: { withAccessToken: async (operation: (accessToken: string) => Promise<unknown>) => operation('access-token') },
      restoreAccount: async () => undefined,
    } as unknown as AccountRemotesHost

    const detail = await call(host)
    const rendered = JSON.stringify(detail)
    expect(detail).toMatchObject({ status: 'error' })
    expect(rendered).not.toContain(GITHUB_PAT)
    // The failure the user has to act on survives the mask.
    expect(rendered).toContain('HTTP 502')
  })
})

describe('gateway usage remote', () => {
  it('masks the credential the gateway echoed into the usage snapshot', async () => {
    const host = {
      api: {
        getUsageDashboardStats: async () => { throw new Error(`gateway refused Authorization: Bearer ${JWT} (HTTP 401)`) },
        getUsageDashboardModels: async () => ({}),
        getUsageDashboardTrend: async () => ({}),
        getUsageDashboardInsights: async () => ({}),
        getUsage: async () => ({}),
      },
      account: { snapshot: () => ({ status: 'authenticated' }), withAccessToken: async (operation: (accessToken: string) => Promise<unknown>) => operation('access-token') },
      restoreAccount: async () => undefined,
    } as unknown as PaymentRemotesHost

    const snapshot = await tokenUsageGateway(host, 30)
    expect(snapshot.status).toBe('error')
    expect(JSON.stringify(snapshot)).not.toContain(JWT)
    expect(snapshot.message).toContain('HTTP 401')
  })
})

describe('Claude protocol bridge error frames', () => {
  const bridges: ClaudeProtocolBridge[] = []

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map(bridge => bridge.dispose()))
  })

  const post = async (url: string, apiKey: string, body: Record<string, unknown>): Promise<{ readonly status: number; readonly body: string }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.text() }
  }

  it('masks the bridge secret when handling fails before the stream starts', async () => {
    let apiKey = ''
    const bridge = new ClaudeProtocolBridge({
      // A synchronous throw is the path the top-level handler catches: the
      // stream never becomes an iterable, so nothing downstream can mask it.
      stream() { throw new Error(`provider refused x-api-key: ${apiKey}`) },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    apiKey = endpoint.apiKey

    const answer = await post(`${endpoint.baseURL}/v1/messages`, endpoint.apiKey, {
      model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }],
    })
    expect(answer.status).toBe(500)
    expect(answer.body).not.toContain(endpoint.apiKey)
    expect(answer.body).toContain('provider refused')
  })

  it('masks an upstream failure reported for a non-streaming request', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `upstream 401 for Bearer ${ANTHROPIC_KEY}`, code: 'PROVIDER_ERROR' } } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')

    const answer = await post(`${endpoint.baseURL}/v1/messages`, endpoint.apiKey, {
      model: 'agnes-3.0-flash', max_tokens: 32, stream: false, messages: [{ role: 'user', content: 'hi' }],
    })
    expect(answer.status).toBe(502)
    expect(answer.body).not.toContain(ANTHROPIC_KEY)
    expect(answer.body).toContain('upstream 401')
  })

  it('masks an upstream failure frame on the streaming Anthropic route', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `upstream 401 for Bearer ${ANTHROPIC_KEY}`, code: 'PROVIDER_ERROR' } } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')

    const answer = await post(`${endpoint.baseURL}/v1/messages`, endpoint.apiKey, {
      model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }],
    })
    expect(answer.body).toContain('"type":"error"')
    expect(answer.body).not.toContain(ANTHROPIC_KEY)
    expect(answer.body).toContain('upstream 401')
  })

  it('masks an error thrown mid-stream on the streaming Anthropic route', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'half' }
        throw new Error(`provider refused authorization: ${GITHUB_PAT}`)
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')

    const answer = await post(`${endpoint.baseURL}/v1/messages`, endpoint.apiKey, {
      model: 'agnes-3.0-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }],
    })
    expect(answer.body).toContain('"type":"error"')
    expect(answer.body).not.toContain(GITHUB_PAT)
    expect(answer.body).toContain('provider refused authorization')
  })

  it('masks an upstream failure frame on the streaming OpenAI route', async () => {
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'half' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `upstream 401 for Bearer ${ANTHROPIC_KEY}`, code: 'PROVIDER_ERROR' } } }
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.openAIEndpoint('agnes', 'agnes-3.0-flash')

    const answer = await post(`${endpoint.baseURL}/responses`, endpoint.apiKey, {
      model: 'agnes-3.0-flash', stream: true, input: [{ role: 'user', content: 'hi' }],
    })
    expect(answer.body).toContain('"type":"response.failed"')
    expect(answer.body).not.toContain(ANTHROPIC_KEY)
    expect(answer.body).toContain('upstream 401')
  })
})

describe('plugin update status', () => {
  afterEach(() => vi.restoreAllMocks())

  it('masks the credential a failing release source echoed into the update status', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`proxy refused https://user:${GITHUB_PAT}@api.github.com/repos/example/repo/releases`),
    )
    const settings = { get: () => ({ pluginUpdateChecksEnabled: true }), update: async () => undefined }
    const service = new FreeCodeGoPluginUpdateService({ settings: settings as never, packageName: 'freecodego-test' })

    const status = await service.check(true)
    expect(status).toMatchObject({ phase: 'error' })
    expect(status.error).not.toContain(GITHUB_PAT)
    expect(status.error).toContain('proxy refused')
  })
})
