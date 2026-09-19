/**
 * The Logfare directory is fetched on demand: readers serve whatever roster is
 * known and refresh past its TTL in the background. That design only works if a
 * failed refresh is *not* an answer. Caching the hardcoded fallback set as if it
 * were one replaced the live directory for the whole TTL (the picker, the
 * payment screen, and media generation all read this roster), announced a
 * directory change that never happened, and stopped the read path from retrying
 * even after the upstream recovered.
 *
 * These pins drive the real class against a stubbed fetch: a failure keeps the
 * roster it already had, a cold start is the only place the fallback belongs,
 * and an invalidation is never undone by a late failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'

const TTL_MS = 10 * 60_000

/** A live directory whose rows are recognizable on sight, unlike the fallback. */
const liveRows = [
  { id: 'live-a', name: 'Live A', endpoints: ['chat/completions'], tier: 1, requires_training_opt_in: false, premium_unlocked: true },
  { id: 'live-b', name: 'Live B', endpoints: ['chat/completions'], tier: 1, requires_training_opt_in: false, premium_unlocked: true },
]

let base = 0
let failing = false
let fetchCalls = 0
let events: string[] = []

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 20)) }
const at = (offsetMs: number): void => { vi.setSystemTime(base + offsetMs) }
const idsOf = (models: readonly { id: string }[]): string[] => models.map(model => model.id)
const isFallback = (models: readonly { id: string }[]): boolean => !idsOf(models).includes('live-a') && !idsOf(models).includes('live-b')

beforeEach(() => {
  base = Date.now()
  failing = false
  fetchCalls = 0
  events = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls += 1
    if (failing) return new Response('upstream exploded', { status: 503 })
    return new Response(JSON.stringify({ data: liveRows }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function catalogs(): FreeCodeGoManagedCatalogs {
  return new FreeCodeGoManagedCatalogs({
    ctx: { emit: (name: string) => events.push(name), get: () => undefined },
    credentials: () => undefined,
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

describe('logfare catalog cache', () => {
  it('keeps the live roster when a refresh fails', async () => {
    const instance = catalogs()
    expect(idsOf(await instance.refreshLogfareModels())).toEqual(['live-a', 'live-b'])

    at(TTL_MS + 60_000)
    failing = true

    expect(idsOf(await instance.refreshLogfareModels())).toEqual(['live-a', 'live-b'])
    expect(idsOf(await instance.logfareModels())).toEqual(['live-a', 'live-b'])
    expect(fetchCalls).toBe(2)
  })

  it('never announces a directory change for a refresh that did not answer', async () => {
    const instance = catalogs()
    await instance.refreshLogfareModels()
    expect(events).toEqual(['llm/adapters-updated'])

    at(TTL_MS + 60_000)
    failing = true
    await instance.refreshLogfareModels()

    // The one emit belongs to the successful fetch; a failure must not claim the
    // directory changed, or every reader re-renders a roster that did not move.
    expect(events).toEqual(['llm/adapters-updated'])
  })

  it('attempts at most one refresh per cadence while the directory is down', async () => {
    const instance = catalogs()
    await instance.refreshLogfareModels()
    at(TTL_MS + 60_000)
    failing = true

    await instance.logfareModels()
    await settle()
    expect(fetchCalls).toBe(2)

    // Three more reads inside the window: the roster keeps serving, the network
    // is left alone. Without this the read path retried on every picker open.
    await instance.logfareModels()
    await instance.logfareModels()
    await instance.logfareModels()
    await settle()

    expect(fetchCalls).toBe(2)
    expect(idsOf(await instance.logfareModels())).toEqual(['live-a', 'live-b'])
  })

  it('serves the kept roster once the upstream recovers inside the cadence', async () => {
    const instance = catalogs()
    await instance.refreshLogfareModels()
    at(TTL_MS + 60_000)
    failing = true
    await instance.refreshLogfareModels()

    failing = false
    at(TTL_MS + 2 * 60_000)

    // The roster was never replaced, so recovery needs no fetch at all.
    expect(idsOf(await instance.logfareModels())).toEqual(['live-a', 'live-b'])
    expect(fetchCalls).toBe(2)
  })

  it('answers the fallback set only when nothing was known', async () => {
    const instance = catalogs()
    failing = true

    const first = await instance.logfareModels()
    await settle()
    expect(isFallback(first)).toBe(true)

    await instance.logfareModels()
    await instance.logfareModels()
    await settle()

    // One attempt, not one per read, and no phantom directory change.
    expect(fetchCalls).toBe(1)
    expect(events).toEqual([])
  })

  it('does not resurrect a roster an invalidation discarded', async () => {
    const instance = catalogs()
    await instance.refreshLogfareModels()
    at(TTL_MS + 60_000)
    failing = true

    const pending = instance.refreshLogfareModels()
    instance.invalidateLogfareCatalog()

    expect(isFallback(await pending)).toBe(true)
  })

  it('still shows the fallback rows when a live directory answers with none', async () => {
    const answeredStub = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', answeredStub)
    const instance = catalogs()

    // A deliberate choice, pinned so a future change to it is intentional: an
    // answered-but-empty directory shows fallback rows rather than a blank list.
    const answered = await instance.refreshLogfareModels()
    expect(isFallback(answered)).toBe(true)

    // The two cold-start outcomes look identical from the rows alone, so pin the
    // difference that matters: an answer is cached and announced, while a
    // failure (see the pin above) is neither. Collapsing them back together is
    // how a roster went missing for a whole TTL in the first place.
    expect(events).toEqual(['llm/adapters-updated'])
    await instance.logfareModels()
    expect(answeredStub).toHaveBeenCalledTimes(1)
  })
})
