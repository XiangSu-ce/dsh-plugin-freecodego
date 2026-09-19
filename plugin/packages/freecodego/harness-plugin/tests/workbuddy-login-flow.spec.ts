import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AccountRemotesHost } from '../src/account-remotes.ts'
import { workbuddyPollBrowserLogin, workbuddyStartBrowserLogin, workbuddyStatus } from '../src/account-remotes.ts'
import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'
import type { FreeCodeGoManagedCatalogsDeps } from '../src/managed-catalogs.ts'
import { WorkBuddyIntlClient } from '../src/workbuddy-intl.ts'

// The sign-in itself opens the system browser; a test must never do that.
// Only the OS opener is stubbed (a test run must not launch a browser).
// Everything else in the module — notably the http(s) allow-list that the
// authorization tickets are validated with — stays the real implementation, so
// this suite cannot pass against a mocked-out security check.
vi.mock('../src/system-browser.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/system-browser.ts')>()
  return { ...actual, openUrlInSystemBrowser: vi.fn(async () => true) }
})

/** The vault document the card, the adapter, and the directory all read. */
function vault(initial?: string): { readonly provider: CredentialProvider; readonly read: () => string | undefined } {
  let value = initial
  return {
    read: () => value,
    provider: {
      resolve: vi.fn(async (ref: unknown) => ref === 'WORKBUDDY_INTL_STORE' ? (value === undefined ? undefined : { value, source: 'test' }) : undefined),
      describe: vi.fn(async () => ({ configured: value !== undefined, writable: true })),
      set: vi.fn(async (ref: unknown, next: string) => { if (ref === 'WORKBUDDY_INTL_STORE') value = next }),
      unset: vi.fn(async (ref: unknown) => { if (ref === 'WORKBUDDY_INTL_STORE') value = undefined }),
    } as unknown as CredentialProvider,
  }
}

/** The product document listing the routes this pool may serve. */
const DOCUMENT = {
  code: 0,
  data: {
    agents: [{ name: 'cli', models: ['auto', 'deepseek-v4'] }],
    models: [
      { id: 'auto', name: 'Auto', credits: 'x0.00', maxInputTokens: 200_000, maxOutputTokens: 32_000 },
      { id: 'deepseek-v4', name: 'DeepSeek V4', credits: 'x0.00', maxInputTokens: 128_000, maxOutputTokens: 16_000 },
    ],
  },
}

const GRANTED = {
  code: 0,
  msg: 'OK',
  data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3_600, uid: 'u-1', domain: 'workbuddy.ai', nickname: 'me@test.dev' },
}

/** The device-authorization grant the product issues before any browser step. */
const AUTH_STATE = {
  code: 0,
  msg: 'OK',
  data: {
    state: 'srv-state-1',
    authUrl: 'https://www.workbuddy.ai/login?platform=CLI&state=srv-state-1',
  },
}

/** The Host view the WorkBuddy remotes need, over a real catalog host. */
function host(provider: CredentialProvider): AccountRemotesHost {
  const client = new WorkBuddyIntlClient(provider, account => catalogs.workbuddyPersistTokens(account))
  const catalogs = new FreeCodeGoManagedCatalogs({
    credentials: () => provider,
    workbuddy: () => client,
  } as unknown as FreeCodeGoManagedCatalogsDeps)
  return {
    ctx: { emit: vi.fn() },
    catalogs,
  } as unknown as AccountRemotesHost
}

afterEach(() => vi.restoreAllMocks())

describe('WorkBuddy sign-in button flow', () => {
  it('opens the server-issued authorization URL for the state the product minted', async () => {
    const { provider } = vault()
    const stateCalls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://www.workbuddy.ai/v2/plugin/auth/state')) {
        stateCalls.push(`${init?.method ?? 'GET'} ${url}`)
        return new Response(JSON.stringify(AUTH_STATE), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    const ticket = await workbuddyStartBrowserLogin(host(provider))
    expect(ticket.note).toBeUndefined()
    // The grant is requested, never invented: a client-side state can never be
    // bound to the browser step, so the card polled forever.
    expect(stateCalls).toHaveLength(1)
    expect(stateCalls[0]).toContain('/v2/plugin/auth/state')
    expect(stateCalls[0]).toContain('platform=CLI')
    const url = new URL(ticket.loginUrl)
    expect(url.origin).toBe('https://www.workbuddy.ai')
    expect(url.pathname).toBe('/login')
    // The poll key and the opened URL are the product's own pair, not ours.
    expect(url.searchParams.get('state')).toBe(ticket.state)
    expect(ticket.state).toBe('srv-state-1')
    expect(ticket.expiresAt).toBeGreaterThan(Date.now())
  })

  it('fails loudly when the product refuses to issue a grant', async () => {
    const { provider } = vault()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    await expect(workbuddyStartBrowserLogin(host(provider))).rejects.toThrow(/WORKBUDDY_LOGIN_FAILED/)
  })

  it('keeps waiting while the browser step is unfinished, then stores the account', async () => {
    const { provider, read } = vault()
    let issued = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://www.workbuddy.ai/v2/plugin/auth/state')) {
        return new Response(JSON.stringify(AUTH_STATE), { status: 200 })
      }
      if (url.startsWith('https://www.workbuddy.ai/v2/plugin/auth/token')) {
        return new Response(JSON.stringify(issued ? GRANTED : { code: 11_217, msg: '11217:login ing...' }), { status: 200 })
      }
      if (url.startsWith('https://www.workbuddy.ai/v2/plugin/login/account')) {
        // The identity read is authenticated with the token it belongs to.
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer at-1')
        return new Response(JSON.stringify({ code: 0, data: { uid: 'u-looked-up', nickname: 'looked-up' } }), { status: 200 })
      }
      if (url.startsWith('https://www.workbuddy.ai/v3/config')) return new Response(JSON.stringify(DOCUMENT), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    const remotes = host(provider)
    const ticket = await workbuddyStartBrowserLogin(remotes)
    expect(await workbuddyPollBrowserLogin(remotes, ticket.state)).toEqual({ pending: true })
    expect(read()).toBeUndefined()

    issued = true
    const finished = await workbuddyPollBrowserLogin(remotes, ticket.state)
    expect(finished.pending).toBe(false)
    if (finished.pending) throw new Error('expected the account to be stored')
    // The address the identity provider issued is what the card renders.
    expect(finished.state.accounts).toMatchObject([{ email: 'me@test.dev' }])
    expect(finished.state.freeModels.map(model => model.id)).toEqual(['auto', 'deepseek-v4'])
    // The routing identity survives the round trip: chat requests need it.
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts[0]).toMatchObject({ id: 'u-1', uid: 'u-1', domain: 'workbuddy.ai', refreshToken: 'rt-1' })
  })

  it('completes a grant that arrives without a uid through the identity read', async () => {
    const { provider, read } = vault()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://www.workbuddy.ai/v2/plugin/auth/token')) {
        const { uid: _uid, ...withoutUid } = GRANTED.data
        return new Response(JSON.stringify({ code: 0, data: withoutUid }), { status: 200 })
      }
      if (url.startsWith('https://www.workbuddy.ai/v2/plugin/login/account')) {
        return new Response(JSON.stringify({ code: 0, data: { uid: 'u-looked-up', nickname: 'looked-up', enterpriseId: 'ent-1' } }), { status: 200 })
      }
      return new Response(JSON.stringify(DOCUMENT), { status: 200 })
    })
    const remotes = host(provider)
    const finished = await workbuddyPollBrowserLogin(remotes, 'srv-state-1')
    expect(finished.pending).toBe(false)
    // Without the routing id a stored account could never carry a request.
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts[0]).toMatchObject({ id: 'u-looked-up', uid: 'u-looked-up', enterpriseId: 'ent-1' })
  })

  it('imports a token-only credential under a derived identity instead of crashing', async () => {
    const { provider, read } = vault()
    const remotes = host(provider)
    // Exactly what the desktop import sends when the local credential carries
    // tokens and nothing else: no id, no email, no uid.
    await remotes.catalogs.workbuddyImportAccount({ accessToken: 'at-abcdefghijkl' })
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[]; activeAccountId: string }
    // Last resort identity is derived from the token tail, and it is the active
    // account; an import that throws here leaves the user with no credential.
    expect(stored.accounts).toHaveLength(1)
    expect(stored.accounts[0]?.id).toBe('workbuddy-abcdefghijkl')
    expect(stored.activeAccountId).toBe('workbuddy-abcdefghijkl')
    expect(stored.accounts[0]?.accessToken).toBe('at-abcdefghijkl')
    expect(stored.accounts[0]?.email).toBeUndefined()
    expect(stored.accounts[0]?.uid).toBeUndefined()
    // An imported credential with no usable expiry engages the refresh margin
    // on the first request rather than being treated as already valid.
    expect(Number(stored.accounts[0]?.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('derives the identity from a uid when the import omits the email', async () => {
    const { provider, read } = vault()
    const remotes = host(provider)
    await remotes.catalogs.workbuddyImportAccount({ accessToken: 'at-1', refreshToken: 'rt-1', uid: 'u-9', domain: 'workbuddy.ai' })
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts[0]).toMatchObject({ id: 'u-9', uid: 'u-9', domain: 'workbuddy.ai', refreshToken: 'rt-1' })
  })

  it('reports nothing until a credential exists, then the free directory', async () => {
    const { provider } = vault()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(DOCUMENT), { status: 200 }))
    const remotes = host(provider)
    expect(await workbuddyStatus(remotes)).toMatchObject({ configured: false, accounts: [], freeModels: [] })
  })
})

describe('WorkBuddy token persistence', () => {
  /** One stored pool row, keyed the way the vault holds it. */
  const row = (value: Record<string, unknown>): string => JSON.stringify(value)

  it('never overwrites a different account that has no stored id', async () => {
    // A vault written before rows carried `id` holds a token-only row. Rotating
    // a SECOND account must leave that row alone: matching it by "no id" puts
    // one account's tokens on another row and loses the clobbered refresh token.
    const { provider, read } = vault(row({ accounts: [{ accessToken: 'at-legacy', refreshToken: 'rt-legacy' }, { id: 'u-2', accessToken: 'at-2', refreshToken: 'rt-2' }] }))
    const remotes = host(provider)
    await remotes.catalogs.workbuddyPersistTokens({ id: 'u-2', accessToken: 'at-2-rotated', refreshToken: 'rt-2-rotated', expiresAt: Date.now() + 3_600_000 })
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts[0]).toMatchObject({ accessToken: 'at-legacy', refreshToken: 'rt-legacy' })
    expect(stored.accounts[0]?.expiresAt).toBeUndefined()
    expect(stored.accounts[1]).toMatchObject({ accessToken: 'at-2-rotated', refreshToken: 'rt-2-rotated' })
  })

  it('still reaches a token-only row, which is the account that rotated', async () => {
    // The legacy row above must stay updatable: the reader hands out the id it
    // derived for that row, so a rotation addressed by that id has to land.
    const { provider, read } = vault(row({ accounts: [{ accessToken: 'at-legacy', refreshToken: 'rt-legacy' }] }))
    const remotes = host(provider)
    const derived = (await remotes.catalogs.workbuddyAccounts())[0]?.id
    expect(derived).toBe('workbuddy-at-legacy')
    // Narrowed rather than asserted: the rotation below is addressed by this id.
    if (derived === undefined) throw new Error('the token-only row must be reachable by its derived id')
    await remotes.catalogs.workbuddyPersistTokens({ id: derived, accessToken: 'at-rotated', refreshToken: 'rt-rotated', expiresAt: Date.now() + 3_600_000 })
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts[0]).toMatchObject({ accessToken: 'at-rotated', refreshToken: 'rt-rotated' })
  })

  it('records a credit sweep for a token-only row instead of dropping it', async () => {
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { accessToken: 'at-legacy', refreshToken: 'rt-legacy' }] }))
    const remotes = host(provider)
    const legacy = (await remotes.catalogs.workbuddyAccounts())[1]?.id
    expect(legacy).toBe('workbuddy-at-legacy')
    if (legacy === undefined) throw new Error('the token-only row must be addressable for its credit sweep')
    await remotes.catalogs.workbuddyApplyAccountState(legacy, { credits: { total: 100, remaining: 40, used: 60, checkedAt: 1_789_000_000_000, expiringSoon: false, expired: false, packages: [] } })
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts[1]).toMatchObject({ creditRemaining: 40, creditUsed: 60 })
    // The other account's row is untouched.
    expect(stored.accounts[0]).not.toHaveProperty('creditRemaining')
  })
})

describe('WorkBuddy pool actions', () => {
  const row = (value: Record<string, unknown>): string => JSON.stringify(value)

  /** The id the card would hold for the vault's token-only second row. */
  const legacyIdOf = async (catalogs: FreeCodeGoManagedCatalogs): Promise<string> => {
    const id = (await catalogs.workbuddyAccounts())[1]?.id
    expect(id).toBe('workbuddy-at-legacy')
    if (id === undefined) throw new Error('the token-only row must be addressable')
    return id
  }

  it('removes the account the card listed even when its row carries no id', async () => {
    // The card, the picker and the sweep all address rows by the id the reader
    // derived. `remove` matched the raw `id` field instead, found nothing in a
    // vault written before rows carried one, and returned success: the account
    // was still there on the next read.
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { accessToken: 'at-legacy', refreshToken: 'rt-legacy' }] }))
    const remotes = host(provider)
    await remotes.catalogs.workbuddyRemoveAccount(await legacyIdOf(remotes.catalogs))
    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[] }
    expect(stored.accounts).toHaveLength(1)
    expect(stored.accounts[0]?.id).toBe('u-1')
  })

  it('selects an account the vault only knows by its token tail', async () => {
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { accessToken: 'at-legacy', refreshToken: 'rt-legacy' }], activeAccountId: 'u-1' }))
    const remotes = host(provider)
    const legacy = await legacyIdOf(remotes.catalogs)
    await remotes.catalogs.workbuddySetActiveAccount(legacy)
    expect((JSON.parse(read()!) as { activeAccountId?: string }).activeAccountId).toBe(legacy)
  })

  it('promotes the surviving row under the id the reader hands out', async () => {
    // The promotion read `filtered[0].id`, which is empty for a token-only
    // survivor: the pool recorded no selection at all after a removal.
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { accessToken: 'at-legacy', refreshToken: 'rt-legacy' }], activeAccountId: 'u-1' }))
    const remotes = host(provider)
    await remotes.catalogs.workbuddyRemoveAccount('u-1')
    const stored = JSON.parse(read()!) as { accounts: readonly unknown[]; activeAccountId?: string }
    expect(stored.accounts).toHaveLength(1)
    expect(stored.activeAccountId).toBe('workbuddy-at-legacy')
  })

  it('keeps the selection when an unrelated account is removed', async () => {
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { id: 'u-2', uid: 'u-2', accessToken: 'at-2' }], activeAccountId: 'u-2' }))
    const remotes = host(provider)
    await remotes.catalogs.workbuddyRemoveAccount('u-1')
    const stored = JSON.parse(read()!) as { accounts: readonly unknown[]; activeAccountId?: string }
    expect(stored.accounts).toHaveLength(1)
    expect(stored.activeAccountId).toBe('u-2')
  })

  it('clears the selection when removing the final account', async () => {
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }], activeAccountId: 'u-1' }))
    const remotes = host(provider)
    await remotes.catalogs.workbuddyRemoveAccount('u-1')
    const stored = JSON.parse(read()!) as { accounts: readonly unknown[]; activeAccountId?: string }
    expect(stored.accounts).toEqual([])
    expect(stored.activeAccountId).toBeUndefined()
  })

  it('names the account it could not find instead of a fixed failure sentence', async () => {
    // The not-found error was thrown inside the function that caught it and was
    // replaced by a constant message, so a stale id was indistinguishable from a
    // vault write failure.
    const { provider } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }] }))
    const remotes = host(provider)
    await expect(remotes.catalogs.workbuddySetActiveAccount('u-gone')).rejects.toThrow(/u-gone/u)
  })

  it('reports a removal the vault refused instead of claiming success', async () => {
    const { provider, read } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { id: 'u-2', uid: 'u-2', accessToken: 'at-2' }] }))
    vi.mocked(provider.set).mockRejectedValue(new Error('vault is read-only'))
    const remotes = host(provider)
    await expect(remotes.catalogs.workbuddyRemoveAccount('u-2')).rejects.toThrow(/vault is read-only/u)
    expect((JSON.parse(read()!) as { accounts: readonly unknown[] }).accounts).toHaveLength(2)
  })

  it('reports the account the card selected instead of the first one with a token', async () => {
    // Nothing read the stored selection back: the status recomputed "active" as
    // the first row with a token, so "Use this account" wrote the vault and left
    // the card showing the account the user had moved away from.
    const { provider } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }, { id: 'u-2', uid: 'u-2', accessToken: 'at-2' }], activeAccountId: 'u-2' }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(DOCUMENT), { status: 200 }))
    const remotes = host(provider)
    const status = await workbuddyStatus(remotes)
    expect(status.activeAccountId).toBe('u-2')
    // Both rows are still listed, and each one's own state is unchanged.
    expect(status.accounts.map(account => account.id)).toEqual(['u-1', 'u-2'])
  })

  it('falls back to a serving row when the selection names an account that is gone', async () => {
    const { provider } = vault(row({ accounts: [{ id: 'u-1', uid: 'u-1', accessToken: 'at-1' }], activeAccountId: 'u-gone' }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(DOCUMENT), { status: 200 }))
    const remotes = host(provider)
    expect((await workbuddyStatus(remotes)).activeAccountId).toBe('u-1')
  })
})
