/**
 * The tool families that must not depend on an installed engine.
 *
 * Three things are worth pinning without a workspace: that the tools are
 * registered with the shape the model is promised (a required-target refusal,
 * bounded output), that the families register with no code-graph engine present —
 * the checkpoint tools used to be registered inside the Graphify branch, so they
 * existed only for users who had installed it — and that the read path answers
 * instead of throwing when nothing is recorded. The filesystem half of each —
 * pre-image, post-image, rollback against a real file — is where the tracker's own
 * spec already sits, and a second copy of it would only pin the same decisions
 * twice.
 *
 * Why not a real workspace here, stated accurately: the glue's filesystem half —
 * pre-image, post-image, the reverted bytes on disk — is **not covered by this
 * file or any other**, and that is a gap rather than a choice worth defending. An
 * earlier version of this comment justified the omission with a lint-budget
 * measurement that was taken with `lib/` unbuilt and is therefore wrong:
 * `team-worktree.spec.ts` imports `node:child_process`, `node:fs`,
 * `node:fs/promises`, `node:os` and `node:path` and carries **zero** lint-budget
 * entries, so a filesystem test is affordable once the build output exists. What
 * this file does cover is the argument parsing and the surface itself; the path
 * computation it relies on is covered directly, in `hunk-tracker.spec.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'

interface RegisteredTool {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
  execute(args: unknown, exec: unknown): unknown
}

/** A registry built on a fake host, with the tool definitions it registers. */
function registryBoth(): { readonly engineering: FreeCodeGoEngineeringRegistry; readonly tools: RegisteredTool[] } {
  const built = registry()
  ;(built.engineering as unknown as { registerCheckpointTools(): void }).registerCheckpointTools()
  return built
}

/** A registry built on a fake host, with the tool definitions it registers. */
function registry(): { readonly engineering: FreeCodeGoEngineeringRegistry; readonly tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = []
  const ctx = {
    on: vi.fn(),
    effect: vi.fn(),
    get: (name: string) => (name === 'tools' ? { register: (definition: RegisteredTool) => { tools.push(definition); return { dispose: () => undefined } } } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as Context
  const engineering = new FreeCodeGoEngineeringRegistry(ctx, undefined)
  // The install pass registers the tool families, and it also probes the
  // code-graph engines; the hunk family is registered separately and
  // unconditionally (see `registerHunkTools`), so calling it here is the seam
  // under test rather than a shortcut around it — reaching the same call through
  // `install()` would mean stubbing engine status to assert something else.
  ;(engineering as unknown as { registerHunkTools(): void }).registerHunkTools()
  return { engineering, tools }
}

const tool = (tools: readonly RegisteredTool[], name: string): RegisteredTool => {
  const found = tools.find(entry => entry.name === name)
  if (found === undefined) throw new Error(`expected ${name} to be registered`)
  return found
}

/**
 * An execution context whose session names no workspace.
 *
 * Deliberate: the resolvers fall back to the process's own directory, and leaving
 * the header empty keeps this file from naming a process global it would then have
 * to be trusted about.
 */
const exec = { agent: { session: { header: {} } } }

describe('the checkpoint tool family, with no engine installed', () => {
  it('registers all five, because none of them needs an engine', () => {
    // The defect this pins: these lived in the Graphify branch, so a user without
    // that engine had no checkpoint tools at all — while the registry happily
    // reported snapshots it had captured automatically.
    const { tools } = registryBoth()
    const names = tools.map(entry => entry.name)
    for (const name of ['engineering_checkpoint_capture', 'engineering_checkpoint_restore', 'engineering_checkpoint_diff', 'engineering_checkpoint_pin', 'engineering_checkpoint_list']) {
      expect(names).toContain(name)
    }
  })

  it('registers each one once, so the roster has no duplicate', () => {
    const { tools } = registryBoth()
    const names = tools.map(entry => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('registers both families through the real install pass', async () => {
    // The direct calls above prove the families *can* register without an engine;
    // this one proves the install pass actually calls them that way, which is the
    // half that was wrong. Only presence is asserted: which graph tools appear
    // depends on which engine artifacts this machine happens to have, and a test
    // that asserts absence there would pass or fail by where it runs. The code
    // path that used to lose these tools is pinned by the direct-call cases.
    const { engineering, tools } = registry()
    await (engineering as unknown as { registerTools(): Promise<void> }).registerTools()
    const names = tools.map(entry => entry.name)
    expect(names).toContain('engineering_checkpoint_capture')
    expect(names).toContain('engineering_hunks')
    expect(names).toContain('engineering_hunk_revert')
  })

  it('mounts them on the path taken when no engine is installed', async () => {
    // The regression itself, made independent of this machine: with both engines
    // reporting "not installed", engine selection resolves to none and the install
    // pass takes the repo-map-only branch. That branch is where these seven tools
    // used to disappear, so this is the case that fails if the calls move back
    // inside the Graphify branch.
    const { engineering, tools } = registry()
    const private_ = engineering as unknown as {
      graphify: { status: () => Promise<unknown> }
      codeGraph: { status: () => Promise<unknown> }
      registerTools(): Promise<void>
    }
    vi.spyOn(private_.graphify, 'status').mockResolvedValue({ installed: false })
    vi.spyOn(private_.codeGraph, 'status').mockResolvedValue({ installed: false })
    await private_.registerTools()
    const names = tools.map(entry => entry.name)
    expect(names).toContain('engineering_checkpoint_capture')
    expect(names).toContain('engineering_checkpoint_list')
    expect(names).toContain('engineering_hunks')
  })

  it('keeps the graph family out of the unconditional path', () => {
    // The other half of the same decision: what *does* need an engine stays behind
    // the engine check, so this cannot be "fixed" by making everything eager.
    const { tools } = registryBoth()
    expect(tools.map(entry => entry.name)).not.toContain('engineering_graph_status')
  })
})

describe('the hunk tool surface', () => {
  it('registers a list tool and a revert tool', () => {
    const { tools } = registryBoth()
    expect(tools.map(entry => entry.name)).toContain('engineering_hunks')
    expect(tools.map(entry => entry.name)).toContain('engineering_hunk_revert')
  })

  it('describes what each one answers, rather than only naming itself', () => {
    const { tools } = registry()
    for (const name of ['engineering_hunks', 'engineering_hunk_revert']) {
      const description = tool(tools, name).description ?? ''
      expect(description.length).toBeGreaterThan(60)
    }
  })

  it('bounds the list it will answer with, whatever the caller asks for', async () => {
    // The journal is bounded and this is a read of it; a caller asking for more
    // than the cap gets the cap, and the schema says so as well.
    const { tools } = registry()
    const parameters = tool(tools, 'engineering_hunks').parameters as { properties?: { limit?: { maximum?: number } } }
    expect(parameters.properties?.limit?.maximum).toBe(100)
    const answer = await tool(tools, 'engineering_hunks').execute({ limit: 5_000 }, exec)
    expect(answer).toMatchObject({ total: 0, shown: 0 })
    expect(Array.isArray((answer as { hunks?: unknown }).hunks)).toBe(true)
  })

  it('answers an empty journal instead of failing a turn over it', () => {
    const { tools } = registry()
    expect(tool(tools, 'engineering_hunks').execute({}, exec)).toMatchObject({ total: 0, hunks: [] })
  })

  it('refuses a revert that names nothing, and says how to name something', async () => {
    const { tools } = registry()
    const answer = await tool(tools, 'engineering_hunk_revert').execute({}, exec)
    expect(answer).toMatchObject({ ok: false, reason: 'missing-target' })
    expect((answer as { detail: string }).detail).toContain('hunk_id')
  })

  it('refuses a hunk id it never issued rather than writing anything', async () => {
    const { tools } = registry()
    expect(await tool(tools, 'engineering_hunk_revert').execute({ hunk_id: 'not-a-hunk' }, exec))
      .toMatchObject({ ok: false, reason: 'unknown-hunk', hunkId: 'not-a-hunk' })
  })

  it('refuses a call id with no file, because a call may have touched several', async () => {
    const { tools } = registry()
    expect(await tool(tools, 'engineering_hunk_revert').execute({ call_id: 'call-1' }, exec))
      .toMatchObject({ ok: false, reason: 'missing-target' })
  })
})

describe('the memory tools describe the gate they write behind', () => {
  // Both call `saveDraft`, which writes `trust: 'draft'`, and every Agent-facing
  // read resolves `['reviewed']` — `get`, `search`, and the session-start
  // `recall`. So a memory these tools write is invisible to every Agent until a
  // user reviews it, and the description is the half the model reads: it would
  // create a handoff, report it as delivered, and leave the next session with
  // nothing. Both descriptions stated the opposite — "made available to all
  // FreeCodeGo engines" and "automatically available to the next Agent working in
  // this project" — and a promise of automatic delivery is exactly what stops the
  // model from telling the user that review is the step standing in the way.
  it('names the review gate rather than promising automatic delivery', async () => {
    const { engineering, tools } = registry()
    const private_ = engineering as unknown as {
      memoryAvailable: boolean
      graphify: { status: () => Promise<unknown> }
      codeGraph: { status: () => Promise<unknown> }
      registerTools(): Promise<void>
    }
    vi.spyOn(private_.graphify, 'status').mockResolvedValue({ installed: false })
    vi.spyOn(private_.codeGraph, 'status').mockResolvedValue({ installed: false })
    // The memory family is registered only once the store has opened, which
    // `reconcile()` does against a real data home. Opening one here would make
    // this a test of the data home; the seam under test is the description, so
    // the flag the registration reads is set directly.
    private_.memoryAvailable = true
    await private_.registerTools()
    for (const name of ['engineering_memory_save', 'engineering_handoff_create']) {
      const description = tool(tools, name).description ?? ''
      expect(description).toMatch(/draft/)
      expect(description).toMatch(/review/)
      expect(description).not.toMatch(/automatically available|available to all/iu)
    }
  })
})

describe('the runtime-free repo map registers in both engine branches', () => {
  // The map is not an alternative to a graph engine: it is zero-dependency and
  // answers a question the graph tools do not, so the Graphify branch needs it as
  // much as the branch that has no engine. It used to be written out in both
  // places, verbatim — the two copies differed only in whether the cwd came from
  // `registerGraphTools`'s `cwdFor` or from the same expression inlined — which
  // meant a change to one copy would have made the same tool behave differently
  // depending on which engine happened to be installed. Neither branch was
  // asserted, so nothing would have said so: the tool is present either way, and
  // the difference only shows in what it does. This pins the pair.
  it('offers the same definition with an engine installed as without one', () => {
    const withEngine = registry()
    ;(withEngine.engineering as unknown as { registerGraphTools(): void }).registerGraphTools()
    const withoutEngine = registry()
    ;(withoutEngine.engineering as unknown as { registerRepoMapToolOnly(): void }).registerRepoMapToolOnly()

    const inEngineBranch = tool(withEngine.tools, 'engineering_repo_map')
    const inPlainBranch = tool(withoutEngine.tools, 'engineering_repo_map')
    expect(inEngineBranch.description).toBe(inPlainBranch.description)
    expect(inEngineBranch.parameters).toStrictEqual(inPlainBranch.parameters)
    // The Graphify family comes with it, so the branch really is the engine one
    // and the case is not passing because both helpers happened to be the same.
    expect(withEngine.tools.map(entry => entry.name)).toContain('engineering_graph_status')
  })
})
