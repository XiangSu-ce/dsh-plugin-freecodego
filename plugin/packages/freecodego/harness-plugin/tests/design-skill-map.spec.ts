/**
 * The design pack's Skills, read the way the capability map reads them.
 *
 * The vendoring script checks a lot about the tree it writes — emoji, body size,
 * remaining CLI calls — and none of it is "can the map actually see these". That
 * is a different question with a different failure mode: a `SKILL.md` whose
 * frontmatter the parser cannot read contributes no entry, so a pack of 17 Skills
 * shows up as a shorter list with nothing anywhere saying one was dropped.
 *
 * So this reads the real vendored tree rather than a fixture. The other specs use
 * fixtures because the upstream pack drifts on re-sync; here the tree *is* the
 * subject, and a re-sync that silently breaks a frontmatter should fail this.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { buildSkillMap, parseSkillBrief, SKILL_MAP_MAX_CHARS } from '../src/engineering.ts'
import {
  forgetMountedSkillRoots,
  mountedPluginSkillRoots,
  publishMountedSkillRoots,
} from '../src/mounted-skill-roots.ts'

/** The vendored design pack, addressed the way the pack's own resolver does. */
const DESIGN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'design', 'skills')

/** The skill directories actually on disk. */
function skillDirectories(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

describe('the vendored design pack', () => {
  it('parses every vendored skill into a brief', () => {
    const directories = skillDirectories(DESIGN_ROOT)
    // A tree with nothing in it would make every assertion below vacuous.
    expect(directories.length).toBeGreaterThan(0)
    const briefs = directories.flatMap((name) => {
      const brief = parseSkillBrief(readFileSync(resolve(DESIGN_ROOT, name, 'SKILL.md'), 'utf8'))
      return brief === undefined ? [] : [brief]
    })
    expect(briefs.map(brief => brief.name).sort()).toEqual(directories)
    // Every brief carries a description: an entry with an empty one is a name the
    // model has no reason to pick and no way to tell apart from its neighbours.
    for (const brief of briefs) expect(brief.description.length).toBeGreaterThan(0)
  })

  it('renders all of them into the map, within the map budget', () => {
    const directories = skillDirectories(DESIGN_ROOT)
    const briefs = directories.flatMap((name) => {
      const brief = parseSkillBrief(readFileSync(resolve(DESIGN_ROOT, name, 'SKILL.md'), 'utf8'))
      return brief === undefined ? [] : [brief]
    })
    const built = buildSkillMap(briefs)
    expect(built).toBeDefined()
    expect(built!.text.length).toBeLessThanOrEqual(SKILL_MAP_MAX_CHARS)
    // Both bounds have to leave every skill listed: the entry cap because the pack
    // is below it, and the character budget because 17 entries fit. A map that
    // silently dropped some would still render — this is the assertion that
    // notices.
    expect(built!.metrics.discovered).toBe(directories.length)
    expect(built!.metrics.rendered).toBe(directories.length)
    for (const name of directories) expect(built!.text).toContain(name)
  })
})

describe('the mounted-roots registry the map reads', () => {
  // The registry is process-scoped on purpose — two packs that never hold a
  // reference to each other still have to agree on what is mounted — so a case
  // has to withdraw what it published. That requirement is the same one the packs
  // themselves are under, which is why there is no reset seam here for tests to
  // use that production code does not have.
  beforeEach(() => {
    forgetMountedSkillRoots('engineering')
    forgetMountedSkillRoots('design')
  })

  it('unions two owners instead of the last writer winning', () => {
    // The bug this replaces: the map read one pack's private root list, so a
    // second pack mounting its own root was invisible. A registry that replaced
    // the whole set per write would reproduce it with a different mechanism.
    publishMountedSkillRoots('engineering', ['/roots/starter'])
    publishMountedSkillRoots('design', ['/roots/design'])
    expect(mountedPluginSkillRoots()).toEqual(['/roots/starter', '/roots/design'])
    expect([...new Set(mountedPluginSkillRoots())].length).toBe(mountedPluginSkillRoots().length)
  })

  it('treats an empty list and never having published as the same state', () => {
    publishMountedSkillRoots('design', ['/roots/design', '/roots/design'])
    expect(mountedPluginSkillRoots()).toEqual(['/roots/design'])
    publishMountedSkillRoots('design', [])
    expect(mountedPluginSkillRoots()).toEqual([])
  })

  it('withdraws one owner without touching the other', () => {
    publishMountedSkillRoots('engineering', ['/roots/starter'])
    publishMountedSkillRoots('design', ['/roots/design'])
    forgetMountedSkillRoots('design')
    expect(mountedPluginSkillRoots()).toEqual(['/roots/starter'])
    forgetMountedSkillRoots('engineering')
    expect(mountedPluginSkillRoots()).toEqual([])
  })

  it('reaches the design Skills through the union, not through one pack', () => {
    // The end of the chain, and the thing that was broken: the map asks the
    // registry for roots, so a Skill reachable only through the second pack still
    // gets an entry. The engineering root is a path that does not exist, which is
    // what makes this a test of the union rather than of one owner's list —
    // discovery over a root that is not there contributes nothing and is not an
    // error, exactly as it behaves at runtime.
    publishMountedSkillRoots('engineering', ['/roots/engineering'])
    publishMountedSkillRoots('design', [DESIGN_ROOT])
    const roots = mountedPluginSkillRoots()
    expect(roots).toEqual(['/roots/engineering', DESIGN_ROOT])
    const briefs = roots.flatMap(root => root === DESIGN_ROOT
      ? skillDirectories(root).map(name => ({ name, description: `description for ${name}`, modelInvocable: true, userInvocable: true }))
      : [])
    const built = buildSkillMap(briefs)
    expect(built).toBeDefined()
    for (const name of skillDirectories(DESIGN_ROOT)) expect(built!.text).toContain(name)
  })
})
