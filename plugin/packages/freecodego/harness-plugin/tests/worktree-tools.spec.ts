/**
 * Session worktrees: the operations, and the two claims that matter most.
 *
 * 1. `enter` followed by `exit` leaves nothing behind that nobody can find. The
 *    registry is what makes a copy findable, so every path here asserts the
 *    registry and the directory agree — a registered copy that is gone, or a
 *    copy on disk that no entry names, is the orphan this whole module is
 *    arranged to avoid.
 * 2. The result says what the caller actually got. The Harness fixes a session's
 *    cwd at creation, so `enter` must report the copy's path *and* say the
 *    conversation was not moved into it. That sentence is the difference between
 *    isolation and the illusion of it.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { TeamWorktrees, WORKTREE_RELATIVE_DIRECTORY } from '../src/team/worktree.ts'
import { realCreatorDeps } from '../src/worktree/creator.ts'
import {
  SessionWorktrees,
  isolationNote,
  sessionWorktreePlan,
  sessionWorktreeSlug,
  worktreeToolDefinitions,
  worktreeOwner,
  type SessionWorktreePorts,
  type WorktreeRegistry,
} from '../src/worktree/tools.ts'

const run = promisify(execFile)

const scratch = mkdtempSync(join(tmpdir(), 'worktree-tools-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** An in-memory registry, so these tests are about the operations, not the file. */
class MemoryRegistry implements WorktreeRegistry {
  readonly entries: import('../src/team/worktree.ts').TeamWorktree[] = []
  async list(): Promise<readonly import('../src/team/worktree.ts').TeamWorktree[]> {
    return [...this.entries]
  }
  async register(entry: import('../src/team/worktree.ts').TeamWorktree): Promise<void> {
    const index = this.entries.findIndex(existing => existing.id === entry.id)
    if (index === -1) this.entries.push(entry)
    else this.entries[index] = entry
  }
}

/** A workspace directory that the tests create real copies in. */
function workspace(name: string): string {
  const root = join(scratch, name)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), `export const ${name.replaceAll('-', '_')} = 1\n`)
  return root
}

/** The real copy primitive, so "created" means a directory with files in it. */
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

describe('the derived names', () => {
  test('a session id becomes one path, branch and entry id', () => {
    const plan = sessionWorktreePlan({ workspaceRoot: '/w', sessionId: 'sess-1' })
    expect(plan.slug.startsWith('sess-1-')).toBe(true)
    expect(plan.id).toBe(`wt_${plan.slug}`)
    expect(plan.branch).toBe(`freecodego/session/${plan.slug}`)
    expect(plan.path).toBe(join('/w', WORKTREE_RELATIVE_DIRECTORY, plan.slug))
  })

  test('two ids that sanitize to the same name get different directories', () => {
    // The collision the team allocator's comment names: both sanitize to `ab`.
    expect(sessionWorktreeSlug('a/b')).not.toBe(sessionWorktreeSlug('a\\b'))
    expect(sessionWorktreeSlug('a/b').startsWith('ab-')).toBe(true)
  })

  test('a pathological id still yields a usable path segment', () => {
    const slug = sessionWorktreeSlug('../..')
    expect(slug).not.toContain('..')
    expect(slug).not.toContain('/')
    expect(slug.length).toBeGreaterThan(0)
  })

  test('the owner is recovered from the member id, and a member is not a session', () => {
    expect(worktreeOwner('session:abc')).toEqual({ kind: 'session', sessionId: 'abc' })
    expect(worktreeOwner('alice')).toEqual({ kind: 'member' })
  })
})

describe('enter', () => {
  test('creates a copy, registers it, and says the cwd did not move', async () => {
    const root = workspace('enter-basic')
    const suite = new SessionWorktrees(ports())
    const outcome = await suite.enter({ workspaceRoot: root, sessionId: 's1' })

    expect(outcome.reused).toBe(false)
    expect(outcome.worktree.path).toBe(join(root, WORKTREE_RELATIVE_DIRECTORY, sessionWorktreeSlug('s1')))
    expect(existsSync(join(outcome.worktree.path, 'src', 'index.ts'))).toBe(true)
    expect(outcome.worktree.memberId).toBe('session:s1')
    expect(outcome.worktree.state).toBe('active')
    // The claim that keeps this feature honest.
    expect(outcome.isolation).toContain(outcome.worktree.path)
    expect(outcome.isolation).toContain('still resolve against its original workspace')
    expect(outcome.isolation).toContain('for real')
  })

  test('re-entering returns what the session holds instead of orphaning it', async () => {
    const root = workspace('enter-reentry')
    const suite = new SessionWorktrees(ports())
    const first = await suite.enter({ workspaceRoot: root, sessionId: 's2' })
    const second = await suite.enter({ workspaceRoot: root, sessionId: 's2' })
    expect(second.reused).toBe(true)
    expect(second.worktree.path).toBe(first.worktree.path)
    expect(second.isolation).toContain('already held')
    expect((await suite.list()).length).toBe(1)
  })

  test('a registered copy that has been deleted is replaced, not reused', async () => {
    // "Held" has to mean the copy is there, or every later call reports isolation
    // against a directory that does not exist.
    const root = workspace('enter-missing')
    const suite = new SessionWorktrees(ports())
    const first = await suite.enter({ workspaceRoot: root, sessionId: 's3' })
    rmSync(first.worktree.path, { recursive: true, force: true })
    const second = await suite.enter({ workspaceRoot: root, sessionId: 's3' })
    expect(second.reused).toBe(false)
    expect(existsSync(second.worktree.path)).toBe(true)
  })

  test('a failed creation leaves no directory and no entry', async () => {
    const root = workspace('enter-failure')
    const registry = new MemoryRegistry()
    const suite = new SessionWorktrees(ports({
      registry,
      create: async (input) => {
        // A half-made copy: the failure mode that is worse than no copy, because
        // the next `enter` would reuse it.
        mkdirSync(join(input.targetPath, 'partial'), { recursive: true })
        throw new Error('the disk filled up')
      },
    }))
    await expect(suite.enter({ workspaceRoot: root, sessionId: 's4' })).rejects.toThrow('the disk filled up')
    expect(registry.entries).toHaveLength(0)
    // The parent directory is allowed to exist — it is the shared home of every
    // worktree and creating it is not a half-made copy. What must not survive is
    // a copy at the path the next `enter` would reuse.
    expect(existsSync(join(root, WORKTREE_RELATIVE_DIRECTORY, sessionWorktreeSlug('s4')))).toBe(false)
  })

  test('a fast copy records no branch, because there is none', async () => {
    // Recording the intended name would make a later merge offer to merge a
    // branch that does not exist.
    const root = workspace('enter-fast')
    const suite = new SessionWorktrees(ports())
    const outcome = await suite.enter({ workspaceRoot: root, sessionId: 's5', requested: 'fast' })
    expect(outcome.strategy).toBe('fast')
    expect(outcome.worktree.branch).toBe('')
    expect(outcome.worktree.strategy).toBe('fast')
  })

  test('the exclude hook is best-effort and its failure loses only the note', async () => {
    const root = workspace('enter-exclude-failure')
    const suite = new SessionWorktrees(ports({
      exclude: async () => { throw new Error('read-only git directory') },
    }))
    const outcome = await suite.enter({ workspaceRoot: root, sessionId: 's6' })
    expect(existsSync(outcome.worktree.path)).toBe(true)
  })

  test('two sessions in one workspace get different copies; two workspaces do not share a registry', async () => {
    const left = workspace('two-left')
    const right = workspace('two-right')
    const one = new SessionWorktrees(ports())
    const two = new SessionWorktrees(ports())
    const a = await one.enter({ workspaceRoot: left, sessionId: 'shared-id' })
    const b = await two.enter({ workspaceRoot: right, sessionId: 'shared-id' })
    expect(a.worktree.path).not.toBe(b.worktree.path)
    expect((await one.list()).length).toBe(1)
    expect((await two.list()).length).toBe(1)
  })
})

describe('exit', () => {
  test('keeps the copy and the branch by default, and says so', async () => {
    const root = workspace('exit-keep')
    const suite = new SessionWorktrees(ports())
    const entered = await suite.enter({ workspaceRoot: root, sessionId: 'x1' })
    const outcome = await suite.exit({ sessionId: 'x1' })
    expect(outcome.removed).toBe(false)
    expect(existsSync(entered.worktree.path)).toBe(true)
    expect(outcome.detail).toContain('for review')
    expect(outcome.worktree?.state).toBe('abandoned')
    // Not held any more, so a later enter makes a fresh copy.
    expect(await suite.held('x1')).toBeUndefined()
  })

  test('remove: true discards the copy and records it as abandoned', async () => {
    const root = workspace('exit-remove')
    const suite = new SessionWorktrees(ports())
    const entered = await suite.enter({ workspaceRoot: root, sessionId: 'x2' })
    const outcome = await suite.exit({ sessionId: 'x2', remove: true })
    expect(outcome.removed).toBe(true)
    expect(existsSync(entered.worktree.path)).toBe(false)
    expect((await suite.status({ sessionId: 'x2', workspaceRoot: root }))?.worktree.state).toBe('abandoned')
  })

  test('a failed removal keeps the entry active, so a later exit can retry', async () => {
    // Marking it released while the directory survives is how a worktree becomes
    // invisible and unremovable.
    const root = workspace('exit-failure')
    const suite = new SessionWorktrees(ports({
      remove: async () => { throw new Error('the copy is busy') },
    }))
    await suite.enter({ workspaceRoot: root, sessionId: 'x3' })
    const outcome = await suite.exit({ sessionId: 'x3', remove: true })
    expect(outcome.removed).toBe(false)
    expect(outcome.detail).toContain('still registered')
    expect((await suite.held('x3'))?.state).toBe('active')
  })

  test('a removal port that returns without removing anything is not a removal', async () => {
    // The git port reports `git worktree remove` failures in a result instead of
    // throwing, so a refused removal reached this operation looking successful
    // and the copy was marked released while it was still on disk. The result has
    // to be about the directory, not about the port's willingness to report.
    const root = workspace('exit-silent-failure')
    const suite = new SessionWorktrees(ports({
      remove: async () => undefined,
    }))
    const entered = await suite.enter({ workspaceRoot: root, sessionId: 'x4' })
    const outcome = await suite.exit({ sessionId: 'x4', remove: true })
    expect(existsSync(entered.worktree.path)).toBe(true)
    expect(outcome.removed).toBe(false)
    expect(outcome.detail).toContain('still on disk')
    expect((await suite.held('x4'))?.state).toBe('active')
  })

  test('exiting without holding anything is a no-op with a sentence, not an error', async () => {
    const suite = new SessionWorktrees(ports())
    const outcome = await suite.exit({ sessionId: 'never-entered' })
    expect(outcome.removed).toBe(false)
    expect(outcome.detail).toContain('holds no worktree')
  })
})

describe('status and list', () => {
  test('status measures the copy rather than describing it', async () => {
    const root = workspace('status-bytes')
    const suite = new SessionWorktrees(ports())
    await suite.enter({ workspaceRoot: root, sessionId: 'st1' })
    const row = await suite.status({ sessionId: 'st1', workspaceRoot: root })
    expect(row?.exists).toBe(true)
    expect(row?.bytes).toBeGreaterThan(0)
  })

  test('status reports a missing directory as missing, with no size', async () => {
    // A size for a directory that is gone would read as an empty copy.
    const root = workspace('status-missing')
    const suite = new SessionWorktrees(ports())
    const entered = await suite.enter({ workspaceRoot: root, sessionId: 'st2' })
    rmSync(entered.worktree.path, { recursive: true, force: true })
    const row = await suite.status({ sessionId: 'st2', workspaceRoot: root })
    expect(row?.exists).toBe(false)
    expect(row?.bytes).toBeUndefined()
  })

  test('status of a session that never entered is undefined rather than empty', async () => {
    const suite = new SessionWorktrees(ports())
    expect(await suite.status({ sessionId: 'nobody', workspaceRoot: scratch })).toBeUndefined()
  })

  test('list names the owner of each entry, team and session alike', async () => {
    const root = workspace('list-owners')
    const registry = new MemoryRegistry()
    await registry.register({ id: 'wt_alice', memberId: 'alice', branch: 'freecodego/team/alice', path: join(root, 'nope'), base: '', createdAt: 1, state: 'active' })
    const suite = new SessionWorktrees(ports({ registry }))
    await suite.enter({ workspaceRoot: root, sessionId: 'ls1' })
    const rows = await suite.list()
    expect(rows.map(row => row.owner).sort()).toEqual(['member', 'session'])
    const session = rows.find(row => row.owner === 'session')
    expect(session?.sessionId).toBe('ls1')
    expect(session?.bytes).toBeGreaterThan(0)
    // A registered path that is gone is reported, not hidden.
    expect(rows.find(row => row.owner === 'member')?.exists).toBe(false)
  })
})

describe('the tools', () => {
  const root = workspace('tool-defs')
  const registry = new MemoryRegistry()
  const suite = new SessionWorktrees(ports({ registry }))
  const definitions = worktreeToolDefinitions({
    sessions: () => suite,
    sessionOf: exec => (exec as { readonly agent?: { readonly session?: { readonly id?: string; readonly header?: { readonly cwd?: string } } } })?.agent?.session?.id === undefined
      ? undefined
      : { id: String((exec as { agent: { session: { id: string; header: { cwd: string } } } }).agent.session.id), cwd: root },
  })

  // One session id for every call in this block: the point of the test is the
  // handoff between the tools, and keying each call to its own tool name would
  // test four sessions instead of one conversation.
  const EXEC = { agent: { session: { id: 'tool-surface', header: { cwd: root } } } }
  const call = async (name: string, args: unknown, exec: unknown = EXEC): Promise<Record<string, unknown>> =>
    await (definitions.find(definition => definition.name === name)!.execute as (a: unknown, e: unknown) => Promise<Record<string, unknown>>)(args, exec)

  test('all four are registered, and each says what it does to the workspace', () => {
    expect(definitions.map(definition => definition.name)).toEqual([
      'engineering_worktree_enter',
      'engineering_worktree_exit',
      'engineering_worktree_status',
      'engineering_worktree_list',
    ])
    // The enter description is the one place a model learns that its cwd did not
    // move, so it is asserted rather than left to review.
    expect(String(definitions[0]!.description)).toContain('working directory is fixed by the Harness')
  })

  test('enter then status then exit, through the tool surface', async () => {
    const entered = await call('engineering_worktree_enter', { strategy: 'fast' })
    expect(entered.reused).toBe(false)
    expect(String(entered.branch)).toBe('null')
    expect(String(entered.isolation)).toContain('working copy')

    const status = await call('engineering_worktree_status', {})
    expect(status.held).toBe(true)
    expect(status.path).toBe(entered.path)

    const exited = await call('engineering_worktree_exit', {})
    expect(exited.removed).toBe(false)

    const after = await call('engineering_worktree_status', {})
    expect(after.held).toBe(false)
  })

  test('list counts bytes and names missing copies', async () => {
    const listed = await call('engineering_worktree_list', {})
    expect(listed.count).toBeGreaterThan(0)
    expect(Array.isArray(listed.missing)).toBe(true)
  })

  test('a call with no agent behind it is refused with the reason instead of guessing a session', async () => {
    const result = await call('engineering_worktree_status', {}, {})
    expect(String(result.error)).toContain('no agent behind it')
  })
})

describe('the shared registry (real git)', () => {
  const repo = join(scratch, 'shared-repo')
  let gitWorks = false

  beforeAll(async () => {
    try {
      await run('git', ['--version'])
    } catch {
      return
    }
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'main.ts'), 'export const main = 1\n')
    await run('git', ['init', '--initial-branch=main'], { cwd: repo })
    await run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.'], { cwd: repo })
    await run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'init'], { cwd: repo })
    gitWorks = true
  }, 60_000)

  test('a session worktree the team registry records is one the team can see', async () => {
    if (!gitWorks) {
      console.warn('[worktree-tools] git is unavailable; the shared-registry check did not run')
      return
    }
    const registry = new TeamWorktrees(repo, join(repo, '.freecodego', 'worktrees.json'))
    const runGit = async (args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
      try {
        const result = await run('git', [...args], { cwd: repo })
        return { code: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string }
        return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) }
      }
    }
    const suite = new SessionWorktrees({
      registry,
      create: async input => await (await import('../src/worktree/creator.ts')).createWorktree(
        { repoRoot: input.repoRoot, targetPath: input.targetPath, requested: input.requested, branch: input.branch, gitAvailable: true },
        realCreatorDeps(args => runGit(['-C', input.repoRoot, ...args])),
      ),
      remove: async (input) => {
        await runGit(['-C', input.repoRoot, 'worktree', 'remove', '--force', input.path])
        await runGit(['-C', input.repoRoot, 'worktree', 'prune'])
      },
      exclude: async () => registry.excludeWorktreeDirectory(),
      head: async () => (await runGit(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim() || undefined,
    })
    const head = (await runGit(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()

    const entered = await suite.enter({ workspaceRoot: repo, sessionId: 'git-session' })
    // No fallback: this repository is real and git is on PATH, so a `fast`
    // strategy here would mean the git path failed for an unstated reason.
    expect(entered.fallbackReason).toBeUndefined()
    expect(entered.strategy).toBe('git')
    expect(entered.worktree.branch).toBe(`freecodego/session/${sessionWorktreeSlug('git-session')}`)
    expect(entered.worktree.base).toBe(head)
    // One registry: the entry the session wrote is the entry the team reads.
    const asTeamSees = await registry.list()
    expect(asTeamSees.map(entry => entry.id)).toContain(entered.worktree.id)

    // Invariant 1: the worktree directory never shows up as untracked noise.
    const status = await runGit(['-C', repo, 'status', '--porcelain'])
    expect(status.stdout).not.toContain('.freecodego/worktrees')

    // And it is a real worktree that git itself knows about. Compared with
    // forward slashes because git reports Windows paths that way, and resolved
    // because spelling is not the subject here: `os.tmpdir()` can hand back the
    // Windows 8.3 short form (`C:/Users/ADMINI~1/AppData/Local/Temp`) while git
    // answers in the long one, so a raw comparison would fail on a machine whose
    // temp directory happens to be spelled short. `node:fs/promises`'s
    // `realpath` folds that form; note that `realpathSync` from `node:fs`
    // deliberately does not, so the two are not interchangeable here.
    const branched = await runGit(['-C', repo, 'worktree', 'list'])
    expect(branched.stdout).toContain((await realpath(entered.worktree.path)).replaceAll('\\', '/'))

    const exited = await suite.exit({ sessionId: 'git-session', remove: true, repoRoot: repo })
    expect(exited.removed).toBe(true)
    expect(existsSync(entered.worktree.path)).toBe(false)
    // The branch survives a removal, because deleting it is the step that can
    // destroy work.
    const stillBranched = await runGit(['-C', repo, 'rev-parse', '--verify', '--quiet', entered.worktree.branch])
    expect(stillBranched.code).toBe(0)
    // And the exclude line is really in the git directory.
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.freecodego/worktrees/')
  }, 120_000)
})

describe('the isolation note', () => {
  test('never claims the conversation moved', () => {
    const note = isolationNote('/tmp/copy', false)
    expect(note).toContain('still resolve against its original workspace')
    expect(note).not.toContain('your working directory is now')
  })
})
