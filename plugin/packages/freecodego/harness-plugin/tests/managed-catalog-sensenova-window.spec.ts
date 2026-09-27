/**
 * The VyceAI window defect, one provider over.
 *
 * Both direct providers publish the capacity of each route in their own directory
 * and both readers kept the ids while dropping the numbers. On SenseNova that is
 * worse in one direction than on VyceAI, because the routes are not the same size:
 * its directory answers `context_length` 262,144 for `sensenova-6.8-flash-lite`,
 * `sensenova-u1.5-lite` and `sensenova-u1-fast`, and 1,048,576 for the text routes
 * beside them (`max_output_length` 65,536, and 131,072 for `glm-5.2`) — measured on
 * the live directory with the account's own key.
 *
 * Every one of those routes resolved at the adapter's flat 1,000,000, so:
 *
 *   - `sensenova-6.8-flash-lite` — the smallest-window route in the roster — was
 *     described as 3.8× the context it serves. Compaction is sized against that
 *     number, so the conversation was allowed to grow past 262,144 with nothing
 *     local to warn anyone, which is the shape of the failure this plugin was
 *     already fixed for once (see `managed-catalog-vyce-window.spec.ts`).
 *   - the static roster that answers before any directory read carried the same
 *     1,000,000 for all five text routes, and its reader never copied
 *     `contextWindow` onto the row at all — so both the live and the offline path
 *     reported one guessed number.
 *
 * The pins below hold the fixed form: a published per-route number reaches the row
 * and the resolved model, the static roster keeps the measured per-route numbers as
 * the fallback, and a route with nothing published resolves at the smallest window
 * this provider serves rather than at the largest one anyone might hope for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'
import { parseRouteCapacity, SENSENOVA_DEFAULT_CONTEXT_WINDOW, SENSENOVA_MODELS } from '../src/managed-catalog-utils.ts'

/**
 * The directory as SenseNova answers it, spellings included.
 *
 * Two of these rows deliberately disagree with the static roster: they stand for
 * a route the provider resized after this plugin shipped, which is the one case a
 * constant cannot follow and therefore the only case that proves the reader is
 * reading the directory at all. A fixture whose numbers match the fallback would
 * pass while the directory half of the fix was missing — verified by mutating it.
 */
const directoryRows = [
  { id: 'sensenova-6.8-flash-lite', object: 'model', context_length: 131_072, max_output_length: 32_768 },
  { id: 'deepseek-v4-flash', object: 'model', context_length: 1_048_576, max_output_length: 65_536 },
  { id: 'glm-5.2', object: 'model', context_length: 524_288, max_output_length: 98_304 },
  { id: 'kimi-k3', object: 'model', context_length: 1_048_576, max_output_length: 65_536 },
  { id: 'deepseek-v4-pro', object: 'model', context_length: 1_048_576, max_output_length: 65_536 },
]

let home = ''
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'fcg-sensenova-window-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** Answer the model directory with `rows`, and nothing else. */
function stubDirectory(rows: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: rows }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
}

function catalogs(): FreeCodeGoManagedCatalogs {
  return new FreeCodeGoManagedCatalogs({
    ctx: {
      emit: () => undefined,
      on: () => undefined,
      get: (name: string) => name === 'llm'
        ? { registerAdapter: () => undefined }
        : undefined,
    },
    credentials: () => ({ resolve: async () => ({ value: 'sk-test' }) }),
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

const rowFor = (rows: readonly { id: string }[], id: string): Record<string, unknown> => {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`no row for ${id}`)
  return row as unknown as Record<string, unknown>
}

describe('the capacity one directory row publishes', () => {
  it('reads both providers’ spellings and ignores anything that is not a positive integer', () => {
    expect(parseRouteCapacity({ context_window: 270_000 })).toEqual({ contextWindow: 270_000 })
    expect(parseRouteCapacity({ context_length: 262_144, max_output_length: 65_536 }))
      .toEqual({ contextWindow: 262_144, maxTokens: 65_536 })
    // A directory is remote input: a string, a zero, a fraction and a negative are
    // all "publishes nothing", never a window the harness would size compaction on.
    expect(parseRouteCapacity({ context_length: '262144' })).toEqual({})
    expect(parseRouteCapacity({ context_length: 0, max_output_length: -1 })).toEqual({})
    expect(parseRouteCapacity({ context_length: 1.5 })).toEqual({})
    expect(parseRouteCapacity({})).toEqual({})
  })
})

describe('SenseNova context window', () => {
  it('takes each route window from the directory, which does not serve one size', async () => {
    stubDirectory(directoryRows)
    const rows = await catalogs().listSenseNovaModels('sensenova')

    // The two resized rows report the directory's number and not the static one,
    // which is what separates "reads the directory" from "repeats a constant".
    expect(rowFor(rows, 'sensenova-6.8-flash-lite').contextWindow).toBe(131_072)
    expect(rowFor(rows, 'glm-5.2').contextWindow).toBe(524_288)
    // The untouched rows still land on their own published size, so this is not a
    // whole-roster shift either.
    expect(rowFor(rows, 'deepseek-v4-flash').contextWindow).toBe(1_048_576)
    // `defaultContextWindow` is what the catalog surfaces read while
    // `contextWindow` is what the adapter resolves the route from; a row where the
    // two disagree reports one number and compacts against another.
    expect(rowFor(rows, 'sensenova-6.8-flash-lite').defaultContextWindow).toBe(131_072)
    // The output cap comes from the same row: 98,304 is this fixture's
    // `glm-5.2` `max_output_length`, not a number this plugin picked.
    expect(rowFor(rows, 'glm-5.2').defaultMaxTokens).toBe(98_304)
  })

  it('resolves the routed model at the published window, which is what compaction reads', async () => {
    stubDirectory(directoryRows)
    const registered: Record<string, unknown> = {}
    const instance = new FreeCodeGoManagedCatalogs({
      ctx: {
        emit: () => undefined,
        on: () => undefined,
        get: (name: string) => name === 'llm'
          ? { registerAdapter: (providers: readonly string[], adapter: unknown) => { for (const provider of providers) registered[provider] = adapter } }
          : undefined,
      },
      credentials: () => ({ resolve: async () => ({ value: 'sk-test' }) }),
    } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
    instance.registerSenseNovaAdapter()
    const connector = (registered.sensenova as { connector: { resolveModel: (provider: string, model: string) => Promise<{ context: { contextWindow: number } }> } }).connector

    // 1,000,000 here is the defect stated as a number: it is what the flat adapter
    // default reported for a route that serves 262,144 — and what it would still
    // report for this fixture's resized route, whose directory entry says 131,072.
    await expect(connector.resolveModel('sensenova', 'sensenova-6.8-flash-lite'))
      .resolves.toMatchObject({ context: { contextWindow: 131_072 } })
    await expect(connector.resolveModel('sensenova', 'glm-5.2'))
      .resolves.toMatchObject({ context: { contextWindow: 524_288 } })
    await expect(connector.resolveModel('sensenova', 'deepseek-v4-flash'))
      .resolves.toMatchObject({ context: { contextWindow: 1_048_576 } })
  })

  it('falls back to the measured per-route numbers, not one flat 1,000,000, when no directory answers', async () => {
    // Nothing answered: the static roster is all a reader has, and it now carries
    // the numbers this provider publishes instead of a single optimistic value.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }))
    const offline = await catalogs().listSenseNovaModels('sensenova')

    expect(rowFor(offline, 'sensenova-6.8-flash-lite').contextWindow).toBe(262_144)
    expect(rowFor(offline, 'deepseek-v4-flash').contextWindow).toBe(1_048_576)
    // And the offline roster carries no 1,000,000 at all — the exact value that
    // let the stale declaration look like capacity this provider does not serve.
    expect(SENSENOVA_MODELS.map(model => model.contextWindow)).not.toContain(1_000_000)
  })

  it('assumes the smallest window this provider serves, never the largest, for a route that publishes none', async () => {
    expect(SENSENOVA_DEFAULT_CONTEXT_WINDOW).toBe(262_144)
    expect(SENSENOVA_DEFAULT_CONTEXT_WINDOW).toBeLessThan(1_000_000)
    // It is a real per-route window rather than a convenient number: the static
    // roster's own entry for that route carries the same value.
    expect(SENSENOVA_MODELS.find(model => model.id === 'sensenova-6.8-flash-lite')?.contextWindow)
      .toBe(SENSENOVA_DEFAULT_CONTEXT_WINDOW)
    // And every static window is one the provider actually published, so no route
    // in the fallback roster claims more context than its own directory entry.
    expect(SENSENOVA_MODELS.map(model => model.contextWindow)).toEqual([262_144, 1_048_576, 1_048_576, 1_048_576, 1_048_576])
  })
})
