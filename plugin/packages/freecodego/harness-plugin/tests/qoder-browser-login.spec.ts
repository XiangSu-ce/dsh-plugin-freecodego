import { afterEach, describe, expect, it, vi } from 'vitest'
import { qoderPollBrowserLogin, qoderStartBrowserLogin } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'
import type { QoderAccount } from '../src/qoder/types.ts'

// The browser step is the OS's business and must not be spawned by a test.
vi.mock('../src/system-browser.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/system-browser.ts')>()
  return { ...actual, openUrlInSystemBrowser: async () => true }
})

const POLL_URL = 'https://openapi.qoder.sh/api/v1/deviceToken/poll'
const USERINFO_URL = 'https://openapi.qoder.sh/api/v1/userinfo'
const PLAN_URL = 'https://openapi.qoder.sh/api/v2/user/plan'

const DEVICE_TOKEN = 'dt-issued-by-upstream'
const REFRESH_TOKEN = 'drt-issued-by-upstream'

/** One fake upstream that counts poll exchanges and can hold one open. */
interface FakeUpstream {
  /** How many device-token exchanges upstream was asked for. */
  readonly pollCalls: () => number
  /** Hold the next identity read open, modelling an exchange that takes seconds. */
  readonly hold: () => void
  /** Release the held identity read. */
  readonly release: () => void
  /** Fail the identity read so the token cannot be stored. */
  readonly failIdentity: () => void
}

function fakeUpstream(): FakeUpstream {
  let pollCalls = 0
  let held = false
  let release: (() => void) | undefined
  let failIdentity = false
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    const json = (status: number, body: Record<string, unknown>): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith(POLL_URL)) {
      pollCalls += 1
      return json(200, { token: DEVICE_TOKEN, refresh_token: REFRESH_TOKEN })
    }
    if (url.startsWith(USERINFO_URL)) {
      if (held) await new Promise<void>((resolve) => { release = resolve })
      if (failIdentity) return json(500, { message: 'identity unavailable' })
      return json(200, { userId: 'u-1', email: 'ada@example.com', name: 'Ada', userType: 'personal_standard' })
    }
    if (url.startsWith(PLAN_URL)) return json(200, { plan_tier_name: 'Pro Trial' })
    throw new Error(`unexpected request: ${url}`)
  })
  return {
    pollCalls: () => pollCalls,
    hold: () => { held = true },
    release: () => { held = false; release?.() },
    failIdentity: () => { failIdentity = true },
  }
}

/**
 * The one Host surface this remote reaches: the pool it stores into and the
 * status every answer is read back from.
 */
function host(): { readonly value: AccountRemotesHost; readonly stored: readonly QoderAccount[] } {
  const stored: QoderAccount[] = []
  const catalogs = {
    qoderAccounts: vi.fn(async () => stored),
    qoderActiveAccountId: vi.fn(async () => stored[0]?.id),
    qoderFreeModels: vi.fn(async () => []),
    invalidateQoderCatalog: vi.fn(),
    qoderImportAccount: vi.fn(async (input: { readonly deviceToken: string; readonly uid?: string; readonly name?: string; readonly region?: 'global' | 'cn' }) => {
      stored.length = 0
      stored.push({
        id: input.uid ?? `qoder-${input.deviceToken.slice(-12)}`,
        region: input.region ?? 'global',
        deviceToken: input.deviceToken,
        ...(input.name === undefined ? {} : { name: input.name }),
        createdAt: 1,
        lastChecked: 1,
      })
    }),
  }
  const value = { catalogs, ctx: { emit: vi.fn() } } as unknown as AccountRemotesHost
  return { value, stored }
}

async function loginTicket(): Promise<string> {
  const started = await qoderStartBrowserLogin({} as AccountRemotesHost)
  return started.state
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Qoder browser login polling', () => {
  it('answers a repeat poll for a finished ticket with the stored account', async () => {
    // The Settings page polls on a timer, so asking the same ticket twice is
    // normal. Deleting the ticket on success made that second question answer
    // `authorization is no longer pending`, which the card rendered as a failed
    // sign-in — while the account it had just stored was sitting in the vault.
    const upstream = fakeUpstream()
    const target = host()
    const state = await loginTicket()

    const first = await qoderPollBrowserLogin(target.value, state)
    expect(first).toMatchObject({ pending: false })

    const second = await qoderPollBrowserLogin(target.value, state)
    expect(second).toMatchObject({ pending: false })
    expect(second).toMatchObject({ state: { configured: true, accounts: [{ name: 'Ada' }] } })
    // The replay reads the stored account; it never exchanges the spent nonce.
    expect(upstream.pollCalls()).toBe(1)
  })

  it('joins an exchange that is already running instead of starting a second', async () => {
    const upstream = fakeUpstream()
    const target = host()
    const state = await loginTicket()
    upstream.hold()

    const first = qoderPollBrowserLogin(target.value, state)
    const second = qoderPollBrowserLogin(target.value, state)
    // Both calls are inside the same exchange: one upstream poll, not two.
    await Promise.resolve()
    expect(upstream.pollCalls()).toBe(1)

    upstream.release()
    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(left).toMatchObject({ pending: false })
    expect(upstream.pollCalls()).toBe(1)
    expect(target.value.catalogs.qoderImportAccount).toHaveBeenCalledTimes(1)
  })

  it('keeps a ticket pending while upstream has not authorized it yet', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))
    const target = host()
    const state = await loginTicket()

    expect(await qoderPollBrowserLogin(target.value, state)).toEqual({ pending: true })
    expect(await qoderPollBrowserLogin(target.value, state)).toEqual({ pending: true })
    expect(target.value.catalogs.qoderImportAccount).not.toHaveBeenCalled()
  })

  it('refuses a state this Host never issued', async () => {
    const target = host()
    const failure = await qoderPollBrowserLogin(target.value, 'not-a-ticket')
      .then(() => new Error('the poll was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('QODER_LOGIN_FAILED: authorization is no longer pending')
  })

  it('stops answering once the authorization window has passed', async () => {
    vi.useFakeTimers()
    const target = host()
    const state = await loginTicket()

    vi.setSystemTime(Date.now() + 11 * 60_000)
    const failure = await qoderPollBrowserLogin(target.value, state)
      .then(() => new Error('the poll was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('QODER_LOGIN_FAILED: authorization timed out')
  })

  it('reports a token it could not store instead of hiding it and hanging', async () => {
    // Upstream has already spent the nonce by the time the identity read fails,
    // so this ticket can never produce an account: the caller has to hear the
    // failure, and a retry has to start a new sign-in rather than poll on.
    const upstream = fakeUpstream()
    const target = host()
    const state = await loginTicket()
    upstream.failIdentity()

    const failure = await qoderPollBrowserLogin(target.value, state)
      .then(() => new Error('the poll was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('Qoder userinfo failed: HTTP 500')
    expect(target.stored).toHaveLength(0)

    const retry = await qoderPollBrowserLogin(target.value, state)
      .then(() => new Error('the retry was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(retry.message).toContain('QODER_LOGIN_FAILED: authorization is no longer pending')
  })
})
