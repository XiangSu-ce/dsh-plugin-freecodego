import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  WorkBuddyIntlAdapter,
  WorkBuddyIntlClient,
  freeRoutesOf,
  isFreeRoute,
  readWorkBuddyIntlAccounts,
  parseWorkBuddyAuthState,
  parseWorkBuddyCatalog,
  parseWorkBuddyLoginAccount,
  parseWorkBuddyLoginPoll,
  workBuddyReasoningOptions,
  prepareWorkBuddyChatBody,
  type WorkBuddyIntlRoute,
} from '../src/workbuddy-intl.ts'

const HOUR = 3_600_000
const IN_WINDOW = Date.parse('2026-09-13T00:00:00Z')
const AFTER_WINDOW = Date.parse('2026-10-01T00:00:00Z')

/** One account that can serve without a token refresh. */
function account(id: string): Record<string, unknown> {
  return {
    id,
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + HOUR,
    uid: `uid-${id}`,
    domain: 'workbuddy.ai',
  }
}

function store(accounts: readonly Record<string, unknown>[], activeAccountId?: string): CredentialProvider {
  const value = JSON.stringify({ accounts, ...(activeAccountId === undefined ? {} : { activeAccountId }) })
  return {
    resolve: vi.fn(async ref => ref === 'WORKBUDDY_INTL_STORE' ? { value, source: 'test' } : undefined),
    describe: vi.fn(async () => ({ configured: accounts.length > 0, writable: true })),
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
  } as unknown as CredentialProvider
}

/** The product document the App-facing `/v3/config` read returns. */
const DOCUMENT = {
  code: 0,
  data: {
    agents: [{ name: 'cli', models: ['auto', 'deepseek-v4.1-flash'] }],
    models: [
      { id: 'auto', name: 'Auto', credits: 'x0.00', maxInputTokens: 200_000, maxOutputTokens: 32_000, supportsImages: false },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x1.00', maxInputTokens: 128_000, maxOutputTokens: 16_000, supportsImages: true },
      { id: 'not-for-cli', name: 'App only', credits: 'x0.00', maxInputTokens: 8_000, maxOutputTokens: 1_000 },
      { id: 'disabled', name: 'Retired', credits: 'x0.00', maxInputTokens: 8_000, maxOutputTokens: 1_000, disabled: true },
    ],
    modelPromotions: [
      {
        enabled: true,
        modelIds: ['deepseek-v4.1-flash'],
        priority: 1,
        discount: { displayMode: 'replace', factor: 0 },
        // The active-promotion case. Keep the window wide: an absolute end date
        // turns this shared fixture into the expired case on its own calendar
        // day, and the genuinely expired window is covered separately below.
        schedule: { validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-12-31T00:00:00Z' },
        badge: { label: 'Free now' },
      },
    ],
  },
}

const userMessage = (text: string) => ({
  id: MessageId('m1'),
  role: 'user' as const,
  source: { kind: 'user' as const },
  content: [{ type: 'text' as const, text }],
})

afterEach(() => vi.restoreAllMocks())

/** The requested URL of a recorded fetch call, whatever shape it was passed in. */
const requestedUrl = (input: Parameters<typeof fetch>[0]): string => typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

describe('WorkBuddy catalog parsing', () => {
  it('keeps only the cli allowlist and attaches the promotions covering a route', () => {
    const routes = parseWorkBuddyCatalog(DOCUMENT)
    expect(routes.map(route => route.id)).toEqual(['auto', 'deepseek-v4.1-flash'])
    const free = routes[0]!
    expect(free).toMatchObject({ displayName: 'Auto', rateMultiplier: 0, billing: { free: true } })
    const promoted = routes[1]!
    // The document's own rate, not the discount: the promotion is applied on
    // read so an expiring window leaves the list by itself.
    expect(promoted.rateMultiplier).toBe(1)
    expect(promoted.promotions).toHaveLength(1)
    expect(promoted.promotions?.[0]).toMatchObject({ factor: 0, label: 'Free now' })
  })

  it('reads a document without an envelope or an allowlist', () => {
    const routes = parseWorkBuddyCatalog({ models: [{ id: 'solo', name: 'Solo', credits: 'x0.50' }] })
    expect(routes.map(route => route.id)).toEqual(['solo'])
    expect(routes[0]).toMatchObject({ rateMultiplier: 0.5, billing: { free: false } })
  })

  it('carries each route\'s own reasoning declaration', () => {
    const [glm, hy3, plain] = parseWorkBuddyCatalog({
      models: [
        { id: 'glm-5.3', credits: 'x0.79', supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] } },
        { id: 'hy3', credits: 'x0.00', supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['low', 'high'] } },
        { id: 'auto', credits: 'x0.00' },
      ],
    })
    expect(glm?.reasoning).toEqual({ supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true })
    // A tier the product never names is dropped rather than passed upstream.
    expect(hy3?.reasoning).toMatchObject({ supportedEfforts: ['low', 'high'], canDisableThinking: false })
    // A route that declares nothing has no reasoning control to show.
    expect(plain?.reasoning).toBeUndefined()
  })

  it('reads the older single-effort spelling', () => {
    // The live free route states only `effort: "high"`.
    const [flash] = parseWorkBuddyCatalog({
      models: [{ id: 'deepseek-v4.1-flash', credits: 'x0.00', supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' } }],
    })
    expect(flash?.reasoning).toMatchObject({ defaultEffort: 'high', canDisableThinking: true })
    expect(flash?.reasoning?.supportedEfforts).toBeUndefined()
  })
})

describe('WorkBuddy reasoning options', () => {
  const options = (row: Record<string, unknown>) => workBuddyReasoningOptions(parseWorkBuddyCatalog({ models: [row] })[0])

  it('offers exactly the declared tiers, plus off only when thinking can be disabled', () => {
    expect(options({ id: 'glm-5.3', supportsReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] } }))
      .toEqual({ efforts: ['low', 'high', 'max'], canDisable: true, defaultEffort: 'high' })
    // hy3/hy4 cannot stop thinking: offering "Off" was the bug that made the
    // level look inert, because the upstream ignores it and reasons anyway.
    expect(options({ id: 'hy3', supportsReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['high'] } }))
      .toEqual({ efforts: ['high'], canDisable: false, defaultEffort: 'high' })
  })

  it('falls back to the measured ladder when no list is declared, defaulting to the product tier', () => {
    const flash = options({ id: 'deepseek-v4.1-flash', supportsReasoning: true, reasoning: { effort: 'high' } })
    expect(flash?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(flash?.defaultEffort).toBe('high')
  })

  it('reports no control for a route that declares none', () => {
    expect(options({ id: 'auto', credits: 'x0.00' })).toBeUndefined()
  })
})

describe('WorkBuddy free routes', () => {
  const routes = parseWorkBuddyCatalog(DOCUMENT) as readonly WorkBuddyIntlRoute[]

  it('counts an in-window promotion as free and drops it once the window passes', () => {
    expect(freeRoutesOf(routes, IN_WINDOW).map(route => route.id)).toEqual(['auto', 'deepseek-v4.1-flash'])
    expect(freeRoutesOf(routes, IN_WINDOW).every(route => route.billing?.free === true)).toBe(true)
    // `deepseek-v4.1-flash` was only ever free through the promotion; its baked x1.00
    // rate is what applies once the window closes. The shared document keeps
    // its window open on purpose, so the closing window is spelled out here
    // against the fixed comparison dates rather than the wall clock.
    const closing = parseWorkBuddyCatalog({
      ...DOCUMENT,
      data: {
        ...DOCUMENT.data,
        modelPromotions: [{
          enabled: true,
          modelIds: ['deepseek-v4.1-flash'],
          priority: 1,
          discount: { displayMode: 'replace', factor: 0 },
          schedule: { validFrom: '2026-09-01T00:00:00Z', validUntil: '2026-09-15T00:00:00Z' },
          badge: { label: 'Free now' },
        }],
      },
    }) as readonly WorkBuddyIntlRoute[]
    expect(freeRoutesOf(closing, IN_WINDOW).map(route => route.id)).toEqual(['auto', 'deepseek-v4.1-flash'])
    expect(freeRoutesOf(closing, AFTER_WINDOW).map(route => route.id)).toEqual(['auto'])
    expect(isFreeRoute(closing[1]!, AFTER_WINDOW)).toBe(false)
  })

  it('does not trust a baked free rate on a route whose promotion has expired', () => {
    const stale = parseWorkBuddyCatalog({
      models: [{ id: 'promo', credits: 'x0.00' }],
      modelPromotions: [{
        enabled: true,
        modelIds: ['promo'],
        discount: { displayMode: 'replace', factor: 0 },
        schedule: { validFrom: '2026-08-01T00:00:00Z', validUntil: '2026-08-02T00:00:00Z' },
      }],
    })
    expect(freeRoutesOf(stale, IN_WINDOW).map(route => route.id)).toEqual(['auto'])
  })

  it('falls back to the documented route when nothing is free', () => {
    const paid = parseWorkBuddyCatalog({ models: [{ id: 'paid', credits: 'x1.00' }] })
    expect(freeRoutesOf(paid, IN_WINDOW).map(route => route.id)).toEqual(['auto'])
  })
})

describe('WorkBuddy chat body', () => {
  it('prepends a system message and forces streaming', () => {
    expect(prepareWorkBuddyChatBody({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })).toEqual({
      model: 'auto',
      stream: true,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })
  })

  it('rewrites a developer role instead of adding a second system message', () => {
    const prepared = prepareWorkBuddyChatBody({ messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }] })
    expect(prepared.messages).toEqual([{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }])
  })
})

describe('WorkBuddy browser authorization', () => {
  it('reports pending while the user is still signing in', () => {
    expect(parseWorkBuddyLoginPoll({ code: 11_217, msg: '11217:login ing...' })).toEqual({ kind: 'pending' })
    expect(parseWorkBuddyLoginPoll({})).toEqual({ kind: 'pending' })
  })

  it('hands back the issued pair with the identity the host routes on', () => {
    const result = parseWorkBuddyLoginPoll({
      code: 0,
      msg: 'OK',
      data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3_600, uid: 'u-1', domain: 'workbuddy.ai', nickname: 'me@test.dev' },
    })
    expect(result).toMatchObject({
      kind: 'granted',
      ticket: { accessToken: 'at-1', refreshToken: 'rt-1', uid: 'u-1', domain: 'workbuddy.ai', nickname: 'me@test.dev' },
    })
    if (result.kind !== 'granted') throw new Error('expected a granted ticket')
    expect(result.ticket.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
  })

  it('reads the nested auth/account shape and a seconds expiry', () => {
    const result = parseWorkBuddyLoginPoll({
      code: 0,
      data: { auth: { accessToken: 'at-2', expiresAt: 1_800_000_000 }, account: { uid: 'u-2', enterpriseId: 'e-2' } },
    })
    expect(result).toMatchObject({ kind: 'granted', ticket: { accessToken: 'at-2', uid: 'u-2', enterpriseId: 'e-2', expiresAt: 1_800_000_000_000 } })
  })

  it('surfaces an upstream refusal instead of waiting for it', () => {
    expect(parseWorkBuddyLoginPoll({ code: 40_003, msg: 'authorization denied' })).toEqual({ kind: 'failed', message: 'authorization denied' })
  })

  it('reads the server-issued device grant', () => {
    expect(parseWorkBuddyAuthState({
      code: 0,
      msg: 'OK',
      data: { state: '54e29ffe', authUrl: 'https://www.workbuddy.ai/login?platform=CLI&state=54e29ffe' },
    })).toEqual({ state: '54e29ffe', authUrl: 'https://www.workbuddy.ai/login?platform=CLI&state=54e29ffe' })
  })

  it('refuses a grant missing either half, so no unbound page is opened', () => {
    expect(parseWorkBuddyAuthState({ code: 0, data: { state: 'x' } })).toBeUndefined()
    expect(parseWorkBuddyAuthState({ code: 0, data: { authUrl: 'https://www.workbuddy.ai/login' } })).toBeUndefined()
    expect(parseWorkBuddyAuthState({ code: 11_217, msg: '11217:login ing...' })).toBeUndefined()
    expect(parseWorkBuddyAuthState(undefined)).toBeUndefined()
  })

  it('refuses a grant whose page is not http(s), so no unopenable link is offered', () => {
    // The URL is opened by the Host *and* rendered as a link in Settings. The
    // Host's opener already refuses anything but http(s); a ticket that still
    // carried one would hand the Settings origin to the scheme instead.
    for (const authUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>1</script>', 'workbuddy://callback']) {
      expect(parseWorkBuddyAuthState({ code: 0, data: { state: '54e29ffe', authUrl } })).toBeUndefined()
    }
    // An http(s) URL keeps its exact bytes: the `state` in the query is what the
    // browser sign-in binds the issued tokens to, so it must not be rewritten.
    const authUrl = 'http://localhost:8787/login?platform=CLI&state=54e29ffe'
    expect(parseWorkBuddyAuthState({ code: 0, data: { state: '54e29ffe', authUrl } })).toEqual({ state: '54e29ffe', authUrl })
  })

  it('reads the identity lookup used to complete a uid-less grant', () => {
    expect(parseWorkBuddyLoginAccount({ code: 0, data: { uid: 'u-1', nickname: 'me', enterpriseId: 'e-1' } }))
      .toEqual({ uid: 'u-1', nickname: 'me', enterpriseId: 'e-1' })
    expect(parseWorkBuddyLoginAccount({ code: 0, data: { account: { uid: 'u-2' } } })).toEqual({ uid: 'u-2' })
    expect(parseWorkBuddyLoginAccount({})).toEqual({})
  })
})

describe('WorkBuddyIntlClient', () => {
  it('carries the uid as X-User-Id and the login domain as X-Domain', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a')]))
    await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-user-id')).toBe('uid-a')
    expect(headers.get('x-domain')).toBe('workbuddy.ai')
    expect(headers.get('x-no-enterprise-id')).toBe('1')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://www.workbuddy.ai/v2/chat/completions')
  })

  it('exchanges a rotating refresh token once for two concurrent requests', async () => {
    // The pool is shared by chat, the credit sweep, and the catalog read, so two
    // requests can find the same near-expired token at the same moment. A
    // single-use upstream refuses the second exchange, and the refusal looks
    // exactly like a dead account: the chat path parked a healthy one and the
    // turn failed while the rotated token sat in memory.
    const expired = { ...account('a'), expiresAt: Date.now() - HOUR }
    let exchanges = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: Parameters<typeof fetch>) => {
      if (requestedUrl(args[0]).endsWith('/v2/plugin/auth/token/refresh')) {
        exchanges += 1
        return exchanges === 1
          ? new Response(JSON.stringify({ code: 0, data: { accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresIn: 3_600 } }), { status: 200 })
          : new Response(JSON.stringify({ code: 1, msg: 'refresh token already used' }), { status: 401 })
      }
      return new Response('{}', { status: 200 })
    })
    const client = new WorkBuddyIntlClient(store([expired]))
    const responses = await Promise.all([
      client.chat({ model: 'auto', messages: [{ role: 'user', content: 'one' }] }),
      client.chat({ model: 'auto', messages: [{ role: 'user', content: 'two' }] }),
    ])
    expect(exchanges).toBe(1)
    expect(responses.map(response => response.ok)).toEqual([true, true])
    // Both requests carry the token the single exchange produced.
    const sent = fetchMock.mock.calls.filter(call => requestedUrl(call[0]).endsWith('/v2/chat/completions'))
      .map(call => new Headers(call[1]?.headers).get('authorization'))
    expect(sent).toEqual(['Bearer rotated', 'Bearer rotated'])
  })

  it('masks a credential the upstream echoes back in its refusal', async () => {
    // The chat request carries `authorization: Bearer <access token>`, and the
    // parked-account reason becomes the turn's error, so an upstream that answers
    // with what it rejected would put a live key into the message the user reads.
    // The provider's own rules name the two tokens it deals in; a message echoing
    // any other provider's key is only caught by the shared masking.
    const leaked = `sk-ant-api03-${'z'.repeat(40)}`
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 40_003, msg: `invalid key ${leaked}` }), { status: 402 }),
    )
    const client = new WorkBuddyIntlClient(store([account('a')]))
    // Narrowed at the boundary rather than cast: the two call sites below both
    // need the *message*, and a cast here is what turned one of them into an
    // unsafe member access.
    const failure = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
      .then(() => new Error('the pool was expected to refuse'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('WorkBuddy upstream request failed (HTTP 402)')
    expect(failure.message).toContain('invalid key')
    expect(failure.message).not.toContain(leaked)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('frames a nested refusal once instead of repeating the same sentence', async () => {
    // A 401 forces a refresh, and the refresh's own failure was reported by its
    // full message — which already begins with the same frame. The result named
    // the status twice and pushed the upstream text to the end of the line.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 40_003, msg: 'refresh rejected' }), { status: 401 }),
    )
    const client = new WorkBuddyIntlClient(store([account('a')]))
    const failure = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
      .then(() => new Error('the pool was expected to refuse'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message.match(/WorkBuddy upstream request failed/g)).toHaveLength(1)
    expect(failure.message).toContain('(HTTP 401)')
  })

  it('rotates to the next account when one is out of credits', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40_001, msg: 'insufficient credits' }), { status: 402 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a'), account('b')]))
    const response = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer token-b')
  })

  it('starts the turn on the account the card selected', async () => {
    // The selection is the one thing the card writes that says which account a
    // request should ride; the pool rotated from its own cursor instead, so the
    // control changed nothing about where a turn went.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a'), account('b')], 'b'))
    const response = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.ok).toBe(true)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer token-b')
  })

  it('still walks the rest of the pool when the selected account cannot serve', async () => {
    // A selection is a preference, not a single point of failure: a spent account
    // is what the fallback rotation exists for.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40_001, msg: 'insufficient credits' }), { status: 402 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a'), account('b')], 'b'))
    const response = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.ok).toBe(true)
    const sent = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('authorization'))
    expect(sent).toEqual(['Bearer token-b', 'Bearer token-a'])
  })

  it('reads the live cli routes with the App-shaped User-Agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(DOCUMENT), { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a')]))
    const models = await client.freeModels()
    expect(models.map(model => model.id)).toEqual(['auto', 'deepseek-v4.1-flash'])
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://www.workbuddy.ai/v3/config')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('user-agent')).toBe('WorkBuddyAI/2.63.2')
  })

  it('offers the tiers the product declares for the selected route', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      data: {
        agents: [{ name: 'cli', models: ['hy3'] }],
        models: [{ id: 'hy3', name: 'Hy3', credits: 'x0.00', supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['low', 'high'] } }],
      },
    }), { status: 200 }))
    const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account('a')])))
    const resolved = await adapter.resolveModel('workbuddy', 'hy3')
    // No "Off": this route reasons whether or not one is sent, so advertising it
    // was advertising a level that does nothing.
    expect(resolved.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'high'])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('high')
  })

  it('advertises the documented route before a sign-in, marked unavailable', async () => {
    // The picker builds its groups from listModels: an empty answer hid the
    // whole provider, so a user could not see what signing in would add.
    const models = await new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([]))).listModels('workbuddy')
    expect(models).toMatchObject([{
      provider: 'workbuddy',
      id: 'auto',
      name: 'WorkBuddy Auto',
      availability: 'unavailable',
      unavailableReason: 'WORKBUDDY_LOGIN_REQUIRED',
    }])
  })
})

describe('WorkBuddy reasoning wire', () => {
  /** Run one turn and hand back the JSON body the adapter actually posted. */
  async function postedBody(effort?: string): Promise<Record<string, unknown>> {
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(String((init)?.body ?? ''))
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account('a')])))
    for await (const _chunk of adapter.stream({
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      messages: [userMessage('hi')],
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    })) { /* drained */ }
    return JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
  }

  it('turns thinking on with the chosen level, which is what made the menu work', async () => {
    // The reported bug: picking High changed nothing because the request never
    // carried an effort, so the upstream answered without reasoning at all.
    expect(await postedBody('high')).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(await postedBody('low')).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
    // `xhigh` is the plugin's spelling; the gateway's own name for it is `max`.
    expect(await postedBody('xhigh')).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
  })

  it('sends nothing reasoning-related for Off, which is how thinking is disabled', async () => {
    const body = await postedBody('off')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).toMatchObject({ stream: true, model: 'deepseek-v4.1-flash' })
  })
})

describe('readWorkBuddyIntlAccounts', () => {
  it('reads the credit snapshot the sweep writes back', async () => {
    const accounts = await readWorkBuddyIntlAccounts(store([{
      ...account('a'),
      creditRemaining: 12.5,
      creditUsed: 7.5,
      creditCheckedAt: 1_789_000_000_000,
      creditExpiringSoon: true,
    }]))
    expect(accounts[0]).toMatchObject({ creditRemaining: 12.5, creditUsed: 7.5, creditCheckedAt: 1_789_000_000_000 })
  })

  it('ignores the retired check-in keys a stored document still carries', async () => {
    // The feature is gone; the vault documents written while it existed must
    // still load, and the leftovers must not leak into an account object.
    const accounts = await readWorkBuddyIntlAccounts(store([{
      ...account('a'),
      checkinDate: '2026-09-14',
      checkinResult: 'inactive',
      checkinMessage: '签到活动未开启或已过期',
    }]))
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).not.toHaveProperty('checkinDate')
    expect(accounts[0]).not.toHaveProperty('checkinResult')
  })
})

describe('WorkBuddyIntlAdapter failures', () => {
  it('reports a spent quota as RATE_LIMIT rather than a rejected credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 40_001, msg: 'insufficient credits' }), { status: 402 }))
    const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account('a')])))
    const failure = await (async () => {
      try {
        for await (const _chunk of adapter.stream({ provider: 'workbuddy', model: 'auto', messages: [userMessage('hi')] })) { /* drained */ }
        return undefined
      } catch (error) { return error }
    })()
    expect(failure).toBeInstanceOf(LlmError)
    expect(failure).toMatchObject({ code: 'RATE_LIMIT', failure: { status: 402 } })
    expect((failure as LlmError).message).toContain('积分不足')
  })

  it('reports a missing sign-in as AUTH with the sign-in instruction', async () => {
    const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([])))
    const failure = await (async () => {
      try {
        for await (const _chunk of adapter.stream({ provider: 'workbuddy', model: 'auto', messages: [userMessage('hi')] })) { /* drained */ }
        return undefined
      } catch (error) { return error }
    })()
    expect(failure).toMatchObject({ code: 'AUTH' })
    expect((failure as LlmError).message).toContain('WORKBUDDY_LOGIN_REQUIRED')
  })
})
