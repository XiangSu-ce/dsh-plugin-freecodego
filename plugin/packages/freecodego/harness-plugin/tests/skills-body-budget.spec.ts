/**
 * The body budget of the skills this package ships.
 *
 * Why
 * ---
 * `skills/publish.ts` already refuses to *publish* a skill whose body is over
 * {@link DEFAULT_SKILL_TOKEN_LIMIT}, and the reason it gives is the reason this file
 * exists: a skill body is loaded into the model's context whenever the skill is
 * selected, so its size is paid in every window it is chosen for. The built-in packs
 * were never held to that rule — 42 `SKILL.md` files with no size check anywhere,
 * the largest at ~8,000 tokens, which is 1.6× the limit this package enforces on
 * everyone else's skills. The gate below applies the same number, through the same
 * parser and the same estimator, to the files we ship.
 *
 * The one exemption this file used to carry is gone: `subagent-driven-development`
 * was 1.6× the limit, and the work item it named — move the detail into files the
 * Skill links to — has been done, so the entry was deleted rather than kept as a
 * ceiling. The `OVER_BUDGET` mechanism stays (empty) because the next body that
 * outgrows the limit needs a ratchet, not a comment: a listed file may sit at its
 * recorded ceiling, may only shrink from there, and — the assertion that makes it a
 * ratchet — must still be over the limit, so a file that comes within budget fails
 * this spec until its entry is deleted.
 *
 * @module
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { engineeringSkillDirectory, starterSkillDirectory, superpowersSkillDirectory } from '../src/engineering.ts'
import { DEFAULT_SKILL_TOKEN_LIMIT, parseSkillDocument } from '../src/skills/publish.ts'
import { tokensFromChars } from '../src/token-estimate.ts'

/** One built-in pack, read through the accessor the runtime mounts it by. */
const PACKS: readonly { readonly pack: string; readonly root: string }[] = [
  { pack: 'starter', root: starterSkillDirectory() },
  { pack: 'engineering', root: engineeringSkillDirectory() },
  { pack: 'superpowers', root: superpowersSkillDirectory() },
]

/**
 * Bodies that are over the limit today, keyed `pack/skill`, with the ceiling each may
 * not exceed.
 *
 * Empty, and deliberately kept as a mechanism: `subagent-driven-development` was the
 * one entry (8,000 tokens, 1.6× the limit) and its detail now lives in the companion
 * files it links to, which dropped the body to 4,666. A future body that outgrows the
 * limit adds an entry here with the ceiling it measures at, and that entry then has to
 * be deleted when the body comes back inside the budget.
 */
const OVER_BUDGET: Readonly<Record<string, number>> = {}

/** Every built-in skill body, priced the way the publish pre-flight prices one. */
function builtInBodies(): readonly { readonly key: string; readonly tokens: number }[] {
  const found: { readonly key: string; readonly tokens: number }[] = []
  for (const { pack, root } of PACKS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skill = join(root, entry.name, 'SKILL.md')
      if (!existsSync(skill)) continue
      const { body } = parseSkillDocument(readFileSync(skill, 'utf8'))
      found.push({ key: `${pack}/${entry.name}`, tokens: tokensFromChars(body.length) })
    }
  }
  return found
}

describe('every built-in skill body fits the budget the package enforces on publishers', () => {
  const bodies = builtInBodies()

  it('finds the whole shipped library rather than walking an empty directory', () => {
    // A gate that walks finds nothing when its root moves, and then passes for the
    // wrong reason. The count is the floor, not the exact number: adding a pack or a
    // skill is not a change this file should have to be edited for.
    expect(bodies.length).toBeGreaterThanOrEqual(40)
    expect(bodies.some(entry => entry.key === 'starter/wait-what')).toBe(true)
    expect(bodies.some(entry => entry.key === 'engineering/code-review')).toBe(true)
    expect(bodies.some(entry => entry.key === 'superpowers/writing-plans')).toBe(true)
  })

  it('holds every body to the limit, with only the recorded ratchet above it', () => {
    const over = bodies
      .filter(entry => entry.tokens > DEFAULT_SKILL_TOKEN_LIMIT)
      .map(entry => entry.key)
      .sort()
    expect(over).toEqual(Object.keys(OVER_BUDGET).sort())
  })

  it('lets a ratcheted body shrink but never grow', () => {
    for (const [key, ceiling] of Object.entries(OVER_BUDGET)) {
      const entry = bodies.find(candidate => candidate.key === key)
      // A ratchet entry for a file that no longer exists is a stale exemption.
      expect(entry, `${key} is ratcheted but was not found`).toBeDefined()
      expect(entry?.tokens ?? 0).toBeLessThanOrEqual(ceiling)
      // And the entry is only legitimate while the file is genuinely over budget: the
      // moment it fits, this fails until the exemption is removed.
      expect(entry?.tokens ?? 0).toBeGreaterThan(DEFAULT_SKILL_TOKEN_LIMIT)
    }
  })
})
