/**
 * OpenCode's directory names its free routes and says nothing else about them:
 * a row is `id`, `object`, `created`, `owned_by` — no window, no price, no
 * display name. The window the harness compacts against therefore comes from
 * the one declaration in the adapter that serves them all
 * (`defaultContextWindow: 200_000`), and every free route — the two pinned
 * here among them — resolves at that number.
 *
 * The same read can fail, and that is the second half. `openCodeFreeModels`
 * answers a failed fetch with the built-in roster, so a route missing from
 * `FREE_UPSTREAM_MODELS` is a route the picker quietly drops whenever the
 * directory is unreachable — and the newest free rows are exactly the ones a
 * stale built-in list is still missing. `deepseek-v4.1-flash` and
 * `glm-5.3-flash` appeared in the directory as `deepseek-v4.1-flash-free` and
 * `glm-5.3-flash-free` while the built-in list named neither.
 *
 * The pins below hold both halves: each route resolves at 200,000 tokens,
 * with the name the directory read derives (so a resolution that did not find
 * the picker row is caught), and the built-in roster carries both rows with the
 * upstream ids the directory serves.
 *
 * The third case is the surface's other half: the window a saved panel edit
 * writes has to be the window this route later serves. On a catalog route the
 * save lands in the Models entry's `modelOverrides`, a key pi-ai reads for the
 * routes pi-ai serves itself — and OpenCode is not one of them, so a write that
 * only reached settings would be a silent no-op on this route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FreeCodeGoManagedCatalogs, FREE_UPSTREAM_MODELS } from '../src/managed-catalogs.ts'
import { writeModelTuning } from '../src/model-tuning.ts'

/** The directory as OpenCode answers it, for the two rows this spec is about. */
const directoryRows = [
  { id: 'deepseek-v4.1-flash-free', object: 'model', created: 1_792_153_359, owned_by: 'opencode' },
  { id: 'glm-5.3-flash-free', object: 'model', created: 1_792_153_359, owned_by: 'opencode' },
]

let home = ''
let previousHome: string | undefined

beforeEach(async () => {
  // The directory read caches what it fetched under the active home, so a temp
  // home keeps this spec from writing to (or being answered by) the real one.
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'fcg-opencode-window-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** Answer the model directory with `rows`. */
function stubDirectory(rows: readonly unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: rows }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
}

/** The adapter shape this spec resolves through, as the connector publishes it. */
interface OpenCodeConnector {
  resolveModel: (provider: string, model: string) => Promise<{ name?: string; context: { contextWindow: number } }>
}

/** What one registration left behind: the adapter it published, and the context it read. */
interface OpenCodeRegistration {
  /** The adapter the class registered for `opencode`, read through the decorator. */
  readonly connector: OpenCodeConnector
  /** The context that registration was built with, so a write travels as it would live. */
  readonly ctx: Context
}

/**
 * Register the `opencode` adapter against the Host services this spec supplies.
 * @param settings - the settings service the class should find, when one is mounted.
 * @returns the published connector and the context it was registered under.
 */
function registeredOpenCode(settings?: unknown): OpenCodeRegistration {
  const registered: Record<string, unknown> = {}
  const ctx = {
    emit: () => undefined,
    on: () => undefined,
    get: (name: string) => name === 'llm'
      ? { registerAdapter: (providers: readonly string[], adapter: unknown) => { for (const provider of providers) registered[provider] = adapter } }
      : name === 'settings' ? settings : undefined,
  } as unknown as Context
  const catalogs = new FreeCodeGoManagedCatalogs({ ctx } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
  catalogs.registerOpenCodeAdapter()
  return { connector: (registered.opencode as { connector: OpenCodeConnector }).connector, ctx }
}

/**
 * A settings service that applies the mutations it is given and answers with the
 * result.
 *
 * Recording the call alone would prove nothing about the read half: the last
 * case says the value a save writes is the value the adapter then serves, so
 * this stub holds the document and applies each path operation to it, which is
 * what makes the write and the read meet.
 * @returns the in-memory settings service.
 */
function writableSettings(): {
  describe: () => readonly { ns: string; value: unknown }[]
  mutate: (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => Promise<void>
} {
  const document: Record<string, unknown> = { providers: {} }
  return {
    describe: () => [{ ns: 'llm-pi-ai', value: document }],
    mutate: async (_ns, ops) => {
      for (const op of ops) {
        let cursor = document
        for (const key of op.path.slice(0, -1)) {
          const next = cursor[key]
          if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            const created: Record<string, unknown> = {}
            cursor[key] = created
            cursor = created
          } else {
            cursor = next as Record<string, unknown>
          }
        }
        const leaf = op.path[op.path.length - 1]
        // Every path this module writes names at least one segment; a stub that
        // silently applied a pathless op would prove nothing about the read half.
        if (leaf === undefined) throw new Error('settings path op carried no path')
        if (op.op === 'unset') delete cursor[leaf]
        else cursor[leaf] = op.value
      }
    },
  }
}

describe('OpenCode context window', () => {
  it('resolves both new free routes at 200,000 tokens, under the names their ids read as', async () => {
    stubDirectory(directoryRows)
    const { connector } = registeredOpenCode()

    // The name is the picker row's, so this fails if resolution did not find
    // the route in the directory at all — a window assertion alone would pass
    // against the `auto` fallback name and hide a missing row.
    await expect(connector.resolveModel('opencode', 'deepseek-v4.1-flash')).resolves.toMatchObject({
      name: 'Deepseek V4.1 Flash',
      context: { contextWindow: 200_000 },
    })
    await expect(connector.resolveModel('opencode', 'glm-5.3-flash')).resolves.toMatchObject({
      name: 'Glm 5.3 Flash',
      context: { contextWindow: 200_000 },
    })
  })

  it('keeps both routes in the built-in roster, so a failed directory read still offers them at the same window', async () => {
    expect(FREE_UPSTREAM_MODELS.filter(row => row.id === 'deepseek-v4.1-flash' || row.id === 'glm-5.3-flash')).toEqual([
      { id: 'deepseek-v4.1-flash', name: 'Deepseek V4.1 Flash', upstreamId: 'deepseek-v4.1-flash-free' },
      { id: 'glm-5.3-flash', name: 'Glm 5.3 Flash', upstreamId: 'glm-5.3-flash-free' },
    ])

    // An unreachable directory serves the built-in roster rather than failing
    // the route, so the same resolution has to work with no directory at all.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }))
    const { connector } = registeredOpenCode()
    await expect(connector.resolveModel('opencode', 'glm-5.3-flash')).resolves.toMatchObject({
      name: 'Glm 5.3 Flash',
      context: { contextWindow: 200_000 },
    })
  })

  it('serves the window a tuning write states, and its own default for every model the write does not name', async () => {
    stubDirectory(directoryRows)
    const { connector, ctx } = registeredOpenCode(writableSettings())

    // Nothing written yet: the adapter's own declaration answers the route.
    await expect(connector.resolveModel('opencode', 'glm-5.3-flash')).resolves.toMatchObject({
      context: { contextWindow: 200_000 },
    })

    // The panel's save, through the entry point the panel calls.
    await writeModelTuning(ctx, { provider: 'opencode', model: 'glm-5.3-flash', contextWindow: 400_000 })

    await expect(connector.resolveModel('opencode', 'glm-5.3-flash')).resolves.toMatchObject({
      name: 'Glm 5.3 Flash',
      context: { contextWindow: 400_000 },
    })
    // A model the write did not name keeps the plugin's own window.
    await expect(connector.resolveModel('opencode', 'deepseek-v4.1-flash')).resolves.toMatchObject({
      context: { contextWindow: 200_000 },
    })
  })
})
