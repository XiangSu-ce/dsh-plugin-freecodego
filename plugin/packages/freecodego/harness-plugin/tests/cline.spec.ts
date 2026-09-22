import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import { ClineAdapter, ClineClient, ClineUpstreamError, readClineFeed } from '../src/cline.ts'

const HOUR = 3_600_000

function store(initialAuth?: string): CredentialProvider {
  let auth: string | undefined = initialAuth
  return {
    resolve: vi.fn(async ref => ref === 'CLINE_AUTH' ? (auth === undefined ? undefined : { value: auth, source: 'test' }) : undefined),
    describe: vi.fn(async () => ({ configured: false, writable: true })),
    set: vi.fn(async (ref, value: string) => { if (ref === 'CLINE_AUTH') auth = value }),
    unset: vi.fn(async (ref) => { if (ref === 'CLINE_AUTH') auth = undefined }),
  } as unknown as CredentialProvider
}

/** One account that can serve without a refresh, for rotation tests. */
function account(id: string): Record<string, unknown> {
  return { id, refreshToken: `refresh-${id}`, accessToken: `token-${id}`, expiresAt: Date.now() + HOUR }
}

/** The stored account list and the selection the host kept beside it. */
interface PersistedClineAccounts {
  readonly accounts: readonly Record<string, unknown>[]
  readonly activeAccountId?: string
}

function persisted(credentials: CredentialProvider): Promise<PersistedClineAccounts> {
  return credentials.resolve('CLINE_AUTH' as never).then(value => JSON.parse(value!.value) as PersistedClineAccounts)
}

function header(call: [unknown, unknown] | undefined, name: string): string | null {
  return new Headers((call?.[1] as RequestInit | undefined)?.headers).get(name)
}

afterEach(() => vi.restoreAllMocks())

describe('ClineClient', () => {
  it('exchanges a refresh token and keeps the rotated refresh token', async () => {
    const credentials = store()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      data: { accessToken: 'access-1', refreshToken: 'refresh-2', expiresAt: Date.now() + HOUR, userInfo: { email: 'me@example.com' } },
    }), { status: 200 }))
    const client = new ClineClient(credentials)
    await client.addAccountFromRefreshToken('refresh-1')
    // The account is stored verified: an unverified token would let the card
    // show an account that can never carry a request.
    expect(await client.accounts()).toMatchObject([{ id: 'me@example.com', status: 'active' }])
    expect((await persisted(credentials)).accounts[0]).toMatchObject({ refreshToken: 'refresh-2', accessToken: 'access-1' })
  })

  it('reads the live free-model feed and returns nothing when it is unreachable', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      free: [
        { id: 'stepfun/step-3.7-flash', name: 'StepFun 3.7 Flash' },
        { id: 'newco/new-free', name: 'New Free', description: 'brand new', tags: ['free'] },
      ],
    }), { status: 200 }))
    const client = new ClineClient(credentials)
    const models = await client.freeModels()
    expect(models.map(model => model.id)).toEqual(['stepfun/step-3.7-flash', 'newco/new-free'])
    expect(models[1]).toMatchObject({ provider: 'newco', description: 'brand new', tags: ['free'] })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.cline.bot/api/v1/ai/cline/recommended-models')
    // Cline authenticates with the `workos:`-prefixed bearer form, not the raw token.
    expect(header(fetchMock.mock.calls[0] as [unknown, unknown], 'authorization')).toBe('Bearer workos:token-a')

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    client.invalidateCatalog()
    // Live-only: an unreachable feed yields an empty list rather than stale
    // ids that would 4xx on every call.
    expect(await client.freeModels()).toEqual([])
  })

  it('reports the account\'s plan usage windows and credit balance', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')], activeAccountId: 'a' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          fiveHour: { used: 12, limit: 100, resetAt: Date.now() + HOUR },
          weekly: { usedPercent: 42.4 },
        },
        plan: 'Free',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'usr-01EXAMPLE' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ balance: 500000 }), { status: 200 }))
    const client = new ClineClient(credentials)
    const usage = await client.usage()
    expect(usage.windows).toHaveLength(2)
    expect(usage.windows[0]).toMatchObject({ id: 'five-hour', usedPercent: 12, resetsAt: expect.any(Number) })
    expect(usage.windows[1]).toMatchObject({ id: 'weekly', usedPercent: 42.4 })
    expect(usage).toMatchObject({ plan: 'Free', balanceUsd: 0.5 })
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://api.cline.bot/api/v1/users/me')
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('https://api.cline.bot/api/v1/users/usr-01EXAMPLE/balance')

    // A failed upstream read is an empty snapshot, not a thrown error: the
    // usage panel must never take the account list down with it.
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    client.invalidateUsage()
    await expect(client.usage()).resolves.toEqual({ windows: [] })
  })

  it('uses the cached usage snapshot until it expires', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')], activeAccountId: 'a' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { weekly: { usedPercent: 10 } }, plan: 'Free' }), { status: 200 }))
    const client = new ClineClient(credentials)
    await client.usage()
    await client.usage()
    // The second read is served from the cache: only the first call hits the
    // network (usage-limits, then the profile probe that finds no user id).
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rotates past an auth-failed account and parks a rate-limited one', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a'), account('b'), account('c')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'INFERENCE_CAP_ERROR: Try again in 17h 59m' } }), { status: 429 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[]}\n\n', { status: 200 }))
    const client = new ClineClient(credentials)
    const response = await client.chat('{"model":"deepseek/deepseek-v4-flash"}')
    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'https://api.cline.bot/api/v1/chat/completions',
      'https://api.cline.bot/api/v1/chat/completions',
      'https://api.cline.bot/api/v1/chat/completions',
    ])
    expect(fetchMock.mock.calls.map(call => header(call as [unknown, unknown], 'authorization'))).toEqual([
      'Bearer workos:token-a', 'Bearer workos:token-b', 'Bearer workos:token-c',
    ])
    // The dead account is reported rather than silently dropped, and the capped
    // one records the upstream delay against the route that hit it — the account
    // itself stays in rotation for every other free model.
    const rows = await client.accounts()
    expect(rows.map(row => [row.id, row.status])).toEqual([
      ['a', 'reauth-required'], ['b', 'active'], ['c', 'active'],
    ])
    expect(rows[1]).toMatchObject({
      coolingModels: [{ model: 'deepseek/deepseek-v4-flash', until: expect.any(Number) }],
    })
  })

  it('parks the capped route without taking the account\'s other routes down', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'INFERENCE_CAP_ERROR: Try again in 17h 59m' } }), { status: 429 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[]}\n\n', { status: 200 }))
    const client = new ClineClient(credentials)
    await expect(client.chat('{"model":"deepseek/deepseek-v4-flash"}')).rejects.toBeInstanceOf(ClineUpstreamError)
    // The route is parked; the account is not.
    expect((await client.accounts())[0]).toMatchObject({ id: 'a', status: 'active' })
    expect((await client.accounts())[0]?.coolingModels?.map(row => row.model)).toEqual(['deepseek/deepseek-v4-flash'])
    // A different free model is served by the same account, with no extra wait.
    await expect(client.chat('{"model":"zhipu/glm-5.3-flash"}')).resolves.toMatchObject({ status: 200 })
    expect(header(fetchMock.mock.calls[1] as [unknown, unknown], 'authorization')).toBe('Bearer workos:token-a')
  })

  it('reports a status no account could fix instead of handing its error body to the SSE reader', async () => {
    // A 5xx or a request-level 4xx is not an account problem: rotating would
    // park every healthy account for a request none of them could serve, and
    // since the adapter reads only `response.body`, the upstream's own
    // explanation would be replaced downstream by a generic stream failure.
    const credentials = store(JSON.stringify({ accounts: [account('a'), account('b')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'upstream exploded: model backend unavailable' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ))
    const client = new ClineClient(credentials)
    await expect(client.chat('{"model":"deepseek/deepseek-v4-flash"}')).rejects.toThrow('upstream exploded')
    // One attempt, and no account parked: the pool cannot fix this one.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await client.accounts()).map(row => row.status)).toEqual(['active', 'active'])
  })

  it('masks a credential the upstream echoes back in its failure body', async () => {
    // The refused body is what this client hands on as the error message, so the
    // masking has to happen where the detail is read — a caller only ever sees
    // the message, and cannot mask what it has already been given.
    const leaked = `ghp_${'A'.repeat(36)}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: `upstream exploded: rejected key ${leaked}` } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ))
    const client = new ClineClient(store(JSON.stringify({ accounts: [account('a')] })))
    const failure = await client.chat('{"model":"deepseek/deepseek-v4-flash"}')
      .then(() => new Error('the request was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('upstream exploded')
    expect(failure.message).not.toContain(leaked)
  })

  it('parks the account itself when the upstream blames billing, not a route', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    // 402 is the account's own payment state: no model choice routes around it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'payment required' } }), { status: 402 }))
    const client = new ClineClient(credentials)
    await expect(client.chat('{"model":"deepseek/deepseek-v4-flash"}')).rejects.toBeInstanceOf(ClineUpstreamError)
    const row = (await client.accounts())[0]
    expect(row).toMatchObject({ id: 'a', status: 'cooling', cooldownUntil: expect.any(Number) })
    expect(row?.coolingModels).toBeUndefined()
  })

  it('keeps the rotated refresh token when a 401 follows the refresh that rotated it', async () => {
    const credentials = store(JSON.stringify({
      // An expired access token is what forces the refresh that rotates the
      // credential, so the request runs against a pool whose stored copy is
      // already one generation behind.
      accounts: [{ ...account('a'), expiresAt: Date.now() - 1_000 }],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const href = input instanceof Request ? input.url : String(input)
      if (href.includes('/auth/refresh')) {
        return new Response(JSON.stringify({
          data: { accessToken: 'token-a2', refreshToken: 'refresh-a2', expiresAt: Date.now() + HOUR },
        }), { status: 200 })
      }
      // Refused even though the refresh itself succeeded. Recording the token
      // the request started with would leave the account holding one the
      // upstream has retired, which only ever surfaces as CLINE_REAUTH_REQUIRED.
      return new Response('unauthorized', { status: 401 })
    })
    const client = new ClineClient(credentials)
    await expect(client.chat('{"model":"deepseek/deepseek-v4-flash"}')).rejects.toBeInstanceOf(ClineUpstreamError)
    const row = (await persisted(credentials)).accounts[0]
    expect(row).toMatchObject({ refreshToken: 'refresh-a2' })
    // The dead access token is still dropped, so the next attempt re-authorizes.
    expect(row).not.toHaveProperty('accessToken')
  })

  it('keeps a route park across a credential refresh', async () => {
    const credentials = store(JSON.stringify({
      accounts: [{ ...account('a'), cooldowns: { 'deepseek/deepseek-v4-flash': Date.now() + HOUR } }],
    }))
    // A token refresh runs every few hours on every account; it must not hand a
    // capped model back to the pool as a side effect.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      data: { accessToken: 'token-a2', refreshToken: 'refresh-a2', expiresAt: Date.now() + HOUR },
    }), { status: 200 }))
    const client = new ClineClient(credentials)
    await client.refreshAccounts()
    expect((await client.accounts())[0]).toMatchObject({
      status: 'active', coolingModels: [{ model: 'deepseek/deepseek-v4-flash', until: expect.any(Number) }],
    })
    expect((await persisted(credentials)).accounts[0]).toMatchObject({
      accessToken: 'token-a2', cooldowns: { 'deepseek/deepseek-v4-flash': expect.any(Number) },
    })
  })

  it('drops a park once its deadline has passed instead of reporting it forever', async () => {
    const credentials = store(JSON.stringify({
      accounts: [{ ...account('a'), cooldownUntil: Date.now() - 60_000, cooldowns: { 'zhipu/glm-5.3-flash': Date.now() - 30_000 } }],
    }))
    const client = new ClineClient(credentials)
    expect((await client.accounts())[0]).toMatchObject({ id: 'a', status: 'active' })
    expect((await client.accounts())[0]?.cooldownUntil).toBeUndefined()
    expect((await client.accounts())[0]?.coolingModels).toBeUndefined()
  })

  it('throws a typed upstream error once every account has failed', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'INFERENCE_CAP_ERROR: Try again in 5m' } }), { status: 429 }))
    const client = new ClineClient(credentials)
    const error = await client.chat('{}').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ClineUpstreamError)
    expect((error as ClineUpstreamError).status).toBe(429)
  })

  it('walks the WorkOS device login and registers the Cline account', async () => {
    const credentials = store()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri_complete: 'https://auth.example/device', interval: 5, expires_in: 300 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'workos-access', refresh_token: 'workos-refresh' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accessToken: 'cline-access', refreshToken: 'cline-refresh', expiresAt: Date.now() + HOUR, userInfo: { email: 'me@example.com' } } }), { status: 200 }))
    const client = new ClineClient(credentials)
    await expect(client.startDeviceLogin()).resolves.toMatchObject({ deviceCode: 'device-1', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.example/device' })
    await expect(client.pollDeviceLogin('device-1')).resolves.toBe(true)
    await expect(client.pollDeviceLogin('device-1')).resolves.toBe(false)
    expect(await client.accounts()).toMatchObject([{ id: 'me@example.com', email: 'me@example.com', status: 'active' }])
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'https://api.workos.com/user_management/authorize/device',
      'https://api.workos.com/user_management/authenticate',
      'https://api.workos.com/user_management/authenticate',
      'https://api.cline.bot/api/v1/auth/register',
    ])
  })

  it('keeps a non-http authorization page out of the device ticket', async () => {
    // The page is opened by the Host and rendered as a clickable link in
    // Settings; only http(s) is ever relayed, and a rejected
    // `verification_uri_complete` falls back to the plain `verification_uri`.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'd1', user_code: 'A-B', verification_uri_complete: 'javascript:alert(1)', verification_uri: 'https://auth.example/device' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'd2', user_code: 'C-D', verification_uri_complete: 'javascript:alert(1)', verification_uri: 'file:///etc/passwd' }), { status: 200 }))
    const client = new ClineClient(store())
    await expect(client.startDeviceLogin()).resolves.toMatchObject({ deviceCode: 'd1', verificationUrl: 'https://auth.example/device' })
    await expect(client.startDeviceLogin()).rejects.toThrow('CLINE_LOGIN_FAILED: device authorization response was incomplete')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('removes and refreshes accounts individually', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a'), account('b')] }))
    const client = new ClineClient(credentials)
    await client.removeAccount('a')
    expect((await client.accounts()).map(row => row.id)).toEqual(['b'])

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: { accessToken: 'token-b2', refreshToken: 'refresh-b2', expiresAt: Date.now() + HOUR } }), { status: 200 }))
    await client.refreshAccounts()
    expect((await persisted(credentials)).accounts[0]).toMatchObject({ accessToken: 'token-b2', refreshToken: 'refresh-b2' })
  })

  it('keeps the selected account when a background refresh touches another one', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a'), account('b')], activeAccountId: 'a' }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: { accessToken: 'token-2', refreshToken: 'refresh-2', expiresAt: Date.now() + HOUR },
    }), { status: 200 }))
    const client = new ClineClient(credentials)
    await client.refreshAccounts()
    // Refreshing a token is not choosing an account: the pool's active row must
    // not follow whichever refresh happened to run last.
    expect((await persisted(credentials)).activeAccountId).toBe('a')
  })

  it('keeps the selected account when an unrelated account is removed', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a'), account('b'), account('c')], activeAccountId: 'c' }))
    const client = new ClineClient(credentials)
    await client.removeAccount('a')
    expect((await persisted(credentials)).activeAccountId).toBe('c')
    // Only the account that was actually selected falls through to a survivor.
    await client.removeAccount('c')
    expect((await persisted(credentials)).activeAccountId).toBe('b')
  })

  it('adopts an account the user just authorized', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')], activeAccountId: 'a' }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      data: { accessToken: 'token-z', refreshToken: 'refresh-z', expiresAt: Date.now() + HOUR, userInfo: { email: 'z@example.com' } },
    }), { status: 200 }))
    const client = new ClineClient(credentials)
    await client.addAccountFromRefreshToken('refresh-z')
    expect((await persisted(credentials)).activeAccountId).toBe('z@example.com')
  })

  it('reads usage from a usable account instead of one awaiting reauthorization', async () => {
    // The account whose refresh last failed has no credential left; the usage
    // panel must not go blank while other accounts still serve requests.
    const credentials = store(JSON.stringify({
      accounts: [{ id: 'a', refreshToken: 'refresh-a' }, account('b')],
      activeAccountId: 'a',
    }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = url instanceof Request ? url.url : String(url)
      if (href.includes('/auth/refresh')) return new Response('nope', { status: 401 })
      if (href.endsWith('/plan/usage-limits')) {
        return new Response(JSON.stringify({ data: { weekly: { usedPercent: 42 } } }), { status: 200 })
      }
      if (href.endsWith('/users/me')) return new Response(JSON.stringify({ id: 'usr-1' }), { status: 200 })
      return new Response(JSON.stringify({ balance: 500000 }), { status: 200 })
    })
    const usage = await new ClineClient(credentials).usage()
    expect(usage.windows[0]).toMatchObject({ id: 'weekly', usedPercent: 42 })
    expect(header(fetchMock.mock.calls[0] as [unknown, unknown], 'authorization')).toBe('Bearer workos:token-b')
  })
})

describe('ClineAdapter', () => {
  const options = {
    provider: 'cline',
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ id: MessageId('m1'), role: 'user' as const, source: { kind: 'user' as const }, content: [{ type: 'text' as const, text: 'hello' }] }],
  }

  it('serves an empty directory before sign-in so no fabricated route is advertised', async () => {
    const adapter = new ClineAdapter(new ClineClient(store()))
    // Live-only: with no account there is no authenticated feed, and inventing
    // model ids would 4xx on every call. The picker simply shows no Cline rows.
    await expect(adapter.listModels('cline')).resolves.toEqual([])
  })

  it('reads the subscription half of the feed too, which the picker had been dropping', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      free: [{ id: 'stepfun/step-3.7-flash', name: 'StepFun 3.7 Flash' }],
      recommended: [
        { id: 'mimo-v2.5', name: 'MiMo v2.5' },
        // Listed in both halves: the free answer is the one that holds.
        { id: 'stepfun/step-3.7-flash', name: 'StepFun 3.7 Flash' },
      ],
    }), { status: 200 }))
    const client = new ClineClient(credentials)
    // The status card's list is still free-only.
    await expect(client.freeModels()).resolves.toMatchObject([{ id: 'stepfun/step-3.7-flash' }])
    // The whole roster is what the settings checklist draws from.
    const all = await client.allModels()
    expect(all.map(model => model.id)).toEqual(['stepfun/step-3.7-flash', 'mimo-v2.5'])
    expect(all.map(model => model.free)).toEqual([true, false])
  })

  it('finds the metered half by shape, so a non-model array cannot become a route', async () => {
    // Which key the subscription rows arrive under is not fixed by anything this
    // code can see, so the rule is stated by shape: anything `parseClineModel`
    // rejects is not a route, and an id in both halves stays free.
    const feed = readClineFeed({
      free: [{ id: 'stepfun/step-3.7-flash', name: 'StepFun 3.7 Flash' }],
      notices: [{ message: 'maintenance' }, 'plain string', null],
      categories: [{ label: 'coding' }],
      cline_pass: [{ id: 'glm-5.3', name: 'GLM 5.3' }],
    })
    expect(feed.free.map(model => model.id)).toEqual(['stepfun/step-3.7-flash'])
    expect(feed.metered.map(model => model.id)).toEqual(['glm-5.3'])
  })

  it('keeps reading a single-list feed as free, so no route is switched off by a shape change', () => {
    // `models` is the key this reader accepted before the second half existed. A
    // feed that reports only that list used to be entirely free; reading it as the
    // subscription half would hide every route behind a price that is not there.
    const feed = readClineFeed({ models: [{ id: 'newco/new-free', name: 'New Free' }] })
    expect(feed.free.map(model => model.id)).toEqual(['newco/new-free'])
    expect(feed.metered).toEqual([])
  })

  it('states a metered rate for the subscription half instead of offering it as free', async () => {
    // A subscription row that arrived with the free rate would be tagged FREE and
    // switched on by default — money the user never asked to spend.
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      free: [{ id: 'newco/new-free', name: 'New Free' }],
      recommended: [{ id: 'mimo-v2.5', name: 'MiMo v2.5' }],
    }), { status: 200 }))
    const rows = await new ClineAdapter(new ClineClient(credentials)).listModels('cline')
    expect(rows.map(row => row.id)).toEqual(['newco/new-free', 'mimo-v2.5'])
    expect(rows[0]!.description).toContain('×0')
    expect(rows[1]!.description).toContain('tag:metered')
  })

  it('advertises the live feed as available once an account exists', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ free: [{ id: 'newco/new-free', name: 'New Free' }] }), { status: 200 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    await expect(adapter.listModels('cline')).resolves.toMatchObject([{ id: 'newco/new-free', availability: 'available' }])
  })

  it('describes every free route with a zero rate so the picker tags it FREE', async () => {
    // The native picker renders its FREE tag from a `×0` in the description.
    // Cline's own feed sends prose with no rate, so the free routes rendered as
    // unpriced until the adapter stated the rate itself.
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      free: [{ id: 'newco/new-free', name: 'New Free', description: 'Newco flagship' }],
    }), { status: 200 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    const rows = await adapter.listModels('cline')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.description).toContain('×0')
    // The rate leads the string, so an upstream note mentioning a multiplier
    // cannot shadow the FREE tag.
    expect(rows[0]!.description?.indexOf('×0')).toBeLessThan(rows[0]!.description?.indexOf('官方免费模型') ?? 0)
  })

  it('greys out only the route that ran out of free budget', async () => {
    const credentials = store(JSON.stringify({
      accounts: [{ ...account('a'), cooldowns: { 'newco/new-free': Date.now() + HOUR } }],
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      free: [{ id: 'newco/new-free', name: 'New Free' }, { id: 'zhipu/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
    }), { status: 200 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    await expect(adapter.listModels('cline')).resolves.toMatchObject([
      { id: 'newco/new-free', availability: 'unavailable', unavailableReason: 'CLINE_MODEL_RATE_LIMITED' },
      { id: 'zhipu/glm-5.3-flash', availability: 'available' },
    ])
  })

  it('streams the upstream SSE and sends the route body Cline expects', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.model).toBe('deepseek/deepseek-v4-flash')
    expect(body.reasoning_effort).toBe('high')
    expect(typeof body.session_id).toBe('string')
    // The header and the payload name the *same* session. Cline compares them,
    // and two ids built in two places is exactly how they stopped agreeing.
    expect(header(fetchMock.mock.calls[0] as [unknown, unknown], 'x-task-id')).toBe(body.session_id)
  })

  it('identifies itself as a Cline product surface, which is what a free route is gated on', async () => {
    // Without these, Cline answers 403 "… is only available via Cline product
    // surfaces" for every free model, however valid the token is. The values
    // mirror the official CLI client, because the upstream allowlists them.
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    for await (const _chunk of adapter.stream(options)) { /* consume */ }
    const call = fetchMock.mock.calls[0] as [unknown, unknown]
    expect(header(call, 'user-agent')).toBe('Cline/3.0.50')
    expect(header(call, 'x-client-type')).toBe('cline-cli')
    expect(header(call, 'x-client-version')).toBe('3.0.50')
    expect(header(call, 'x-platform')).toBe('terminal')
    expect(header(call, 'x-platform-version')).toBe('3.0.50')
    expect(header(call, 'x-core-version')).toBe('0.0.70')
    expect(header(call, 'x-is-multiroot')).toBe('false')
    expect(header(call, 'http-referer')).toBe('https://cline.bot')
    expect(header(call, 'x-title')).toBe('Cline')
  })

  it('carries the same identity on the authenticated reads the panel makes', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ free: [] }), { status: 200 }))
    await new ClineClient(credentials).freeModels()
    const call = fetchMock.mock.calls[0] as [unknown, unknown]
    expect(header(call, 'x-client-type')).toBe('cline-cli')
    expect(header(call, 'authorization')).toBe('Bearer workos:token-a')
    // `x-task-id` is present on a read too, and is its own session.
    expect(header(call, 'x-task-id')).toMatch(/^sess_/)
  })

  it('reports a quota gate as a rate limit instead of a broken credential', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('forbidden', { status: 403 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    const error = await (async () => { for await (const _chunk of adapter.stream(options)) { /* consume */ } })()
      .catch((thrown: unknown) => thrown)
    // A 403 here is the free tier's own gate: the credential is still good, so
    // the chat UI must not answer "API key is invalid".
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure).toMatchObject({ code: 'RATE_LIMIT', status: 403 })
    expect((error as LlmError).message).toContain('deepseek/deepseek-v4-flash')
  })

  it('does not blame the account for a refusal the account cannot fix', async () => {
    // The client-identity 403: rotating through the pool would park every
    // healthy account and end in "quota or subscription", which points the user
    // at billing for a client-version problem.
    const credentials = store(JSON.stringify({ accounts: [account('a'), account('b')] }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Error 403: deepseek/deepseek-v4-flash is only available via Cline product surfaces.' },
    }), { status: 403 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    const error = await (async () => { for await (const _chunk of adapter.stream(options)) { /* consume */ } })()
      .catch((thrown: unknown) => thrown)
    // One attempt, not one per account: no account can change what it is about.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((error as LlmError).message).toContain('product surfaces')
    // And nothing was parked, so the pool is intact for the next request.
    const stored = await persisted(credentials)
    expect(stored.accounts.every(item => item.cooldowns === undefined && item.cooldownUntil === undefined)).toBe(true)
  })

  it('names the capped model and its recovery time when the pool is spent', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'INFERENCE_CAP_ERROR: Try again in 30m' } }), { status: 429 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    const error = await (async () => { for await (const _chunk of adapter.stream(options)) { /* consume */ } })()
      .catch((thrown: unknown) => thrown)
    expect((error as LlmError).failure).toMatchObject({ code: 'RATE_LIMIT', status: 429 })
    expect((error as LlmError).message).toContain('deepseek/deepseek-v4-flash')
    // 30m → "最早约 30 分钟", so the user knows the wait is not indefinite.
    expect((error as LlmError).message).toContain('30 分钟')
  })

  it('keeps a real credential failure on the auth path', async () => {
    const credentials = store(JSON.stringify({ accounts: [account('a')] }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const adapter = new ClineAdapter(new ClineClient(credentials))
    const error = await (async () => { for await (const _chunk of adapter.stream(options)) { /* consume */ } })()
      .catch((thrown: unknown) => thrown)
    expect((error as LlmError).failure).toMatchObject({ code: 'AUTH' })
  })
})
