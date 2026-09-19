/**
 * The Agent-facing memory tools, driven through their own handlers.
 *
 * Why this exists
 * ---------------
 * `engineering_memory_timeline` and `engineering_memory_export` were registered,
 * documented, and reachable with nothing that ever called one. The store they sit
 * on is covered by `engineering-memory.spec.ts` (`timeline` windows, the
 * reviewed-only export, credential skips) and the export format by its own spec,
 * but the *handler* — the code that turns a model's arguments into a store call,
 * and the door the settings switch is supposed to close — had no driver. The
 * remaining four memory tools were in the same position.
 *
 * So this file stands up the missing piece: a registry whose `memory` field is a
 * real `EngineeringMemoryStore` on a temporary database, with the memory family
 * registered exactly as `reconcile()` registers it. Driving the tools against a
 * real store is the point — a double would have tested the double, and the two
 * things worth pinning live only at this seam:
 *
 * 1. **The arguments reach the store the schema promises.** `before`/`after` are
 *    the window the timeline tool offers, and `export` must write the reviewed
 *    records and only those.
 * 2. **The settings switch is enforced where the call is made, not only where the
 *    tool was registered.** Registration reads `memoryAvailable`, which a settings
 *    change does not touch until its queued reconcile runs. In that window the
 *    family served every call with the switch already off.
 *
 * The export tool writes under the FreeCodeGo data home, so the test owns that
 * home for its duration rather than letting a driven call touch the user's real
 * one.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/engineering-memory-tool-surface
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'
import { EngineeringMemoryStore } from '../src/engineering-memory.ts'

interface RegisteredTool {
  readonly name: string
  readonly description?: string
  readonly parameters?: { readonly properties?: Readonly<Record<string, unknown>> }
  execute(args: unknown, exec: unknown): unknown
}

const WORKSPACE = mkdtempSync(join(tmpdir(), 'freecodego-memory-tools-ws-'))
/** The data home the export tool writes into; the real one is never touched. */
const DATA_HOME = mkdtempSync(join(tmpdir(), 'freecodego-memory-tools-home-'))
const PREVIOUS_DATA_HOME = process.env.FREECODEGO_HOME
process.env.FREECODEGO_HOME = DATA_HOME

/** Every store a harness opened, so a failed assertion cannot leave one holding
 *  its database file open — on Windows that is what turns the temp-home cleanup
 *  into an `EPERM`. */
const openedStores: EngineeringMemoryStore[] = []

afterEach(() => {
  for (const store of openedStores.splice(0)) store.close()
})

afterAll(() => {
  if (PREVIOUS_DATA_HOME === undefined) delete process.env.FREECODEGO_HOME
  else process.env.FREECODEGO_HOME = PREVIOUS_DATA_HOME
  rmSync(WORKSPACE, { recursive: true, force: true })
  // Best-effort: a leftover handle must not fail an otherwise green run.
  try { rmSync(DATA_HOME, { recursive: true, force: true }) } catch { /* left for the OS to reap */ }
})

/** The `exec` every memory handler reads its workspace from. */
const EXEC = { agent: { session: { header: { cwd: WORKSPACE } } } }

interface Harness {
  readonly tool: (name: string) => RegisteredTool
  readonly names: readonly string[]
  readonly store: EngineeringMemoryStore
}

/**
 * A registry whose memory store is real and whose engine probes report nothing
 * installed, so only the engine-free tools mount alongside the memory family.
 *
 * `memoryAvailable` is set directly rather than earned through `reconcile()`:
 * reconciling for real would mean opening a job store and a checkpoint store and
 * probing two engines to reach a state that is only the precondition here. What
 * this file is about starts once the family is mounted.
 */
async function harness(input: { readonly memoryEnabled?: boolean } = {}): Promise<Harness> {
  const tools: RegisteredTool[] = []
  const ctx = {
    on: vi.fn(),
    effect: vi.fn(),
    get: (name: string) => (name === 'tools' ? { register: (definition: RegisteredTool) => { tools.push(definition); return { dispose: () => undefined } } } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as Context
  const settings = {
    get: () => ({
      engineeringEnabled: true,
      engineeringCodeGraphEnabled: false,
      engineeringMemoryEnabled: input.memoryEnabled ?? true,
    }),
    update: async () => undefined,
  }
  const engineering = new FreeCodeGoEngineeringRegistry(ctx, settings)
  const storeRoot = join(DATA_HOME, `store-${randomUUID()}`)
  mkdirSync(storeRoot, { recursive: true })
  const store = new EngineeringMemoryStore(storeRoot)
  await store.open()
  openedStores.push(store)
  const privates = engineering as unknown as {
    memory: EngineeringMemoryStore
    memoryAvailable: boolean
    graphify: Record<string, unknown>
    graphifySidecar: { graphify: unknown }
    codeGraph: Record<string, unknown>
    registerTools(): Promise<void>
  }
  privates.memory = store
  privates.memoryAvailable = true
  const absent = { status: () => Promise.resolve({ installed: false, state: 'not-installed' }) }
  privates.graphify = absent
  privates.graphifySidecar.graphify = absent
  privates.codeGraph = absent
  await privates.registerTools()
  return {
    tool: (name: string) => {
      const found = tools.find(entry => entry.name === name)
      if (found === undefined) throw new Error(`no tool named ${name}; registered: ${tools.map(entry => entry.name).join(', ')}`)
      return found
    },
    names: tools.map(entry => entry.name),
    store,
  }
}

interface TimelineIndex {
  readonly id: string
  readonly title: string
}
interface TimelineResult {
  readonly anchor: TimelineIndex
  readonly before: readonly TimelineIndex[]
  readonly after: readonly TimelineIndex[]
}

describe('the memory tools, driven through their handlers', () => {
  it('mounts the memory family once the store is open, and names each tool once', async () => {
    const built = await harness()
    for (const name of [
      'engineering_memory_search',
      'engineering_memory_get',
      'engineering_memory_timeline',
      'engineering_memory_export',
      'engineering_memory_save',
      'engineering_handoff_create',
    ]) {
      expect(built.names).toContain(name)
    }
    expect(new Set(built.names).size).toBe(built.names.length)
    built.store.close()
  })

  it('reads the timeline window the schema arms, and only for reviewed records', async () => {
    const built = await harness()
    vi.useFakeTimers()
    try {
      // Distinct days, so the ordering the window is taken over is unambiguous.
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      const first = built.store.saveDraft({ cwd: WORKSPACE, title: 'First decision', body: 'The first reviewed decision.' })
      vi.setSystemTime(new Date('2025-01-02T00:00:00Z'))
      const anchor = built.store.saveDraft({ cwd: WORKSPACE, title: 'Anchor decision', body: 'The middle reviewed decision.' })
      // Between the anchor and the last record, but never reviewed: the Agent's
      // read path resolves `['reviewed']`, so it must not appear either side.
      vi.setSystemTime(new Date('2025-01-02T12:00:00Z'))
      built.store.saveDraft({ cwd: WORKSPACE, title: 'Pending draft', body: 'Not yet reviewed.' })
      vi.setSystemTime(new Date('2025-01-03T00:00:00Z'))
      const last = built.store.saveDraft({ cwd: WORKSPACE, title: 'Last decision', body: 'The last reviewed decision.' })
      for (const record of [first, anchor, last]) built.store.review({ cwd: WORKSPACE, id: record.id, trust: 'reviewed' })

      const window = await built.tool('engineering_memory_timeline').execute({ id: anchor.id, before: 1, after: 1 }, EXEC) as TimelineResult
      expect(window.anchor).toMatchObject({ id: anchor.id, title: 'Anchor decision' })
      expect(window.before.map(record => record.id)).toEqual([first.id])
      expect(window.after.map(record => record.id)).toEqual([last.id])

      // `before: 0` is a real request for no earlier records, not the default.
      const anchorOnly = await built.tool('engineering_memory_timeline').execute({ id: anchor.id, before: 0, after: 0 }, EXEC) as TimelineResult
      expect(anchorOnly.before).toEqual([])
      expect(anchorOnly.after).toEqual([])

      // The schema is what the model reads, so the window bounds it advertises are
      // part of the contract this handler must honour.
      const properties = built.tool('engineering_memory_timeline').parameters?.properties ?? {}
      expect(properties).toMatchObject({
        id: { pattern: '^mem_[a-fA-F0-9]{32}$' },
        before: { minimum: 0, maximum: 10 },
        after: { minimum: 0, maximum: 10 },
      })
    } finally {
      vi.useRealTimers()
      built.store.close()
    }
  })

  it('exports exactly the reviewed records, under the data home', async () => {
    const built = await harness()
    const reviewed = built.store.saveDraft({ cwd: WORKSPACE, title: 'Reviewed decision', body: 'Durable reviewed knowledge.' })
    built.store.review({ cwd: WORKSPACE, id: reviewed.id, trust: 'reviewed' })
    built.store.saveDraft({ cwd: WORKSPACE, title: 'Pending draft', body: 'Never part of the document library.' })

    const result = await built.tool('engineering_memory_export').execute({}, EXEC) as {
      readonly directory: string
      readonly written: readonly string[]
      readonly failed: readonly unknown[]
      readonly skipped: readonly unknown[]
    }
    expect(result.failed).toEqual([])
    expect(result.written).toContain('INDEX.md')
    // The folder is the plugin's own data home, keyed by project, not the cwd.
    expect(result.directory.startsWith(DATA_HOME)).toBe(true)
    const files = readdirSync(result.directory)
    expect(files).toContain('INDEX.md')

    const index = readFileSync(join(result.directory, 'INDEX.md'), 'utf8')
    expect(index).toContain('Reviewed decision')
    expect(index).not.toContain('Pending draft')
    // One document per reviewed record, beside the index.
    expect(files.filter(name => name !== 'INDEX.md')).toHaveLength(1)
    built.store.close()
  })

  it('refuses every memory tool while the settings switch is off, even before its reconcile runs', async () => {
    // The registration reads `memoryAvailable`, which a settings change does not
    // move until the queued reconcile runs. This is that window: the family is
    // mounted, the store is open, and the switch is already off. The switch is
    // only real if it is applied at the door the Agent knocks on.
    const built = await harness({ memoryEnabled: false })
    const id = 'mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const calls: readonly (readonly [string, unknown])[] = [
      ['engineering_memory_search', { query: 'anything' }],
      ['engineering_memory_get', { ids: [id] }],
      ['engineering_memory_timeline', { id }],
      ['engineering_memory_export', {}],
      ['engineering_memory_save', { title: 'Title', body: 'Body' }],
      ['engineering_handoff_create', { title: 'Title', body: 'Body', targetEngine: 'codex' }],
    ]
    for (const [name, args] of calls) {
      // Wrapped because a handler that gates before its first `await` throws
      // synchronously, and one written `async` rejects: the switch must be real
      // either way, so the assertion covers both shapes.
      await expect(Promise.resolve().then(() => built.tool(name).execute(args, EXEC)), name)
        .rejects.toThrow(/disabled in FreeCodeGo settings/u)
    }
    // Nothing reached the store: the refusal is the door, not a store error.
    expect(built.store.list({ cwd: WORKSPACE, trusts: ['draft'] }).records).toEqual([])
    built.store.close()
  })

  it('still answers the settings panel while the Agent-facing door is shut', async () => {
    // The review flow reads the store through its own remotes, and the panel is
    // most likely to be open exactly when the switch was just turned off. A gate
    // put on the store instead of on the tool would close that door too.
    const built = await harness({ memoryEnabled: false })
    const draft = built.store.saveDraft({ cwd: WORKSPACE, title: 'Pending review', body: 'Waiting for a human.' })
    expect(built.store.list({ cwd: WORKSPACE, trusts: ['draft'] }).records.map(record => record.id)).toEqual([draft.id])
    expect(built.store.timeline({ cwd: WORKSPACE, id: draft.id, trusts: ['draft'] }).anchor).toMatchObject({ id: draft.id })
    built.store.close()
  })
})
