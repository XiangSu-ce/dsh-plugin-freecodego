/**
 * What a Skill import must not do, before the installer is handed anything.
 *
 * Two screens stand between a cloned repository and a Skill on disk, and this file
 * holds each to its own claim. The payload may not carry a symbolic link: the
 * install walks the tree and writes what it finds, so an ordinary-looking companion
 * file can read a file from outside the Skill. And a Skill search must tell
 * *absent* apart from *not looked for*: the search is bounded, and a budget that
 * ran out used to return the same answer as a repository that genuinely has no
 * such Skill, which turned "I stopped looking" into a statement about the user's
 * repository.
 *
 * The install itself — staging, the recoverable promotion, the lockfile written
 * last — is `skills-installer.spec.ts`'s subject, because that is where the install
 * happens now: `skills/marketplace-install.ts` fetches, screens, and then hands the
 * payload to `installer.installSkill`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSkillPayloadHasNoLinks, findSkillDirectory } from '../src/community-catalog-utils.ts'

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
    // SKILL.md the scan reads, and the install walks the whole tree regardless.
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
 * A budget that ran out and a repository without the Skill are different answers,
 * and the caller has to be able to tell which one it received: one is a fact about
 * the repository, the other is a fact about the search.
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
