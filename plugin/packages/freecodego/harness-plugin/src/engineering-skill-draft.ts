/**
 * Derive Skill drafts from reviewed project memory.
 *
 * ## What this closes
 *
 * The plugin can already *consume* Skills: it mounts the audited bundle, accepts
 * extra roots, and loads them into any engine. It could not *produce* one. A
 * project that spent a week establishing a practice had no way to turn that
 * practice into a Skill, so the knowledge stayed in memory records that only
 * surface when something happens to search for them.
 *
 * ## Why drafts, and why from reviewed records only
 *
 * This module writes a proposal, never an installed Skill. The reason is the
 * trust ladder the memory store already enforces: a `draft` or `captured` record
 * is unreviewed observation, and a Skill built from it would be an unreviewed
 * instruction that every future session executes. Only `reviewed` records are
 * eligible, which means a human has already vouched for each fact the draft
 * rests on.
 *
 * ## Why the output is deterministic
 *
 * No model call. A cluster of related memories already contains everything a
 * Skill body needs — a practice and the decisions behind it — and asking a model
 * to restate them would cost a round trip while introducing a way for the draft
 * to say something none of its sources did. The draft cites its sources by id so
 * a reviewer can check every claim against the record it came from.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engineering-skill-draft
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FreeCodeGoEngineeringMemoryKind, FreeCodeGoEngineeringSkillDraft, FreeCodeGoEngineeringSkillDraftCluster } from './types.ts'

/** A cluster needs at least this many related records to be worth a Skill. */
const MIN_CLUSTER_SIZE = 3

/** Bounds, so one enormous memory graph cannot produce an unusable draft set. */
const MAX_CLUSTERS = 8
const MAX_SOURCES_PER_CLUSTER = 12
const MAX_BODY_CHARS = 6_000

/**
 * The minimum a memory must expose to be clustered.
 *
 * Deliberately narrower than `FreeCodeGoEngineeringMemoryDetail`: a caller that
 * already holds full details satisfies it, and the clustering logic never
 * depends on a field it does not use. `tags` is optional because the compact
 * index rows the list and search surfaces return do not carry them.
 */
export interface SkillDraftSource {
  readonly id: string
  readonly title: string
  readonly kind: FreeCodeGoEngineeringMemoryKind
  readonly createdAt: number
  readonly tags?: readonly string[]
}

/** Skill names are lowercase kebab-case, as the discovery contract requires. */
const SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Cluster reviewed memories into candidate practices.
 *
 * Clustering is by shared `kind` and tag rather than by embedding: the plugin
 * has no vector store, and tags are the signal a human already attached when
 * reviewing the record. Two records belong together when they share the
 * *first* tag — the one the reviewer put first — which keeps a record's many
 * incidental tags from fusing unrelated clusters.
 *
 * @param memories - reviewed memory indexes for one project.
 * @returns clusters large enough to be worth a Skill, largest first.
 */
export function clusterMemoriesForSkills(memories: readonly SkillDraftSource[]): readonly FreeCodeGoEngineeringSkillDraftCluster[] {
  const byTag = new Map<string, SkillDraftSource[]>()
  for (const memory of memories) {
    // `kind` participates as a synthetic tag so a tagless project still clusters
    // by what the records are (decisions together, bugfixes together).
    const tags = (memory.tags ?? []).filter(tag => tag.trim() !== '')
    const keys = tags.length === 0 ? [`kind:${memory.kind}`] : [`kind:${memory.kind}`, tags[0]!]
    for (const key of keys) {
      const bucket = byTag.get(key)
      if (bucket === undefined) byTag.set(key, [memory])
      else bucket.push(memory)
    }
  }
  const clusters: FreeCodeGoEngineeringSkillDraftCluster[] = []
  for (const [key, members] of byTag) {
    if (members.length < MIN_CLUSTER_SIZE) continue
    // A memory can land in two buckets; keep the first placement so each record
    // appears in exactly one draft.
    clusters.push({ key, memories: [...members].sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_SOURCES_PER_CLUSTER) })
  }
  const seen = new Set<string>()
  // Real tag clusters outrank the synthetic `kind:` keys when both cover the
  // same records. Dedup is first-wins, so the previous size-then-key order let
  // `kind:decision` beat `retry` on alphabetical order and discard the only
  // cluster that names an actual practice — producing a useless
  // `engineering-decision` draft instead of `engineering-retry`. Specificity
  // must therefore be the primary sort, ahead of size.
  const specificity = (key: string): number => key.startsWith('kind:') ? 1 : 0
  return clusters
    .sort((left, right) => specificity(left.key) - specificity(right.key) || right.memories.length - left.memories.length || left.key.localeCompare(right.key))
    .filter((cluster) => {
      const overlap = cluster.memories.some(memory => seen.has(memory.id))
      if (overlap) return false
      for (const memory of cluster.memories) seen.add(memory.id)
      return true
    })
    .slice(0, MAX_CLUSTERS)
}

/** Turn a cluster key into a candidate Skill name, or undefined when it cannot. */
export function skillNameForCluster(key: string): string | undefined {
  const base = key.replace(/^kind:/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase()
  if (base === '') return undefined
  const name = base.startsWith('engineering-') ? base : `engineering-${base}`
  return SKILL_NAME.test(name) ? name : undefined
}

/**
 * Render one Skill draft as a `SKILL.md` body.
 *
 * The frontmatter follows the same shape the bundled Skills use, so a draft that
 * a user accepts needs no reformatting before the loader reads it.
 *
 * @param cluster - the cluster to turn into a draft.
 * @param bodies - memory bodies by id; a missing body is cited by title alone.
 * @returns the draft, or undefined when the cluster cannot yield a valid name.
 */
export function renderSkillDraft(cluster: FreeCodeGoEngineeringSkillDraftCluster, bodies: ReadonlyMap<string, string>): FreeCodeGoEngineeringSkillDraft | undefined {
  const name = skillNameForCluster(cluster.key)
  if (name === undefined) return undefined
  const lines: string[] = [
    '---',
    `name: ${name}`,
    `description: Project practice derived from ${cluster.memories.length} reviewed memory records. Review before enabling.`,
    'metadata:',
    '  origin: FreeCodeGo memory-derived draft',
    '  version: 1',
    '---',
    '',
    `# ${name.replace(/^engineering-/u, '').replaceAll('-', ' ').replace(/^./u, character => character.toUpperCase())}`,
    '',
    '> **Draft.** Derived from reviewed project memory by `engineeringSkillDraft`.',
    '> The sources below are the only evidence for every statement here; edit or',
    '> discard this file before it is loaded as a Skill.',
    '',
  ]
  let budget = MAX_BODY_CHARS
  for (const memory of cluster.memories) {
    const body = (bodies.get(memory.id) ?? '').replace(/\s+/gu, ' ').trim()
    const heading = `## ${memory.title}`
    // A body that would overflow the budget is dropped rather than truncated:
    // a Skill that stops mid-sentence teaches the wrong thing.
    if (heading.length + body.length > budget) continue
    lines.push(heading, '', `- Kind: \`${memory.kind}\` · source: \`${memory.id}\``, '')
    if (body !== '') lines.push(body, '')
    budget -= heading.length + body.length
  }
  return {
    name,
    key: cluster.key,
    sources: cluster.memories.map(memory => memory.id),
    content: `${lines.join('\n')}\n`,
  }
}

/** Resolve and confine the draft directory for one project's workspace. */
export function skillDraftDirectory(workspaceRoot: string): string | undefined {
  const root = resolve(workspaceRoot)
  if (root === '') return undefined
  return join(root, '.freecodego', 'skill-drafts')
}

/**
 * Write the drafts for a workspace.
 *
 * Files land in `.freecodego/skill-drafts/` — inside the workspace but under a
 * directory the plugin already owns — so a user can diff and review them like
 * any other change. Nothing is installed and no Skill root is registered: the
 * gap between "a file exists" and "every engine now follows it" is exactly the
 * boundary a human should cross deliberately.
 *
 * @returns one entry per draft actually written.
 */
export async function writeSkillDrafts(workspaceRoot: string, memories: readonly SkillDraftSource[], bodies: ReadonlyMap<string, string>): Promise<readonly FreeCodeGoEngineeringSkillDraft[]> {
  const directory = skillDraftDirectory(workspaceRoot)
  if (directory === undefined) return []
  const clusters = clusterMemoriesForSkills(memories)
  const drafts = clusters.map(cluster => renderSkillDraft(cluster, bodies)).filter((draft): draft is FreeCodeGoEngineeringSkillDraft => draft !== undefined)
  if (drafts.length === 0) return []
  try {
    // One directory per draft, each holding a `SKILL.md`, so a user who accepts
    // one can move the directory straight into a Skill root unchanged.
    for (const draft of drafts) {
      const target = join(directory, draft.name)
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'SKILL.md'), draft.content, 'utf8')
    }
  } catch {
    return []
  }
  return drafts
}
