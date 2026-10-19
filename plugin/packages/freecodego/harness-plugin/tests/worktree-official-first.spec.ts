/**
 * Worktrees: the official runtime first, the plugin's own creator second.
 *
 * 0.2.1 shipped `experimental/tool-worktree`: a `create_worktree` tool over a
 * `worktrees` service that creates the branch and the checkout *and moves the
 * calling session's working directory*. That last part is the whole reason this
 * order exists — `enter` cannot move a running session's cwd, so a copy the
 * official runtime makes is strictly better isolation than the plugin's own.
 *
 * Three claims are asserted here, because each one is a way the two create paths
 * could be wired together and still be wrong:
 *
 * 1. When the runtime is composed, `enter` delegates to it, adopts the result into
 *    this plugin's registry, and reports the copy the session was *moved into*.
 *    Without the adoption the copy would exist and be invisible: `status` would
 *    say the session holds nothing and `exit` would have nothing to release.
 * 2. When the runtime refuses, `enter` still returns an isolated copy and names
 *    the reason. A fallback nobody can see is indistinguishable from the official
 *    path having worked.
 * 3. `exit` removes a copy from the repository the entry records, not from the
 *    copy itself: git refuses to delete the directory it is running in (a
 *    permission error on Windows), and after the official move that directory *is*
 *    the session's cwd.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import type { WorktreeEntry } from '../src/worktree/registry.ts'
import {
  SessionWorktrees,
  worktreeToolDefinitions,
  type OfficialWorktreeCreation,
  type OfficialWorktreeRuntime,
  type SessionWorktreePorts,
  type WorktreeRegistryPort,
} from '../src/worktree/tools.ts'

const scratch = mkdtempSync(join(tmpdir(), 'worktree-official-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** An in-memory registry, so these tests are about the pairing, not the file. */
class MemoryRegistry implements WorktreeRegistryPort {
  readonly entries: WorktreeEntry[] = []
  async list(): Promise<readonly WorktreeEntry[]> {
    return [...this.entries]
  }
  async register(entry: WorktreeEntry): Promise<void> {
    const index = this.entries.findIndex(existing => existing.id === entry.id)
    if (index === -1) this.entries.push(entry)
    else this.entries[index] = entry
  }
}

/** A workspace to point the tools at. */
function workspace(name: string): string {
  const root = join(scratch, name)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1\n')
  return root
}

/** The plugin's own copy primitive: real files, so "created" means a directory. */
const realCreate: SessionWorktreePorts['create'] = async (input) => {
  const { copyTree } = await import('../src/worktree/fast.ts')
  const copied = await copyTree({ from: input.repoRoot, to: input.targetPath })
  return { strategy: 'fast', path: input.targetPath, files: 1, mechanism: copied.mechanism }
}

function ports(overrides: Partial<SessionWorktreePorts> = {}): SessionWorktreePorts {
  return {
    registry: new MemoryRegistry(),
    create: realCreate,
    remove: async (input) => { rmSync(input.path, { recursive: true, force: true }) },
    ...overrides,
  }
}

/** The tool surface over one workspace and one session. */
function surface(input: {
  readonly root: string
  readonly suite: SessionWorktrees
  readonly official?: OfficialWorktreeRuntime
  readonly repoRootOf?: (cwd: string) => Promise<string | undefined>
}): { readonly call: (name: string, args: unknown) => Promise<Record<string, unknown>>; readonly exec: unknown } {
  const definitions = worktreeToolDefinitions({
    sessions: () => input.suite,
    sessionOf: () => ({ id: 'session-1', cwd: input.root }),
    ...(input.official === undefined ? {} : { official: () => input.official }),
    ...(input.repoRootOf === undefined ? {} : { repoRootOf: input.repoRootOf }),
  })
  const exec = { agent: { session: { id: 'session-1', header: { cwd: input.root } } } }
  const call = async (name: string, args: unknown): Promise<Record<string, unknown>> =>
    await (definitions.find(definition => definition.name === name)!.execute as (a: unknown, e: unknown) => Promise<Record<string, unknown>>)(args, exec)
  return { call, exec }
}

/** An official runtime that answers with `created` and records what it was asked. */
function officialRuntime(created: OfficialWorktreeCreation): OfficialWorktreeRuntime & { readonly calls: { name?: string; from?: string }[] } {
  const calls: { name?: string; from?: string }[] = []
  return {
    calls,
    async create(_agent, input) {
      calls.push({ ...input })
      // The official runtime makes the directory and moves the session into it;
      // the directory is what `status` measures, so it has to exist here too.
      mkdirSync(created.path, { recursive: true })
      return created
    },
  }
}

describe('engineering_worktree_enter with the official runtime composed', () => {
  test('delegates to create_worktree, adopts its copy, and says the session moved', async () => {
    const root = workspace('official-delegates')
    const registry = new MemoryRegistry()
    const created: OfficialWorktreeCreation = {
      path: join(root, 'official', 'wt-one'),
      branch: 'dsh/wt-one',
      baseCommit: 'deadbeef',
      repositoryRoot: root,
    }
    const official = officialRuntime(created)
    let pluginCreated = false
    const suite = new SessionWorktrees(ports({
      registry,
      create: async (input) => {
        pluginCreated = true
        return await realCreate(input)
      },
    }))

    const { call } = surface({ root, suite, official })
    const entered = await call('engineering_worktree_enter', { ref: 'HEAD~1' })

    expect(official.calls).toEqual([{ from: 'HEAD~1' }])
    expect(pluginCreated).toBe(false)
    expect(entered.provider).toBe('official')
    expect(entered.path).toBe(created.path)
    expect(String(entered.isolation)).toContain('working directory into it')

    // Adopted, not merely reported: the registry is what `status`, `list` and
    // `exit` read, so the copy has to be in it.
    const held = await suite.held('session-1')
    expect(held?.path).toBe(created.path)
    expect(held?.branch).toBe(created.branch)
    expect(held?.repoRoot).toBe(root)

    const status = await call('engineering_worktree_status', {})
    expect(status.held).toBe(true)
    expect(status.path).toBe(created.path)
  })

  test('falls back to the plugin creator and names why', async () => {
    const root = workspace('official-falls-back')
    const official: OfficialWorktreeRuntime = {
      async create() {
        throw new Error('not a git repository')
      },
    }
    const suite = new SessionWorktrees(ports())
    const { call } = surface({ root, suite, official })

    const entered = await call('engineering_worktree_enter', {})
    expect(entered.provider).toBe('plugin')
    expect(String(entered.fallbackReason)).toContain('not a git repository')
    expect(String(entered.path)).toContain('.freecodego')
    expect(existsSync(String(entered.path))).toBe(true)
  })

  test('does not consult the official runtime for a copy without git', async () => {
    const root = workspace('official-skipped-fast')
    const official: OfficialWorktreeRuntime = {
      async create() {
        throw new Error('the official runtime was asked for a fast copy')
      },
    }
    const suite = new SessionWorktrees(ports())
    const { call } = surface({ root, suite, official })

    const entered = await call('engineering_worktree_enter', { strategy: 'fast' })
    expect(entered.provider).toBe('plugin')
    expect(entered.fallbackReason).toBeUndefined()
    expect(String(entered.branch)).toBe('null')
  })
})

describe('engineering_worktree_exit after the official move', () => {
  test('removes the copy from the repository the entry records', async () => {
    const root = workspace('exit-records-repo')
    const registry = new MemoryRegistry()
    const removals: { repoRoot: string; path: string }[] = []
    const suite = new SessionWorktrees(ports({
      registry,
      remove: async (input) => {
        removals.push({ repoRoot: input.repoRoot, path: input.path })
        rmSync(input.path, { recursive: true, force: true })
      },
    }))
    const created: OfficialWorktreeCreation = {
      path: join(root, 'official', 'wt-two'),
      branch: 'dsh/wt-two',
      baseCommit: 'cafe',
      repositoryRoot: root,
    }
    const { call } = surface({
      root,
      suite,
      official: officialRuntime(created),
      // After the official move the session's cwd *is* the copy, so a resolver
      // asked from the workspace would answer with the copy. That is exactly the
      // wrong root to run `git worktree remove` from.
      repoRootOf: async () => created.path,
    })

    await call('engineering_worktree_enter', {})
    const exited = await call('engineering_worktree_exit', { remove: true })

    expect(exited.removed).toBe(true)
    expect(removals).toEqual([{ repoRoot: root, path: created.path }])
    expect(existsSync(created.path)).toBe(false)
  })
})
