/**
 * The capability-marketplace cache is keyed by request URL, so every search
 * term, page offset, and opened MCP slug writes its own file into a directory
 * shared with the fixed-name catalogs. Nothing else in the plugin enumerates
 * that directory, so without a sweep the entries only accumulate on disk.
 *
 * This pins the sweep: an aged-out entry goes, a fresh one stays, and every
 * other file in the directory — the catalogs that are not this cache — is left
 * strictly alone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/marketplace-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/marketplace-utils.ts')>()
  return { ...actual, fetchMarketplaceJson: vi.fn(async () => ({ data: { servers: [], total: 0 } })) }
})

import { capabilityMarketplace, type CommunityRemotesHost, type CommunityRemotesState } from '../src/community-remotes.ts'

const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

const DAY_MS = 24 * 60 * 60_000

/** A harness home whose state directory already holds the files under test. */
async function homeWithCacheFiles(): Promise<{ home: string; directory: string }> {
  const home = await mkdtemp(join(tmpdir(), 'fcg-marketplace-cache-'))
  created.push(home)
  const directory = join(home, 'state', 'freecodego')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'capability-marketplace-stale.json'), JSON.stringify({ version: 1, savedAt: Date.now() - 30 * DAY_MS, payload: {} }))
  await writeFile(join(directory, 'capability-marketplace-fresh.json'), JSON.stringify({ version: 1, savedAt: Date.now() - DAY_MS, payload: {} }))
  // Not this cache: a fixed-name catalog in the same directory.
  await writeFile(join(directory, 'kilo-free-models.json'), JSON.stringify({ version: 1, savedAt: Date.now() - 30 * DAY_MS, models: [] }))
  return { home, directory }
}

function hostFor(directory: string): CommunityRemotesHost {
  const state: CommunityRemotesState = {
    communityMutationTask: undefined,
    communityCatalogPromise: undefined,
    communityCatalogRefreshPromise: undefined,
    marketplaceRefreshPromises: new Map(),
    communityIconCacheTask: undefined,
    marketplaceCachePrunedAt: 0,
  }
  return {
    ctx: {},
    // The listing only needs the switch state the summaries filter on.
    capabilities: { configuration: () => ({ mcpServers: [] }) },
    catalogs: { catalogCachePath: (name: string) => join(directory, name) },
    state,
    communityCatalog: async () => ({ plugins: [] }),
    communityProfileDirectory: () => directory,
    communitySkillDirectory: () => join(directory, 'skills'),
    communityRuntimeStartTime: () => 0,
  } as unknown as CommunityRemotesHost
}

describe('capability marketplace cache sweep', () => {
  it('removes aged-out entries and leaves fresh and foreign files alone', async () => {
    const { directory } = await homeWithCacheFiles()
    const host = hostFor(directory)

    await capabilityMarketplace(host, { kind: 'mcp', query: 'anything' })

    expect(existsSync(join(directory, 'capability-marketplace-stale.json'))).toBe(false)
    expect(existsSync(join(directory, 'capability-marketplace-fresh.json'))).toBe(true)
    expect(existsSync(join(directory, 'kilo-free-models.json'))).toBe(true)
  })

  it('throttles the sweep so a read does not rescan the directory every time', async () => {
    const { directory } = await homeWithCacheFiles()
    const host = hostFor(directory)

    await capabilityMarketplace(host, { kind: 'mcp', query: 'first' })
    expect(existsSync(join(directory, 'capability-marketplace-stale.json'))).toBe(false)

    // A new aged-out entry appears after the sweep already ran...
    await writeFile(join(directory, 'capability-marketplace-stale2.json'), JSON.stringify({ version: 1, savedAt: Date.now() - 30 * DAY_MS, payload: {} }))
    await capabilityMarketplace(host, { kind: 'mcp', query: 'second' })
    // ...and survives this read: the sweep is interval-gated, not per request.
    expect(existsSync(join(directory, 'capability-marketplace-stale2.json'))).toBe(true)
  })
})
