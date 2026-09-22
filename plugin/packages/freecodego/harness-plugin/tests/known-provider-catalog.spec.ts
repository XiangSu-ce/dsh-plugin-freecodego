/**
 * The model menu's FreeCodeGo half must answer without waiting for a connector's
 * directory read, and must never answer with a directory it made up.
 *
 * These pins drive the real decorator over a connector double whose read is the
 * slow part, and they measure what the Host measures: how long a catalog answer
 * takes on a Host that has already seen a directory (a restart) against one whose
 * read is still open. The budgets are wall-clock ones on purpose — the change
 * exists to move a 5528ms first catalog to single-digit milliseconds — and they
 * are loose enough for a loaded box while still failing anything that awaits a
 * read. `KNOWN_CATALOG_COLD_ANSWER_MS` is the hard ceiling on the other case: a
 * menu over twelve routes, none of them read yet, one of them a connector that
 * never answers, is answered within that budget and the slow group is filled in
 * afterwards. A regression to "wait for every route" fails those two tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmImageRequestPricing, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'

import {
  KNOWN_CATALOG_COLD_ANSWER_MS, KNOWN_CATALOG_ERROR_TTL_MS, KNOWN_CATALOG_MAX_AGE_MS,
  KNOWN_CATALOG_TTL_MS, KnownCatalogAdapter, KnownCatalogDirectory,
} from '../src/known-provider-catalog.ts'
import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'

/**
 * What one catalog answer may cost once the directory is known.
 *
 * Twenty times under the read it must not wait for, and far above the one
 * snapshot file read it does perform, so a loaded CI box cannot turn this into a
 * flake while an implementation that awaits the connector still fails it.
 */
const ANSWER_BUDGET_MS = 250

const ROUTE = 'trae'

/** A connector double whose directory read is the only slow thing about it. */
class SlowConnector extends LlmAdapter {
  readonly calls = { list: 0, resolve: 0, prepare: 0, stream: 0 }
  models: readonly LlmModelInfo[] = []
  /** Opened by hand so "the read has not answered yet" is a fact, not a sleep. */
  gate: Promise<void> | undefined

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Slow Connector' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return resolveRetryPolicy(undefined, 'spec')
  }

  override imageRequestPricing(): LlmImageRequestPricing | undefined {
    return { priceImages: () => [{ visualTokens: 42, text: '' }] }
  }

  override async listModels(): Promise<readonly LlmModelInfo[]> {
    this.calls.list += 1
    if (this.gate !== undefined) await this.gate
    return this.models
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.calls.resolve += 1
    if (this.gate !== undefined) await this.gate
    return { provider, id: model, name: `Name of ${model}`, context: { contextWindow: 200_000 } }
  }

  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    this.calls.prepare += 1
    return Promise.resolve({
      model: { provider, id: model, name: 'inner' },
      stream: () => this.stream({} as GenerateOptions),
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.stream += 1
  }
}

const rows = (provider: string, ids: readonly string[]): readonly LlmModelInfo[] =>
  ids.map(id => ({ provider, id, name: `Name of ${id}` }))

/** Every directory instance this run opened, so the temp homes can be removed. */
const homes: string[] = []
let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fcg-known-catalog-'))
  homes.push(home)
})

afterEach(async () => {
  vi.useRealTimers()
  for (const directory of homes.splice(0)) {
    // A snapshot write that outlives its test can land while this runs.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** The route table of one snapshot document under test. */
function asRoutes(value: Record<string, unknown>): Record<string, unknown> {
  const routes = value.routes
  return typeof routes === 'object' && routes !== null ? routes as Record<string, unknown> : {}
}

/** One directory over this run's snapshot path, with the announcements recorded. */
function bench(): { file: string; directory: KnownCatalogDirectory; announced: number[] } {
  const file = join(home, 'provider-catalogs.json')
  const announced: number[] = []
  const directory = new KnownCatalogDirectory({
    file: () => file,
    write: async (target, value) => { await writeFile(target, `${JSON.stringify(value)}\n`) },
    announce: () => { announced.push(Date.now()) },
  })
  return { file, directory, announced }
}

/** Let a fire-and-forget revalidation settle; its connector double does no I/O. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

/** Write one route's snapshot the way a previous process left it. */
async function seedSnapshot(file: string, route: {
  readonly readAt: number
  readonly models: readonly LlmModelInfo[]
  readonly resolved?: readonly LlmResolvedModelInfo[]
}): Promise<void> {
  await writeFile(file, JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    routes: { [ROUTE]: { readAt: route.readAt, models: route.models, resolved: route.resolved ?? [] } },
  }))
}

describe('known provider catalog', () => {
  it('answers a known route within the budget while its read is still open', async () => {
    const { file } = await bench()
    // Read before this process started: the rows are served, and the directory
    // is revalidated behind them.
    await seedSnapshot(file, {
      readAt: Date.now() - KNOWN_CATALOG_TTL_MS - 1,
      models: rows(ROUTE, ['glm-5.3', 'solo-coder']),
      resolved: [{
        provider: ROUTE, id: 'glm-5.3', name: 'Name of glm-5.3', context: { contextWindow: 200_000 },
      }],
    })
    const { directory, announced } = bench()
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['glm-5.3', 'solo-coder', 'added-later'])
    const read = Promise.withResolvers<void>()
    connector.gate = read.promise

    const started = Date.now()
    const served = await directory.listModels(ROUTE, connector)
    const listTook = Date.now() - started
    const resolved = await directory.resolveModel(ROUTE, 'glm-5.3', connector)
    const answeredTook = Date.now() - started

    expect(served.map(model => model.id)).toEqual(['glm-5.3', 'solo-coder'])
    expect(resolved.name).toBe('Name of glm-5.3')
    // The read is open (it is gated) and the metadata pass never reached the
    // connector, so any latency here would be this layer waiting on either.
    expect(connector.calls.list).toBe(1)
    expect(connector.calls.resolve).toBe(0)
    expect(listTook).toBeLessThan(ANSWER_BUDGET_MS)
    expect(answeredTook).toBeLessThan(ANSWER_BUDGET_MS)
    expect(announced).toHaveLength(0)

    // When the read arrives, its rows are served from then on, and the catalog
    // is told once that the directory moved.
    read.resolve()
    await vi.waitFor(() => {
      expect(directory.knownModels(ROUTE)?.map(model => model.id))
        .toEqual(['glm-5.3', 'solo-coder', 'added-later'])
    })
    expect(announced).toHaveLength(1)
    expect((await directory.listModels(ROUTE, connector)).map(model => model.id))
      .toEqual(['glm-5.3', 'solo-coder', 'added-later'])
  })

  it('answers a first run within the cold budget and stores nothing it invented', async () => {
    const { directory, announced } = bench()
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['glm-5.3'])
    const gate = Promise.withResolvers<void>()
    connector.gate = gate.promise

    const started = Date.now()
    const served = await directory.listModels(ROUTE, connector)
    const took = Date.now() - started
    // Nothing is known on this machine, so the answer carries no rows — but it
    // is the budget that ends the wait, not the read, and that read keeps going.
    expect(served).toEqual([])
    expect(took).toBeGreaterThanOrEqual(KNOWN_CATALOG_COLD_ANSWER_MS - 100)
    expect(took).toBeLessThan(KNOWN_CATALOG_COLD_ANSWER_MS + 1_000)
    // The bounded answer is not a directory: nothing was stored, so nothing
    // downstream can read "this provider lost every route" from it.
    expect(directory.knownModels(ROUTE)).toBeUndefined()
    expect(announced).toHaveLength(0)

    // When the read lands, its rows are served from then on and the catalog is
    // told once — this is the group that appears just after the menu opened.
    gate.resolve()
    await vi.waitFor(() => {
      expect(directory.knownModels(ROUTE)?.map(model => model.id)).toEqual(['glm-5.3'])
    })
    expect(announced).toHaveLength(1)
    expect((await directory.listModels(ROUTE, connector)).map(model => model.id)).toEqual(['glm-5.3'])
    // One read for the whole episode: the bounded answer joined the read the
    // prewarm started rather than starting a second one.
    expect(connector.calls.list).toBe(1)
  })

  it('reports a first read that fails instead of answering it away', async () => {
    const { directory, announced } = bench()
    const connector = new SlowConnector()
    connector.listModels = () => Promise.reject(new Error('directory refused'))

    const started = Date.now()
    await expect(directory.listModels(ROUTE, connector)).rejects.toThrow('directory refused')
    // The failure arrives with the read, well inside the budget, so a provider
    // that is genuinely broken shows an error rather than an empty group.
    expect(Date.now() - started).toBeLessThan(KNOWN_CATALOG_COLD_ANSWER_MS)
    expect(announced).toHaveLength(0)

    // And it is remembered: the next catalog reports it instead of paying for
    // another read of a directory that just refused one.
    let reads = 0
    connector.listModels = () => { reads += 1; return Promise.reject(new Error('directory refused')) }
    await expect(directory.listModels(ROUTE, connector)).rejects.toThrow('directory refused')
    expect(reads).toBe(0)

    // Past the error window the route is retried, so a provider that came back
    // is not stuck reporting yesterday's failure.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + KNOWN_CATALOG_ERROR_TTL_MS + 1)
    connector.models = rows(ROUTE, ['glm-5.3'])
    connector.listModels = async () => { reads += 1; return connector.models }
    expect((await directory.listModels(ROUTE, connector)).map(model => model.id)).toEqual(['glm-5.3'])
    expect(reads).toBe(1)
  })

  it('fills a slow route in after the menu has already been answered', async () => {
    const { directory, announced } = bench()
    // Twelve routes like this deployment's, one of them never answering — the
    // shape that made the picker look as if it had not opened at all.
    const routes = Array.from({ length: 12 }, (_value, index) => `route-${index}`)
    const asked = routes.map(route => {
      const connector = new SlowConnector()
      connector.models = rows(route, [`${route}-model`])
      return { route, adapter: new KnownCatalogAdapter([route], connector, directory) }
    })
    const hung = new SlowConnector()
    const gate = Promise.withResolvers<void>()
    hung.gate = gate.promise
    asked.push({ route: 'trae', adapter: new KnownCatalogAdapter(['trae'], hung, directory) })

    // The Host builds one catalog by asking every registered route at once and
    // waiting for the slowest; this is that pass, over the same decorators.
    const menu = () => Promise.all(asked.map(entry => entry.adapter.listModels(entry.route)))
    const started = Date.now()
    const first = await menu()
    const took = Date.now() - started
    // The menu is held open by the budget, not by the route that never answers.
    expect(took).toBeLessThan(KNOWN_CATALOG_COLD_ANSWER_MS + 1_000)
    const listed = (pass: readonly (readonly { id: string }[])[]): string[] =>
      pass.flatMap(list => list.map(model => model.id))
    expect(listed(first)).toHaveLength(12)
    expect(first.at(-1)).toEqual([])
    // The twelve fast directories landed while the budget was being spent; the
    // one announcement still to come is the slow route's.
    const announcedBefore = announced.length

    // The slow group is what arrives afterwards, and the announcement is what
    // makes the menu that is already open ask again and draw it.
    hung.models = rows('trae', ['glm-5.3'])
    gate.resolve()
    await vi.waitFor(() => { expect(announced.length).toBeGreaterThan(announcedBefore) })
    expect(listed(await menu())).toHaveLength(13)
  })

  it('serves the known directory while the revalidation behind it fails', async () => {
    const { directory, announced } = bench()
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['glm-5.3'])
    await directory.listModels(ROUTE, connector)
    expect(announced).toHaveLength(1)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + KNOWN_CATALOG_TTL_MS + 1)
    let attempts = 0
    const offline = new SlowConnector()
    offline.listModels = () => {
      attempts += 1
      return Promise.reject(new Error('directory offline'))
    }

    const served = await directory.listModels(ROUTE, offline)
    await settle()
    expect(attempts).toBe(1)
    expect(served.map(model => model.id)).toEqual(['glm-5.3'])
    expect(directory.knownModels(ROUTE)?.map(model => model.id)).toEqual(['glm-5.3'])
    // The single announcement is the first read's; a failed revalidation says
    // nothing, because it learned nothing.
    expect(announced).toHaveLength(1)

    // The event path (a provider-topology change) re-reads behind the answer
    // too, once the floor between two reads has passed.
    vi.setSystemTime(Date.now() + 60_000)
    directory.revalidate(ROUTE, offline)
    await settle()
    expect(attempts).toBe(2)
    expect(directory.knownModels(ROUTE)?.map(model => model.id)).toEqual(['glm-5.3'])
  })

  it('reads every unknown route once on prewarm and leaves a fresh one alone', async () => {
    const { directory } = await bench()
    const warm = new SlowConnector()
    warm.models = rows(ROUTE, ['glm-5.3'])
    await directory.listModels(ROUTE, warm)

    const unknown = new SlowConnector()
    unknown.models = rows('kilo', ['kilo-auto/free'])
    const adapter = new KnownCatalogAdapter([ROUTE], warm, directory)
    const fresh = new KnownCatalogAdapter(['kilo'], unknown, directory)
    await directory.prewarm([adapter, fresh])

    await vi.waitFor(() => {
      expect(directory.knownModels('kilo')?.map(model => model.id)).toEqual(['kilo-auto/free'])
    })
    // The fresh route keeps its snapshot: a boot must not re-read a directory
    // that was just read.
    expect(warm.calls.list).toBe(1)
    expect(unknown.calls.list).toBe(1)
  })

  it('writes one snapshot at a time so a route read meanwhile is not lost', async () => {
    const file = join(home, 'provider-catalogs.json')
    // The first write is held open, so the second route's read lands while a
    // snapshot is being written. A second pass starting there can finish first
    // and put the older state back: measured on a restarted Host, the slow
    // route's directory was read, known, and absent from the file — so the next
    // boot paid its cold read all over again.
    const held = Promise.withResolvers<void>()
    const saved: number[] = []
    let active = 0
    let peakActive = 0
    let holds = 0
    const directory = new KnownCatalogDirectory({
      file: () => file,
      write: async (target, value) => {
        active += 1
        peakActive = Math.max(peakActive, active)
        saved.push(Object.keys(asRoutes(value)).length)
        try {
          if (holds === 0) {
            holds += 1
            await held.promise
          }
          await writeFile(target, `${JSON.stringify(value)}\n`)
        } finally {
          active -= 1
        }
      },
      announce: () => undefined,
    })
    const slow = new SlowConnector()
    slow.models = rows('slow', ['slow-model'])
    const fast = new SlowConnector()
    fast.models = rows('fast', ['fast-model'])

    const slowRead = directory.listModels('slow', slow)
    await vi.waitFor(() => { expect(saved).toHaveLength(1) })
    const fastRead = directory.listModels('fast', fast)

    // The second landing never starts a competing write; it asks the pass that
    // is already running to repeat with the newer state.
    await vi.waitFor(() => { expect(directory.knownModels('fast')).toBeDefined() })
    expect(saved).toHaveLength(1)

    held.resolve()
    await Promise.all([slowRead, fastRead])
    await vi.waitFor(() => { expect(saved.length).toBeGreaterThanOrEqual(2) })
    expect(peakActive).toBe(1)
    expect(saved[0]).toBe(1)
    expect(saved.at(-1)).toBe(2)

    const snapshot = JSON.parse(await readFile(file, 'utf8')) as { routes: Record<string, unknown> }
    expect(Object.keys(snapshot.routes).sort()).toEqual(['fast', 'slow'])
  })

  it('restores the snapshot on prewarm instead of reading a route it already has', async () => {
    const { file, directory } = await bench()
    await seedSnapshot(file, {
      readAt: Date.now(),
      models: rows(ROUTE, ['glm-5.3']),
      resolved: [{ provider: ROUTE, id: 'glm-5.3', name: 'Name of glm-5.3' }],
    })
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['from-the-network'])
    const adapter = new KnownCatalogAdapter([ROUTE], connector, directory)

    await directory.prewarm([adapter])

    // The boot looked at the snapshot first, found the route fresh, and left the
    // connector alone: twelve network reads in front of the first menu open is
    // the wait this layer exists to remove.
    expect(connector.calls.list).toBe(0)
    expect((await adapter.listModels(ROUTE)).map(model => model.id)).toEqual(['glm-5.3'])
    expect((await adapter.resolveModel(ROUTE, 'glm-5.3')).name).toBe('Name of glm-5.3')
    expect(connector.calls.list).toBe(0)
    expect(connector.calls.resolve).toBe(0)
  })

  it('delegates everything a turn needs to the connector adapter', async () => {
    const { directory } = await bench()
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['glm-5.3'])
    const wrapper = new KnownCatalogAdapter([ROUTE], connector, directory)

    expect(wrapper.providerInfo(ROUTE)).toEqual({ id: ROUTE, name: 'Slow Connector' })
    expect(wrapper.providerRetryPolicy(ROUTE)).toEqual(resolveRetryPolicy(undefined, 'spec'))
    expect(wrapper.imageRequestPricing(ROUTE, 'glm-5.3')?.priceImages([]))
      .toEqual([{ visualTokens: 42, text: '' }])

    const prepared = await wrapper.prepareCall(ROUTE, 'glm-5.3')
    expect(prepared.model.name).toBe('inner')
    for await (const _chunk of prepared.stream({} as GenerateOptions)) { /* drain the inner stream */ }
    for await (const _chunk of wrapper.stream({} as GenerateOptions)) { /* drain the inner stream */ }
    expect(connector.calls.prepare).toBe(1)
    expect(connector.calls.stream).toBe(2)
  })

  it('drops a snapshot the Host would reject rather than serving it', async () => {
    const { file, directory } = await bench()
    await writeFile(file, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      routes: {
        [ROUTE]: {
          readAt: Date.now(),
          // Another route's row, and a resolved entry whose context window is not
          // a number: the Host fails a whole provider group on either, so this
          // route is left to the connector instead.
          models: [{ provider: 'someone-else', id: 'x', name: 'X' }],
          resolved: [{ provider: ROUTE, id: 'x', name: 'X', context: { contextWindow: 'big' } }],
        },
      },
    }))
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['glm-5.3'])

    expect((await directory.listModels(ROUTE, connector)).map(model => model.id)).toEqual(['glm-5.3'])
    expect(connector.calls.list).toBe(1)
  })

  it('ignores a snapshot older than the serving bound', async () => {
    const { file, directory } = await bench()
    await writeFile(file, JSON.stringify({
      version: 1,
      savedAt: Date.now() - KNOWN_CATALOG_MAX_AGE_MS - 1,
      routes: {
        [ROUTE]: { readAt: Date.now(), models: rows(ROUTE, ['stale']), resolved: [] },
      },
    }))
    const connector = new SlowConnector()
    connector.models = rows(ROUTE, ['glm-5.3'])

    expect((await directory.listModels(ROUTE, connector)).map(model => model.id)).toEqual(['glm-5.3'])
  })

  it('registers the wrapper for a real route and prewarms its directory', async () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const registered: Record<string, LlmAdapter> = {}
    let fetchCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({
        data: [{ id: 'kilo-auto/free', name: 'Kilo Auto', isFree: true }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const catalogs = new FreeCodeGoManagedCatalogs({
      ctx: {
        emit: () => undefined,
        on: () => undefined,
        get: (name: string) => name === 'llm'
          ? {
            registerAdapter: (providers: readonly string[], adapter: LlmAdapter) => {
              for (const provider of providers) registered[provider] = adapter
            },
          }
          : undefined,
      },
    } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
    try {
      catalogs.registerKiloAdapter()
      const kilo = registered.kilo
      expect(kilo).toBeInstanceOf(KnownCatalogAdapter)
      if (kilo === undefined) throw new Error('kilo was not registered')

      // Nothing is known yet, so the boot prewarm is what reads the directory,
      // and the catalog then answers from it without another fetch.
      await catalogs.prewarmProviderCatalogs()
      // The rows are the connector's own, prefix and all — this layer stores and
      // serves a directory, it does not relabel one.
      const listed = await kilo.listModels('kilo')
      expect(listed.map(model => model.id)).toEqual(['kilo/kilo-auto/free'])
      expect(fetchCalls).toBe(1)
      // The catalog's next read is answered from the directory the prewarm
      // stored: no second directory fetch for a menu that is opened again.
      const again = await kilo.listModels('kilo')
      expect(again.map(model => model.id)).toEqual(['kilo/kilo-auto/free'])
      expect(fetchCalls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})
