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
  workBuddyContextWindow,
  workBuddyUserAgent,
  workBuddySurfaceIdentity,
  workBuddyIdentity,
  decorateWorkBuddyLoginUrl,
  prepareWorkBuddyChatBody,
  prepareWorkBuddyReasoning,
  type WorkBuddyIntlRoute,
} from '../src/workbuddy-intl.ts'
import { assertSurfaceIdentity } from '../src/request-identity.ts'

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

afterEach(() => {
  vi.restoreAllMocks()
  // The park tests move the clock; a leaked fake clock would decide every later
  // account expiry in this file.
  vi.useRealTimers()
})

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

  it('prices the turn by the conversation, and never over a key the caller stated', () => {
    // The backend turns prefix caching on only when the key is present, so a turn
    // without one reports no cache hits at several times the cost of the same
    // turn with it. A caller that already decided its own key keeps it: this
    // module states a default, not a correction.
    expect(prepareWorkBuddyChatBody({ model: 'auto', messages: [] }, 'sess-1')).toMatchObject({ prompt_cache_key: 'sess-1' })
    expect(prepareWorkBuddyChatBody({ model: 'auto', messages: [], prompt_cache_key: 'mine' }, 'sess-1')).toMatchObject({ prompt_cache_key: 'mine' })
    expect(prepareWorkBuddyChatBody({ model: 'auto', messages: [] })).not.toHaveProperty('prompt_cache_key')
  })
})

describe('WorkBuddy login URL', () => {
  it('adds the desktop client\'s two parameters without rebuilding what the server minted', () => {
    // `platform` and `state` are the server's: the browser step binds the issued
    // tokens to that state, and a URL rebuilt on this side drops one of them and
    // leaves the poll answering "still signing in" forever.
    const decorated = new URL(decorateWorkBuddyLoginUrl('http://localhost:8787/login?platform=CLI&state=54e29ffe'))
    expect(decorated.searchParams.get('platform')).toBe('CLI')
    expect(decorated.searchParams.get('state')).toBe('54e29ffe')
    expect(decorated.searchParams.get('version')).toBe('5.5.2')
    // A per-attempt id, so two attempts are two lines in the server's log.
    expect(decorated.searchParams.get('loginSessionId')).toMatch(/^[0-9a-f-]{36}$/u)
    const second = new URL(decorateWorkBuddyLoginUrl('http://localhost:8787/login?state=54e29ffe'))
    expect(second.searchParams.get('loginSessionId')).not.toBe(decorated.searchParams.get('loginSessionId'))
  })

  it('hands back an unparsable URL unchanged rather than a different one', () => {
    expect(decorateWorkBuddyLoginUrl('not a url')).toBe('not a url')
  })
})

describe('WorkBuddy DeepSeek reasoning switch', () => {
  const body = { model: 'deepseek-v4.1-flash', messages: [] }
  const declared = { efforts: ['low', 'high'] as const, defaultEffort: 'high' }

  it('states the route\'s own tier when the caller stated none', () => {
    // The flag and the tier are one switch on this host: neither alone produces
    // `reasoning_content`, so a route that declares a ladder gets both.
    expect(prepareWorkBuddyReasoning(body, 'deepseek-v4.1-flash', declared)).toEqual({
      ...body, thinking: { type: 'enabled' }, reasoning_effort: 'high',
    })
  })

  it('carries the flag alone when the route declares no ladder to choose from', () => {
    expect(prepareWorkBuddyReasoning(body, 'deepseek-v4.1-flash', undefined)).toEqual({
      ...body, thinking: { type: 'enabled' },
    })
  })

  it('leaves an explicit off alone', () => {
    // A user who turned reasoning off on a route that offers off must not have it
    // switched back on by the fallback this module states for everyone else.
    expect(prepareWorkBuddyReasoning(body, 'deepseek-v4.1-flash', declared, 'off')).toEqual(body)
  })

  it('replaces a tier the route does not accept instead of sending a refusal', () => {
    expect(prepareWorkBuddyReasoning(body, 'deepseek-v4.1-flash', declared, 'medium')).toMatchObject({ reasoning_effort: 'high' })
    // A route with no `high` falls back to the lowest tier it does accept.
    expect(prepareWorkBuddyReasoning(body, 'deepseek-v4.1-flash', { efforts: ['low', 'medium'], defaultEffort: 'medium' }, 'xhigh'))
      .toMatchObject({ reasoning_effort: 'medium' })
  })

  it('keeps an accepted tier, and spells xhigh the way the wire does', () => {
    expect(prepareWorkBuddyReasoning({ ...body, reasoning_effort: 'high' }, 'deepseek-v4.1-flash', declared, 'high')).toMatchObject({ reasoning_effort: 'high' })
    expect(prepareWorkBuddyReasoning(body, 'deepseek-v4.1-flash', { efforts: ['xhigh'], defaultEffort: 'xhigh' }))
      .toMatchObject({ reasoning_effort: 'max' })
  })

  it('touches no other model family, whose thinking switch is their own', () => {
    for (const model of ['glm-5.2', 'hy3', 'kimi-k2.6', 'minimax-m2.5', 'auto']) {
      expect(prepareWorkBuddyReasoning({ ...body, model }, model, declared), model).toEqual({ ...body, model })
    }
  })
})

describe('WorkBuddy chat identity', () => {
  it('resolves the User-Agent by the model family the route belongs to', () => {
    // The international lines are served to the international client form and the
    // domestic ones to the domestic form; one User-Agent for every route is a
    // client that does not exist. An unknown prefix keeps the international form,
    // which is the shape a newly published route is reached through.
    expect(workBuddyUserAgent('gpt-5.6-sol')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    expect(workBuddyUserAgent('claude-sonnet-5')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    expect(workBuddyUserAgent('auto')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    for (const domestic of ['glm-5.2', 'hy3', 'hy4-preview-f', 'kimi-k2.6', 'minimax-m2.5']) {
      expect(workBuddyUserAgent(domestic), domestic).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    }
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
  it('names the destination as X-Domain rather than the credential login snapshot', async () => {
    // The account's `domain` is where it signed in, which is not necessarily where
    // this build talks: an imported credential can still carry the host the
    // desktop client used before it moved. A request whose declared identity and
    // destination disagree is the one the gateway refuses.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a')]))
    await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-user-id')).toBe('uid-a')
    expect(headers.get('x-domain')).toBe('www.workbuddy.ai')
    expect(headers.get('x-no-enterprise-id')).toBe('1')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://www.workbuddy.ai/v2/chat/completions')
  })

  it('sends the desktop chat identity the turn is attributed by', async () => {
    // The chat route is served to the desktop client, and that client names itself
    // in headers the plugin surface does not carry: the attribution name as
    // `X-Product` (the deployment kind `SaaS` files the turn under no product at
    // all), the IDE identity the usage columns are read from, and the conversation
    // ids. Without them the turn is answered as an unknown client, if at all.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([{ ...account('a'), enterpriseId: 'e-1' }]))
    await client.chat(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      { sessionId: 'sess-7' },
    )
    const call = fetchMock.mock.calls[0]
    const headers = new Headers(call?.[1]?.headers)
    expect(headers.get('x-product')).toBe('WorkBuddy')
    expect(headers.get('x-product-code')).toBe('workbuddy')
    expect(headers.get('x-agent-purpose')).toBe('conversation')
    expect(headers.get('x-ide-name')).toBe('WorkBuddy')
    expect(headers.get('x-ide-type')).toBe('WorkBuddy')
    expect(headers.get('x-ide-version')).toBe('5.5.2')
    // The domestic line, so the domestic client form. A `glm-` route asked for as
    // the international build is a request for a client this route is not served to.
    expect(headers.get('user-agent')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(headers.get('x-conversation-id')).toBe('sess-7')
    for (const header of ['x-conversation-message-id', 'x-conversation-request-id']) {
      expect(headers.get(header), header).toMatch(/^[0-9a-f-]{36}$/u)
    }
    expect(headers.get('x-conversation-message-id')).not.toBe(headers.get('x-conversation-request-id'))
    // Both spellings of one enterprise identity travel together.
    expect(headers.get('x-enterprise-id')).toBe('e-1')
    expect(headers.get('x-tenant-id')).toBe('e-1')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ prompt_cache_key: 'sess-7' })
  })

  it('gives one turn without a session its own conversation instead of sharing one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a')]))
    await client.chat({ model: 'auto', messages: [] })
    await client.chat({ model: 'auto', messages: [] })
    const ids = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('x-conversation-id'))
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/u)
    expect(ids[0]).not.toBe(ids[1])
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

  it('does not exchange a token over a plan gate', async () => {
    // A 403 on these routes is the plan, not an expired token: no refresh can move a
    // model into a plan, and each attempt spends a single-use refresh token. The
    // read used to treat any 403 as an unauthorized answer and rotate twice — once
    // across the three resource queries, once in the legacy billing fallback.
    const refreshes: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: Parameters<typeof fetch>) => {
      const url = requestedUrl(args[0])
      if (url.endsWith('/v2/plugin/auth/token/refresh')) {
        refreshes.push(url)
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresIn: 3_600 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 40_003, msg: 'this model is not in your plan' }), { status: 403 })
    })
    const [accountA] = await readWorkBuddyIntlAccounts(store([account('a')]))
    const client = new WorkBuddyIntlClient(store([account('a')]))
    const snapshot = await client.credits(accountA!)
    expect(refreshes).toEqual([])
    // The refusal still has to be reported in the upstream's own words: the read
    // answered with an error rather than with a position it invented.
    expect(snapshot.credits).toMatchObject({ error: expect.stringContaining('not in your plan') })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(3)
  })

  it('parks a plan gate for the credit window, not the sign-in window', async () => {
    // Six minutes later, the five-minute sign-in park this used to take would have
    // expired and the turn would start on the account whose plan cannot serve the
    // route; the credit window keeps the walk on the account that can.
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-09-13T00:00:00Z')
    vi.setSystemTime(start)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40_003, msg: 'this model is not in your plan' }), { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a'), account('b')]))
    await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'one' }] })
    vi.setSystemTime(start + 6 * 60_000)
    await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'two' }] })
    const sent = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('authorization'))
    expect(sent).toEqual(['Bearer token-a', 'Bearer token-b', 'Bearer token-b'])
  })

  it('lets a rate-limited account back in once its minute has passed', async () => {
    // The control for the case above: the same six minutes, a different gate. A 429
    // is a one-minute turn, so the first account serves again — which is what makes
    // the parked plan gate above a reading of the status rather than a clock that
    // never moves.
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-09-13T00:00:00Z')
    vi.setSystemTime(start)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new WorkBuddyIntlClient(store([account('a'), account('b')]))
    await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'one' }] })
    vi.setSystemTime(start + 6 * 60_000)
    await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'two' }] })
    const sent = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('authorization'))
    expect(sent).toEqual(['Bearer token-a', 'Bearer token-b', 'Bearer token-a'])
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

  it('sizes every route against the window this product serves, keeping a smaller published one', async () => {
    // The catalog's largest claim is 1,000,000 (`maxInputTokens` and `maxAllowedSize`)
    // with `contextWindow.defaultLength` 300,000 beside it, and the product serves
    // 264,000 — so the number the connector declares is the smaller of the route's
    // own ceiling and the product's. Declaring the catalog's largest value is the
    // direction that breaks: compaction is sized against it, so the conversation is
    // allowed to grow past what the service serves and the route starts refusing
    // mid-session with nothing local to warn anyone.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        agents: [{ name: 'cli', models: ['deepseek-v4.1-flash', 'hy3', 'auto'] }],
        models: [
          {
            id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.00',
            maxInputTokens: 1_000_000, maxAllowedSize: 1_000_000, maxOutputTokens: 128_000,
            contextWindow: { defaultLength: 300_000, supportedLengths: [300_000, 1_000_000] },
          },
          // A route whose own ceiling is smaller than the product's: kept as its own.
          { id: 'hy3', name: 'Hy3', credits: 'x0.00', maxInputTokens: 192_000, maxOutputTokens: 64_000 },
          // A route that publishes no window at all: the product's ceiling stands.
          { id: 'auto', name: 'Auto', credits: 'x0.00' },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account('a')])))

    expect((await adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(264_000)
    expect((await adapter.resolveModel('workbuddy', 'hy3')).context?.contextWindow).toBe(192_000)
    expect((await adapter.resolveModel('workbuddy', 'auto')).context?.contextWindow).toBe(264_000)

    // And the row the picker renders carries the same number the adapter compacts
    // against, so the card cannot promise a window the turn will not get.
    // `LlmModelInfo` does not declare these fields, which is why the adapter reads
    // them through a widening assertion of its own; the cast here is the same read.
    const rows = await adapter.listModels('workbuddy')
    const rowWindow = (id: string): number | undefined =>
      (rows.find(row => row.id === id) as { readonly contextWindow?: number } | undefined)?.contextWindow
    expect(rowWindow('deepseek-v4.1-flash')).toBe(264_000)
    expect(rowWindow('hy3')).toBe(192_000)
  })

  it('answers one window for every combination a catalog row can present', () => {
    // The rule itself, away from any document: the two facts are combined, never
    // chosen between.
    expect(workBuddyContextWindow(undefined)).toBe(264_000)
    expect(workBuddyContextWindow(1_000_000)).toBe(264_000)
    expect(workBuddyContextWindow(300_000)).toBe(264_000)
    expect(workBuddyContextWindow(264_000)).toBe(264_000)
    // A route that really is smaller keeps its own number rather than being
    // raised to the ceiling.
    expect(workBuddyContextWindow(192_000)).toBe(192_000)
    expect(workBuddyContextWindow(176_000)).toBe(176_000)
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

describe('WorkBuddy metered routes', () => {
  /** A document whose allowlist holds one free route and one that costs money. */
  const MIXED_DOCUMENT = {
    code: 0,
    data: {
      agents: [{ name: 'cli', models: ['auto', 'glm-5.3'] }],
      models: [
        { id: 'auto', name: 'Auto', credits: 'x0.00', maxInputTokens: 200_000, maxOutputTokens: 32_000 },
        { id: 'glm-5.3', name: 'GLM 5.3', credits: 'x1.50', maxInputTokens: 128_000, maxOutputTokens: 16_000 },
      ],
    },
  }

  function mockDocument(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(MIXED_DOCUMENT), { status: 200, headers: { 'content-type': 'application/json' } }))
  }

  it('lists the metered half of the product document and states its rate', async () => {
    mockDocument()
    const adapter = new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account('a')])))
    const rows = await adapter.listModels('workbuddy')
    // Both halves: the settings checklist has to list a metered route, or the
    // user could never switch one on.
    expect(rows.map(row => row.id)).toEqual(['auto', 'glm-5.3'])
    expect(rows[0]!.description).toContain('×0')
    // The rate is the product's own, not a placeholder: the row that costs more is
    // described as costing more.
    expect(rows[1]!.description).toContain('×1.5')
    // And the status card's cloud still counts only what is free.
    mockDocument()
    await expect(new WorkBuddyIntlClient(store([account('a')])).freeModels()).resolves.toMatchObject([{ id: 'auto' }])
  })

  it('prices a promoted route at zero while the promotion is in force', async () => {
    // The document bakes the discounted value into `credits` for the length of a
    // promotion, so a route it lists as costing 1.5 while a factor-0 promotion
    // covers it must still be described as free.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        agents: [{ name: 'cli', models: ['glm-5.3'] }],
        models: [{ id: 'glm-5.3', name: 'GLM 5.3', credits: 'x1.50', maxInputTokens: 128_000, maxOutputTokens: 16_000 }],
        modelPromotions: [{
          enabled: true,
          modelIds: ['glm-5.3'],
          priority: 1,
          discount: { displayMode: 'replace', factor: 0 },
          schedule: { validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-12-31T00:00:00Z' },
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const rows = await new WorkBuddyIntlAdapter(new WorkBuddyIntlClient(store([account('a')]))).listModels('workbuddy')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.description).toContain('×0')
    expect(rows[0]!.description).not.toContain('×1.5')
  })
})

describe('WorkBuddy reasoning wire', () => {
  /** Run one turn and hand back the JSON body the adapter actually posted. */
  async function postedBody(effort?: string): Promise<Record<string, unknown>> {
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      // Only the chat POST is the turn: a DeepSeek route also reads the live route
      // directory first, because the tier fallback below may only state a level
      // that document declares, and that read is a bodyless GET.
      if (String(input).endsWith('/v2/chat/completions')) bodies.push(String((init)?.body ?? ''))
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

/** Every header a surface declares, filled with a placeholder, for the positive case. */
function surfaceHeaders(surface: 'chat' | 'credits' | 'catalog'): Record<string, string> {
  const identity = workBuddySurfaceIdentity(surface)
  const extras = Object.keys(identity.extraHeaders)
  const names = identity.required.flatMap(entry => typeof entry === 'string' ? [entry] : [entry[0]])
  return Object.fromEntries([...names, ...extras].map(name => [name, 'placeholder']))
}

// The table is only a guard if a violation is loud. These run the assertion the
// adapters run on every request, in both directions: a declaration that is
// satisfied passes, and a request missing one header names exactly that header.
describe('the identity table refuses requests that are missing a declared header', () => {
  it('accepts each surface when every declared header is present', () => {
    for (const surface of ['chat', 'credits', 'catalog'] as const) {
      expect(() => assertSurfaceIdentity(workBuddyIdentity, surface, surfaceHeaders(surface)), surface).not.toThrow()
    }
  })

  it('names the missing chat header and the surface it belongs to', () => {
    const headers = surfaceHeaders('chat')
    delete headers['x-ide-version']
    expect(() => assertSurfaceIdentity(workBuddyIdentity, 'chat', headers)).toThrow(/WORKBUDDY_IDENTITY_INCOMPLETE: the chat request is missing x-ide-version/)
  })

  it('matches header names case-insensitively, as the wire does', () => {
    const headers = Object.fromEntries(Object.entries(surfaceHeaders('catalog')).map(([name, value]) => [name.toUpperCase(), value]))
    expect(() => assertSurfaceIdentity(workBuddyIdentity, 'catalog', headers)).not.toThrow()
  })

  it('accepts either spelling of an either-or header and demands one of them', () => {
    const byUser = surfaceHeaders('credits')
    expect(byUser['x-user-id']).toBe('placeholder')
    expect(() => assertSurfaceIdentity(workBuddyIdentity, 'credits', byUser)).not.toThrow()

    const anonymous = { ...byUser }
    delete anonymous['x-user-id']
    anonymous['x-no-user-id'] = '1'
    expect(() => assertSurfaceIdentity(workBuddyIdentity, 'credits', anonymous)).not.toThrow()

    const neither = { ...byUser }
    delete neither['x-user-id']
    expect(() => assertSurfaceIdentity(workBuddyIdentity, 'credits', neither)).toThrow(/missing x-user-id \| x-no-user-id/)
  })

  it('keeps the chat surface on the attribution name the reference sends', () => {
    // The plugin shim may not appear in any of these three header values: the
    // gateway matches the IDE's own identity, and the parity spec pins the rest.
    const chat = workBuddySurfaceIdentity('chat')
    expect(chat.product).toBe('WorkBuddy')
    expect(chat.extraHeaders['x-ide-name']).toBe('WorkBuddy')
    expect(chat.extraHeaders['x-ide-type']).toBe('WorkBuddy')
    expect(JSON.stringify(chat)).not.toMatch(/freecodego|freebuff|plugin/i)
    // Credits and the catalog speak as the deployment, not the IDE.
    expect(workBuddySurfaceIdentity('credits').product).toBe('SaaS')
    expect(workBuddySurfaceIdentity('catalog').product).toBe('SaaS')
  })
})
