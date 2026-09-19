/**
 * SenseNova and NVIDIA list their models from the same host and the same bearer
 * token that inference uses. So a directory that answers 401 is not merely
 * unreachable — it is telling us the credential is refused, and every row that
 * still claims `available` is a route the picker offers and that fails on first
 * use. The advisor picker says so in its own words ("must not offer selections
 * that fail on use"), which is why this is pinned per provider.
 *
 * What must *not* change: an unreachable directory (5xx, DNS, timeout) keeps
 * advertising the static free tier, because a listing endpoint being down does
 * not make those routes unusable — that fallback is the whole point of the
 * hardcoded roster.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'

interface Row { readonly id: string; readonly provider?: string; readonly availability?: string; readonly unavailableReason?: string }

let outcome: 'answered' | 'empty' | '401' | '403' | '500' | 'transport' = 'answered'
let base = 0
let events: string[] = []

const TTL_MS = 10 * 60_000
/** Let a background revalidation land: only `Date` is faked in this spec. */
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 20)) }
const at = (offsetMs: number): void => { vi.setSystemTime(base + offsetMs) }

const liveIds = (url: string): readonly { id: string }[] => String(url).includes('nvidia')
  ? [{ id: 'moonshotai/kimi-k3' }, { id: 'deepseek-ai/deepseek-v4-pro-0813' }]
  : [{ id: 'sensenova-6.8-flash-lite' }, { id: 'glm-5.2' }]

beforeEach(() => {
  outcome = 'answered'
  base = Date.now()
  events = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (outcome === 'transport') throw new Error('getaddrinfo ENOTFOUND')
    if (outcome === '401') return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
    if (outcome === '403') return new Response('forbidden', { status: 403 })
    if (outcome === '500') return new Response('upstream exploded', { status: 500 })
    if (outcome === 'empty') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ data: liveIds(String(url)) }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function catalogs(): FreeCodeGoManagedCatalogs {
  return withCredentials({ resolve: async () => ({ value: 'sk-test' }) })
}

/** No credential provider at all, which is how a fresh install looks. */
function catalogsWithoutKey(): FreeCodeGoManagedCatalogs {
  return withCredentials(undefined)
}

function withCredentials(provider: { resolve: () => Promise<{ value: string }> } | undefined): FreeCodeGoManagedCatalogs {
  return new FreeCodeGoManagedCatalogs({
    ctx: { emit: (name: string) => events.push(name), get: () => undefined },
    credentials: () => provider,
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

const availableIds = (rows: readonly Row[]): string[] => rows.filter(row => row.availability === 'available').map(row => row.id)
const reasonsOf = (rows: readonly Row[]): string[] => [...new Set(rows.map(row => row.unavailableReason).filter((reason): reason is string => reason !== undefined))]

type Lister = (instance: FreeCodeGoManagedCatalogs, label: string) => Promise<readonly Row[]>
type Invalidator = (instance: FreeCodeGoManagedCatalogs) => void

describe.each([
  ['sensenova', 'SENSENOVA_API_KEY_REJECTED', ((instance, label) => instance.listSenseNovaModels(label)) as Lister, (instance: FreeCodeGoManagedCatalogs) => instance.invalidateSenseNovaCatalog()],
  ['nvidia', 'NVIDIA_API_KEY_REJECTED', ((instance, label) => instance.listNvidiaModels(label)) as Lister, (instance: FreeCodeGoManagedCatalogs) => instance.invalidateNvidiaCatalog()],
] as const)('%s directory credentials', (provider, rejectedReason, list, invalidate: Invalidator) => {
  it('hands each concurrent caller its own route label from one shared read', async () => {
    // Rows carry the caller's label back and the registry rejects a row whose
    // provider is not the route it asked for (`INVALID_CATALOG`), so the cached
    // value is the bare id list: any caller builds its own rows, off one fetch.
    const instance = catalogs()
    const [first, second] = await Promise.all([list(instance, provider), list(instance, `${provider}-alias`)])

    expect([...new Set(first.map(row => row.provider))]).toEqual([provider])
    expect([...new Set(second.map(row => row.provider))]).toEqual([`${provider}-alias`])
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1)
  })

  it('does not ask the directory again inside the cache cadence', async () => {
    const instance = catalogs()
    const first = await list(instance, provider)
    const second = await list(instance, provider)

    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1)
    expect(second.map(row => row.id)).toEqual(first.map(row => row.id))
  })

  it('serves the known roster past its TTL without waiting on the directory', async () => {
    const instance = catalogs()
    await list(instance, provider)
    at(TTL_MS + 60_000)
    outcome = 'transport'

    // The answer is the narrowing a real directory produced, not the static
    // fallback, and the read did not wait for the failing revalidation.
    const stale = await list(instance, provider)
    expect(availableIds(stale)).toEqual(liveIds(provider).map(row => row.id))
    await settle()
  })

  it('never blocks a read that already has a roster to show', async () => {
    const instance = catalogs()
    await list(instance, provider)
    at(TTL_MS + 60_000)
    // A directory that never answers: a caller holding a roster must not be held
    // up by the revalidation, which belongs off the read path.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    const stale = await list(instance, provider)
    expect(availableIds(stale)).toEqual(liveIds(provider).map(row => row.id))
  })

  it('never replaces a known roster with a failed revalidation, and announces nothing', async () => {
    // Both failure exits: a non-2xx answer and a thrown transport failure. They
    // are separate branches, and each one used to be indistinguishable from an
    // answer once cached.
    for (const failure of ['500', 'transport'] as const) {
      const instance = catalogs()
      const attemptsBefore = vi.mocked(globalThis.fetch).mock.calls.length
      // Each round starts from scratch in time and in the directory: the roster
      // to protect has to exist before the revalidation fails, and the clock has
      // to cross its TTL rather than start past it.
      at(0)
      outcome = 'answered'
      await list(instance, provider)
      const announced = events.length
      at(TTL_MS + 60_000)
      outcome = failure

      await list(instance, provider)
      await settle()

      expect(availableIds(await list(instance, provider))).toEqual(liveIds(provider).map(row => row.id))
      expect(events.length).toBe(announced)
      // One answer plus one failed revalidation for this round, no third attempt.
      expect(vi.mocked(globalThis.fetch).mock.calls.length - attemptsBefore).toBe(2)
    }
  })

  it('attempts once per cadence while a directory is down and nothing has answered', async () => {
    const instance = catalogs()
    outcome = '500'

    const cold = await list(instance, provider)
    await settle()
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1)

    await list(instance, provider)
    await list(instance, provider)
    await settle()

    // Still the static tier, and still one attempt: a fresh install whose
    // directory is down must not re-fetch on every listing.
    expect(availableIds(cold).length).toBeGreaterThan(liveIds(provider).length)
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1)
  })

  it('revalidates at most once per cadence while the directory is down', async () => {
    const instance = catalogs()
    await list(instance, provider)
    at(TTL_MS + 60_000)
    outcome = '500'

    await list(instance, provider)
    await settle()
    const afterFirstFailure = vi.mocked(globalThis.fetch).mock.calls.length

    await list(instance, provider)
    await list(instance, provider)
    await settle()

    expect(afterFirstFailure).toBe(2)
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(afterFirstFailure)
  })

  it('drops the cached roster when the key changes', async () => {
    const instance = catalogs()
    const narrowed = await list(instance, provider)
    invalidate(instance)
    outcome = 'empty'

    // The new key's directory answers with nothing that matches: the static tier
    // is advertised again, which only happens if the old narrowing is gone.
    const afterKeyChange = await list(instance, provider)
    expect(availableIds(afterKeyChange).length).toBeGreaterThan(narrowed.length)
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2)
  })

  it('shares one directory read between callers asking for the same route', async () => {
    const instance = catalogs()
    const stub = vi.mocked(globalThis.fetch)
    const [first, second] = await Promise.all([list(instance, provider), list(instance, provider)])

    expect(first.map(row => row.id)).toEqual(second.map(row => row.id))
    expect(stub.mock.calls.length).toBe(1)
  })

  it('marks every route unavailable when the directory refuses the credential', async () => {
    outcome = '401'
    const rows = await list(catalogs(), provider)

    expect(rows.length).toBeGreaterThan(0)
    expect(availableIds(rows)).toEqual([])
    expect(reasonsOf(rows)).toEqual([rejectedReason])
  })

  it('keeps advertising the free tier when the directory is unreachable', async () => {
    for (const unreachable of ['500', 'transport'] as const) {
      outcome = unreachable
      const rows = await list(catalogs(), provider)
      expect(availableIds(rows).length).toBe(rows.length)
    }
  })

  it('leaves a 403 alone, because a permitted account may still be refused a listing', async () => {
    // Deliberately narrower than "non-2xx": 403 can mean an authenticated
    // account that may not list models, which is not evidence about inference.
    outcome = '403'
    const rows = await list(catalogs(), provider)
    expect(availableIds(rows).length).toBe(rows.length)
  })

  it('narrows to the live roster when the directory answers', async () => {
    const rows = await list(catalogs(), provider)
    expect(availableIds(rows)).toEqual(liveIds(provider).map(row => row.id))
  })

  it('still asks for a key when none is configured', async () => {
    const rows = await list(catalogsWithoutKey(), provider)
    expect(availableIds(rows)).toEqual([])
    expect(reasonsOf(rows)).toEqual([`${provider.toUpperCase()}_API_KEY_REQUIRED`])
  })
})
