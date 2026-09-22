/**
 * The Marketplace install as the Host reaches it — through the remote, not the
 * module underneath it.
 *
 * `marketplace-install.spec.ts` proves what the install does; this file proves the
 * **Marketplace page is wired to it**, which is the claim that a revert would break
 * silently. The path it replaces cloned the repository and copied the Skill into
 * place with no record at all: every case here fails against that version, because
 * the record beside the root is what it never wrote.
 *
 * The identity is a directory on this machine, so the case is offline: `skill:`
 * followed by anything the source parser understands is what the Host hands over,
 * and a local path is the one identity whose fetch needs no network. What is being
 * checked is not how a repository is cloned — that is the module spec's subject —
 * but that installing through the remote lands a *recorded* Skill, refuses a
 * collision before enabling the root, and reports what it pinned.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skillPlacements, skillPresetInstall, skillPresetRemove, type CommunityRemotesHost, type CommunityRemotesState } from '../src/community-remotes.ts'
import type { FreeCodeGoCapabilityRegistry } from '../src/capabilities.ts'
import { SKILL_LOCK_FILENAME } from '../src/skills/lockfile.ts'
import { verifySkillRoot } from '../src/skills/marketplace-install.ts'
import type { PlacementContext } from '../src/skills/placement.ts'

const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A scratch harness home this case's cleanup owns. */
async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** A Skill directory on disk, with the name its SKILL.md declares. */
async function writeSkillDirectory(input: { readonly base: string; readonly directory: string; readonly declared: string; readonly body: string }): Promise<string> {
  const path = join(input.base, input.directory)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${input.declared}\n---\n${input.body}\n`)
  return path
}

/**
 * A Host surface wide enough for one install.
 *
 * `enabled` records the managed roots the install asked to enable, in order: the
 * install→enable ordering is a claim of this path (a refusal must not enable
 * anything), and a fake that swallowed the call could not hold it.
 */
function hostFor(home: string, context?: Partial<PlacementContext>, preferred?: { readonly agent: 'harness' | 'agents'; readonly scope: 'project' | 'user' }): { readonly host: CommunityRemotesHost; readonly enabled: string[]; readonly logged: string[] } {
  const enabled: string[] = []
  const logged: string[] = []
  const state: CommunityRemotesState = {
    communityMutationTask: undefined,
    communityCatalogPromise: undefined,
    communityCatalogRefreshPromise: undefined,
    marketplaceRefreshPromises: new Map(),
    communityIconCacheTask: undefined,
    marketplaceCachePrunedAt: 0,
  }
  const host = {
    ctx: { logger: { info: (message: string) => { logged.push(message) } } },
    capabilities: {
      enableManagedSkillRoot: async (id: string, root: string) => {
        enabled.push(`${id}:${root}`)
        return { enabledSkillRoots: [root] }
      },
      // Read-only: a removal re-reads the snapshot instead of re-enabling the root.
      snapshot: async () => ({ enabledSkillRoots: ['whatever the root already was'] }),
      // The matrix reports the remembered choice from the same configuration the install
      // path reads, so the page and the install cannot disagree about the destination.
      configuration: () => (preferred === undefined ? {} : { preferredSkillPlacement: preferred }),
    } as unknown as FreeCodeGoCapabilityRegistry,
    state,
    communityCatalog: async () => ({ plugins: [] }),
    communityProfileDirectory: () => join(home, 'profile'),
    communitySkillDirectory: () => join(home, 'profile', 'skills'),
    communityRuntimeStartTime: () => 0,
    // Resolved by the Host in production (data home, home directory, folder trust).
    // Restated here so the matrix's own arithmetic — not a fake of it — decides where
    // a placement install lands.
    skillPlacementContext: async () => ({
      workspace: join(home, 'workspace'),
      dataHome: join(home, 'data'),
      home: join(home, 'user'),
      projectTrusted: false,
      ...context,
    }),
  } as unknown as CommunityRemotesHost
  return { host, enabled, logged }
}

describe('the Marketplace install remote', () => {
  it('installs a recorded Skill and enables the root it landed in', async () => {
    const home = await scratch('fcg-skill-remote-')
    const { host, enabled, logged } = hostFor(home)
    const root = host.communitySkillDirectory()
    const directory = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'installed through the remote' })

    const snapshot = await skillPresetInstall(host, `skill:${directory}`)

    // The report the settings page reads: what was pinned, and that it was recorded.
    expect(snapshot.skillInstall?.name).toBe('demo')
    expect(snapshot.skillInstall?.locked).toBe(true)
    expect(snapshot.skillInstall?.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('installed through the remote')
    // The record is written beside the root, and it is what makes the install checkable.
    expect(existsSync(join(home, 'profile', SKILL_LOCK_FILENAME))).toBe(true)
    expect(await verifySkillRoot(root)).toEqual([])
    expect(enabled).toEqual([`freecodego-community:${root}`])
    expect(logged.join('\n')).toContain('demo')
  })

  it('removes a Skill through the remote, taking its record with it', async () => {
    const home = await scratch('fcg-skill-remote-remove-')
    const { host, enabled } = hostFor(home)
    const root = host.communitySkillDirectory()
    const directory = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'to be removed' })

    await skillPresetInstall(host, `skill:${directory}`)
    const snapshot = await skillPresetRemove(host, `skill:${directory}`)

    expect(snapshot.skillRemove?.name).toBe('demo')
    expect(snapshot.skillRemove?.recorded).toBe(true)
    expect(snapshot.skillRemove?.verification).toEqual([])
    expect(existsSync(join(root, 'demo'))).toBe(false)
    // The record is not left naming a Skill that is gone.
    expect(await verifySkillRoot(root)).toEqual([])
    // The root stays mounted: removal re-reads the snapshot rather than enabling.
    expect(enabled.length).toBe(1)
  })

  it('rejects the removal of something this root does not hold', async () => {
    const home = await scratch('fcg-skill-remote-remove-missing-')
    const { host } = hostFor(home)
    await mkdir(host.communitySkillDirectory(), { recursive: true })

    await expect(skillPresetRemove(host, 'skill:acme/skills/demo')).rejects.toThrow(/not installed in this managed root/u)
  })

  it('installs into a chosen placement and mounts that placement\'s own root', async () => {
    const home = await scratch('fcg-skill-remote-placement-')
    const { host, enabled } = hostFor(home)
    const directory = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'placed by the user' })
    const root = join(home, 'data', 'skills')

    const snapshot = await skillPresetInstall(host, `skill:${directory}`, { agent: 'harness', scope: 'user' })

    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('placed by the user')
    expect(snapshot.skillInstall?.placement).toEqual({ root, provenance: 'user, harness native' })
    // The id is per placement: reusing the community root's id would unmount the
    // community root the page reads its own list from.
    expect(enabled).toEqual([`freecodego-skill-harness-user:${root}`])
    // The default root is untouched — a placement moves the file, it does not copy it.
    expect(existsSync(join(host.communitySkillDirectory(), 'demo'))).toBe(false)
  })

  it('removes a placed Skill out of the root it was placed in', async () => {
    const home = await scratch('fcg-skill-remote-placement-remove-')
    const { host } = hostFor(home)
    const directory = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'to be removed from its placement' })
    const root = join(home, 'data', 'skills')

    await skillPresetInstall(host, `skill:${directory}`, { agent: 'harness', scope: 'user' })
    const snapshot = await skillPresetRemove(host, `skill:${directory}`)

    expect(snapshot.skillRemove?.name).toBe('demo')
    expect(snapshot.skillRemove?.recorded).toBe(true)
    expect(existsSync(join(root, 'demo'))).toBe(false)
    expect(await verifySkillRoot(root)).toEqual([])
  })

  it('refuses a project install into an untrusted folder with the matrix\'s own reason', async () => {
    const home = await scratch('fcg-skill-remote-placement-untrusted-')
    const { host, enabled } = hostFor(home)
    const directory = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'must not land in an untrusted checkout' })

    await expect(skillPresetInstall(host, `skill:${directory}`, { agent: 'agents', scope: 'project' })).rejects.toThrow(/requires a trusted folder/u)
    expect(enabled).toEqual([])
    expect(existsSync(join(home, 'workspace', '.agents', 'skills', 'demo'))).toBe(false)
  })

  it('reports the remembered destination beside the rows, even when its row is unusable', async () => {
    const home = await scratch('fcg-skill-remote-preferred-')
    const { host } = hostFor(home, {}, { agent: 'agents', scope: 'project' })

    const payload = await skillPlacements(host)

    // Reported as the choice, not as one of the rows: a row says whether a destination
    // *can* be used here, and this says which one the user asked for. Dropping it
    // because the folder is untrusted would make the page forget a choice it should
    // show alongside the reason it cannot be honoured.
    expect(payload.preferred).toEqual({ agent: 'agents', scope: 'project' })
    expect(payload.rows.find(row => row.agent === 'agents' && row.scope === 'project')).toMatchObject({ ok: false })
  })

  it('omits the remembered destination when the user never chose one', async () => {
    const home = await scratch('fcg-skill-remote-no-preference-')
    const { host } = hostFor(home)

    // Absent rather than `{ agent: undefined }`: "no preference" is one fact, and a
    // placeholder value would let the page preselect a destination nobody picked.
    expect(await skillPlacements(host)).not.toHaveProperty('preferred')
  })

  it('reports the matrix with the reasons its unusable rows carry', async () => {
    const home = await scratch('fcg-skill-remote-matrix-')
    const { host } = hostFor(home)

    const payload = await skillPlacements(host)

    expect(payload.workspace).toBe(join(home, 'workspace'))
    expect(payload.projectTrusted).toBe(false)
    expect(payload.defaultRoot).toBe(host.communitySkillDirectory())
    const project = payload.rows.filter(row => row.scope === 'project')
    expect(project.length).toBeGreaterThan(0)
    // Every project row refuses for the *reason*, not as a missing path: a page that
    // only ever saw the option disabled could not tell an untrusted checkout from a
    // combination that does not exist.
    for (const row of project) expect(row.ok ? row : row.reason).toMatch(/trusted folder/u)
    expect(payload.rows.find(row => row.agent === 'harness' && row.scope === 'user')).toMatchObject({ ok: true, root: join(home, 'data', 'skills'), provenance: 'user, harness native' })
  })

  it('accepts a trusted folder\'s project install, which is the same matrix answering yes', async () => {
    const home = await scratch('fcg-skill-remote-placement-trusted-')
    const { host, enabled } = hostFor(home, { projectTrusted: true })
    const directory = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'placed into the project' })
    const root = join(home, 'workspace', '.dsh', 'skills')

    await skillPresetInstall(host, `skill:${directory}`, { agent: 'harness', scope: 'project' })

    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('placed into the project')
    expect(enabled).toEqual([`freecodego-skill-harness-project:${root}`])
  })

  it('refuses a colliding name before enabling anything, and leaves the install in place', async () => {
    const home = await scratch('fcg-skill-remote-refused-')
    const { host, enabled } = hostFor(home)
    const root = host.communitySkillDirectory()
    const installed = await writeSkillDirectory({ base: home, directory: 'first', declared: 'demo', body: 'the installed body' })
    const other = await writeSkillDirectory({ base: home, directory: 'second', declared: 'demo', body: 'a different body' })

    await skillPresetInstall(host, `skill:${installed}`)
    const before = enabled.length

    // The remote reports the refusal as a thrown error — the page shows it — and the
    // root is not enabled again: nothing changed, so nothing is announced.
    await expect(skillPresetInstall(host, `skill:${other}`)).rejects.toThrow(/already installed/u)
    expect(enabled.length).toBe(before)
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('the installed body')
  })
})
