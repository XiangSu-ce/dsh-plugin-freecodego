/**
 * The Skill asset roots this plugin has mounted, by owner.
 *
 * The session-start capability map exists because a switched-on pack gives no
 * other signal that a batch of Skills just became available — the tool catalog is
 * model-facing and the user never sees it. That map used to read the engineering
 * registry's own root list, which was the same thing as "what this plugin
 * mounted" only while engineering was the only thing that mounted Skills. The
 * design pack mounts its own root through its own fiber, so the two stopped being
 * the same question and the map silently stopped naming 17 of the plugin's
 * Skills.
 *
 * The fix is a shared answer rather than a wider read: each owner publishes the
 * roots it has mounted and withdraws them when it unmounts, and the map asks what
 * is mounted rather than asking one particular owner. Keyed by owner so that two
 * packs reconciling independently cannot clobber each other's contribution — the
 * registry replacing the whole set on every write would make whichever pack
 * reconciled last the only one listed.
 *
 * Process-scoped rather than instance-scoped because the question is about this
 * process: two registries that never hold a reference to each other still have to
 * agree on it.
 *
 * @module
 */

/** Roots currently mounted, per owner. An owner absent from the map has none. */
const byOwner = new Map<string, readonly string[]>()

/**
 * Record one owner's mounted roots.
 *
 * An empty list removes the owner rather than storing an empty entry, so
 * "unmounted" and "never mounted" are the same state and cannot be read as
 * different ones.
 *
 * @param owner - the pack's name; the published set is the union across owners.
 * @param roots - the roots that owner currently has mounted.
 */
export function publishMountedSkillRoots(owner: string, roots: readonly string[]): void {
  if (roots.length === 0) byOwner.delete(owner)
  else byOwner.set(owner, [...new Set(roots)])
}

/**
 * Every root this plugin currently has mounted.
 *
 * Order is owner insertion order, and each owner's roots keep the order it
 * published them in — the order the map renders, and the order a pack decides
 * (starter before the rest, for instance).
 *
 * @returns the union across owners, deduplicated within an owner.
 */
export function mountedPluginSkillRoots(): readonly string[] {
  return [...byOwner.values()].flat()
}

/** Drop an owner's contribution, whatever it was. @param owner - the pack's name. */
export function forgetMountedSkillRoots(owner: string): void {
  byOwner.delete(owner)
}
