/**
 * Real-registry dispatch for the write-side closures the first audit could only
 * reach with an empty store: a memory draft, a checkpoint round-trip, and an
 * isolated working copy.
 *
 * Why this file exists
 * --------------------
 * `tool-runtime-integration.spec.ts` proved 32 of the 78 names dispatch through
 * the real `ToolRuntime`, but the memory calls it made all read an *empty*
 * store, the checkpoint calls only listed, and the worktree calls only reported
 * status. Those calls can succeed while every write path behind them is broken:
 * a save that returns a record the lossless-JSON gate rejects, a capture whose
 * id shape the restore schema refuses, an enter that never touches disk. So this
 * file drives the three closures end to end — save → (not recalled) → review
 * boundary, capture → diff → pin → restore, enter → status → exit — and reads
 * the disk afterwards to see the effect the tool claimed.
 *
 * The reviewed half of the memory boundary (a record a user promotes, then
 * recall/export/timeline) is pinned by `engineering-memory-tool-surface.spec.ts`
 * against a real store; the user promotion itself is a Remote, not a tool, so it
 * cannot be reached from this registry and is not repeated here.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/tool-runtime-closure
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { runtimeWorld } from './support/runtime-world.ts'

const run = promisify(execFile)

/** The parsed payload of a successful tool result, read with the shape the case
 *  asserts — the registry types it as `JsonValue`, so the cast is stated once. */
const valueOf = <T>(result: { readonly value?: unknown }): T => result.value as unknown as T

/** The engineering switches every closure case needs; graph is off so checkpoints
 *  still open (they gate on code-graph *or* quality) without a graph probe. */
const ENGINEERING_SETTINGS: Record<string, unknown> = {
  engineeringEnabled: true,
  engineeringMemoryEnabled: true,
  engineeringCodeGraphEnabled: true,
  engineeringQualityEnabled: false,
  engineeringSkillsEnabled: false,
  designEnabled: false,
  advisorProvider: 'opencode',
  advisorModel: 'auto',
}

/** Fetch one deferred engineering tool the way the model has to, then leave it
 *  callable for the rest of the case. */
async function expose(
  w: Awaited<ReturnType<typeof runtimeWorld>>,
  agent: Parameters<typeof w.call>[0],
  name: string,
): Promise<void> {
  const fetch = await w.call(agent, 'tool_search', { query: `select:${name}` })
  expect(fetch, `${name} discovery: ${JSON.stringify(fetch)}`).toMatchObject({ isError: false })
}

describe('engineering memory write closure through the real registry', () => {
  it('saves a draft that dispatches, and keeps it out of every agent-facing read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-closure-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-closure-mem-'))
    const previousHome = process.env.FREECODEGO_HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.FREECODEGO_HOME = home
    process.env.DSH_HOME = home
    const w = await runtimeWorld({ ...ENGINEERING_SETTINGS }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_status')
      const agent = await w.create('memory-closure', workspace)
      for (const name of [
        'engineering_memory_save', 'engineering_memory_search', 'engineering_memory_get',
        'engineering_memory_timeline', 'engineering_memory_export', 'engineering_handoff_create',
      ]) await expose(w, agent, name)

      const saved = await w.call(agent, 'engineering_memory_save', {
        title: 'Audit draft record',
        body: 'A durable fact recorded by the closure test; it must stay a draft until reviewed.',
        kind: 'discovery',
      })
      expect(saved, JSON.stringify(saved)).toMatchObject({ isError: false, value: { trust: 'draft', kind: 'discovery' } })
      const id = valueOf<{ id: string }>(saved).id
      expect(id).toMatch(/^mem_[a-f0-9]{32}$/u)

      // A draft is not agent-visible: search does not return it, and get by its
      // id returns no body. This is the contract the tool description promises
      // ("no Agent recalls it until a user reviews it").
      const searched = await w.call(agent, 'engineering_memory_search', { query: 'Audit draft record' })
      expect(searched).toMatchObject({ isError: false })
      expect(valueOf<{ results: readonly unknown[] }>(searched).results).toEqual([])
      const got = await w.call(agent, 'engineering_memory_get', { ids: [id] })
      expect(got).toMatchObject({ isError: false, value: { records: [] } })

      // The timeline reads reviewed records only, so a draft anchor is refused
      // rather than leaked.
      const timeline = await w.call(agent, 'engineering_memory_timeline', { id })
      expect(timeline).toMatchObject({ isError: true })

      // A handoff is the same write shape with a fixed kind and a target tag.
      const handoff = await w.call(agent, 'engineering_handoff_create', {
        title: 'Handoff for the next engine',
        body: 'Resume from the checkpoint closure test.',
        targetEngine: 'codex',
      })
      expect(handoff, JSON.stringify(handoff)).toMatchObject({ isError: false, value: { trust: 'draft', kind: 'handoff' } })
      expect(valueOf<{ tags: readonly string[] }>(handoff).tags).toContain('target-codex')

      // Export serializes reviewed records only; with no reviewed record it still
      // succeeds and reports none.
      const exported = await w.call(agent, 'engineering_memory_export', {})
      expect(exported, JSON.stringify(exported)).toMatchObject({ isError: false })

      // A kind outside the schema's enum is refused by the store's own vocabulary,
      // so no listing has to render a category its reader does not know.
      expect(await w.call(agent, 'engineering_memory_save', { title: 'ok', body: 'body', kind: 'not-a-kind' }))
        .toMatchObject({ isError: true })

      // The 200-code-point bound is a byte cap at the store, so the schema maximum
      // is honoured in any script while a title past it is refused.
      expect(await w.call(agent, 'engineering_memory_save', { title: '决'.repeat(200), body: 'A bounded decision.' }))
        .toMatchObject({ isError: false })
      expect(await w.call(agent, 'engineering_memory_save', { title: '决'.repeat(400), body: 'A bounded decision.' }))
        .toMatchObject({ isError: true })
    } finally {
      await w.close()
      if (previousHome === undefined) delete process.env.FREECODEGO_HOME
      else process.env.FREECODEGO_HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('memory review closure through the real registry and its Remote', () => {
  it('promotes, rejects, and supersedes a draft, and only the promoted record becomes readable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-closure-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-closure-review-'))
    const previousHome = process.env.FREECODEGO_HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.FREECODEGO_HOME = home
    process.env.DSH_HOME = home
    const w = await runtimeWorld({ ...ENGINEERING_SETTINGS }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_status')
      const agent = await w.create('memory-review', workspace)
      for (const name of [
        'engineering_memory_save', 'engineering_memory_search', 'engineering_memory_get',
        'engineering_memory_timeline', 'engineering_memory_export',
      ]) await expose(w, agent, name)

      // The user-only decision is a Remote, not a tool: exactly the seam the
      // first closure file could not cross. Reaching it here is what makes this a
      // *reviewed* closure rather than three store calls wearing a tool's name.
      const plugin = w.plugin
      expect(plugin, 'the plugin (and its Remote) must be mounted for this closure').toBeDefined()
      const decide = (id: string, decision: 'reviewed' | 'rejected' | 'superseded'): unknown =>
        plugin!.engineeringMemoryReview(agent.id, { id, decision })

      const save = (title: string, body: string): Promise<{ isError?: boolean; value?: unknown }> =>
        w.call(agent, 'engineering_memory_save', { title, body, kind: 'decision' })
      const savedId = (result: { isError?: boolean; value?: unknown }): string => {
        expect(result, JSON.stringify(result)).toMatchObject({ isError: false })
        const id = valueOf<{ id: string }>(result).id
        expect(id).toMatch(/^mem_[a-f0-9]{32}$/u)
        return id
      }
      const searchIds = async (query: string): Promise<readonly string[]> => {
        const found = await w.call(agent, 'engineering_memory_search', { query })
        expect(found, JSON.stringify(found)).toMatchObject({ isError: false })
        return valueOf<{ results: readonly { id: string }[] }>(found).results.map(record => record.id)
      }
      const detailIds = async (id: string): Promise<readonly string[]> => {
        const got = await w.call(agent, 'engineering_memory_get', { ids: [id] })
        expect(got, JSON.stringify(got)).toMatchObject({ isError: false })
        return valueOf<{ records: readonly { id: string }[] }>(got).records.map(record => record.id)
      }

      // --- A reviewed record becomes agent-visible through every read path ---
      const kept = savedId(await save('Reviewed closure decision', 'The durable fact keptknowledge that survives review.'))
      // A draft is not readable; the promotion is what changes that.
      expect(await searchIds('keptknowledge')).toEqual([])
      expect(await detailIds(kept)).toEqual([])

      const promoted = decide(kept, 'reviewed') as { readonly id: string; readonly trust: string }
      expect(promoted, JSON.stringify(promoted)).toMatchObject({ id: kept, trust: 'reviewed' })

      expect(await searchIds('keptknowledge')).toContain(kept)
      const detail = await w.call(agent, 'engineering_memory_get', { ids: [kept] })
      expect(valueOf<{ records: readonly { id: string; trust: string; body: string }[] }>(detail).records[0])
        .toMatchObject({ id: kept, trust: 'reviewed', body: 'The durable fact keptknowledge that survives review.' })
      const window = await w.call(agent, 'engineering_memory_timeline', { id: kept })
      expect(window, JSON.stringify(window)).toMatchObject({ isError: false, value: { anchor: { id: kept } } })

      // The export writes documents, so its evidence is on disk, not in a field.
      const exported = await w.call(agent, 'engineering_memory_export', {})
      expect(exported, JSON.stringify(exported)).toMatchObject({ isError: false, value: { failed: [] } })
      const directory = valueOf<{ directory: string }>(exported).directory
      expect(await readFile(join(directory, 'INDEX.md'), 'utf8')).toContain('Reviewed closure decision')

      // A reviewed record is terminal: the review ladder only moves a pending
      // draft or captured observation, so re-deciding it is refused rather than
      // silently rewriting history.
      expect(() => decide(kept, 'rejected')).toThrow(/only a pending draft or captured record/u)

      // --- A rejected record never becomes readable ---
      const rejected = savedId(await save('Rejected closure decision', 'The observation rejectedknowledge a reviewer turned away.'))
      expect(decide(rejected, 'rejected')).toMatchObject({ id: rejected, trust: 'rejected' })
      expect(await searchIds('rejectedknowledge')).toEqual([])
      expect(await detailIds(rejected)).toEqual([])
      expect(await w.call(agent, 'engineering_memory_timeline', { id: rejected })).toMatchObject({ isError: true })
      expect(await readFile(join(directory, 'INDEX.md'), 'utf8')).not.toContain('Rejected closure decision')

      // --- A superseded record never becomes readable either ---
      const superseded = savedId(await save('Superseded closure decision', 'The stale note supersededknowledge a newer record replaced.'))
      expect(decide(superseded, 'superseded')).toMatchObject({ id: superseded, trust: 'superseded' })
      expect(await searchIds('supersededknowledge')).toEqual([])
      expect(await detailIds(superseded)).toEqual([])
      expect(await w.call(agent, 'engineering_memory_timeline', { id: superseded })).toMatchObject({ isError: true })

      // The decision vocabulary is checked at the Remote door, not only at the
      // store: an unknown decision is refused before any record is touched.
      const pending = savedId(await save('Pending closure decision', 'Waiting on a decision.'))
      expect(() => decide(pending, 'not-a-decision' as 'reviewed')).toThrow(/review decision is invalid/u)
      // Refused before the update: the record is still a readable draft decision.
      expect((plugin!.engineeringMemoryGet(agent.id, [pending]) as readonly { readonly trust: string }[])[0]?.trust).toBe('draft')
    } finally {
      await w.close()
      if (previousHome === undefined) delete process.env.FREECODEGO_HOME
      else process.env.FREECODEGO_HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('checkpoint round-trip through the real registry', () => {
  it('captures, previews, pins, and restores tracked files on disk', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-closure-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-closure-ckpt-'))
    const previousHome = process.env.FREECODEGO_HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.FREECODEGO_HOME = home
    process.env.DSH_HOME = home
    const w = await runtimeWorld({ ...ENGINEERING_SETTINGS }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_status')
      const agent = await w.create('checkpoint-closure', workspace)
      await expose(w, agent, 'engineering_checkpoint_capture')

      const before = join(workspace, 'tracked.md')
      await writeFile(before, 'original body\n')
      const captured = await w.call(agent, 'engineering_checkpoint_capture', { label: 'before the edit' })
      expect(captured, JSON.stringify(captured)).toMatchObject({ isError: false })
      const id = valueOf<{ id: string }>(captured).id
      // The capture schema and the restore schema are separate literals; the id
      // this capture returns has to satisfy both.
      expect(id).toMatch(/^ckpt_[a-f0-9]{24}$/u)

      // Change the tracked file and add a new one.
      await writeFile(before, 'changed body\n')
      const added = join(workspace, 'added.md')
      await writeFile(added, 'created after capture\n')

      await expose(w, agent, 'engineering_checkpoint_diff')
      const diff = await w.call(agent, 'engineering_checkpoint_diff', { id })
      expect(diff, JSON.stringify(diff)).toMatchObject({
        isError: false,
        value: { modified: ['tracked.md'], addedSince: ['added.md'], deletedSince: [] },
      })

      await expose(w, agent, 'engineering_checkpoint_list')
      const listed = await w.call(agent, 'engineering_checkpoint_list', {})
      expect(listed).toMatchObject({ isError: false })
      expect(valueOf<{ checkpoints: readonly { id: string }[] }>(listed).checkpoints.map(row => row.id)).toContain(id)

      await expose(w, agent, 'engineering_checkpoint_pin')
      expect(await w.call(agent, 'engineering_checkpoint_pin', { id, pinned: true }))
        .toMatchObject({ isError: false, value: { pinned: true } })

      await expose(w, agent, 'engineering_checkpoint_restore')
      const restored = await w.call(agent, 'engineering_checkpoint_restore', { id })
      expect(restored, JSON.stringify(restored)).toMatchObject({ isError: false, value: { restoredFiles: 1, deletedFiles: 1 } })

      // The disk, not the report, is the evidence: the tracked file is back and
      // the file created after the checkpoint is gone.
      expect(await readFile(before, 'utf8')).toBe('original body\n')
      await expect(stat(added)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await w.close()
      if (previousHome === undefined) delete process.env.FREECODEGO_HOME
      else process.env.FREECODEGO_HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('worktree lifecycle through the real registry', () => {
  it('creates a real copy on disk, reports it, and removes it on exit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-closure-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-closure-wt-'))
    const previousHome = process.env.FREECODEGO_HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.FREECODEGO_HOME = home
    process.env.DSH_HOME = home
    // A real repository, so the default `auto` strategy exercises the git path.
    await run('git', ['init', '--quiet'], { cwd: workspace, windowsHide: true })
    await writeFile(join(workspace, 'README.md'), '# closure\n')
    await run('git', ['-c', 'user.email=audit@example.com', '-c', 'user.name=Audit', 'add', '.', '--', 'README.md'], { cwd: workspace, windowsHide: true })
    await run('git', ['-c', 'user.email=audit@example.com', '-c', 'user.name=Audit', 'commit', '--quiet', '-m', 'init'], { cwd: workspace, windowsHide: true })
    const w = await runtimeWorld({ ...ENGINEERING_SETTINGS }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_worktree_status')
      const agent = await w.create('worktree-closure', workspace)
      await expose(w, agent, 'engineering_worktree_enter')

      const entered = await w.call(agent, 'engineering_worktree_enter', {})
      expect(entered, JSON.stringify(entered)).toMatchObject({ isError: false, value: { exists: true, owner: 'session' } })
      const path = valueOf<{ path: string }>(entered).path
      expect(path.length).toBeGreaterThan(0)
      // The report is only true if the directory is really there.
      await expect(stat(path)).resolves.toMatchObject({ isDirectory: expect.any(Function) })

      await expose(w, agent, 'engineering_worktree_status')
      const status = await w.call(agent, 'engineering_worktree_status', {})
      expect(status, JSON.stringify(status)).toMatchObject({ isError: false, value: { held: true, path } })

      await expose(w, agent, 'engineering_worktree_exit')
      const exited = await w.call(agent, 'engineering_worktree_exit', { remove: true })
      expect(exited, JSON.stringify(exited)).toMatchObject({ isError: false, value: { removed: true } })
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

      const after = await w.call(agent, 'engineering_worktree_status', {})
      expect(after, JSON.stringify(after)).toMatchObject({ isError: false, value: { held: false } })
    } finally {
      await w.close()
      if (previousHome === undefined) delete process.env.FREECODEGO_HOME
      else process.env.FREECODEGO_HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('checkpoint Remotes and tools agree through one real registry', () => {
  it('captures, diffs, pins, restores, and removes consistently across both entry points', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-closure-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-closure-ckpt-remote-'))
    const previousHome = process.env.FREECODEGO_HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.FREECODEGO_HOME = home
    process.env.DSH_HOME = home
    const w = await runtimeWorld({ ...ENGINEERING_SETTINGS }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_status')
      const agent = await w.create('checkpoint-remote', workspace)
      for (const name of [
        'engineering_checkpoint_capture', 'engineering_checkpoint_diff',
        'engineering_checkpoint_list', 'engineering_checkpoint_pin', 'engineering_checkpoint_restore',
      ]) await expose(w, agent, name)

      const plugin = w.plugin
      expect(plugin, 'the checkpoint Remotes need the mounted plugin').toBeDefined()

      // A capture through the Remote is visible to the tool's list: the two
      // entries share one store, so a UI that captures must not be invisible to
      // the model's list.
      const remoteCapture = await plugin!.engineeringCheckpointCapture(agent.id, { label: 'remote capture' })
      expect(remoteCapture.id).toMatch(/^ckpt_[a-f0-9]{24}$/u)
      const toolListed = await w.call(agent, 'engineering_checkpoint_list', {})
      expect(toolListed, JSON.stringify(toolListed)).toMatchObject({ isError: false })
      expect(valueOf<{ checkpoints: readonly { id: string }[] }>(toolListed).checkpoints.map(row => row.id)).toContain(remoteCapture.id)

      const tracked = join(workspace, 'tracked.md')
      await writeFile(tracked, 'original body\n')
      const toolCapture = await w.call(agent, 'engineering_checkpoint_capture', { label: 'tool capture' })
      expect(toolCapture, JSON.stringify(toolCapture)).toMatchObject({ isError: false })
      const toolId = valueOf<{ id: string }>(toolCapture).id
      expect(toolId).toMatch(/^ckpt_[a-f0-9]{24}$/u)
      expect(plugin!.engineeringCheckpointList(agent.id).map(row => row.id)).toContain(toolId)

      // Change a tracked file and add a new one, then compare the two previews
      // of the same checkpoint: a divergence here would be a UI that promises a
      // different restore than the tool the model would run.
      await writeFile(tracked, 'changed body\n')
      const added = join(workspace, 'added.md')
      await writeFile(added, 'created after capture\n')
      const remoteDiff = plugin!.engineeringCheckpointDiff(agent.id, { id: toolId })
      const toolDiff = await w.call(agent, 'engineering_checkpoint_diff', { id: toolId })
      expect(valueOf(toolDiff)).toEqual(remoteDiff)
      expect(remoteDiff).toMatchObject({ modified: ['tracked.md'], addedSince: ['added.md'], deletedSince: [] })

      // A pin set through the UI Remote is the pin the tool's list reports.
      expect(plugin!.engineeringCheckpointSetPinned(agent.id, { id: toolId, pinned: true })).toEqual({ pinned: true })
      const pinnedTool = await w.call(agent, 'engineering_checkpoint_list', {})
      expect(valueOf<{ checkpoints: readonly { id: string; pinned?: boolean }[] }>(pinnedTool).checkpoints
        .find(row => row.id === toolId)?.pinned).toBe(true)

      // Restore through the Remote writes the same disk state the tool path does.
      const restored = await plugin!.engineeringCheckpointRestore(agent.id, { id: toolId })
      expect(restored, JSON.stringify(restored)).toMatchObject({ restoredFiles: 1, deletedFiles: 1 })
      expect(await readFile(tracked, 'utf8')).toBe('original body\n')
      await expect(stat(added)).rejects.toMatchObject({ code: 'ENOENT' })

      // Removal has no tool twin, so the cross-check is the other direction: the
      // Remote delete is what the tool's list stops showing, and a second delete
      // is refused rather than reported as a no-op success.
      expect(plugin!.engineeringCheckpointRemove(agent.id, { id: remoteCapture.id })).toEqual({ deleted: true })
      expect(plugin!.engineeringCheckpointList(agent.id).map(row => row.id)).not.toContain(remoteCapture.id)
      const afterRemove = await w.call(agent, 'engineering_checkpoint_list', {})
      expect(valueOf<{ checkpoints: readonly { id: string }[] }>(afterRemove).checkpoints.map(row => row.id)).not.toContain(remoteCapture.id)
      expect(() => plugin!.engineeringCheckpointRemove(agent.id, { id: remoteCapture.id })).toThrow(/was not found/u)
    } finally {
      await w.close()
      if (previousHome === undefined) delete process.env.FREECODEGO_HOME
      else process.env.FREECODEGO_HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('memory read entries: Remote and tool agree on one store and one boundary', () => {
  it('reads the same reviewed set on both sides while the review surface alone sees pending records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-closure-home-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-closure-matrix-'))
    const previousHome = process.env.FREECODEGO_HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.FREECODEGO_HOME = home
    process.env.DSH_HOME = home
    const w = await runtimeWorld({ ...ENGINEERING_SETTINGS }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_status')
      const agent = await w.create('memory-matrix', workspace)
      for (const name of [
        'engineering_memory_save', 'engineering_memory_search', 'engineering_memory_get',
        'engineering_memory_timeline', 'engineering_memory_export',
      ]) await expose(w, agent, name)
      const plugin = w.plugin
      expect(plugin, 'the memory Remotes need the mounted plugin').toBeDefined()

      // Unique body tokens, because a shared substring would match every record
      // and turn an exact-set assertion into a vacuous one.
      const save = async (title: string, body: string): Promise<string> => {
        const saved = await w.call(agent, 'engineering_memory_save', { title, body, kind: 'decision' })
        expect(saved, JSON.stringify(saved)).toMatchObject({ isError: false })
        const id = valueOf<{ id: string }>(saved).id
        // Distinct created_at values, so the timeline window has an unambiguous
        // order to take its neighbours over.
        await new Promise(resolve => setTimeout(resolve, 5))
        return id
      }
      const first = await save('Matrix first', 'alphaphrase')
      const anchor = await save('Matrix anchor', 'betaphrase')
      const draft = await save('Matrix draft', 'gammaphrase')
      const last = await save('Matrix last', 'deltaphrase')
      for (const id of [first, anchor, last]) plugin!.engineeringMemoryReview(agent.id, { id, decision: 'reviewed' })

      const ids = (rows: readonly { readonly id: string }[]): readonly string[] => rows.map(row => row.id)

      // --- search: Remote and tool read the same reviewed rows, and neither leaks a draft ---
      for (const needle of ['betaphrase', 'alphaphrase']) {
        const remote = plugin!.engineeringMemorySearch(agent.id, needle) as readonly { readonly id: string }[]
        const tool = await w.call(agent, 'engineering_memory_search', { query: needle })
        expect(valueOf<{ results: readonly { readonly id: string }[] }>(tool).results.map(row => row.id))
          .toEqual(ids(remote))
      }
      expect(ids(plugin!.engineeringMemorySearch(agent.id, 'betaphrase') as readonly { readonly id: string }[])).toEqual([anchor])
      expect(ids(plugin!.engineeringMemorySearch(agent.id, 'gammaphrase') as readonly { readonly id: string }[])).toEqual([])

      // --- get: same reviewed record on both sides; the review surface alone may read the pending draft ---
      const remoteGet = plugin!.engineeringMemoryGet(agent.id, [anchor, draft]) as readonly { readonly id: string; readonly trust: string }[]
      expect(ids(remoteGet)).toEqual([anchor, draft])
      expect(remoteGet.map(row => row.trust)).toEqual(['reviewed', 'draft'])
      const toolGet = await w.call(agent, 'engineering_memory_get', { ids: [anchor, draft] })
      expect(valueOf<{ records: readonly { readonly id: string }[] }>(toolGet).records.map(row => row.id)).toEqual([anchor])

      // --- timeline: identical window on both sides, and the pending draft is skipped ---
      const remoteTimeline = plugin!.engineeringMemoryTimeline(agent.id, { id: anchor, before: 1, after: 1 }) as {
        readonly before: readonly { readonly id: string }[]
        readonly after: readonly { readonly id: string }[]
      }
      const toolTimeline = await w.call(agent, 'engineering_memory_timeline', { id: anchor, before: 1, after: 1 })
      expect(valueOf(toolTimeline)).toEqual(remoteTimeline)
      expect(ids(remoteTimeline.before)).toEqual([first])
      expect(ids(remoteTimeline.after)).toEqual([last])

      // --- list: Remote-only and user-facing: no bodies, reviewed by default, pending on request ---
      const listed = plugin!.engineeringMemoryList(agent.id) as { readonly records: readonly { readonly id: string; readonly body?: unknown }[] }
      expect(ids(listed.records)).toContain(anchor)
      expect(ids(listed.records)).not.toContain(draft)
      expect(listed.records.every(record => !('body' in record))).toBe(true)
      const listedDrafts = plugin!.engineeringMemoryList(agent.id, { trusts: ['draft'] }) as { readonly records: readonly { readonly id: string }[] }
      expect(ids(listedDrafts.records)).toEqual([draft])

      // --- recall: Remote-only session-start injection, reviewed-only ---
      const recalled = plugin!.engineeringMemoryRecall(agent.id) as { readonly usedTokens: number; readonly records: readonly { readonly id: string }[] }
      expect(recalled.usedTokens).toBeGreaterThan(0)
      expect(ids(recalled.records)).toContain(anchor)
      expect(ids(recalled.records)).not.toContain(draft)

      // --- export: the Remote payload and the tool's written files see the same reviewed set ---
      const remoteExport = plugin!.engineeringMemoryExport(agent.id)
      // `omitted` is only in the declared Remote type once the class method stops
      // narrowing it away; reading it here is what pins that the type and the
      // store agree on the truncation axis.
      expect(remoteExport.omitted).toBe(0)
      expect([...ids(remoteExport.records)].sort()).toEqual([first, anchor, last].sort())
      const toolExport = await w.call(agent, 'engineering_memory_export', {})
      const index = await readFile(join(valueOf<{ readonly directory: string }>(toolExport).directory, 'INDEX.md'), 'utf8')
      expect(index).toContain('Matrix anchor')
      expect(index).not.toContain('Matrix draft')
    } finally {
      await w.close()
      if (previousHome === undefined) delete process.env.FREECODEGO_HOME
      else process.env.FREECODEGO_HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
