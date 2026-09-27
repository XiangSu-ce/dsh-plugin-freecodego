/**
 * The third provider in the window sweep, and the one with no number to read.
 *
 * NVIDIA's NIM directory answers 82 ids and **no capacity field**: no
 * `context_window`, no `context_length`, no `max_output_tokens` (measured against
 * the public endpoint, which needs no key). So unlike the VyceAI and SenseNova
 * paths there is nothing here to read, and the declaration is the product's —
 * 264,000.
 *
 * What it replaces is a flat 1,000,000. That number was the over-large direction,
 * and this roster makes the failure concrete rather than theoretical: it runs from
 * small open models (`google/gemma-3-4b-it`, `ibm/granite-3.0-3b-a800m-instruct`)
 * to 0813-era flagships, and compaction is sized against the declared window — so
 * 1,000,000 let a conversation grow far past what a NIM route serves, with nothing
 * local to warn anyone, which is the shape of the failure this sweep exists for.
 *
 * These pins hold the two halves: the route resolves at the product ceiling, and
 * the reader does not invent a per-row wall it was never given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'
import { NVIDIA_DEFAULT_CONTEXT_WINDOW } from '../src/managed-catalog-utils.ts'

let home = ''
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'fcg-nvidia-window-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** Answer the model directory with ids and nothing else, as NIM does. */
function stubDirectory(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: [
      { id: 'moonshotai/kimi-k3', object: 'model', owned_by: 'moonshotai' },
      { id: 'google/gemma-4-31b-it', object: 'model', owned_by: 'google' },
    ] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
}

/** The adapter the class registers for `nvidia`, as the Host's `llm` service holds it. */
function nvidiaConnector(): { resolveModel: (provider: string, model: string) => Promise<{ context?: { contextWindow: number } }> } {
  const registered: Record<string, unknown> = {}
  const catalogs = new FreeCodeGoManagedCatalogs({
    ctx: {
      emit: () => undefined,
      on: () => undefined,
      get: (name: string) => name === 'llm'
        ? { registerAdapter: (providers: readonly string[], adapter: unknown) => { for (const id of providers) registered[id] = adapter } }
        : undefined,
    },
    // A key is what makes these routes resolvable at all; the directory itself is public.
    credentials: () => ({ resolve: async () => ({ value: 'nvapi-test' }) }),
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
  catalogs.registerNvidiaAdapter()
  return (registered.nvidia as { connector: { resolveModel: (provider: string, model: string) => Promise<{ context?: { contextWindow: number } }> } }).connector
}

describe('NVIDIA context window', () => {
  it('declares the product ceiling, not the million tokens the old default asserted', () => {
    expect(NVIDIA_DEFAULT_CONTEXT_WINDOW).toBe(264_000)
    expect(NVIDIA_DEFAULT_CONTEXT_WINDOW).toBeLessThan(1_000_000)
  })

  it('resolves every listed route at the product ceiling', async () => {
    stubDirectory()
    const connector = nvidiaConnector()
    // The number compaction reads. A route that resolved at 1,000,000 is one the
    // harness would let grow to 1,000,000 before doing anything about it.
    await expect(connector.resolveModel('nvidia', 'moonshotai/kimi-k3')).resolves.toMatchObject({ context: { contextWindow: 264_000 } })
    await expect(connector.resolveModel('nvidia', 'google/gemma-4-31b-it')).resolves.toMatchObject({ context: { contextWindow: 264_000 } })
  })

  it('invents no per-route window from a directory that publishes none', async () => {
    stubDirectory()
    const rows = await nvidiaConnector().resolveModel('nvidia', 'moonshotai/kimi-k3')
    expect(rows.context?.contextWindow).toBe(NVIDIA_DEFAULT_CONTEXT_WINDOW)
    // And the listing carries no window either: a row that stated a per-route
    // number here would be a number nobody published.
    const listed = await new FreeCodeGoManagedCatalogs({
      ctx: { emit: () => undefined, on: () => undefined, get: () => undefined },
      credentials: () => ({ resolve: async () => ({ value: 'nvapi-test' }) }),
    } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0]).listNvidiaModels('nvidia')
    expect(listed.every(row => (row as { readonly contextWindow?: number }).contextWindow === undefined)).toBe(true)
  })
})
