/**
 * Installing a Skill from the Marketplace, as the wiring claims it works.
 *
 * The modules this path is built from each have their own spec — `skills-source-pin`
 * reads sources, `skills-installer` stages and promotes, `skills.spec` covers the
 * lockfile's shape. What is only true of **this** path, and what each case here
 * exists to hold, is the order and the record:
 *
 * 1. **The identity is read by the source parser first.** `owner/repo#v1.2.0` and
 *    `github:owner/repo&path:/skills/demo` are installable, and the Marketplace's
 *    own `owner/repo/skill` spelling is what remains when neither reading applies.
 * 2. **The name that is collision-checked is the one inside `SKILL.md`**, not the
 *    directory the user typed or asked for. The install fetches first for exactly
 *    this reason, and a refusal that named the spelling instead of the claim would
 *    refuse against a name the install was never going to use.
 * 3. **A refusal leaves the root untouched**, because the fetch writes only into a
 *    temp directory.
 * 4. **The lockfile is the record, and it is written last.** Files in place with no
 *    record is reported as that, not as success — and the unrecorded directory is
 *    then itself a claim a later install must respect.
 * 5. **What was installed can be checked afterwards.** Verification is what makes
 *    `installed` a claim rather than a statement about a past moment.
 *
 * Every case here is offline: the local-source reading is a directory on this
 * machine, and the GitHub readings are exercised through the identity parser rather
 * than by cloning, which is what a unit test can hold without a network.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NODE_INSTALLER_FS, type InstallerFs } from '../src/skills/installer.ts'
import { SKILL_LOCK_FILENAME } from '../src/skills/lockfile.ts'
import {
  installSkillFromMarketplace, isSkillRefusal, readSkillInstallState, removeSkillFromMarketplace, resolveSkillTarget, verifySkillRoot,
} from '../src/skills/marketplace-install.ts'

const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A scratch directory this case's cleanup owns. */
async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/**
 * A Skill directory on disk.
 *
 * `declared` is separate from `directory` on purpose: the two disagreeing is what
 * "the declared name wins" means, and a fixture where they always agree could not
 * tell that rule from a rule that used the directory name.
 */
async function writeSkillDirectory(input: { readonly base: string; readonly directory: string; readonly declared?: string; readonly body?: string }): Promise<string> {
  const path = join(input.base, input.directory)
  await mkdir(join(path, 'reference'), { recursive: true })
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${input.declared ?? input.directory}\n---\n${input.body ?? 'body'}\n`)
  await writeFile(join(path, 'reference', 'notes.md'), 'notes\n')
  return path
}

/** A managed Skills root, which the install creates its state document beside. */
async function managedRoot(base: string): Promise<string> {
  const root = join(base, 'skills')
  await mkdir(root, { recursive: true })
  return root
}

describe('reading what to install', () => {
  it('reads a ref as the source parser, not as a Marketplace id', () => {
    // The Marketplace spelling has three segments and no ref; this one has a ref,
    // which the Marketplace reading has nowhere to put, so the order is not a
    // preference — the parser goes first and this is what it produces.
    expect(resolveSkillTarget('acme/skills#v1.2.0')).toEqual({
      kind: 'github',
      source: { kind: 'github', owner: 'acme', repo: 'skills', ref: 'v1.2.0' },
      name: 'skills',
    })
  })

  it('reads an explicit subdirectory, and takes the Skill name from it', () => {
    expect(resolveSkillTarget('github:acme/skills&path:/skills/demo')).toEqual({
      kind: 'github',
      source: { kind: 'github', owner: 'acme', repo: 'skills', path: 'skills/demo' },
      name: 'demo',
    })
  })

  it('still reads the Marketplace spelling, which is what remains', () => {
    expect(resolveSkillTarget('acme/skills/demo')).toEqual({
      kind: 'github',
      source: { kind: 'github', owner: 'acme', repo: 'skills' },
      name: 'demo',
    })
  })

  it('refuses an npm source by name rather than resolving to nothing', () => {
    const target = resolveSkillTarget('@scope/name')
    expect(isSkillRefusal(target) ? target.refused : target).toMatch(/npm .*owner\/repo/u)
  })

  it('says what a Marketplace id looks like when nothing else applies', () => {
    const target = resolveSkillTarget('not a source!')
    expect(isSkillRefusal(target) ? target.refused : target).toMatch(/owner\/repo\/skill-name/u)
  })
})

describe('installing through the installer', () => {
  it('installs, records the commit it received, and verifies afterwards', async () => {
    const base = await scratch('fcg-marketplace-install-')
    const root = await managedRoot(base)
    const directory = await writeSkillDirectory({ base, directory: 'first', declared: 'demo' })

    const report = await installSkillFromMarketplace({ identity: directory, root })
    if (isSkillRefusal(report)) throw new Error(report.refused)

    // The declared name, not the directory spelling: discovery matches on this one.
    expect(report.name).toBe('demo')
    expect(report.source).toBe(directory)
    expect(report.locked).toBe(true)
    expect(report.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('body')
    expect(report.verification).toEqual([])
    expect(report.collisions).toEqual([])
    // Beside the root, not inside it: the record is not a Skill.
    expect(existsSync(join(base, SKILL_LOCK_FILENAME))).toBe(true)
    expect(await verifySkillRoot(root)).toEqual([])
  })

  it('derives a content id that changes when the content does', async () => {
    const base = await scratch('fcg-marketplace-content-id-')
    const root = await managedRoot(base)
    const one = await installSkillFromMarketplace({ identity: await writeSkillDirectory({ base, directory: 'one', body: 'first body' }), root })
    const two = await installSkillFromMarketplace({ identity: await writeSkillDirectory({ base, directory: 'two', body: 'second body' }), root })
    if (isSkillRefusal(one) || isSkillRefusal(two)) throw new Error('expected both installs to land')

    // A source with no commit gets a content id instead of a placeholder, and two
    // different payloads must not share one — that is the whole pin.
    expect(one.resolvedCommit).not.toBe(two.resolvedCommit)
  })

  it('re-runs an install of the same source as an upgrade rather than a collision', async () => {
    const base = await scratch('fcg-marketplace-reinstall-')
    const root = await managedRoot(base)
    const directory = await writeSkillDirectory({ base, directory: 'first', declared: 'demo' })

    const first = await installSkillFromMarketplace({ identity: directory, root })
    if (isSkillRefusal(first)) throw new Error(first.refused)
    const again = await installSkillFromMarketplace({ identity: directory, root })
    if (isSkillRefusal(again)) throw new Error(again.refused)

    expect(again.idempotent).toBe(true)
    expect(again.replacedCommit).toBe(first.resolvedCommit)
    expect(again.locked).toBe(true)
  })

  it('refuses a name claimed by different content, naming both sides', async () => {
    const base = await scratch('fcg-marketplace-collision-')
    const root = await managedRoot(base)
    const installed = await writeSkillDirectory({ base, directory: 'first', declared: 'demo', body: 'the installed body' })
    const other = await writeSkillDirectory({ base, directory: 'second', declared: 'demo', body: 'a different body' })

    const first = await installSkillFromMarketplace({ identity: installed, root })
    if (isSkillRefusal(first)) throw new Error(first.refused)
    const refused = await installSkillFromMarketplace({ identity: other, root })

    expect(isSkillRefusal(refused) ? refused.refused : refused).toMatch(/already installed/u)
    // The refusal names the claim in its own terms — the declared name, twice.
    expect(isSkillRefusal(refused) ? refused.refused : '').toContain('"demo"')
    // And it refused before writing: the installed content is still the first one.
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('the installed body')
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).not.toContain('a different body')
  })

  it('treats a directory present on disk without a record as a claim', async () => {
    const base = await scratch('fcg-marketplace-unrecorded-')
    const root = await managedRoot(base)
    const first = await writeSkillDirectory({ base, directory: 'first', declared: 'demo', body: 'unrecorded body' })
    const second = await writeSkillDirectory({ base, directory: 'second', declared: 'demo', body: 'other body' })

    // A port that fails the lockfile's own write: the files land, the record does not.
    const noRecord: InstallerFs = {
      ...NODE_INSTALLER_FS,
      rename: async (from, to) => {
        if (to.endsWith(SKILL_LOCK_FILENAME)) throw new Error('the state directory is not writable')
        await NODE_INSTALLER_FS.rename(from, to)
      },
    }
    const landed = await installSkillFromMarketplace({ identity: first, root, fs: noRecord })
    if (isSkillRefusal(landed)) throw new Error(landed.refused)

    // Files in place with no record is reported as exactly that, not as success.
    expect(landed.locked).toBe(false)
    expect(landed.lockfileWarning).toMatch(/could not be recorded/u)
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('unrecorded body')
    expect(existsSync(join(base, SKILL_LOCK_FILENAME))).toBe(false)

    // Nothing can prove the unrecorded directory is the same content, so a later
    // install of a different payload under that name is refused rather than allowed
    // to overwrite something it cannot identify.
    const state = await readSkillInstallState(root)
    expect(state.installed.map(skill => skill.name)).toContain('demo')
    const refused = await installSkillFromMarketplace({ identity: second, root })
    expect(isSkillRefusal(refused)).toBe(true)
    expect(await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('unrecorded body')
  })

  it('reads the name a pre-lockfile directory declares, not the folder it sits in', async () => {
    const base = await scratch('fcg-marketplace-legacy-claim-')
    const root = await managedRoot(base)
    // What the install path wrote before this record existed: a flattened identity
    // directory whose real name is only inside its SKILL.md.
    const legacy = join(root, 'example-skills-demo')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'SKILL.md'), '---\nname: demo\n---\nlegacy body\n')
    const replacement = await writeSkillDirectory({ base, directory: 'replacement', declared: 'demo', body: 'new body' })

    const refused = await installSkillFromMarketplace({ identity: replacement, root })

    // Refused against the declared name. Checking the directory name instead would
    // find nothing here and let a second `demo` in for the registry to resolve by
    // silently dropping one of them.
    expect(isSkillRefusal(refused) ? refused.refused : refused).toContain('"demo"')
    expect(await readFile(join(legacy, 'SKILL.md'), 'utf8')).toContain('legacy body')
    expect(existsSync(join(root, 'demo'))).toBe(false)
  })

  it('refuses a payload the text installer cannot carry, by file name', async () => {
    const base = await scratch('fcg-marketplace-binary-')
    const root = await managedRoot(base)
    const directory = await writeSkillDirectory({ base, directory: 'binary' })
    await writeFile(join(directory, 'reference', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

    const refused = await installSkillFromMarketplace({ identity: directory, root })
    expect(isSkillRefusal(refused) ? refused.refused : refused).toMatch(/logo\.png.* not text|not text/u)
    expect(existsSync(join(root, 'binary'))).toBe(false)
  })

  it('leaves an identity that points outside the managed root alone', async () => {
    const base = await scratch('fcg-marketplace-outside-')
    const root = await managedRoot(base)
    // A Skill on this machine that is not in the managed root: a removal must be
    // scoped to the root, not to whatever directory the identity happens to name.
    const outside = await writeSkillDirectory({ base, directory: 'outside', declared: 'demo' })

    const refused = await removeSkillFromMarketplace({ identity: outside, root })

    expect(isSkillRefusal(refused)).toBe(true)
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(true)
  })

  it('detects a Skill that changed after it was installed', async () => {
    const base = await scratch('fcg-marketplace-verify-')
    const root = await managedRoot(base)
    const directory = await writeSkillDirectory({ base, directory: 'first', declared: 'demo', body: 'as installed' })
    const report = await installSkillFromMarketplace({ identity: directory, root })
    if (isSkillRefusal(report)) throw new Error(report.refused)

    await writeFile(join(root, 'demo', 'SKILL.md'), '---\nname: demo\n---\ntampered\n')
    const failures = await verifySkillRoot(root)

    // One failure per Skill, naming it: this is what turns the lockfile into a
    // claim somebody can check instead of a past-tense note.
    expect(failures.map(failure => failure.name)).toEqual(['demo'])
    expect(failures[0]?.reason).toMatch(/changed since it was installed/u)
  })
})

/**
 * Removal, held to two claims: it takes away the directory **and** the record, and
 * it removes the right one or nothing at all.
 *
 * A removal that deleted files but left the lockfile naming them would make every
 * later verification report a Skill that is not there — the record describing files
 * that do not exist is exactly the state the install order is arranged to avoid.
 * And the entry it removes has to be the one the identity installed: a page offers
 * Remove on a card, so a name that happens to collide with a different Skill's is
 * the one mistake this path must not make quietly.
 */
describe('removing an installed Skill', () => {
  it('takes away the directory and the record together, leaving verification clean', async () => {
    const base = await scratch('fcg-marketplace-remove-')
    const root = await managedRoot(base)
    const directory = await writeSkillDirectory({ base, directory: 'first', declared: 'demo', body: 'to be removed' })
    const installed = await installSkillFromMarketplace({ identity: directory, root })
    if (isSkillRefusal(installed)) throw new Error(installed.refused)

    const removed = await removeSkillFromMarketplace({ identity: directory, root })
    if (isSkillRefusal(removed)) throw new Error(removed.refused)

    expect(removed.name).toBe('demo')
    expect(removed.directory).toBe('demo')
    expect(removed.recorded).toBe(true)
    expect(removed.source).toBe(installed.source)
    expect(existsSync(join(root, 'demo'))).toBe(false)
    // The record went with the files: nothing is left claiming a Skill that is gone.
    expect(await verifySkillRoot(root)).toEqual([])
    expect((await readSkillInstallState(root)).installed).toEqual([])
  })

  it('removes the flattened directory an earlier install left, from the same Marketplace id', async () => {
    const base = await scratch('fcg-marketplace-remove-legacy-')
    const root = await managedRoot(base)
    // What the pre-lockfile installer wrote for `acme/skills/demo`, and nothing in
    // the record: removal has to recognize it from the identity alone.
    const legacy = join(root, 'acme-skills-demo')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'SKILL.md'), '---\nname: widget\n---\nlegacy body\n')

    const removed = await removeSkillFromMarketplace({ identity: 'acme/skills/demo', root })
    if (isSkillRefusal(removed)) throw new Error(removed.refused)

    // Reported as unrecorded rather than as a clean uninstall: nothing could
    // confirm it afterwards, and the caller has to be able to say so. Both names are
    // reported because they differ here — the declared one, and the directory.
    expect(removed.name).toBe('widget')
    expect(removed.directory).toBe('acme-skills-demo')
    expect(removed.recorded).toBe(false)
    expect(existsSync(legacy)).toBe(false)
  })

  it('refuses an identity nothing in the root answers to', async () => {
    const base = await scratch('fcg-marketplace-remove-missing-')
    const root = await managedRoot(base)

    const refused = await removeSkillFromMarketplace({ identity: 'acme/skills/demo', root })

    expect(isSkillRefusal(refused) ? refused.refused : refused).toMatch(/not installed in this managed root/u)
  })

  it('refuses when a name under another source claims the same Skill name', async () => {
    const base = await scratch('fcg-marketplace-remove-other-source-')
    const root = await managedRoot(base)
    // Installed by hand from a directory that is *not* the one the identity names,
    // recorded under its own source: same name, different Skill.
    const mine = await writeSkillDirectory({ base, directory: 'mine', declared: 'demo', body: 'mine' })
    const installed = await installSkillFromMarketplace({ identity: mine, root })
    if (isSkillRefusal(installed)) throw new Error(installed.refused)

    const refused = await removeSkillFromMarketplace({ identity: 'github:acme/skills&path:/skills/demo', root })

    // Refused, not removed: the record names a different source, so this identity
    // is not the one that put `demo` there. And the refusal says so, rather than
    // claiming nothing by that name exists — the page offers Remove off the name.
    const message = isSkillRefusal(refused) ? refused.refused : ''
    expect(message).toMatch(/different source/u)
    expect(message).toContain('demo')
    expect(existsSync(join(root, 'demo', 'SKILL.md'))).toBe(true)
    expect(await verifySkillRoot(root)).toEqual([])
  })
})
