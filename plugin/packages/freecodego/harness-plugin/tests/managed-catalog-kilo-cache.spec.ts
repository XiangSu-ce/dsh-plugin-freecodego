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

import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'

import { FreeCodeGoManagedCatalogs, KILO_RATE_LIMIT_HINT } from '../src/managed-catalogs.ts'
import { KILO_GATEWAY_BASE_URL } from '../src/managed-catalog-utils.ts'

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

/**
 * The registered `kilo` adapter as this spec reads it: the route resolution the
 * adapter runs per request lives on its configuration, not on the instance.
 */
interface KiloAdapterHandle {
  readonly config: {
    readonly resolveConnection: (model: string) => Promise<{ readonly baseURL: string; readonly model: string }>
  }
  readonly stream: (options: { readonly provider: string; readonly model: string; readonly messages: readonly unknown[] }) => AsyncIterable<unknown>
}

/**
 * The adapter the class registers for the `kilo` provider, captured the way the
 * Host's `llm` service would hold it. Routing a selection is the adapter's job,
 * so the pins below drive the real registration rather than a re-derived copy
 * of the lookup.
 */
function registeredKiloAdapter(): KiloAdapterHandle {
  const registered: Record<string, unknown> = {}
  const catalogs = new FreeCodeGoManagedCatalogs({
    ctx: {
      emit: () => undefined,
      // Registration also subscribes this route to provider-topology changes.
      on: () => undefined,
      get: (name: string) => name === 'llm'
        ? { registerAdapter: (providers: readonly string[], adapter: unknown) => { for (const provider of providers) registered[provider] = adapter } }
        : undefined,
    },
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
  catalogs.registerKiloAdapter()
  // The route is registered behind the known-directory decorator, so the routing
  // under test is the connector adapter's own — read through `connector`.
  return (registered.kilo as { connector: KiloAdapterHandle }).connector
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

describe('kilo selection routing', () => {
  it('resolves a picker-namespaced selection against the bare directory roster', async () => {
    // The picker namespaces its Kilo rows as `kilo/<directory id>` while the
    // directory lists the same routes bare. Comparing the two spellings
    // verbatim matched nothing, so every Kilo route failed with "not available
    // in the public directory" before it ever reached the gateway.
    const adapter = registeredKiloAdapter()

    // The row id is the directory's normalized one (the `:free` suffix is
    // stripped before the picker ever sees it) while the request carries the
    // directory's own upstream id, so the two must not be conflated either.
    await expect(adapter.config.resolveConnection('kilo/kilo-pro/free'))
      .resolves.toEqual(expect.objectContaining({ baseURL: KILO_GATEWAY_BASE_URL, model: 'kilo-pro/free:free' }))
    // The auto row exists in the directory under its own id and stays exact.
    await expect(adapter.config.resolveConnection('kilo/kilo-auto/free'))
      .resolves.toEqual(expect.objectContaining({ model: 'kilo-auto/free' }))
  })

  it('still refuses an id the directory does not publish', async () => {
    // The prefix fix must not turn the roster into a wildcard.
    const adapter = registeredKiloAdapter()

    await expect(adapter.config.resolveConnection('kilo/nex-agi/nex-n2.5-pro'))
      .rejects.toThrow('not available in the public directory')
  })

  it('explains a 429 with the quota Kilo documents, not just the status', async () => {
    // The free routes are metered per egress IP at 200 requests an hour and the
    // response carries no `retry-after`, so a bare status sends the user hunting
    // for a broken model on every row at once.
    // The directory still answers — a limited *route* is not a missing roster.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => String(url).includes('/models')
      ? new Response(JSON.stringify({ data: freeRows }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'Rate limit exceeded', error_type: 'rate_limit_exceeded' }), { status: 429 })))
    const adapter = registeredKiloAdapter()
    const drain = async (): Promise<unknown> => {
      for await (const _chunk of adapter.stream({ provider: 'kilo', model: 'kilo/kilo-pro/free', messages: [{ id: MessageId('m1'), role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) { /* drain */ }
      return undefined
    }

    const failure = await drain().then(() => new Error('the request was expected to fail'), (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('RATE_LIMIT')
    expect((failure as LlmError).message).toContain(KILO_RATE_LIMIT_HINT)
    // The metered thing is the exit address, and the two levers a user has over
    // it are the ones the hint has to name — a hint that only says "retry later"
    // leaves the reader with nothing to do that differs from the attempt that
    // just failed. Asserted on the copy itself, in both languages, because this
    // text is the whole remedy.
    for (const lever of ['节点 IP', '真实 IP', 'node IP', 'real IP']) {
      expect(KILO_RATE_LIMIT_HINT).toContain(lever)
    }
  })
})
