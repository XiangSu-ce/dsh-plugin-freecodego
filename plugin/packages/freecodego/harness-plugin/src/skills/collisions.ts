/**
 * Name collisions between skills, and the honest handling of them.
 *
 * The Host's `SkillRegistry` already resolves a same-name conflict by keeping the
 * higher-priority skill and dropping the other with a log line. That behaviour is
 * not wrong for a runtime — something has to win — but it is a poor fit for an
 * *installer*, because the user who just installed a skill and cannot see it
 * anywhere gets a log message they never read and no way to tell "my skill is
 * shadowed" from "the install failed".
 *
 * So this module does not patch the registry and does not reimplement its
 * precedence. It does two things around it:
 *
 * - **Refuses an install that would collide**, naming both sources and saying
 *   what to do about it. An install that silently loses is worse than one that
 *   is refused, because the refusal is visible at the moment of the mistake.
 * - **Enumerates every collision for the report**, including the skills the
 *   registry dropped, so `engineering_inspect` and the Skills page can show what
 *   the runtime is not showing.
 *
 * An install of a skill with the same name *and* the same source is an idempotent
 * no-op rather than a collision: that is what re-running an install command
 * looks like, and rejecting it would make the command non-repeatable.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/collisions
 */

import { formatSkillSource, sameSkillSource, type SkillSource } from './source.ts'

/** A skill the runtime already knows about. */
export interface InstalledSkill {
  /**
   * The name discovery matches on — the one inside `SKILL.md` when the directory
   * declares one, and the directory's own name when it does not. This is the field a
   * collision is decided on, because this is the field the registry compares.
   */
  readonly name: string
  /** Parsed source, when the record carries one. */
  readonly source?: SkillSource
  /** Where it lives, for the report. */
  readonly root: string
  /**
   * The directory it occupies under that root, when that differs from the name.
   *
   * The two come apart for a Skill that landed under its declared name (`demo`) and
   * for one an older install wrote into a flattened identity directory
   * (`acme-skills-demo`). A collision is about the name; *removal* has to address the
   * directory, so the caller needs both rather than one of them twice.
   */
  readonly directory?: string
}

/** One name claimed by more than one place. */
export interface SkillCollision {
  readonly name: string
  /** Every claim, in discovery order. */
  readonly claims: readonly { readonly source: string; readonly root: string }[]
}

/** The verdict on an install. */
export type CollisionVerdict =
  | { readonly ok: true; readonly idempotent: boolean }
  | { readonly ok: false; readonly reason: string; readonly collision: SkillCollision }

/**
 * Find every name claimed by more than one *source*.
 *
 * Deliberately includes claims the registry dropped: the point of this function
 * is to show what is *not* visible at runtime.
 *
 * The same source recorded in two roots is deliberately *not* one of them. The two
 * copies are byte-identical, so the one the registry drops is a copy of what it
 * kept — the user has nothing to resolve, and a report row they cannot act on is
 * how a report stops being read. It is the same rule {@link checkSkillInstall}
 * applies to a repeated install. What this function exists for is the two claims
 * that are *different* content, which is what "collides" means in the module
 * header. (This paragraph was added after the summary line was found to promise
 * "claimed more than once", which is wider than what the filter below reports.)
 * @param skills - every skill the runtime and the installer know about.
 * @returns the collisions, ordered by name so a report is not a diff.
 */
export function findSkillCollisions(skills: readonly InstalledSkill[]): readonly SkillCollision[] {
  const byName = new Map<string, { source: string; root: string }[]>()
  for (const skill of skills) {
    const claims = byName.get(skill.name) ?? []
    claims.push({ source: skill.source === undefined ? '(unknown source)' : formatSkillSource(skill.source), root: skill.root })
    byName.set(skill.name, claims)
  }
  return [...byName.entries()]
    .filter(([, claims]) => new Set(claims.map(claim => claim.source)).size > 1)
    .map(([name, claims]) => ({ name, claims }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Decide whether an install may proceed.
 * @param input - the skill being installed and what is already present.
 * @returns whether to install, install-as-no-op, or refuse with both sides named.
 */
export function checkSkillInstall(input: {
  readonly name: string
  readonly source: SkillSource
  readonly root: string
  readonly installed: readonly InstalledSkill[]
}): CollisionVerdict {
  const existing = input.installed.filter(skill => skill.name === input.name)
  if (existing.length === 0) return { ok: true, idempotent: false }

  const sameSource = existing.every(skill => skill.source !== undefined && sameSkillSource(skill.source, input.source))
  if (sameSource) {
    // Re-running an install that already succeeded. Not a collision, and not a
    // refusal: making the install command non-repeatable would be worse.
    //
    // Every claim sharing the source counts, not just a single one. The `existing
    // .length === 1` this used to carry *is* the same-source-in-two-roots shape —
    // the one {@link findSkillCollisions} deliberately reports nothing about,
    // because the copies are byte-identical and there is nothing to resolve. Here
    // it produced the report that function exists to avoid: the refusal named
    // `github:acme/skills` once per root *and* once more as the install target, so
    // the user was told to "uninstall or rename one of them" with no way to tell
    // which of three identical lines was which.
    return { ok: true, idempotent: true }
  }

  const collision: SkillCollision = {
    name: input.name,
    claims: [
      ...existing.map(skill => ({
        source: skill.source === undefined ? '(unknown source)' : formatSkillSource(skill.source),
        root: skill.root,
      })),
      { source: formatSkillSource(input.source), root: input.root },
    ],
  }
  return {
    ok: false,
    collision,
    reason: `a skill named "${input.name}" is already installed from ${collision.claims.map(claim => `${claim.source} (${claim.root})`).join(' and ')}. Installing would make the runtime keep one and silently drop the other. Uninstall or rename one of them, then install again.`,
  }
}

/**
 * Whether a name may be used for a skill at all.
 * @param name - the proposed name.
 * @returns true when the name is installable.
 */
export function isUsableSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}
