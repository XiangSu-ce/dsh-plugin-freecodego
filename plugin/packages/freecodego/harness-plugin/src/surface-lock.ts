/**
 * Injected-surface measurement and a reviewed digest lock.
 *
 * Why
 * ---
 * Two lessons from OMX's `debloat-metrics.md` and `omx-capabilities.lock.json`:
 *
 * 1. **A prompt surface is code, so it deserves a lock.** OMX hashes every prompt
 *    file per surface and runs `verify:capabilities-lock` in its test script, so
 *    a prompt cannot drift without someone seeing the digest change. Our injected
 *    text — memory guidance, recovery briefs, role instructions, tool
 *    descriptions — has no such tripwire.
 * 2. **Never let an estimate be read as a measurement.** OMX is careful to say
 *    its `approximateTokens` is a lexical estimate and explicitly *not* a
 *    tokenizer count, actual injected context, or task spend. We kept making
 *    exactly that mistake in our token discussion, so the disclaimer travels with
 *    the number here instead of living in a doc.
 *
 * The lock file lists a digest per surface. `diffSurfaceLock` answers three
 * questions separately — added, removed, changed — because "the memory guidance
 * grew by a paragraph" and "the memory guidance was deleted" need different
 * reviews, and a single boolean would hide both.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/surface-lock
 */

import { createHash } from 'node:crypto'

import { tokensFromChars } from './token-estimate.ts'

/**
 * The disclaimer that must accompany {@link SurfaceMeasurement.approximateTokens}.
 *
 * Copied in spirit from OMX's prompt inventory: a word/punctuation estimate is
 * useful for comparing two revisions of the same surface and useless as a
 * statement about what a request costs.
 */
export const SURFACE_TOKEN_ESTIMATE_NOTE =
  'approximateTokens is a lexical estimate (bytes / 4), not a tokenizer count, not actual injected context, and not the token cost of a task.'

/**
 * One thing this plugin puts in front of the model.
 *
 * The text is the entry's whole content, kept verbatim: the lock is only worth
 * having if it hashes what the model actually reads, so nothing is normalized on
 * the way in.
 */
export interface SurfaceEntry {
  /** Stable identity inside its group, e.g. a tool name or a guidance id. */
  readonly name: string
  /** Exactly the text that reaches the model (or would, when enabled). */
  readonly text: string
}

/**
 * Entries that belong to one named surface, such as the tool schemas.
 *
 * The name is the lock's key, so a group renamed in a release appears as one
 * added and one removed rather than as a silently changed hash.
 */
export interface SurfaceGroup {
  /** Surface name, used as the lock key: `tool-schemas`, `injected-guidance`, … */
  readonly group: string
  readonly entries: readonly SurfaceEntry[]
}

/**
 * How large one group is, measured rather than estimated from the schema text.
 *
 * `bytes` is the real number and `approximateTokens` is the rough one: the pair is
 * here so a change can be compared between two revisions without ever dressing the
 * estimate up as a cost.
 */
export interface SurfaceMeasurement {
  readonly group: string
  readonly entries: number
  readonly bytes: number
  /** See {@link SURFACE_TOKEN_ESTIMATE_NOTE}; never present this as a token count. */
  readonly approximateTokens: number
}

/**
 * Every group's measurement, with the totals and the disclaimer.
 *
 * The disclaimer travels with the numbers rather than beside them, because these
 * figures are read on a status panel where nothing else would say what they are.
 */
export interface SurfaceReport {
  readonly groups: readonly SurfaceMeasurement[]
  readonly totals: { readonly entries: number; readonly bytes: number; readonly approximateTokens: number }
  readonly disclaimer: string
}

/**
 * The reviewed surface hashes, as committed to the repository.
 *
 * One digest per group rather than per entry: a reviewer is asked to approve what
 * changed at the level a person can read, and a per-entry document would change on
 * every tool added to a group it already covers.
 */
export interface SurfaceLockDocument {
  readonly version: 1
  /** Group name → digest of every entry in that group, sorted by entry name. */
  readonly surfaces: Readonly<Record<string, string>>
}

/**
 * How the current surfaces differ from the reviewed lock.
 *
 * The three lists are kept apart instead of collapsed into "changed", because the
 * gate's message has to say which way a surface moved: an added group is a review
 * that has not happened yet, a removed one is a promise the plugin stopped keeping.
 */
export interface SurfaceLockDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
  /** True when `added` and `removed` and `changed` are all empty. */
  readonly matches: boolean
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Digest one entry: name and text together, so renaming an entry is a change
 * even when its body is untouched.
 * @param entry - the entry to digest.
 * @returns Its hex digest, over the name and the text as the model reads them.
 */
export function entryDigest(entry: SurfaceEntry): string {
  return digest(`${entry.name}\u0000${entry.text}`)
}

/**
 * Digest a whole group.
 *
 * Entries are sorted by name before hashing, because the injected order must be
 * deterministic for the cache prefix to hold — a lock that changed when a tool was
 * registered in a different order would train us to ignore it.
 * @param group - the group to digest.
 * @returns Its hex digest, over every entry's name and digest.
 */
export function groupDigest(group: SurfaceGroup): string {
  const entries = [...group.entries].sort((left, right) => left.name.localeCompare(right.name))
  return digest(entries.map(entry => `${entry.name}\u0000${entryDigest(entry)}`).join('\u0001'))
}

/**
 * Measure every injected surface, as the status panel and the gate read it.
 * @param groups - the surfaces to measure.
 * @returns One measurement per group, the totals, and the estimate's disclaimer.
 */
export function measureSurfaces(groups: readonly SurfaceGroup[]): SurfaceReport {
  const measurements = groups.map((group) => {
    const bytes = group.entries.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0)
    return { group: group.group, entries: group.entries.length, bytes, approximateTokens: tokensFromChars(bytes) }
  })
  return {
    groups: measurements,
    totals: {
      entries: measurements.reduce((total, entry) => total + entry.entries, 0),
      bytes: measurements.reduce((total, entry) => total + entry.bytes, 0),
      approximateTokens: measurements.reduce((total, entry) => total + entry.approximateTokens, 0),
    },
    disclaimer: SURFACE_TOKEN_ESTIMATE_NOTE,
  }
}

/**
 * Build the lock document a reviewer commits.
 * @param groups - the surfaces as they stand now.
 * @returns The document to write, one digest per group.
 */
export function buildSurfaceLock(groups: readonly SurfaceGroup[]): SurfaceLockDocument {
  const surfaces: Record<string, string> = {}
  for (const group of groups) surfaces[group.group] = groupDigest(group)
  return { version: 1, surfaces }
}

/**
 * Compare the surfaces now against the reviewed lock.
 *
 * A missing lock is not "no difference": every group is reported as added, so a
 * gate that runs before the lock was ever written fails rather than passing on a
 * comparison it could not make.
 * @param lock - the reviewed lock, when one is committed.
 * @param groups - the surfaces as they stand now.
 * @returns The three lists of groups, and whether all three are empty.
 */
export function diffSurfaceLock(lock: SurfaceLockDocument | undefined, groups: readonly SurfaceGroup[]): SurfaceLockDiff {
  const current = buildSurfaceLock(groups).surfaces
  if (lock === undefined) {
    return { added: Object.keys(current).sort(), removed: [], changed: [], matches: false }
  }
  const added: string[] = []
  const changed: string[] = []
  for (const [group, value] of Object.entries(current)) {
    const previous = lock.surfaces[group]
    if (previous === undefined) added.push(group)
    else if (previous !== value) changed.push(group)
  }
  const removed = Object.keys(lock.surfaces).filter(group => current[group] === undefined)
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    matches: added.length === 0 && removed.length === 0 && changed.length === 0,
  }
}

/**
 * One-line summary for a gate failure or a status panel.
 * @param diff - the comparison to describe.
 * @returns A sentence naming what moved, or that nothing did.
 */
export function describeSurfaceLockDiff(diff: SurfaceLockDiff): string {
  if (diff.matches) return 'injected surfaces match the reviewed lock'
  const parts: string[] = []
  if (diff.added.length > 0) parts.push(`added: ${diff.added.join(', ')}`)
  if (diff.changed.length > 0) parts.push(`changed: ${diff.changed.join(', ')}`)
  if (diff.removed.length > 0) parts.push(`removed: ${diff.removed.join(', ')}`)
  return `injected surfaces changed — ${parts.join('; ')}`
}

/**
 * Collect the surfaces this plugin injects, from the pieces that already exist.
 *
 * Kept here (rather than in the boot code) so tests can assert the lock without a
 * live Harness, and so "what do we inject" has exactly one answer.
 * @param input - the registered tool schemas and injected guidance to collect.
 * @returns The surfaces this plugin injects, one group per injection channel.
 */
export function collectPluginSurfaces(input: {
  readonly toolSchemas?: readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown }[]
  readonly guidance?: readonly { readonly name: string; readonly text: string }[]
}): readonly SurfaceGroup[] {
  const tools = input.toolSchemas ?? []
  const guidance = input.guidance ?? []
  return [
    {
      group: 'tool-schemas',
      entries: tools.map(tool => ({
        name: tool.name,
        text: JSON.stringify({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} }),
      })),
    },
    { group: 'injected-guidance', entries: guidance.map(entry => ({ name: entry.name, text: entry.text })) },
  ]
}
