import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WorkBuddyInternationalAccount } from '../src/types.ts'
import {
  WorkBuddyIntlClient,
  parseWorkBuddyCreditPackage,
  summarizeWorkBuddyCredits,
} from '../src/workbuddy-intl.ts'
import { WorkBuddyPoolService } from '../src/workbuddy-pool.ts'

const DAY = 24 * 3_600_000
const NOW = Date.parse('2026-09-13T10:00:00Z')

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function account(id = 'a'): WorkBuddyInternationalAccount {
  return { id, accessToken: `token-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + DAY, creditTotal: 0, lastChecked: 0, uid: id, domain: 'workbuddy.ai' }
}

function store(accounts: readonly WorkBuddyInternationalAccount[]): CredentialProvider {
  const value = JSON.stringify({ accounts })
  return {
    resolve: vi.fn(async ref => ref === 'WORKBUDDY_INTL_STORE' ? { value, source: 'test' } : undefined),
    describe: vi.fn(async () => ({ configured: true, writable: true })),
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
  } as unknown as CredentialProvider
}

afterEach(() => vi.restoreAllMocks())

describe('credit package parsing', () => {
  it('reads the cockpit shape with a precise remaining amount and an expiry', () => {
    const parsed = parseWorkBuddyCreditPackage({
      PackageCode: 'TCACA_code_007_nzdH5h4Nl0',
      PackageName: '活动赠送包',
      CycleCapacitySizePrecise: '100.5',
      CycleCapacityRemainPrecise: '75.25',
      DeductionEndTime: NOW + 2 * DAY,
      Status: 0,
    }, NOW)
    expect(parsed).toMatchObject({ packageName: '活动赠送包', total: 100.5, remaining: 75.25, used: 25.25, expiringSoon: true, expired: false })
  })

  it('reads the summary shape and derives the missing half of the equation', () => {
    const parsed = parseWorkBuddyCreditPackage({ PackageCode: 'summary', CycleTotalCapacity: '4485', CycleUsedCapacity: '2156.71' }, NOW)
    expect(parsed.total).toBe(4485)
    expect(parsed.used).toBeCloseTo(2156.71)
    expect(parsed.remaining).toBeCloseTo(2328.29)
    expect(parsed.expireAt).toBeUndefined()
    expect(parsed.expiringSoon).toBe(false)
  })

  it('reads an expiry from seconds, ISO text, and a bare date without inventing amounts', () => {
    expect(parseWorkBuddyCreditPackage({ ExpiredTime: 1_800_000_000 }, NOW).expireAt).toBe(1_800_000_000_000)
    expect(parseWorkBuddyCreditPackage({ ExpiredTime: '2026-09-20T00:00:00Z' }, NOW).expireAt).toBe(Date.parse('2026-09-20T00:00:00Z'))
    expect(parseWorkBuddyCreditPackage({ ExpiredTime: '2026-09-20' }, NOW).expireAt).toBe(Date.parse('2026-09-20'))
    expect(parseWorkBuddyCreditPackage({}, NOW)).toMatchObject({ total: 0, remaining: 0, used: 0 })
  })
})

describe('credit summarization', () => {
  it('sums every package and reports only live expiries', () => {
    const summary = summarizeWorkBuddyCredits([
      parseWorkBuddyCreditPackage({ CycleCapacitySizePrecise: 80, CycleCapacityRemainPrecise: 30, DeductionEndTime: NOW + 2 * DAY }, NOW),
      parseWorkBuddyCreditPackage({ CycleCapacitySizePrecise: 20, CycleCapacityRemainPrecise: 10, DeductionEndTime: NOW + 30 * DAY }, NOW),
      // An emptied package must not drag the soonest expiry down.
      parseWorkBuddyCreditPackage({ CycleCapacitySizePrecise: 5, CycleCapacityRemainPrecise: 0, DeductionEndTime: NOW - DAY }, NOW),
    ], NOW)
    expect(summary).toMatchObject({ total: 105, remaining: 40, used: 65, expiringSoon: true, expired: false, checkedAt: NOW })
    expect(summary.soonestExpireAt).toBe(NOW + 2 * DAY)
  })
})

describe('WorkBuddyIntlClient credits', () => {
  it('asks the three resource questions with the web client identity', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push(url)
      const headers = new Headers(init?.headers)
      expect(headers.get('x-client-platform')).toBe('web')
      expect(headers.get('x-user-id')).toBe('a')
      if (url.endsWith('get-user-resource-summary')) {
        return json({ code: 0, data: { Packages: [
          { PackageCode: 'activity', CycleTotalCapacity: 100, CycleRemainCapacity: 80 },
          { PackageCode: 'free', CycleTotalCapacity: 500, CycleRemainCapacity: 300 },
        ] } })
      }
      if (url.endsWith('paid-packages')) {
        return json({ code: 0, data: { Accounts: [
          { PackageCode: 'activity', CycleCapacitySizePrecise: '60', CycleCapacityRemainPrecise: '40', DeductionEndTime: Date.now() + 2 * DAY },
        ] } })
      }
      if (url.endsWith('free-packages')) return json({ code: 0, data: { Accounts: [] } })
      throw new Error(`unexpected url ${url}`)
    })
    const client = new WorkBuddyIntlClient(store([account()]))
    const snapshot = await client.credits(account())
    expect(calls).toHaveLength(3)
    // The detail row wins over the summary row for the same package.
    expect(snapshot.credits.packages.map(entry => entry.packageCode)).toEqual(['activity', 'free'])
    expect(snapshot.credits.total).toBe(560)
    expect(snapshot.credits.remaining).toBe(340)
    expect(snapshot.credits.expiringSoon).toBe(true)
  })

  it('treats a valid empty answer as final and never reaches the legacy query', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('get-user-resource-summary')) return json({ code: 0, data: { Packages: [] } })
      if (url.endsWith('paid-packages') || url.endsWith('free-packages')) return json({ code: 0, data: { Accounts: [] } })
      throw new Error(`unexpected url ${url}`)
    })
    const client = new WorkBuddyIntlClient(store([account()]))
    const snapshot = await client.credits(account())
    expect(snapshot.credits.packages).toEqual([])
    expect(snapshot.credits.remaining).toBe(0)
    expect(calls.some(url => url.endsWith('/v2/billing/meter/get-user-resource'))).toBe(false)
  })

  it('falls back to the aggregate query when no resource answer is understood', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('get-user-resource-summary') || url.endsWith('paid-packages') || url.endsWith('free-packages')) {
        return json({ code: 500, message: 'bad request' })
      }
      return json({ code: 0, data: { Accounts: [{ PackageCode: 'legacy', CycleCapacitySizePrecise: '10', CycleCapacityRemainPrecise: '4' }] } })
    })
    const client = new WorkBuddyIntlClient(store([account()]))
    const snapshot = await client.credits(account())
    expect(calls.some(url => url.endsWith('/v2/billing/meter/get-user-resource'))).toBe(true)
    expect(snapshot.credits).toMatchObject({ total: 10, remaining: 4, used: 6 })
  })

  it('reports the upstream reason when even the fallback is refused', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ code: 500, message: 'gateway unavailable' }))
    const client = new WorkBuddyIntlClient(store([account()]))
    const snapshot = await client.credits(account())
    expect(snapshot.credits.error).toBe('gateway unavailable')
    expect(snapshot.credits.remaining).toBe(0)
  })
})


describe('WorkBuddyPoolService', () => {
  /** `credits` is a spy, so the specs read it as a mock instead of calling it. */
  type FakeWorkBuddyClient = WorkBuddyIntlClient & { readonly credits: Mock }

  const fakeClient = (overrides: Partial<WorkBuddyIntlClient> = {}): FakeWorkBuddyClient => ({
    credits: vi.fn(async (target: WorkBuddyInternationalAccount) => ({
      account: target,
      credits: summarizeWorkBuddyCredits([parseWorkBuddyCreditPackage({ CycleCapacitySizePrecise: '100', CycleCapacityRemainPrecise: '40' }, NOW)], NOW),
    })),
    ...overrides,
  } as unknown as FakeWorkBuddyClient)

  function service(client: WorkBuddyIntlClient, accounts: readonly WorkBuddyInternationalAccount[]) {
    const persisted: { readonly id: string; readonly update: { readonly credits?: unknown } }[] = []
    const pool = new WorkBuddyPoolService({
      client: () => client,
      accounts: async () => accounts,
      persist: async (id, update) => { persisted.push({ id, update }) },
    })
    return { pool, persisted }
  }

  it('reads one credit snapshot per account and persists it', async () => {
    const client = fakeClient()
    const { pool, persisted } = service(client, [account('a'), account('b')])
    const results = await pool.run()
    expect(client.credits).toHaveBeenCalledTimes(2)
    expect(results.map(result => result.accountId)).toEqual(['a', 'b'])
    expect(results[0]?.credits?.remaining).toBe(40)
    expect(persisted[0]?.update.credits).toBeDefined()
  })

  it('shares one in-flight sweep instead of running a second', async () => {
    const client = fakeClient()
    const { pool } = service(client, [account('a')])
    const first = pool.run()
    expect(pool.busy).toBe(true)
    const second = pool.run()
    expect(second).toBe(first)
    await first
    expect(pool.busy).toBe(false)
    expect(client.credits).toHaveBeenCalledTimes(1)
  })

  it('keeps sweeping the rest of the pool when one account throws', async () => {
    const client = fakeClient({
      credits: vi.fn(async (target: WorkBuddyInternationalAccount) => {
        if (target.id === 'a') throw new Error('boom')
        return { account: target, credits: summarizeWorkBuddyCredits([], NOW) }
      }),
    })
    const { pool } = service(client, [account('a'), account('b')])
    const results = await pool.run()
    expect(results[0]?.error).toBe('boom')
    expect(results[1]?.error).toBeUndefined()
  })

  it('records a failed credit query without zeroing the stored balance', async () => {
    const client = fakeClient({
      credits: vi.fn(async (target: WorkBuddyInternationalAccount) => ({
        account: target,
        credits: summarizeWorkBuddyCredits([], NOW, 'gateway unavailable'),
      })),
    })
    const { pool } = service(client, [account('a')])
    const results = await pool.run()
    expect(results[0]?.error).toBe('gateway unavailable')
    expect(results[0]?.credits?.error).toBe('gateway unavailable')
  })

  it('does nothing without a client or without accounts', async () => {
    const empty = new WorkBuddyPoolService({ client: () => undefined, accounts: async () => [account('a')], persist: async () => undefined })
    expect(await empty.run()).toEqual([])
    const client = fakeClient()
    const { pool } = service(client, [])
    expect(await pool.run()).toEqual([])
    expect(client.credits).not.toHaveBeenCalled()
  })
})
