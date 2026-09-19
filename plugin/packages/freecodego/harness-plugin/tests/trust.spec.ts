/**
 * The folder-trust gate.
 *
 * What these cases are actually protecting
 * ----------------------------------------
 * A trust gate that is merely *present* proves nothing; the failure it exists to
 * prevent is a repository arming a capability on a machine that never agreed to
 * it. So the cases below deliberately concentrate on the three ways that goes
 * wrong in practice rather than on covering lines:
 *
 * 1. **The unit of trust drifts.** Keying on the cwd instead of the repository
 *    root, or on a path prefix instead of an exact key, silently widens one
 *    grant into a whole subtree. Two cases exist only to catch that (a nested
 *    checkout must not inherit its parent's grant, and a sibling path must not
 *    match), and both are written so that changing the key to a prefix makes
 *    them fail.
 * 2. **A refusal goes silent.** The gate is allowed to skip a surface; it is
 *    never allowed to skip one silently. Every refusal carries a reason, and the
 *    registry reports refusals apart from mount failures so a user can tell
 *    "grant this" from "retry this".
 * 3. **The gate itself becomes the outage.** An unreadable record, a missing
 *    `git`, or a throwing gate must not turn an optional surface into a broken
 *    host. The fail-soft cases are as load-bearing as the denying ones.
 *
 * The record is a file on disk, so the store cases run against a real temporary
 * directory: a mocked filesystem would not exercise the atomic write, which is
 * the part that can corrupt a record.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FreeCodeGoCapabilityRegistry } from '../src/capabilities.ts'
import {
  FOLDER_TRUST_ENV,
  FolderTrustStore,
  canonicalTrustKey,
  defaultTrustRecordPath,
  folderTrustEnabled,
  parseTrustRecord,
  repositoryRoot,
  resolveFolderTrust,
  seedTrustRecordOnce,
} from '../src/trust.ts'

const ISO = '2026-09-17T00:00:00.000Z'

/**
 * A temporary directory in the spelling {@link repositoryRoot} will answer with.
 *
 * The gate keys every grant on a **realpath'd** root (see the module's "unit of
 * trust" note), and `repositoryRoot` must therefore be compared against a
 * canonical expectation. `os.tmpdir()` is not always canonical: on Windows it can
 * be the 8.3 short form (`C:/Users/ADMINI~1/AppData/Local/Temp`), so a fixture
 * built straight from it produces paths that differ from the code's answer in
 * spelling alone and fails every case that compares the two. Resolving the temp
 * base once makes the whole fixture canonical, which is what the production call
 * sites get for free by passing their directory through `repositoryRoot`.
 *
 * The asynchronous `realpath` is the one that works here: `node:fs`'s
 * synchronous `realpathSync` resolves symlinks but leaves the 8.3 short name
 * alone, so a fixture built with it would still disagree with `repositoryRoot`.
 * @param prefix - test-specific prefix so concurrent files do not collide.
 * @returns the canonical path of the created directory.
 */
async function canonicalTmpDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)))
}

function record(roots: readonly string[]) {
  return { version: 1, entries: roots.map(root => ({ root: canonicalTrustKey(root), grantedAt: ISO })) }
}

describe('resolveFolderTrust', () => {
  const root = canonicalTrustKey('/work/repo')

  it('trusts a root that holds a grant', () => {
    expect(resolveFolderTrust({ repoRoot: root, record: record(['/work/repo']), enabled: true }))
      .toEqual({ trusted: true, reason: 'granted' })
  })

  it('refuses a root with no grant', () => {
    expect(resolveFolderTrust({ repoRoot: root, record: record([]), enabled: true }))
      .toEqual({ trusted: false, reason: 'no-record' })
  })

  it('refuses a root whose grant was revoked', () => {
    // A revoke removes the entry, so "revoked" and "never granted" are the same
    // observable state. Both must refuse, and neither may fall back to a parent.
    expect(resolveFolderTrust({ repoRoot: root, record: record(['/work/other']), enabled: true }).trusted).toBe(false)
  })

  it('admits everything when the gate is disabled, and says so', () => {
    // The reason matters as much as the verdict: `global-disabled` is not a user
    // grant, and a surface that reported it as one would claim an audit trail it
    // does not have.
    expect(resolveFolderTrust({ repoRoot: undefined, record: record([]), enabled: false }))
      .toEqual({ trusted: true, reason: 'global-disabled' })
  })

  it('refuses outside a repository instead of treating it as an escape hatch', () => {
    expect(resolveFolderTrust({ repoRoot: undefined, record: record(['/work/repo']), enabled: true }))
      .toEqual({ trusted: false, reason: 'not-a-repository' })
  })

  it('does not leak a grant from a parent repository into a nested checkout', () => {
    // The vendored-checkout case. A prefix comparison would admit this; an exact
    // key comparison refuses it, which is the whole reason the key is exact.
    const nested = canonicalTrustKey('/work/repo/vendor/other')
    expect(resolveFolderTrust({ repoRoot: nested, record: record(['/work/repo']), enabled: true }).trusted).toBe(false)
  })

  it('does not admit a sibling directory that merely shares a prefix', () => {
    const sibling = canonicalTrustKey('/work/repo-other')
    expect(resolveFolderTrust({ repoRoot: sibling, record: record(['/work/repo']), enabled: true }).trusted).toBe(false)
  })
})

describe('canonicalTrustKey', () => {
  it('drops trailing separators so one directory has one key', () => {
    expect(canonicalTrustKey('/work/repo/')).toBe(canonicalTrustKey('/work/repo'))
    expect(canonicalTrustKey('/work/repo///')).toBe(canonicalTrustKey('/work/repo'))
  })

  it('normalizes Windows separators', () => {
    expect(canonicalTrustKey('C:\\work\\repo')).toBe(canonicalTrustKey('C:/work/repo'))
  })

  it('preserves case where the filesystem does', () => {
    // Case folding is a platform property, not a preference: folding on Linux
    // would merge two genuinely different directories into one grant.
    const folded = canonicalTrustKey('/work/Repo') === canonicalTrustKey('/work/repo')
    expect(folded).toBe(process.platform !== 'linux')
  })
})

describe('folderTrustEnabled', () => {
  const previous = process.env[FOLDER_TRUST_ENV]

  afterEach(() => {
    if (previous === undefined) delete process.env[FOLDER_TRUST_ENV]
    else process.env[FOLDER_TRUST_ENV] = previous
  })

  it('lets the environment disable the gate over an enabling setting', () => {
    for (const raw of ['0', 'false', 'off', 'FALSE', ' off ']) {
      process.env[FOLDER_TRUST_ENV] = raw
      expect(folderTrustEnabled({ folderTrustEnabled: true })).toBe(false)
    }
  })

  it('lets the environment enable the gate over a disabling setting', () => {
    for (const raw of ['1', 'true', 'on', 'ON']) {
      process.env[FOLDER_TRUST_ENV] = raw
      expect(folderTrustEnabled({ folderTrustEnabled: false })).toBe(true)
    }
  })

  it('ignores an unrecognized environment value and falls back to settings', () => {
    process.env[FOLDER_TRUST_ENV] = 'maybe'
    expect(folderTrustEnabled({ folderTrustEnabled: false })).toBe(false)
    expect(folderTrustEnabled({ folderTrustEnabled: true })).toBe(true)
  })

  it('defaults on when nothing has an opinion, because the safe state is not the opt-in one', () => {
    delete process.env[FOLDER_TRUST_ENV]
    // `undefined` is the only shape "no opinion" can take: the schema always
    // resolves the key, so an absent settings object is the real case.
    expect(folderTrustEnabled(undefined)).toBe(true)
  })
})

describe('parseTrustRecord', () => {
  it('rejects anything that is not the expected shape', () => {
    // Each of these would otherwise become "some entry is trusted", which is the
    // one direction this parser must never fail in.
    for (const value of [undefined, null, 42, 'text', [], { version: 2, entries: [] }, { version: 1, entries: {} }]) {
      expect(parseTrustRecord(value)).toEqual({ version: 1, entries: [] })
    }
  })

  it('drops malformed entries while keeping the valid ones', () => {
    const parsed = parseTrustRecord({
      version: 1,
      entries: [
        { root: '/work/keep', grantedAt: ISO },
        null,
        [],
        { root: '', grantedAt: ISO },
        { root: '/work/no-timestamp' },
        { root: 42, grantedAt: ISO },
        'nope',
      ],
    })
    expect(parsed.entries).toEqual([{ root: canonicalTrustKey('/work/keep'), grantedAt: ISO }])
  })

  it('canonicalizes stored roots so an old spelling still matches', () => {
    const parsed = parseTrustRecord({ version: 1, entries: [{ root: '/work/repo/', grantedAt: ISO }] })
    expect(parsed.entries[0]?.root).toBe(canonicalTrustKey('/work/repo'))
  })
})

describe('FolderTrustStore', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'freecodego-trust-'))
    file = join(directory, 'nested', 'trusted-folders.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('reads an absent record as empty rather than throwing', async () => {
    expect(await new FolderTrustStore(file).read()).toEqual({ version: 1, entries: [] })
  })

  it('reads a corrupt record as empty rather than throwing', async () => {
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    expect(await new FolderTrustStore(file).read()).toEqual({ version: 1, entries: [] })
  })

  it('grants, reports, and persists a root', async () => {
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    expect(await store.isTrusted(canonicalTrustKey('/work/repo'))).toBe(true)
    expect(await store.isTrusted(canonicalTrustKey('/work/other'))).toBe(false)
    // A second instance is what a restart looks like: the grant must survive
    // outside the object, or it is not durable state at all.
    expect(await new FolderTrustStore(file).isTrusted(canonicalTrustKey('/work/repo'))).toBe(true)
  })

  it('treats a repeated grant as one entry', async () => {
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    await store.grant('/work/repo/')
    expect((await store.read()).entries).toHaveLength(1)
  })

  it('revokes, and revoking an unknown root is a no-op', async () => {
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    await store.revoke('/work/never-granted')
    expect(await store.isTrusted(canonicalTrustKey('/work/repo'))).toBe(true)
    await store.revoke('/work/repo')
    expect(await store.isTrusted(canonicalTrustKey('/work/repo'))).toBe(false)
  })

  it('never trusts an undefined root', async () => {
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    expect(await store.isTrusted(undefined)).toBe(false)
  })

  it('writes atomically, leaving no temporary file behind', async () => {
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    const names = await readdir(join(directory, 'nested'))
    expect(names).toEqual(['trusted-folders.json'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('reports the recorded entries and the path holding them', async () => {
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    const status = await store.status(true)
    expect(status.recordPath).toBe(file)
    expect(status.entries.map(entry => entry.root)).toEqual([canonicalTrustKey('/work/repo')])
  })

  it('reports the switch it was told about rather than a hardcoded one', async () => {
    // `enabled` is documented as the resolved master switch, and this store can see
    // neither the settings document nor the environment fold. Reporting `true`
    // unconditionally made the one field a user checks to find out whether the gate
    // is running the one field the store could not support.
    const store = new FolderTrustStore(file)
    await store.grant('/work/repo')
    expect((await store.status(false)).enabled).toBe(false)
    expect((await store.status(true)).enabled).toBe(true)
    // And the entries are still reported when the gate is off: they are the record,
    // not a decision about it.
    expect((await store.status(false)).entries.map(entry => entry.root)).toEqual([canonicalTrustKey('/work/repo')])
  })
})

describe('repositoryRoot', () => {
  let directory: string
  const gitAvailable = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  beforeEach(async () => {
    directory = await canonicalTmpDir('freecodego-trust-git-')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const initRepo = (path: string): void => {
    execFileSync('git', ['init', '--quiet', path], { stdio: 'ignore' })
  }

  it.skipIf(!gitAvailable)('resolves the repository root containing a nested directory', async () => {
    const repo = join(directory, 'repo')
    await mkdir(join(repo, 'src', 'deep'), { recursive: true })
    initRepo(repo)
    expect(await repositoryRoot(join(repo, 'src', 'deep'))).toBe(canonicalTrustKey(repo))
  })

  it.skipIf(!gitAvailable)('resolves a nested checkout to its own root, not its parent', async () => {
    const parent = join(directory, 'parent')
    const nested = join(parent, 'vendor', 'child')
    await mkdir(nested, { recursive: true })
    initRepo(parent)
    initRepo(nested)
    expect(await repositoryRoot(nested)).toBe(canonicalTrustKey(nested))
  })

  it.skipIf(!gitAvailable)('reports no repository outside one', async () => {
    const outside = join(directory, 'loose')
    await mkdir(outside, { recursive: true })
    expect(await repositoryRoot(outside)).toBeUndefined()
  })
})

/**
 * Seeding is the only place the gate writes without being asked, so these cases
 * are about the two ways an automatic grant turns into a bug: running again when
 * a record already exists (which would resurrect a repository the user removed),
 * and running while the gate is off (which would record a decision nothing acts
 * on). `FREECODEGO_HOME` aims the record at a temporary root, so the cases are
 * about the seeding rule and never touch the real user's home.
 */
describe('seedTrustRecordOnce', () => {
  let directory: string
  let home: string
  let previousHome: string | undefined

  const gitAvailable = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  beforeEach(async () => {
    directory = await canonicalTmpDir('freecodego-trust-seed-')
    home = join(directory, 'home')
    previousHome = process.env.FREECODEGO_HOME
    process.env.FREECODEGO_HOME = home
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FREECODEGO_HOME
    else process.env.FREECODEGO_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  })

  const initRepo = (path: string): void => {
    execFileSync('git', ['init', '--quiet', path], { stdio: 'ignore' })
  }

  it.skipIf(!gitAvailable)('seeds a grant for the repository it booted in', async () => {
    const repo = join(directory, 'repo')
    await mkdir(repo, { recursive: true })
    initRepo(repo)
    expect(await seedTrustRecordOnce({ directory: repo, enabled: true })).toBe(true)
    expect(await new FolderTrustStore(defaultTrustRecordPath()).isTrusted(canonicalTrustKey(repo))).toBe(true)
  })

  it.skipIf(!gitAvailable)('makes the grant visible to the store the gate already read', async () => {
    // The gate reads the record during its first reconcile, which is what the seed
    // follows. A seed that wrote through a second store instance would leave the
    // gate answering from the empty record it cached: the surfaces stay refused and
    // the panel shows no grant, until the next launch — the state the seed exists to
    // prevent, reported as success.
    const repo = join(directory, 'repo')
    await mkdir(repo, { recursive: true })
    initRepo(repo)
    const gate = new FolderTrustStore(defaultTrustRecordPath())
    expect(await gate.read()).toEqual({ version: 1, entries: [] })
    expect(await seedTrustRecordOnce({ directory: repo, enabled: true, store: gate })).toBe(true)
    expect(await gate.isTrusted(canonicalTrustKey(repo))).toBe(true)
    expect((await gate.read()).entries).toHaveLength(1)
  })

  it.skipIf(!gitAvailable)('seeds once, so a restart cannot undo a revoke', async () => {
    const repo = join(directory, 'repo')
    await mkdir(repo, { recursive: true })
    initRepo(repo)
    expect(await seedTrustRecordOnce({ directory: repo, enabled: true })).toBe(true)
    // The user revokes and restarts. Seeding again would silently re-grant the
    // repository they just removed, which is the whole reason this is once.
    await new FolderTrustStore(defaultTrustRecordPath()).revoke(repo)
    expect(await seedTrustRecordOnce({ directory: repo, enabled: true })).toBe(false)
    expect(await new FolderTrustStore(defaultTrustRecordPath()).isTrusted(canonicalTrustKey(repo))).toBe(false)
  })

  it.skipIf(!gitAvailable)('writes nothing while the gate is disabled', async () => {
    const repo = join(directory, 'repo')
    await mkdir(repo, { recursive: true })
    initRepo(repo)
    expect(await seedTrustRecordOnce({ directory: repo, enabled: false })).toBe(false)
    // Not even the file: a record left behind by a disabled gate would claim a
    // decision nobody made.
    await expect(readFile(defaultTrustRecordPath(), 'utf8')).rejects.toThrow()
  })

  it('writes nothing outside a repository', async () => {
    const loose = join(directory, 'loose')
    await mkdir(loose, { recursive: true })
    expect(await seedTrustRecordOnce({ directory: loose, enabled: true })).toBe(false)
    await expect(readFile(defaultTrustRecordPath(), 'utf8')).rejects.toThrow()
  })
})

/**
 * The registry is where the gate has to actually stop something, so these cases
 * drive it with structural doubles: the contract under test is "which entries
 * reach `ctx.plugin`", not the Cordis mount itself.
 */
describe('capability registry trust gating', () => {
  /** A context double that records every mounted provider. */
  const contextDouble = () => {
    const mounted: string[] = []
    return {
      mounted,
      ctx: {
        plugin: async (definition: { readonly name: string }) => {
          mounted.push(definition.name)
          return { dispose: async () => undefined }
        },
        get: () => undefined,
        // `snapshot()` reads the live tool registry to list bridged MCP tools;
        // an empty one keeps these cases about the gate rather than the bridge.
        tools: { schemas: () => [] },
      } as never,
    }
  }

  const settingsDouble = (value: unknown) => ({ get: () => value, update: async () => undefined }) as never

  const configuration = (overrides: Record<string, unknown>) => ({
    mcpEnabled: false,
    skillEnabled: false,
    voiceInputEnabled: true,
    sessionDeleteEnabled: true,
    modelCategories: {},
    mcpServers: [],
    skillRoots: [],
    skillInvocationOverrides: {},
    ...overrides,
  })

  it('mounts a Skill root the gate admits', async () => {
    const { ctx, mounted } = contextDouble()
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({ skillEnabled: true, skillRoots: [{ id: 'r1', enabled: true, path: '/work/trusted/skills' }] })),
      async () => ({ trusted: true, reason: 'granted' }),
    )
    await registry.remount()
    expect(mounted).toEqual(['freecodego-skill-roots'])
  })

  it('withholds a Skill root the gate refuses, and reports the refusal', async () => {
    const { ctx, mounted } = capabilityFreeContext()
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({ skillEnabled: true, skillRoots: [{ id: 'r1', enabled: true, path: '/work/untrusted/skills' }] })),
      async () => ({ trusted: false, reason: 'no-record' }),
    )
    await registry.remount()
    // Nothing mounted, and — the part that matters — the skip is visible.
    expect(mounted).toEqual([])
    const snapshot = await registry.snapshot()
    expect(snapshot.trustRefusals).toEqual([
      { id: 'skill:r1', message: expect.stringContaining('no-record') },
    ])
    expect(snapshot.mountErrors).toBeUndefined()
  })

  it('mounts only the admitted roots when a family is mixed', async () => {
    const { ctx, mounted, mountedConfigs } = capabilityFreeContext()
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({
        skillEnabled: true,
        skillRoots: [
          { id: 'ok', enabled: true, path: '/work/trusted/skills' },
          { id: 'denied', enabled: true, path: '/work/untrusted/skills' },
        ],
      })),
      async directory => directory === '/work/trusted/skills' ? { trusted: true, reason: 'granted' } : { trusted: false, reason: 'no-record' },
    )
    await registry.remount()
    expect(mounted).toEqual(['freecodego-skill-roots'])
    expect(mountedConfigs[0]).toMatchObject({ customSkillDirs: ['/work/trusted/skills'] })
  })

  it('never asks about an MCP server with no working directory', async () => {
    // A server with an empty `cwd` runs from wherever the Host runs, so there is
    // no repository to gate. Asking anyway would refuse a user's own server.
    const { ctx, mounted } = capabilityFreeContext()
    const asked: string[] = []
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({
        mcpEnabled: true,
        mcpServers: [{ id: 's1', enabled: true, transport: 'stdio', serverName: 'github', command: 'npx', args: [], env: {}, headers: {}, cwd: '', url: '' }],
      })),
      async (directory) => { asked.push(directory); return { trusted: true, reason: 'granted' } },
    )
    await registry.remount()
    expect(asked).toEqual([])
    expect(mounted).toEqual(['freecodego-mcp-github'])
  })

  it('gates an MCP server pinned to a directory', async () => {
    const { ctx, mounted } = capabilityFreeContext()
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({
        mcpEnabled: true,
        mcpServers: [{ id: 's1', enabled: true, transport: 'stdio', serverName: 'github', command: 'npx', args: [], env: {}, headers: {}, cwd: '/work/untrusted', url: '' }],
      })),
      async () => ({ trusted: false, reason: 'no-record' }),
    )
    await registry.remount()
    expect(mounted).toEqual([])
    expect((await registry.snapshot()).trustRefusals?.[0]?.id).toBe('mcp:s1')
  })

  it('admits an entry when the gate cannot answer', async () => {
    // Fail-soft by design: the surfaces here are optional, and turning a trust
    // lookup failure into "your Skill root vanished" is a worse bug than the one
    // the gate prevents. The refusal list stays empty so the state is reported
    // as admitted, not as a silently-denied mount.
    const { ctx, mounted } = capabilityFreeContext()
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({ skillEnabled: true, skillRoots: [{ id: 'r1', enabled: true, path: '/work/repo/skills' }] })),
      async () => { throw new Error('record unreadable') },
    )
    await registry.remount()
    expect(mounted).toEqual(['freecodego-skill-roots'])
    expect((await registry.snapshot()).trustRefusals).toBeUndefined()
  })

  it('does not let a standing refusal look like an incomplete mount', async () => {
    // If a refusal counted as "incomplete", every unrelated settings write would
    // consider the family changed and tear down working providers.
    const { ctx } = capabilityFreeContext()
    const registry = new FreeCodeGoCapabilityRegistry(
      ctx,
      settingsDouble(configuration({ skillEnabled: true, skillRoots: [{ id: 'r1', enabled: true, path: '/work/untrusted/skills' }] })),
      async () => ({ trusted: false, reason: 'no-record' }),
    )
    await registry.remount()
    const first = (await registry.snapshot()).trustRefusals?.length
    await registry.remount()
    expect((await registry.snapshot()).trustRefusals?.length).toBe(first)
  })

  /** A context double that also records the config each mount received. */
  function capabilityFreeContext() {
    const mounted: string[] = []
    const mountedConfigs: unknown[] = []
    return {
      mounted,
      mountedConfigs,
      ctx: {
        plugin: async (definition: { readonly name: string }, config: unknown) => {
          mounted.push(definition.name)
          mountedConfigs.push(config)
          return { dispose: async () => undefined }
        },
        get: () => undefined,
        tools: { schemas: () => [] },
      } as never,
    }
  }
})
