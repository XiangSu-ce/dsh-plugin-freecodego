/**
 * The Kilo directory is a network call whose answer the picker shows directly.
 * Its cache lives in memory and on disk, so the two facts a fetch can produce
 * must not be conflated: "the directory answered, and has no free routes" is a
 * result to cache, while "the directory did not answer" is not — recording the
 * latter as the former blanks every Kilo route for the whole TTL and overwrites
 * the last good snapshot with an empty one.
 *
 * These pins drive the real class against a stubbed fetch and a real home
 * directory, and they check disk state too: a failure must not be persisted,
 * while a success must be.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const freeRows = [
  { id: 'kilo-auto/free', name: 'Kilo Auto', isFree: true },
  { id: 'kilo-pro/free:free', name: 'Kilo Pro', isFree: true },
]

let home = ''
let created: string[] = []
let previousHome: string | undefined
let mode: 'ok' | 'http-500' | 'reject' | 'empty' = 'ok'
let fetchCalls = 0

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'fcg-kilo-cache-'))
  process.env.DSH_HOME = home
  created.push(home)
  mode = 'ok'
  fetchCalls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls += 1
    if (mode === 'reject') throw new Error('getaddrinfo ENOTFOUND api.kilo.ai')
    if (mode === 'http-500') return new Response('upstream exploded', { status: 500 })
    return new Response(JSON.stringify({ data: mode === 'empty' ? [] : freeRows }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A fresh instance, the way a restarted Host cold-starts the directory. */
function catalogsFor(): FreeCodeGoManagedCatalogs {
  return new FreeCodeGoManagedCatalogs({
    ctx: { emit: () => undefined, get: () => undefined },
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

const snapshotPath = (catalogs: FreeCodeGoManagedCatalogs): string => catalogs.catalogCachePath('kilo-free-models.json')

/** Seed the exact file the class will read, wherever the active home resolves. */
async function seedSnapshot(catalogs: FreeCodeGoManagedCatalogs, ageMs: number): Promise<string> {
  const file = snapshotPath(catalogs)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({
    version: 1,
    savedAt: Date.now() - ageMs,
    models: freeRows.map(row => ({ id: row.id, upstreamId: row.id, name: row.name })),
  }))
  return file
}

const readSnapshot = async (file: string): Promise<{ savedAt: number; models: readonly { id: string }[] }> =>
  JSON.parse(await readFile(file, 'utf8')) as { savedAt: number; models: readonly { id: string }[] }

const idsOf = (models: readonly { id: string }[]): string[] => models.map(model => model.id)

describe('kilo free-model cache', () => {
  it('keeps serving the last roster when the directory does not answer', async () => {
    const catalogs = catalogsFor()
    await seedSnapshot(catalogs, 25 * HOUR_MS)
    mode = 'reject'

    expect(idsOf(await catalogs.kiloFreeModels())).toEqual(['kilo-auto/free', 'kilo-pro/free:free'])
    // The retry did happen — the roster is served in addition to it, not instead of it.
    expect(fetchCalls).toBe(1)
  })

  it('treats an HTTP error the same as a network error', async () => {
    const catalogs = catalogsFor()
    await seedSnapshot(catalogs, 25 * HOUR_MS)
    mode = 'http-500'

    expect(idsOf(await catalogs.kiloFreeModels())).toEqual(['kilo-auto/free', 'kilo-pro/free:free'])
  })

  it('never persists a failed fetch over the last good snapshot', async () => {
    const catalogs = catalogsFor()
    const file = await seedSnapshot(catalogs, 25 * HOUR_MS)
    const before = await readSnapshot(file)
    mode = 'reject'

    await catalogs.kiloFreeModels()

    const after = await readSnapshot(file)
    expect(idsOf(after.models)).toEqual(['kilo-auto/free', 'kilo-pro/free:free'])
    expect(after.savedAt).toBe(before.savedAt)
  })

  it('attempts one fetch per window instead of one per caller', async () => {
    const catalogs = catalogsFor()
    await seedSnapshot(catalogs, 25 * HOUR_MS)
    mode = 'reject'

    await catalogs.kiloFreeModels()
    await catalogs.kiloFreeModels()
    await catalogs.kiloFreeModels()

    expect(fetchCalls).toBe(1)
  })

  it('serves a recent snapshot without touching the network at all', async () => {
    const catalogs = catalogsFor()
    await seedSnapshot(catalogs, HOUR_MS)

    expect(idsOf(await catalogs.kiloFreeModels())).toEqual(['kilo-auto/free', 'kilo-pro/free:free'])
    expect(fetchCalls).toBe(0)
  })

  it('discards a snapshot that aged past its maximum age', async () => {
    const catalogs = catalogsFor()
    await seedSnapshot(catalogs, 8 * DAY_MS)
    mode = 'reject'

    expect(await catalogs.kiloFreeModels()).toEqual([])
    // An unusable snapshot must not stop the directory from being re-fetched.
    expect(fetchCalls).toBe(1)
  })

  it('still caches a directory that answered with no free routes', async () => {
    const catalogs = catalogsFor()
    mode = 'empty'

    expect(await catalogs.kiloFreeModels()).toEqual([])
    await catalogs.kiloFreeModels()
    await catalogs.kiloFreeModels()

    // An answer is an answer: it is authoritative for the TTL, unlike a failure.
    expect(fetchCalls).toBe(1)
    expect(idsOf((await readSnapshot(snapshotPath(catalogs))).models)).toEqual([])
  })

  it('answers with an empty directory only when there is nothing to keep', async () => {
    const catalogs = catalogsFor()
    mode = 'reject'

    expect(await catalogs.kiloFreeModels()).toEqual([])
    await catalogs.kiloFreeModels()
    await catalogs.kiloFreeModels()

    expect(fetchCalls).toBe(1)
  })

  it('replaces the stale snapshot once the directory answers again', async () => {
    const catalogs = catalogsFor()
    const file = await seedSnapshot(catalogs, 25 * HOUR_MS)
    mode = 'ok'

    // The live directory is normalized (`:free` is stripped), so this is also
    // what the refreshed snapshot must hold.
    expect(idsOf(await catalogs.kiloFreeModels())).toEqual(['kilo-auto/free', 'kilo-pro/free'])
    expect(fetchCalls).toBe(1)

    const after = await readSnapshot(file)
    expect(idsOf(after.models)).toEqual(['kilo-auto/free', 'kilo-pro/free'])
    expect(Date.now() - after.savedAt).toBeLessThan(HOUR_MS)
  })
})
