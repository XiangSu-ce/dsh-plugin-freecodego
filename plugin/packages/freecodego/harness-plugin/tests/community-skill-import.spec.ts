/**
 * What a Skill import must not do.
 *
 * Two guarantees, both of them about the Skill that is already installed. The
 * payload may not carry a symbolic link: `fs.cp` reproduces a link as a link, so
 * an ordinary-looking companion file can read a file from outside the Skill. And
 * a failed install may not destroy the working version: the import used to delete
 * the installed directory and only then copy, so a copy that failed halfway left
 * the user with a half-copied Skill and no way back.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NODE_SKILL_PROMOTION_IO, assertSkillPayloadHasNoLinks, findSkillDirectory, promoteSkillDirectory, skillPromotionPaths } from '../src/community-catalog-utils.ts'

const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A scratch directory that the case's own cleanup owns. */
async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const textAt = async (path: string): Promise<string> => readFile(path, 'utf8')
const failureOf = async (run: Promise<unknown>): Promise<Error> =>
  run.then(() => new Error('the call was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))

/**
 * Windows only creates a link for a privileged process or with Developer Mode
 * on, and a host that cannot create one cannot be attacked this way either — so
 * the case is skipped there rather than asserted into a pass it did not earn.
 */
const canLink = await (async (): Promise<boolean> => {
  const probe = await mkdtemp(join(tmpdir(), 'fcg-link-probe-'))
  try {
    await writeFile(join(probe, 'target'), 'x')
    await symlink(join(probe, 'target'), join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
})()

describe('skill payload link screen', () => {
  it.skipIf(!canLink)('refuses a payload whose companion file is a link', async () => {
    const base = await scratch('fcg-payload-link-')
    const payload = join(base, 'payload')
    await mkdir(join(payload, 'reference'), { recursive: true })
    await writeFile(join(base, 'credentials.txt'), 'PRIVATE KEY MATERIAL')
    await writeFile(join(payload, 'SKILL.md'), '---\nname: ordinary\n---\nbody\n')
    await symlink(join(base, 'credentials.txt'), join(payload, 'reference', 'notes.md'))

    // The nested path in the message is the point: the link is nowhere near the
    // SKILL.md the scan reads, and the copy walks the whole tree regardless.
    await expect(assertSkillPayloadHasNoLinks(payload)).rejects.toThrow(/symbolic link at "reference\/notes\.md"/u)
  })

  it('leaves an ordinary payload alone, nested files included', async () => {
    const base = await scratch('fcg-payload-clean-')
    const payload = join(base, 'payload')
    await mkdir(join(payload, 'reference'), { recursive: true })
    await writeFile(join(payload, 'SKILL.md'), '---\nname: ordinary\n---\nbody\n')
    await writeFile(join(payload, 'reference', 'examples.md'), 'examples\n')

    await expect(assertSkillPayloadHasNoLinks(payload)).resolves.toBeUndefined()
  })
})

/**
 * What a Skill search may claim.
 *
 * The search is bounded by an entry budget, and until it said so, a budget that ran
 * out returned the same `undefined` as a repository with no such Skill — so the
 * caller told the user their repository does not contain a `SKILL.md` it may well
 * contain. Absence and "not looked for" are different answers.
 */
describe('skill directory search', () => {
  it('tells an absent Skill apart from a search that stopped early', async () => {
    const root = await scratch('fcg-skill-search-')
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'SKILL.md'), '---\nname: other\n---\nbody\n')

    await expect(findSkillDirectory(root, 'wanted')).resolves.toBe('not-found')
    await expect(findSkillDirectory(root, 'other')).resolves.toEqual({ directory: join(root, 'nested') })
  })

  it('reports the budget it ran out of instead of claiming the Skill is absent', async () => {
    // The root pass always finishes, so three entries against a budget of two make
    // this deterministic: the queued directory is never opened, whatever `readdir`
    // returns first.
    const root = await scratch('fcg-skill-budget-')
    await writeFile(join(root, 'a.md'), 'a\n')
    await writeFile(join(root, 'b.md'), 'b\n')
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'SKILL.md'), '---\nname: wanted\n---\nbody\n')

    await expect(findSkillDirectory(root, 'wanted', 2)).resolves.toBe('exhausted')
  })
})

describe('skill promotion', () => {
  /**
   * A payload to install, and the version of the same Skill already installed.
   *
   * The installed version carries a file the payload does not, because that is
   * what tells a replacement from a merge.
   */
  async function installation(): Promise<{ readonly payload: string; readonly destination: string }> {
    const base = await scratch('fcg-skill-promote-')
    const payload = join(base, 'payload')
    const destination = join(base, 'skills', 'acme-notes')
    await mkdir(payload, { recursive: true })
    await writeFile(join(payload, 'SKILL.md'), '---\nname: notes\n---\nnew version\n')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'SKILL.md'), '---\nname: notes\n---\nworking version\n')
    await writeFile(join(destination, 'old-only.md'), 'only the working version has this\n')
    return { payload, destination }
  }

  it('leaves the installed version alone when the payload cannot be copied', async () => {
    const { payload, destination } = await installation()
    const failure = await failureOf(promoteSkillDirectory(payload, destination, {
      ...NODE_SKILL_PROMOTION_IO,
      copy: async () => { throw new Error('ENOSPC: no space left on device') },
    }))

    expect(failure.message).toMatch(/could not be staged, so the installed version was left untouched/u)
    expect(await textAt(join(destination, 'SKILL.md'))).toContain('working version')
    expect(await exists(skillPromotionPaths(destination).staged)).toBe(false)
  })

  it('puts the installed version back when the promotion itself fails', async () => {
    const { payload, destination } = await installation()
    // The second move is the promotion; the first is moving the old version aside.
    let moves = 0
    const failure = await failureOf(promoteSkillDirectory(payload, destination, {
      ...NODE_SKILL_PROMOTION_IO,
      move: async (from: string, to: string) => {
        moves += 1
        if (moves === 2) throw new Error('EPERM: operation not permitted')
        await rename(from, to)
      },
    }))

    expect(failure.message).toMatch(/previously installed version was restored/u)
    expect(await textAt(join(destination, 'SKILL.md'))).toContain('working version')
    expect(await exists(join(destination, 'old-only.md'))).toBe(true)
    expect(await exists(skillPromotionPaths(destination).staged)).toBe(false)
    expect(await exists(skillPromotionPaths(destination).backup)).toBe(false)
  })

  it('replaces the whole tree on success and leaves no transient directory beside it', async () => {
    const { payload, destination } = await installation()
    await promoteSkillDirectory(payload, destination)

    expect(await textAt(join(destination, 'SKILL.md'))).toContain('new version')
    // A replaced Skill is the new payload, not the union of both.
    expect(await exists(join(destination, 'old-only.md'))).toBe(false)
    // The Skill service lists every directory under a root, so a leftover would
    // be discovered as a second copy of this Skill.
    const leftovers = (await readdir(dirname(destination))).filter(name => name.startsWith('.freecodego-skill-'))
    expect(leftovers).toEqual([])
  })

  it('finishes a promotion that was killed between its two moves', async () => {
    const { payload, destination } = await installation()
    const { backup } = skillPromotionPaths(destination)
    // The crash: the working version is under the backup name and the destination
    // is gone. Stacking a second promotion on top of that would leave the user's
    // Skill beside the new one under a name nothing points at.
    await rename(destination, backup)

    const failure = await failureOf(promoteSkillDirectory(payload, destination, {
      ...NODE_SKILL_PROMOTION_IO,
      copy: async () => { throw new Error('ENOSPC: no space left on device') },
    }))

    expect(failure).toBeInstanceOf(Error)
    // The retry failed, and the interrupted state was still repaired.
    expect(await textAt(join(destination, 'SKILL.md'))).toContain('working version')
    expect(await exists(backup)).toBe(false)
  })
})
