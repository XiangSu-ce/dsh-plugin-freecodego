/**
 * A context window is not a label: the harness sizes its compaction against it,
 * so a window that is too large is the one that breaks. The conversation is
 * allowed to grow past what the provider will actually accept, nothing local
 * warns anyone, and the route starts refusing mid-session — with the client
 * still reporting a few percent of the window in use.
 *
 * That is what happened to VyceAI. The route declared 1,000,000 for every model
 * while the provider serves 270,000 for `deepseek-v4.1` — a number it publishes
 * in its own directory as `context_window`, which this reader discarded (it kept
 * `id` and nothing else). Measured on the live route with the account's own key:
 * a 269,000-token request was accepted and a 275,000-token one was refused with
 * "This model's maximum context length is 270,000 tokens".
 *
 * A session log holds the other end of it. In the first turn that failed, the
 * prompt held ≈843 KiB of message content (≈216k tokens at 4 bytes/token, ≈288k
 * at the 3 bytes/token this CJK-and-JSON content actually runs at) plus the
 * system prompt and tool schemas, while `request/context` recorded
 * `contextWindow: 1000000` — the harness believed it was 21.6% full while sitting
 * on the provider's ceiling. Every later turn failed the same way, because a
 * longer history can only stay too long.
 *
 * The pins below hold the fix: each route publishes the window its own directory
 * entry carries, the resolved model reports it, and a route the directory does
 * not describe falls back to the number this provider serves rather than to the
 * largest one anyone might hope for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'
import { VYCE_DEFAULT_CONTEXT_WINDOW } from '../src/managed-catalog-utils.ts'

/** The directory as the provider answers it, including the window it publishes. */
const directoryRows = [
  { id: 'deepseek-v4.1', object: 'model', owned_by: 'deepseek', context_window: 270_000 },
  { id: 'qwen3.8-flash', object: 'model', owned_by: 'alibaba', context_window: 1_000_000 },
]

let home = ''
let previousHome: string | undefined

beforeEach(async () => {
  // The known-directory decorator snapshots routes under the active home, so a
  // temp home keeps this spec from reading (or writing) the real catalog cache.
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'fcg-vyce-window-'))
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
    // The directory is authenticated, so a key is what makes it readable at all.
    credentials: () => ({ resolve: async () => ({ value: 'sk-test' }) }),
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

const rowFor = (rows: readonly { id: string }[], id: string): Record<string, unknown> => {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`no row for ${id}`)
  return row as unknown as Record<string, unknown>
}

describe('VyceAI context window', () => {
  it('takes each route window from the directory instead of one number for the provider', async () => {
    stubDirectory(directoryRows)
    const rows = await catalogs().listVyceModels('vyce')

    // Both routes are in the same directory and they are not the same size, so a
    // flat per-provider value is wrong for at least one of them either way.
    expect(rowFor(rows, 'vyce/deepseek-v4.1').contextWindow).toBe(270_000)
    expect(rowFor(rows, 'vyce/qwen3.8-flash').contextWindow).toBe(1_000_000)
    // The row carries the window twice on purpose: `contextWindow` is what the
    // adapter resolves the route from, and `defaultContextWindow` is what the
    // catalog surfaces read. A row where they disagree is a row that reports one
    // number and compacts against another.
    expect(rowFor(rows, 'vyce/deepseek-v4.1').defaultContextWindow).toBe(270_000)
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
    instance.registerVyceAdapter()
    const connector = (registered.vyce as { connector: { resolveModel: (provider: string, model: string) => Promise<{ context: { contextWindow: number } }> } }).connector

    // 1,000,000 here is the defect stated as a number: it is what the route reported
    // while the provider was refusing requests past 270,000.
    await expect(connector.resolveModel('vyce', 'vyce/deepseek-v4.1')).resolves.toMatchObject({ context: { contextWindow: 270_000 } })
    await expect(connector.resolveModel('vyce', 'vyce/qwen3.8-flash')).resolves.toMatchObject({ context: { contextWindow: 1_000_000 } })
  })

  it('falls back to the window this provider serves, not to the largest one, when the directory stays silent', async () => {
    // A directory that omits the field, and one that cannot be read at all: both
    // leave the route active, so both need a window, and the safe direction is the
    // smaller one — compacting early costs room, compacting late costs the route.
    stubDirectory([{ id: 'deepseek-v4.1', object: 'model' }])
    const silent = await catalogs().listVyceModels('vyce')
    expect(rowFor(silent, 'vyce/deepseek-v4.1').contextWindow).toBe(VYCE_DEFAULT_CONTEXT_WINDOW)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }))
    const unreachable = await catalogs().listVyceModels('vyce')
    expect(rowFor(unreachable, 'vyce/deepseek-v4.1').contextWindow).toBe(VYCE_DEFAULT_CONTEXT_WINDOW)
    expect(VYCE_DEFAULT_CONTEXT_WINDOW).toBeLessThan(1_000_000)
  })
})
