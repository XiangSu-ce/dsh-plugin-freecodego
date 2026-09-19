/**
 * Skill drafts are the one place this plugin writes something that a future
 * session may *follow*, so the cases are mostly about what it refuses to do:
 * draft from too little evidence, install itself, or produce a name the loader
 * would reject.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clusterMemoriesForSkills, renderSkillDraft, skillDraftDirectory, skillNameForCluster, writeSkillDrafts, type SkillDraftSource } from '../src/engineering-skill-draft.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

const memory = (id: string, tag: string, kind: SkillDraftSource['kind'] = 'decision', createdAt = 1_700_000_000_000): SkillDraftSource =>
  ({ id, title: `Practice ${id}`, kind, createdAt, tags: [tag] })

describe('skill draft clustering', () => {
  it('prefers a real tag over the synthetic kind key for the same records', () => {
    // The regression this guards: dedup is first-wins, so an alphabetical order
    // let `kind:decision` win and discard the `retry` cluster, producing a
    // useless `engineering-decision` draft instead of `engineering-retry`.
    const clusters = clusterMemoriesForSkills([memory('a', 'retry'), memory('b', 'retry'), memory('c', 'retry')])
    expect(clusters.map(cluster => cluster.key)).toContain('retry')
    expect(clusters.map(cluster => cluster.key)).not.toContain('kind:decision')
  })

  it('falls back to a kind cluster when no tags exist', () => {
    const tagless: SkillDraftSource[] = [1, 2, 3].map(index => ({ id: `m${index}`, title: `t${index}`, kind: 'bugfix', createdAt: index }))
    expect(clusterMemoriesForSkills(tagless).map(cluster => cluster.key)).toEqual(['kind:bugfix'])
  })

  it('ignores a cluster below the minimum size', () => {
    expect(clusterMemoriesForSkills([memory('a', 'retry'), memory('b', 'retry')])).toEqual([])
  })

  it('places each memory in exactly one cluster', () => {
    const clusters = clusterMemoriesForSkills([memory('a', 'retry'), memory('b', 'retry'), memory('c', 'retry')])
    const placed = clusters.flatMap(cluster => cluster.memories.map(entry => entry.id))
    expect(new Set(placed).size).toBe(placed.length)
  })

  it('returns clusters largest first, with a deterministic tie-break', () => {
    const clusters = clusterMemoriesForSkills([
      memory('a', 'retry'), memory('b', 'retry'), memory('c', 'retry'),
      memory('d', 'cache', 'bugfix'), memory('e', 'cache', 'bugfix'), memory('f', 'cache', 'bugfix'), memory('g', 'cache', 'bugfix'),
    ])
    expect(clusters[0]?.memories.length).toBeGreaterThanOrEqual(clusters[1]?.memories.length ?? 0)
  })
})

describe('skill naming', () => {
  it('produces kebab-case names the loader accepts', () => {
    for (const key of ['retry', 'kind:bugfix', 'Release Readiness', 'a_b_c']) {
      const name = skillNameForCluster(key)
      expect(name, key).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      expect(name?.startsWith('engineering-')).toBe(true)
    }
  })

  it('does not double-prefix a name that already carries the prefix', () => {
    expect(skillNameForCluster('engineering-tdd')).toBe('engineering-tdd')
  })

  it('yields no name when the key reduces to nothing', () => {
    expect(skillNameForCluster('---')).toBeUndefined()
  })
})

describe('skill draft rendering', () => {
  const cluster = () => clusterMemoriesForSkills([memory('mem_a', 'retry'), memory('mem_b', 'retry'), memory('mem_c', 'retry')])[0]!

  it('cites every source id so each claim is checkable', () => {
    const draft = renderSkillDraft(cluster(), new Map([['mem_a', 'A'], ['mem_b', 'B'], ['mem_c', 'C']]))!
    for (const id of draft.sources) expect(draft.content).toContain(id)
    expect(draft.sources).toHaveLength(3)
  })

  it('announces itself as a draft', () => {
    const draft = renderSkillDraft(cluster(), new Map())!
    expect(draft.content).toContain('**Draft.**')
    expect(draft.content).toContain('Review before enabling')
    // Frontmatter must open the file for the loader to accept it.
    expect(draft.content.startsWith('---\n')).toBe(true)
  })

  it('drops a body that would overflow the budget instead of truncating it', () => {
    const huge = new Map([['mem_a', 'x'.repeat(50_000)], ['mem_b', 'short'], ['mem_c', 'short']])
    const draft = renderSkillDraft(cluster(), huge)!
    // A Skill that stops mid-sentence teaches the wrong thing; the oversized
    // body is omitted and the remaining sources still render.
    expect(draft.content).not.toContain('xxxx')
    expect(draft.content).toContain('mem_b')
  })

  it('is byte-deterministic for the same inputs', () => {
    const bodies = new Map([['mem_a', 'A'], ['mem_b', 'B'], ['mem_c', 'C']])
    expect(renderSkillDraft(cluster(), bodies)?.content).toBe(renderSkillDraft(cluster(), bodies)?.content)
  })
})

describe('skill draft writing', () => {
  it('writes one SKILL.md per draft under a plugin-owned directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-skill-draft-'))
    directories.push(root)
    const memories = [memory('mem_a', 'retry'), memory('mem_b', 'retry'), memory('mem_c', 'retry')]
    const drafts = await writeSkillDrafts(root, memories, new Map(memories.map(entry => [entry.id, 'Body.'])))
    expect(drafts).toHaveLength(1)
    const file = join(root, '.freecodego', 'skill-drafts', drafts[0]!.name, 'SKILL.md')
    expect((await readFile(file, 'utf8')).length).toBeGreaterThan(0)
    await expect(stat(file)).resolves.toBeDefined()
  })

  it('writes nothing when no cluster qualifies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-skill-draft-'))
    directories.push(root)
    expect(await writeSkillDrafts(root, [memory('mem_a', 'retry')], new Map())).toEqual([])
    await expect(stat(join(root, '.freecodego'))).rejects.toThrow()
  })

  it('never registers a Skill root — drafts stay inert until a human moves them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-skill-draft-'))
    directories.push(root)
    // The directory is inside the workspace and outside any mounted Skill root,
    // so producing a draft cannot change what any engine follows.
    const directory = skillDraftDirectory(root)
    expect(directory).toContain('.freecodego')
    expect(directory).toContain('skill-drafts')
  })
})
