/**
 * The two TRAE deployments, and the decision of which one a turn goes to.
 *
 * The China and international catalogs are near-disjoint and a name sent to the
 * other realm is refused with `4001 param is invalid`, which names nothing about
 * regions. So the routing is the feature: an account from the realm that lists the
 * model has to be the one tried first, the realm that owns the model has to keep
 * its remaining accounts ahead of the other realm's, and a refusal that every
 * account would repeat must not spend the pool finding that out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { TraeAdapter, TraeClient, TRAE_STORE_REF } from '../src/trae-intl.ts'
import { exchangeTraeToken } from '../src/trae/login.ts'

/** The chat origin each realm sends its conversation to. */
const CN_CHAT = 'https://trae-api-cn.mchost.guru'
const SG_CHAT = 'https://coresg-normal.trae.ai'
/** The token origins the China realm may be served by, in the order it tries them. */
const CN_AUTH = ['https://api.trae.com.cn', 'https://api.trae.cn']

/** One stored account, never near expiry unless a case says so. */
function accountRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'cn-1',
    realm: 'cn',
    uid: 'u-cn',
    nickname: 'cn-user',
    machineId: 'a'.repeat(32),
    deviceId: 'b'.repeat(32),
    accessToken: 'access-cn',
    refreshToken: 'refresh-cn',
    expiresAt: 4_000_000_000,
    createdAt: 1,
    lastChecked: 1,
    ...overrides,
  }
}

/** The vault the connector reads its pool from. */
function vault(rows: readonly Record<string, unknown>[], activeAccountId?: string): CredentialProvider {
  const value = JSON.stringify({ accounts: rows, ...(activeAccountId === undefined ? {} : { activeAccountId }) })
  return {
    resolve: vi.fn(async (ref: unknown) => ref === TRAE_STORE_REF ? { value, source: 'test' } : undefined),
    describe: vi.fn(async () => ({ configured: true, writable: true })),
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
  } as unknown as CredentialProvider
}

/** The smallest request the adapter will serialize. */
function userMessage(text: string) {
  return {
    id: MessageId('m1'),
    role: 'user' as const,
    source: { kind: 'user' as const },
    content: [{ type: 'text' as const, text }],
  }
}

/** A conversation that answers one turn. */
function answer(content: string): string {
  return `event: output\ndata: ${JSON.stringify({ response: content })}\n\nevent: done\ndata: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`
}

/** A conversation whose first frame is the account-level refusal. */
function refusal(code: number, message: string): string {
  return `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`
}

/** One conversation the stub was asked for. */
interface ChatCall {
  readonly host: string
  readonly authorization: string
  readonly model: string
}

/**
 * Stand in for the three hosts a mixed pool talks to.
 *
 * `catalogs` is per chat origin, so a realm that is deliberately unreadable is
 * stated by leaving it out — that is how the directory-failure cases are written.
 * @param options - the catalogs to serve, the stream each conversation gets, and
 * whether the directory is currently refusing reads.
 * @returns the calls the connector made, in order.
 */
function serveUpstream(options: {
  readonly catalogs: Readonly<Record<string, readonly string[]>>
  readonly chat: (host: string, attempt: number) => string
  readonly refuseReads?: () => boolean
}): { readonly chats: ChatCall[]; readonly directoryReads: string[]; readonly directoryPeak: () => number } {
  const chats: ChatCall[] = []
  const directoryReads: string[] = []
  // How many directory reads were open at once: a caller that reads its realms one
  // after another can never exceed one, however many realms it has.
  let inFlight = 0
  let peak = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>)
    if (url.pathname === '/api/ide/v1/get_detail_param') {
      directoryReads.push(url.origin)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        // Yield before answering, so only a caller that issues both reads together
        // can have two of them open at once.
        await new Promise(resolve => setTimeout(resolve, 5))
        if (options.refuseReads?.() === true) return new Response('directory unavailable', { status: 503 })
        const names = options.catalogs[url.origin]
      if (names === undefined) return new Response('no catalog on this host', { status: 500 })
      // Shaped like the measured table: a named, visible configuration that
      // declares what it is. The picker's filter reads those fields, and a stub
      // without them describes an internal row rather than a model.
      return new Response(JSON.stringify({
        config_info_list: names.map(id => ({
          config_name: id,
          is_invisible_to_user: false,
          display_config: { display_name: id.toUpperCase(), model_capability: 'reasoning_model' },
        })),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      } finally {
        inFlight -= 1
      }
    }
    if (url.pathname === '/api/agent/v3/llm_utils_chat') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      const attempt = chats.length
      chats.push({ host: url.origin, authorization: headers.get('authorization') ?? '', model: body.model ?? '' })
      return new Response(options.chat(url.origin, attempt), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected upstream call: ${url.href}`)
  })
  return { chats, directoryReads, directoryPeak: () => peak }
}

const CN_ONLY = 'glm-5.2'
const SG_ONLY = 'gpt-5.6-terra'
const SHARED = 'solo-auto'

/** A China account and an international one, both healthy. */
function mixedPool(): readonly Record<string, unknown>[] {
  return [
    accountRow({}),
    accountRow({ id: 'sg-1', realm: 'sg', uid: 'u-sg', nickname: 'sg-user', accessToken: 'access-sg', refreshToken: 'refresh-sg' }),
  ]
}

afterEach(() => { vi.restoreAllMocks() })

describe('Trae realm routing', () => {
  it('sends a model the international catalog owns to the international account, from a cold cache', () => {
    // The regression: the realm decision used to read only catalogs this process
    // had already cached, and the cache lives in memory — so the first turn after a
    // Host restart had no opinion, tried the active China account, and reported the
    // other realm's `4001` as a bad model name.
    const upstream = serveUpstream({
      catalogs: { [CN_CHAT]: [CN_ONLY], [SG_CHAT]: [SG_ONLY] },
      chat: () => answer('hello'),
    })
    const client = new TraeClient(vault(mixedPool(), 'cn-1'), async () => undefined)
    return client.chat({ model: SG_ONLY, messages: [userMessage('hi')] }).then(async response => {
      await response.text()
      expect(upstream.chats).toHaveLength(1)
      expect(upstream.chats[0]!.host).toBe(SG_CHAT)
      // The international account's own session signs it: the routing decides the
      // account, not just the host.
      expect(upstream.chats[0]!.authorization).toBe('Cloud-IDE-JWT access-sg')
      expect(upstream.chats[0]!.model).toBe(SG_ONLY)
    })
  })

  it('reads no catalog to route inside a one-realm pool', () => {
    // A China-only pool has no routing decision to make, and the first turn after a
    // restart is the one place an extra round trip would be felt. It is also what a
    // pool holding international accounts only gets: nothing to compare against.
    const upstream = serveUpstream({ catalogs: { [CN_CHAT]: [CN_ONLY] }, chat: () => answer('ok') })
    const client = new TraeClient(vault([accountRow({}), accountRow({ id: 'cn-2', uid: 'u-cn-2', accessToken: 'access-cn-2' })], 'cn-1'), async () => undefined)
    return client.chat({ model: CN_ONLY, messages: [userMessage('hi')] }).then(async response => {
      await response.text()
      expect(upstream.directoryReads).toEqual([])
      expect(upstream.chats[0]!.host).toBe(CN_CHAT)
    })
  })

  it('keeps the realm that owns the model ahead of the other realm when an account is spent', () => {
    // The round-robin rule that matters in a mixed pool: a spent allowance belongs to
    // the account, so the next account of the *same* realm is tried before an account
    // that cannot serve this name at all.
    const upstream = serveUpstream({
      catalogs: { [CN_CHAT]: [CN_ONLY], [SG_CHAT]: [SG_ONLY] },
      chat: (_host, attempt) => attempt === 0 ? refusal(4008, 'ide_credits exhausted') : answer('second try'),
    })
    const pool = [
      accountRow({}),
      accountRow({ id: 'cn-2', uid: 'u-cn-2', accessToken: 'access-cn-2' }),
      accountRow({ id: 'sg-1', realm: 'sg', uid: 'u-sg', accessToken: 'access-sg' }),
    ]
    const client = new TraeClient(vault(pool, 'cn-1'), async () => undefined)
    return client.chat({ model: CN_ONLY, messages: [userMessage('hi')] }).then(async response => {
      expect(await response.text()).toContain('second try')
      expect(upstream.chats.map(call => call.authorization)).toEqual(['Cloud-IDE-JWT access-cn', 'Cloud-IDE-JWT access-cn-2'])
      expect(upstream.chats.every(call => call.host === CN_CHAT)).toBe(true)
    })
  })

  it('does not spend another account on a name the realm itself rejects', async () => {
    // `4001` is the same answer from every account — it is the realm refusing the
    // name — so walking the pool on one spends every account to reach it again.
    const upstream = serveUpstream({
      catalogs: { [CN_CHAT]: [CN_ONLY], [SG_CHAT]: [SG_ONLY] },
      chat: () => refusal(4001, 'param is invalid'),
    })
    const client = new TraeClient(vault(mixedPool(), 'cn-1'), async () => undefined)
    await expect(client.chat({ model: SG_ONLY, messages: [userMessage('hi')] })).rejects.toMatchObject({ code: 4001 })
    expect(upstream.chats).toHaveLength(1)
  })

  it('tells the user the name may belong to the other deployment when a realm rejects it', async () => {
    // The user-facing half of the same fact: the code alone reads as a broken
    // request, and the sentence is what points at the deployment split.
    serveUpstream({ catalogs: { [CN_CHAT]: [] }, chat: () => refusal(4001, 'param is invalid') })
    const adapter = new TraeAdapter(new TraeClient(vault([accountRow({})], 'cn-1'), async () => undefined))
    const pending = adapter.stream({ provider: 'trae', model: CN_ONLY, messages: [userMessage('hi')] })[Symbol.asyncIterator]().next()
    const failure = await pending.then(() => new Error('the turn was expected to fail'), (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'UPSTREAM_4001' })
    expect(String((failure as Error).message)).toContain('国内版')
  })

  it('reads both realms together rather than one after the other', async () => {
    // The model catalog the picker opens with builds every provider in parallel and
    // waits for the slowest, so sequential realm reads make this connector cost the
    // sum of its reads instead of the worst single one — and that catalog is what a
    // slow menu open waits for.
    const upstream = serveUpstream({
      catalogs: { [CN_CHAT]: [CN_ONLY], [SG_CHAT]: [SG_ONLY] },
      chat: () => answer('ok'),
    })
    await new TraeClient(vault(mixedPool(), 'cn-1'), async () => undefined).directoryModels()
    expect(upstream.directoryReads).toEqual([CN_CHAT, SG_CHAT])
    expect(upstream.directoryPeak()).toBe(2)
  })

  it('merges both realms into one directory, the active realm first and a shared name once', async () => {
    const upstream = serveUpstream({
      catalogs: { [CN_CHAT]: [CN_ONLY, SHARED], [SG_CHAT]: [SG_ONLY, SHARED] },
      chat: () => answer('ok'),
    })
    const rows = await new TraeClient(vault(mixedPool(), 'sg-1'), async () => undefined).directoryModels()
    // Two rows with one id would be two picker entries the Harness cannot tell
    // apart, so the realm that listed it first keeps it — here, the active one.
    expect(rows.map(row => `${row.realm}:${row.id}`)).toEqual([`sg:${SG_ONLY}`, `sg:${SHARED}`, `cn:${CN_ONLY}`])
    expect(upstream.directoryReads).toEqual([SG_CHAT, CN_CHAT])
  })

  it('answers an expired listing from the last read and refreshes behind it', async () => {
    // The picker renders this list on every model-menu open, so a read it waits on
    // is a menu that lags. Past the TTL the answer comes from what is already in
    // hand, and the refresh runs behind it so the list still converges.
    const catalogs: Record<string, readonly string[]> = { [CN_CHAT]: [CN_ONLY], [SG_CHAT]: [SG_ONLY] }
    const upstream = serveUpstream({ catalogs, chat: () => answer('ok') })
    const client = new TraeClient(vault(mixedPool(), 'cn-1'), async () => undefined)
    expect((await client.directoryModels()).map(row => row.id)).toEqual([CN_ONLY, SG_ONLY])
    expect(upstream.directoryReads).toEqual([CN_CHAT, SG_CHAT])
    // The upstream moves on while the stowed list ages: the next listing is
    // answered with what it has, which is what tells a stale answer apart from a
    // round trip the caller waited for.
    catalogs[CN_CHAT] = ['glm-9.9']
    catalogs[SG_CHAT] = ['gpt-9']
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
    expect((await client.directoryModels()).map(row => row.id)).toEqual([CN_ONLY, SG_ONLY])
    // ...and the refresh behind it converges, so the picker catches up by itself.
    await vi.waitFor(async () => { expect((await client.directoryModels()).map(row => row.id)).toEqual(['glm-9.9', 'gpt-9']) })
    expect(upstream.directoryReads).toEqual([CN_CHAT, SG_CHAT, CN_CHAT, SG_CHAT])
  })

  it('keeps the list it has when the refresh behind a listing fails', async () => {
    // A stalled upstream must not empty the picker: the history of a table is not
    // evidence that the table is empty, and publishing the failure's empty list
    // would hide every model of that realm until the upstream came back.
    let down = false
    const upstream = serveUpstream({
      catalogs: { [CN_CHAT]: [CN_ONLY], [SG_CHAT]: [SG_ONLY] },
      chat: () => answer('ok'),
      refuseReads: () => down,
    })
    const client = new TraeClient(vault(mixedPool(), 'cn-1'), async () => undefined)
    await client.directoryModels()
    down = true
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    expect((await client.directoryModels()).map(row => row.id)).toEqual([CN_ONLY, SG_ONLY])
    await vi.waitFor(() => { expect(upstream.directoryReads).toEqual([CN_CHAT, SG_CHAT, CN_CHAT, SG_CHAT]) })
    // And the failing read is not restarted on every render: it is quiet until the
    // backoff passes, so a broken upstream does not turn into a request per frame.
    expect((await client.directoryModels()).map(row => row.id)).toEqual([CN_ONLY, SG_ONLY])
    expect(upstream.directoryReads).toEqual([CN_CHAT, SG_CHAT, CN_CHAT, SG_CHAT])
  })

  it('keeps listing the realm it could read when the other realm refuses its directory', async () => {
    const upstream = serveUpstream({ catalogs: { [CN_CHAT]: [CN_ONLY] }, chat: () => answer('ok') })
    const client = new TraeClient(vault(mixedPool(), 'cn-1'), async () => undefined)
    const rows = await client.directoryModels()
    expect(rows.map(row => row.id)).toEqual([CN_ONLY])
    // And the failed read is not repeated on every render: the answer is held for
    // the catalog TTL, the same as a successful one.
    await client.directoryModels()
    expect(upstream.directoryReads).toEqual([CN_CHAT, SG_CHAT])
  })

  it('serves a United States account from its own chat deployment', async () => {
    // The international product's regional split: same auth, different chat host.
    const upstream = serveUpstream({
      catalogs: { [SG_CHAT]: [SG_ONLY], 'https://coreva-normal.trae.ai': [SG_ONLY] },
      chat: () => answer('ok'),
    })
    const pool = [accountRow({ id: 'us-1', realm: 'sg', uid: 'u-us', userRegion: 'US', accessToken: 'access-us' })]
    const client = new TraeClient(vault(pool, 'us-1'), async () => undefined)
    return client.chat({ model: SG_ONLY, messages: [userMessage('hi')] }).then(async response => {
      await response.text()
      expect(upstream.chats[0]!.host).toBe('https://coreva-normal.trae.ai')
    })
  })
})

describe('Trae token host fallback', () => {
  it('moves to the realm’s other token host when the first answers a gateway page', async () => {
    // A 200 that is not JSON is a name that does not serve this API — the second
    // wrong-host answer, and the reason a realm lists more than one token host.
    const hosts: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      hosts.push(url.origin)
      if (url.origin === CN_AUTH[0]) return new Response('<!doctype html><html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response(JSON.stringify({ Result: { Token: 'token-2', RefreshToken: 'refresh-2', TokenExpireAt: Date.now() + 3_600_000 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await expect(exchangeTraeToken('refresh-1', 'cn')).resolves.toMatchObject({ accessToken: 'token-2', refreshToken: 'refresh-2' })
    expect(hosts).toEqual(CN_AUTH)
  })

  it('reports a credential refusal instead of asking the next host the same question', async () => {
    // The asymmetry is deliberate: a JSON refusal names the credential or the
    // client id, and the next host answers it identically.
    const hosts: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      hosts.push(new URL(String(input)).origin)
      return new Response(JSON.stringify({ code: 10101, message: 'refresh token is not matched to the client' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await expect(exchangeTraeToken('refresh-1', 'cn')).rejects.toThrow(/TRAE_TOKEN_EXCHANGE_RETURNED_NO_TOKEN/u)
    expect(hosts).toEqual([CN_AUTH[0]])
  })
})
