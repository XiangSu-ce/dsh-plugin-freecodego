/**
 * The Claude bridge's own credential: what the `sk-ant-api03-` shape is for, how
 * the secret is compared, and where it must never surface.
 *
 * Why this file exists as its own spec
 * -----------------------------------
 * `credential-redaction-exits.spec.ts` already pins the exits that quote a
 * *provider's* text. This one is about the bridge's *own* secret, which is a
 * different object with a different failure mode: it is minted per bridge, handed
 * to the Claude Agent SDK and to Codex as their API key, and then compared
 * against what comes back on `x-api-key` / `Authorization`. Two things can go
 * wrong there and neither is visible in a passing turn — the comparison can be
 * recoverable from response timing, and the secret can be echoed by an exit
 * nobody asserted on.
 *
 * The shape itself is not decoration. The prefix is pinned here because the
 * reason it is needed is not the reason the source comment used to give, and a
 * later reader who drops it as "hardcoded credential noise" changes which
 * first-party branches Claude Code takes.
 *
 * @module tests/claude-bridge-secret
 */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeProtocolBridge } from '../src/claude-protocol-bridge.ts'

const bridges: ClaudeProtocolBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.dispose()))
})

/** A runtime that answers one empty turn; the cases below assert on auth, not on output. */
const emptyTurn = (): ConstructorParameters<typeof ClaudeProtocolBridge>[0] => ({
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

const post = async (url: string, headers: Record<string, string>, body: unknown): Promise<{ readonly status: number; readonly body: string }> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

const COUNT_TOKENS_BODY = { messages: [{ role: 'user', content: 'estimate this request' }] }

describe('the bridge secret', () => {
  it('mints one secret per bridge instance and reuses it across that instance\'s routes', async () => {
    const first = new ClaudeProtocolBridge(emptyTurn())
    const second = new ClaudeProtocolBridge(emptyTurn())
    bridges.push(first, second)

    const firstRoute = await first.endpoint('agnes', 'agnes-3.0-flash')
    const secondRoute = await second.endpoint('agnes', 'agnes-3.0-flash')
    // 32 random bytes in base64url, no padding: a fixed 43 characters, which is
    // also the length the comparison must not reveal.
    expect(firstRoute.apiKey).toMatch(/^sk-ant-api03-[A-Za-z0-9_-]{43}$/u)
    expect(secondRoute.apiKey).toMatch(/^sk-ant-api03-[A-Za-z0-9_-]{43}$/u)
    expect(firstRoute.apiKey).not.toBe(secondRoute.apiKey)

    // The same instance authenticates every route it opens, including the
    // OpenAI-shaped one, because the client is given one credential per bridge.
    const sameBridgeOpenAiRoute = await first.openAIEndpoint('agnes', 'agnes-3.0-flash')
    expect(sameBridgeOpenAiRoute.apiKey).toBe(firstRoute.apiKey)
    expect(sameBridgeOpenAiRoute.baseURL).not.toBe(firstRoute.baseURL)
  })

  it('accepts the exact secret on either header and rejects every near miss', async () => {
    const bridge = new ClaudeProtocolBridge(emptyTurn())
    bridges.push(bridge)
    const endpoint = await bridge.endpoint('agnes', 'agnes-3.0-flash')
    const url = `${endpoint.baseURL}/v1/messages/count_tokens`
    const secret = endpoint.apiKey
    const wrongTail = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A')

    // Both header spellings the two clients use: `x-api-key` from Claude Code,
    // `Bearer` from Codex.
    expect((await post(url, { 'x-api-key': secret }, COUNT_TOKENS_BODY)).status).toBe(200)
    expect((await post(url, { authorization: `Bearer ${secret}` }, COUNT_TOKENS_BODY)).status).toBe(200)

    // Each candidate is a different way a weaker comparison would let a guess
    // through: a same-shaped stranger, a guess the secret is a prefix of, the
    // secret's own prefix, and a single wrong trailing character.
    const nearMisses: ReadonlyArray<readonly [string, string]> = [
      ['a same-shaped stranger', `sk-ant-api03-${'A'.repeat(43)}`],
      ['a guess the secret prefixes', `${secret}A`],
      ['the secret with its last character dropped', secret.slice(0, -1)],
      ['one wrong trailing character', wrongTail],
    ]
    for (const [label, candidate] of nearMisses) {
      const answer = await post(url, { 'x-api-key': candidate }, COUNT_TOKENS_BODY)
      expect(answer.status, label).toBe(404)
      expect(answer.body, label).not.toContain(secret)
    }
    expect((await post(url, {}, COUNT_TOKENS_BODY)).status).toBe(404)
  })

  it('masks its own secret when a Responses turn throws mid-stream', async () => {
    // The `catch` in `streamResponsesResponse` is a separate exit from the
    // finish-error frame the other spec covers, and it is the one a provider
    // that echoes the request headers reaches.
    let apiKey = ''
    const bridge = new ClaudeProtocolBridge({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'half' }
        throw new Error(`provider refused x-api-key: ${apiKey}`)
      },
    })
    bridges.push(bridge)
    const endpoint = await bridge.openAIEndpoint('agnes', 'agnes-3.0-flash')
    apiKey = endpoint.apiKey

    const answer = await post(
      `${endpoint.baseURL}/responses`,
      { authorization: `Bearer ${endpoint.apiKey}` },
      { model: 'agnes-3.0-flash', stream: true, input: [{ role: 'user', content: 'hi' }] },
    )
    expect(answer.body).toContain('"type":"response.failed"')
    // The readable half of the failure survives the mask.
    expect(answer.body).toContain('provider refused x-api-key')
    expect(answer.body).not.toContain(endpoint.apiKey)
  })

  it('compares the secret without a short-circuiting equality', () => {
    // A behavioural case cannot see this one: `===` and `timingSafeEqual` accept
    // and reject exactly the same inputs, and only the *time* differs. So the
    // comparison is asserted at the source, the way this repository's other
    // source-shape guards are.
    const source = readFileSync(new URL('../src/claude-protocol-bridge.ts', import.meta.url), 'utf8')
    const comparison = /function secretMatches\([^)]*\): boolean \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? ''

    expect(comparison).not.toBe('')
    expect(comparison).toContain('timingSafeEqual')
    // Reverting the body to `presented === secret` passes every case above.
    expect(comparison).not.toMatch(/presented\s*[!=]==?\s*secret/u)

    // Both credential headers have to reach it, or one of them is still compared
    // by the short-circuiting operator.
    expect(source).toContain("secretMatches(req.headers['x-api-key'], this.secret)")
    expect(source).toContain('secretMatches(bearer, this.secret)')
    expect(source).not.toMatch(/req\.headers\['x-api-key'\]\s*[!=]==?\s*this\.secret/u)
  })
})
