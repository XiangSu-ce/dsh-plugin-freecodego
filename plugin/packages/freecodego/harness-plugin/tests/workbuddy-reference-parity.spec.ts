import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkBuddyIntlAdapter, WorkBuddyIntlClient } from '../src/workbuddy-intl.ts'

/**
 * Header-for-header parity with the reference WorkBuddy adapter.
 *
 * Why this exists
 * ---------------
 * `dsh-our-free-model`'s `vendor/channel-pack/src/buddy-adapter.ts` is the
 * implementation this host's chat route is known to be answered by, and the
 * differences between the two were invisible until a turn stopped being served:
 * the same request shape written twice in two codebases, each correct alone.
 * This spec states the reference's chat identity once — transcribed, with the
 * lines it came from — and then measures what this plugin actually sends against
 * it, so a divergence is a failing test rather than a silent one.
 *
 * The transcription is pinned to the reference revision it was read from
 * ({@link REFERENCE_SOURCES}); when that checkout is present, a hash mismatch
 * fails the spec and says to re-read the source instead of quietly comparing
 * against a file that has since changed.
 */

/** Where the reference implementation lives, and the bytes this spec was read from. */
const REFERENCE_SOURCES = [
  {
    path: 'C:/Users/Administrator/Downloads/dsh-our-free-model-main/vendor/channel-pack/src/buddy-adapter.ts',
    sha256: 'de6c54a96e86d13df274395867c055e5d96f5ccb3f522bfe494df23a98056da7',
    what: 'chat request headers (send()) and the DeepSeek reasoning switch',
  },
  {
    path: 'C:/Users/Administrator/Downloads/dsh-our-free-model-main/vendor/channel-pack/src/product.ts',
    sha256: '6ec3e33d1b378111b92fe65ed0edc04945bd136040ae1fcc411e1b9b86fa6d96',
    what: 'the WorkBuddy product identity and its per-model-family User-Agents',
  },
] as const

/**
 * The chat header set the reference sends, field for field.
 *
 * Transcribed from `buddy-adapter.ts` `send()` (`:1761`–`:1795`), which sets:
 * `Authorization`, `Accept: text/event-stream`, `Content-Type: application/json`,
 * `X-Domain` from the product's own host, `X-Product-Code` from the product,
 * `X-Agent-Purpose: conversation`, `X-IDE-Name`/`X-IDE-Type`/`X-IDE-Version` from
 * the product identity, `X-Product: <attribution name>`, a User-Agent resolved by
 * model family, and — for WorkBuddy only — the three `X-Conversation-*` ids.
 * The attribution headers it starts from (`attributionHeaders()`) belong to the
 * caller's runtime, so they are not part of the comparison: this plugin's own
 * runtime supplies its own.
 */
const REFERENCE_CHAT_HEADERS: Readonly<Record<string, string>> = {
  authorization: 'Bearer token-a',
  accept: 'text/event-stream',
  'content-type': 'application/json',
  'x-domain': 'www.workbuddy.ai',
  'x-product-code': 'workbuddy',
  'x-agent-purpose': 'conversation',
  'x-ide-name': 'WorkBuddy',
  'x-ide-type': 'WorkBuddy',
  'x-ide-version': '5.5.2',
  'x-product': 'WorkBuddy',
  'user-agent': 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
}

/** The reference's per-model-family User-Agents (`product.ts:70`–`:71`, `:389`–`:399`). */
const REFERENCE_USER_AGENTS: Readonly<Record<string, string>> = {
  'gpt-5.6-sol': 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
  'claude-sonnet-5': 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
  'auto': 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
  'glm-5.2': 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
  'hy3': 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
  'kimi-k2.6': 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
  'minimax-m2.5': 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
}

/** The ids the reference generates per turn (`buddy-adapter.ts:1793`–`:1795`). */
const REFERENCE_TURN_HEADERS = ['x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id'] as const

/**
 * The headers this plugin sends beyond the reference's set, on purpose.
 *
 * Each one is either this client's own runtime attribution or the browser-shaped
 * half of an identity the reference's CLI-shaped client does not carry. They are
 * listed rather than ignored so that *adding* one is a visible change: an
 * unlisted extra fails the comparison below, which is the same protection the
 * required set gets in the other direction.
 */
const PLUGIN_ONLY_CHAT_HEADERS = [
  // The browser-shaped half of an identity the reference's CLI-shaped client does
  // not carry, and the account identity this plugin declares on every surface.
  'origin', 'referer', 'x-requested-with',
  'x-user-id', 'x-no-user-id', 'x-enterprise-id', 'x-tenant-id', 'x-no-enterprise-id',
] as const

/** One account that serves without a refresh. */
function account(): Record<string, unknown> {
  return {
    id: 'a',
    accessToken: 'token-a',
    refreshToken: 'refresh-a',
    expiresAt: Date.now() + 3_600_000,
    uid: 'uid-a',
  }
}

function store(accounts: readonly Record<string, unknown>[]): CredentialProvider {
  const value = JSON.stringify({ accounts })
  return {
    resolve: vi.fn(async ref => ref === 'WORKBUDDY_INTL_STORE' ? { value, source: 'test' } : undefined),
    describe: vi.fn(async () => ({ configured: accounts.length > 0, writable: true })),
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
  } as unknown as CredentialProvider
}

/** Run one real turn through this plugin and hand back what it posted. */
async function postedTurn(model: string): Promise<{ readonly headers: Record<string, string>; readonly body: Record<string, unknown> }> {
  let sent: { readonly headers: Record<string, string>; readonly body: Record<string, unknown> } | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/v2/chat/completions')) {
      sent = {
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      }
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account()])))
  for await (const _chunk of adapter.stream({
    provider: 'workbuddy',
    model,
    messages: [{ id: MessageId('m1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: ReasoningEffortId('high'),
    sessionId: SessionId('sess-parity'),
  })) { /* drained */ }
  if (sent === undefined) throw new Error('the adapter posted no chat request')
  return sent
}

/**
 * A field-by-field report of two header maps.
 *
 * The reference's own format, rendered for a reader: `=` agrees, `+` is this
 * plugin's own header, `!` is a divergence — the line a failure is read from.
 * @param actual - what this plugin sent.
 * @param expected - what the reference sends.
 * @param generated - names both sides generate per turn, compared by presence.
 * @returns one line per field, sorted by name.
 */
function headerReport(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  generated: readonly string[] = [],
): string {
  const names = [...new Set([...Object.keys(actual), ...Object.keys(expected), ...generated])].sort()
  return names.map((name) => {
    const mine = actual[name]
    const theirs = expected[name]
    if (generated.includes(name)) return `  = ${name}: ${String(mine ?? '(absent)')} (generated per turn)`
    if (mine === theirs) return `  = ${name}: ${String(mine)}`
    if (theirs === undefined) return `  + ${name}: ${String(mine)} (this plugin only)`
    return `  ! ${name}: expected ${String(theirs)}, sent ${String(mine ?? '(absent)')}`
  }).join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkBuddy reference parity', () => {
  it('sends every field the reference chat request sends, with the same value', async () => {
    const turn = await postedTurn('gpt-5.6-sol')
    const report = headerReport(turn.headers, REFERENCE_CHAT_HEADERS, REFERENCE_TURN_HEADERS)
    // `WORKBUDDY_PARITY_REPORT=1` prints the whole side-by-side, for a reader who
    // wants the picture rather than a verdict.
    if (process.env.WORKBUDDY_PARITY_REPORT === '1') console.log(`\nWorkBuddy chat identity, this plugin vs the reference:\n${report}`)
    // The report is the failure message: a diff a reader can act on, not "false".
    for (const [name, value] of Object.entries(REFERENCE_CHAT_HEADERS)) {
      expect(turn.headers[name], `${name}\n${report}`).toBe(value)
    }
    // The three per-turn ids carry values the reference generates, so only their
    // presence is comparable — but all three have to be there, or the turn is not
    // the client's.
    for (const name of REFERENCE_TURN_HEADERS) {
      expect(turn.headers[name], `${name}\n${report}`).toBeTruthy()
    }
  })

  it('resolves the same User-Agent the reference resolves, per model family', async () => {
    for (const [model, userAgent] of Object.entries(REFERENCE_USER_AGENTS)) {
      const turn = await postedTurn(model)
      expect(turn.headers['user-agent'], model).toBe(userAgent)
    }
  })

  it('lists exactly the headers it sends beyond the reference, and no others', async () => {
    const turn = await postedTurn('auto')
    const recorded = [...Object.keys(REFERENCE_CHAT_HEADERS), ...REFERENCE_TURN_HEADERS, ...PLUGIN_ONLY_CHAT_HEADERS]
    const extra = Object.keys(turn.headers).filter(name => !recorded.includes(name))
    // Anything here is a header neither the reference nor the recorded extra list
    // names: a new one has to be recorded (and explained) where it is added.
    expect(extra, `unrecorded extra headers:\n${headerReport(turn.headers, REFERENCE_CHAT_HEADERS, REFERENCE_TURN_HEADERS)}`).toEqual([])
  })

  it('carries the reference body fields, including the prefix-cache key and the reasoning switch', async () => {
    const turn = await postedTurn('deepseek-v4.1-flash')
    // `buddy-adapter.ts` builds: model, messages, stream, prompt_cache_key,
    // tools/temperature/stop/max_tokens when given, and for DeepSeek routes
    // `thinking` plus `reasoning_effort`.
    expect(turn.body).toMatchObject({
      model: 'deepseek-v4.1-flash',
      stream: true,
      prompt_cache_key: 'sess-parity',
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    expect(Array.isArray(turn.body.messages)).toBe(true)
    // Ours states one thing the reference does not: the usage envelope, which is
    // how a completed turn reaches the token ledger with numbers at all.
    expect(turn.body['stream_options']).toEqual({ include_usage: true })
  })

  it.skipIf(!REFERENCE_SOURCES.every(source => existsSync(source.path)))('compares against the reference revision this spec was read from', () => {
    // A transcription compared against a file that has since changed is worse than
    // no comparison, so the recorded digests are checked whenever the checkout is
    // present (it is not part of this repository, hence the skip above).
    for (const source of REFERENCE_SOURCES) {
      if (!existsSync(source.path)) continue
      const digest = createHash('sha256').update(readFileSync(source.path)).digest('hex')
      expect(digest, `${source.path} changed — re-read it (${source.what}) and update this spec`).toBe(source.sha256)
    }
  })
})
