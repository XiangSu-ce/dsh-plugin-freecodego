/**
 * The TRAE sign-in round trip, from the redirect to the stored account.
 *
 * The loopback listener is a real socket here, and the redirect is a real request
 * to it, because that is the seam the flow broke at: the browser did reach the
 * Host, but nothing claimed the authorization until the user pasted the callback
 * by hand. What has to hold is that the redirect alone finishes the sign-in, that
 * one attempt spends the refresh token exactly once, and that a refusal reaches
 * the card instead of disappearing into a page the browser already left.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AccountRemotesHost } from '../src/account-remotes.ts'
import { traePollBrowserLogin, traeStartBrowserLogin, traeStatus, traeSubmitCallback } from '../src/account-remotes.ts'
import { TraeClient, TRAE_STORE_REF } from '../src/trae-intl.ts'
import type { TraeStatus } from '../src/types.ts'
import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'
import type { FreeCodeGoManagedCatalogsDeps } from '../src/managed-catalogs.ts'

// The sign-in opens the system browser; a test must never do that.
vi.mock('../src/system-browser.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/system-browser.ts')>()
  return { ...actual, openUrlInSystemBrowser: vi.fn(async () => true) }
})

/** The vault the account pool lives in. */
function vault(): { readonly provider: CredentialProvider; readonly read: () => string | undefined } {
  let value: string | undefined
  return {
    read: () => value,
    provider: {
      resolve: vi.fn(async (ref: unknown) => ref === TRAE_STORE_REF ? (value === undefined ? undefined : { value, source: 'test' }) : undefined),
      describe: vi.fn(async () => ({ configured: value !== undefined, writable: true })),
      set: vi.fn(async (ref: unknown, next: string) => { if (ref === TRAE_STORE_REF) value = next }),
      unset: vi.fn(async (ref: unknown) => { if (ref === TRAE_STORE_REF) value = undefined }),
    } as unknown as CredentialProvider,
  }
}

/** The Host view the TRAE remotes need, over a real catalog host and pool. */
function host(provider: CredentialProvider): AccountRemotesHost {
  const catalogs = new FreeCodeGoManagedCatalogs({
    credentials: () => provider,
    trae: () => new TraeClient(provider, async () => undefined),
  } as unknown as FreeCodeGoManagedCatalogsDeps)
  return { ctx: { emit: vi.fn() }, catalogs } as unknown as AccountRemotesHost
}

const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'

/**
 * Answer the token exchange, and let every other request through.
 *
 * Passing everything else to the real `fetch` is not optional here: the browser's
 * half of this flow *is* a request to the loopback listener, so a blanket stub
 * would leave it unrouted and the test would prove nothing about it.
 * @param answer - the exchange response, or a promise that stays open to keep it in flight.
 * @returns the refresh tokens the exchange was asked to spend, in order.
 */
function mockExchange(answer: () => Promise<Response> | Response): readonly string[] {
  const spent: string[] = []
  const real = globalThis.fetch.bind(globalThis)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).includes(EXCHANGE_PATH)) return real(input as never, init as never)
    spent.push(String((JSON.parse(String(init?.body)) as { RefreshToken?: string }).RefreshToken))
    return answer()
  })
  return spent
}

/** A token exchange result, in the shape the host answers with. */
function exchanged(token: string): string {
  return JSON.stringify({ Result: { Token: token, RefreshToken: `${token}-refresh`, TokenExpireAt: Date.now() + 86_400_000 } })
}

/** What the sign-in page appends to the callback it redirects to. */
function redirectQuery(refreshToken: string): string {
  return new URLSearchParams({
    isRedirect: 'true',
    scope: 'solo',
    userInfo: JSON.stringify({ UserID: '1599160260758473', ScreenName: 'trae-user', TenantID: 'ent-7' }),
    refreshToken,
  }).toString()
}

/** The loopback URL the Host is listening on for the attempt it just started. */
function callbackUrlOf(status: TraeStatus): string {
  if (status.status !== 'login-pending' || status.loginUrl === undefined) throw new Error(`expected a pending attempt offering a URL, got ${status.status}`)
  const callback = new URL(status.loginUrl).searchParams.get('auth_callback_url')
  if (callback === null) throw new Error('the login URL must carry the loopback callback')
  return callback
}

afterEach(() => { vi.restoreAllMocks() })

describe('Trae sign-in round trip', () => {
  it('stores the account from the redirect alone, without waiting for a poll', async () => {
    const { provider, read } = vault()
    const spent = mockExchange(() => new Response(exchanged('at-1'), { status: 200 }))
    const remotes = host(provider)
    const pending = await traeStartBrowserLogin(remotes, 'cn')
    expect(pending).toMatchObject({ status: 'login-pending', realm: 'cn' })

    // The browser lands on the loopback listener. Nothing else is called: the
    // listener completes the attempt the moment the redirect arrives.
    const page = await fetch(`${callbackUrlOf(pending)}?${redirectQuery('rt-page')}`)
    expect(await page.text()).toContain('授权已收到')
    await vi.waitFor(() => { expect(spent).toEqual(['rt-page']) })

    const stored = JSON.parse(read()!) as { accounts: readonly Record<string, unknown>[]; activeAccountId?: string }
    expect(stored.accounts).toHaveLength(1)
    expect(stored.accounts[0]).toMatchObject({ realm: 'cn', uid: '1599160260758473', accessToken: 'at-1', refreshToken: 'at-1-refresh' })
    expect(stored.activeAccountId).toBe(stored.accounts[0]?.id)

    // The card's poll is what paints it, and it costs no second exchange.
    const settled = await traePollBrowserLogin(remotes)
    expect(settled.status).toBe('authenticated')
    expect(spent).toHaveLength(1)
  })

  it('reports the signed-in state to a reader that never polls', async () => {
    // The card is not the only reader of this status: a panel refresh or another
    // tab asks for it too. A completed attempt must not keep announcing that a
    // browser is still being waited on.
    const { provider } = vault()
    mockExchange(() => new Response(exchanged('at-2'), { status: 200 }))
    const remotes = host(provider)
    const pending = await traeStartBrowserLogin(remotes, 'cn')
    await fetch(`${callbackUrlOf(pending)}?${redirectQuery('rt-page')}`)
    await vi.waitFor(async () => { expect((await traeStatus(remotes)).status).toBe('authenticated') })
  })

  it('spends the refresh token once when a pasted callback arrives mid-exchange', async () => {
    // The paste box exists for a redirect that never arrives. When it *did*
    // arrive, the user is pasting the address of a redirect that is already being
    // exchanged — and `ExchangeToken` rotates the token family, so a second
    // exchange either invalidates the first or is refused for an account that did
    // authorize. That race is the one that used to take ten seconds and sometimes
    // lose.
    const { provider } = vault()
    let release: (() => void) | undefined
    // Held open, so the paste below lands while the redirect's exchange is still
    // in flight — the window the second exchange used to slip through.
    const spent = mockExchange(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return new Response(exchanged('at-3'), { status: 200 })
    })
    const remotes = host(provider)
    const pending = await traeStartBrowserLogin(remotes, 'cn')
    const callback = callbackUrlOf(pending)
    // The redirect arrives; its exchange is stubbed to stay in flight.
    await fetch(`${callback}?${redirectQuery('rt-page')}`)
    await vi.waitFor(() => { expect(spent).toHaveLength(1) })

    const pasted = traeSubmitCallback(remotes, `${callback}?${redirectQuery('rt-page')}`)
    await vi.waitFor(() => { expect(spent).toHaveLength(1) })
    release?.()
    await expect(pasted).resolves.toMatchObject({ status: 'authenticated' })
    expect(spent).toEqual(['rt-page'])
  })

  it('hands the refusal the redirect produced to whoever asks next', async () => {
    const { provider, read } = vault()
    mockExchange(() => new Response(JSON.stringify({ code: 10101, message: 'refresh token is not matched to the client' }), { status: 200 }))
    const remotes = host(provider)
    const pending = await traeStartBrowserLogin(remotes, 'cn')
    await fetch(`${callbackUrlOf(pending)}?${redirectQuery('rt-page')}`)
    // The browser already left with its page, so the failure has to be reported by
    // the next reader rather than thrown into a socket nobody is on.
    await expect(traePollBrowserLogin(remotes)).rejects.toThrow(/TRAE_TOKEN_EXCHANGE_RETURNED_NO_TOKEN/u)
    expect(read()).toBeUndefined()
    // Once reported, the attempt is over: the card offers a fresh sign-in.
    await expect(traePollBrowserLogin(remotes)).rejects.toThrow(/no longer pending/u)
  })

  it('stops listening once the redirect has been answered', async () => {
    // A loopback listener that outlives its attempt is a port held open for a
    // second authorization nobody asked for.
    const { provider } = vault()
    mockExchange(() => new Response(exchanged('at-4'), { status: 200 }))
    const remotes = host(provider)
    const pending = await traeStartBrowserLogin(remotes, 'cn')
    const callback = callbackUrlOf(pending)
    await fetch(`${callback}?${redirectQuery('rt-page')}`)
    await vi.waitFor(async () => { expect((await traeStatus(remotes)).status).toBe('authenticated') })
    await expect(fetch(`${callback}?${redirectQuery('rt-again')}`)).rejects.toThrow()
  })
})
