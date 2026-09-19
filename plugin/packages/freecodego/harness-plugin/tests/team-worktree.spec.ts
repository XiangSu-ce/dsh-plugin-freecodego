import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCKED_ISOLATION_FIELDS, TeamWorktrees, dirtyPaths, worktreeIsolation, type TeamWorktree } from '../src/team/worktree.ts'

const run = promisify(execFile)
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function repository(): Promise<{ cwd: string; worktrees: TeamWorktrees }> {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-team-worktree-'))
  directories.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  await git(cwd, ['init', '-b', 'main'])
  await git(cwd, ['config', 'user.email', 'team@example.test'])
  await git(cwd, ['config', 'user.name', 'Team'])
  // Windows checkouts rewrite line endings, so every file comparison below goes
  // through `read()` rather than comparing raw bytes.
  await writeFile(join(cwd, 'shared.txt'), 'base\n', 'utf8')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'base'])
  // The registry lives outside the workspace, exactly as the plugin places it:
  // plugin state must not become untracked noise in the user's repository.
  return { cwd, worktrees: new TeamWorktrees(cwd, join(root, 'state', 'worktrees.json')) }
}

async function read(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return result.stdout
}

describe('team worktrees', () => {
  it('recognises its own worktree through a different spelling of the same path', async () => {
    // The registry is durable, so an entry can carry the workspace root as another
    // session spelled it: a symlinked checkout, a trailing separator, or — on
    // Windows, and observed on this machine — the 8.3 short name `os.tmpdir()`
    // returns. Both spellings open the same directory, so the record and the
    // convention have not parted ways. Refusing here named the same location twice
    // and told the user to release a worktree that was already theirs.
    const { cwd, worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    const otherSpelling = `${allocated.path.replaceAll('\\', '/')}/`
    expect(otherSpelling).not.toBe(allocated.path)
    await worktrees.register({ ...allocated, path: otherSpelling })
    await expect(worktrees.allocate('member-1')).resolves.toBeDefined()
    // The guard is not weakened: a record that names a genuinely different
    // location still refuses, because that is the case it exists for.
    await worktrees.register({ ...allocated, path: join(cwd, 'elsewhere', 'member-1') })
    await expect(worktrees.allocate('member-1')).rejects.toThrow(/refusing to reuse/u)
  })

  it('reports a workspace that cannot isolate a writer instead of silently sharing it', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'freecodego-plain-'))
    directories.push(plain)
    const worktrees = new TeamWorktrees(plain, join(plain, 'worktrees.json'))
    const available = await worktrees.available()
    expect(available.ok).toBe(false)
    expect(available.reason).toContain('not a git work tree')
    await expect(worktrees.allocate('m1')).rejects.toThrow(/cannot isolate this writer/u)
  })

  it('gives a writer its own branch and directory', async () => {
    const { cwd, worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    expect(allocated.branch).toBe('freecodego/team/member-1')
    expect(existsSync(allocated.path)).toBe(true)
    expect(await git(allocated.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toContain('freecodego/team/member-1')
    // The isolation mechanism must not itself show up as untracked noise.
    expect(await git(cwd, ['status', '--porcelain'])).toEqual('')
    expect(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('.freecodego/worktrees/')
  })

  it('merges a member branch into the workspace and records it as merged', async () => {
    const { cwd, worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    await writeFile(join(allocated.path, 'feature.txt'), 'from member 1\n', 'utf8')
    await git(allocated.path, ['add', '.'])
    await git(allocated.path, ['commit', '-m', 'feature'])
    const outcome = await worktrees.integrate('member-1')
    expect(outcome.merged).toBe(true)
    expect(await read(join(cwd, 'feature.txt'))).toBe('from member 1\n')
    expect((await worktrees.list())[0]?.state).toBe('merged')
    // Merging twice is a no-op, not a second merge commit.
    const again = await worktrees.integrate('member-1')
    expect(again.detail).toBe('already merged')
  })

  it('serializes concurrent integrations of the same member branch', async () => {
    const { cwd, worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    await writeFile(join(allocated.path, 'feature.txt'), 'from member 1\n', 'utf8')
    await git(allocated.path, ['add', '.'])
    await git(allocated.path, ['commit', '-m', 'feature'])
    // Two merge tool calls can overlap during a parent retry. Both callers need
    // an idempotent result; issuing two git merges in parallel instead races on
    // the index and may report a failed merge after the first has already landed.
    const outcomes = await Promise.all([
      worktrees.integrate('member-1'),
      worktrees.integrate('member-1'),
    ])
    expect(outcomes.every(outcome => outcome.merged)).toBe(true)
    // base + member commit + exactly one merge commit.
    expect((await git(cwd, ['rev-list', '--count', 'main'])).trim()).toBe('3')
  })

  it('aborts a conflicting merge, reports the files, and leaves the workspace clean', async () => {
    const { cwd, worktrees } = await repository()
    const one = await worktrees.allocate('member-1')
    await writeFile(join(one.path, 'shared.txt'), 'member 1\n', 'utf8')
    await git(one.path, ['add', '.'])
    await git(one.path, ['commit', '-m', 'member 1 edit'])
    await writeFile(join(cwd, 'shared.txt'), 'workspace\n', 'utf8')
    await git(cwd, ['add', '.'])
    await git(cwd, ['commit', '-m', 'workspace edit'])
    const outcome = await worktrees.integrate('member-1')
    expect(outcome.merged).toBe(false)
    expect(outcome.conflicts).toEqual(['shared.txt'])
    // The point of isolation: one failed integration does not leave a tree
    // nobody can build, and the workspace keeps its own content.
    expect(await git(cwd, ['status', '--porcelain'])).toEqual('')
    expect(await read(join(cwd, 'shared.txt'))).toBe('workspace\n')
    expect((await worktrees.list())[0]?.state).toBe('active')
  })

  it('refuses a merge for a branch that no longer exists', async () => {
    const { cwd, worktrees } = await repository()
    await worktrees.allocate('member-1')
    // The worktree has to go first: git refuses to delete a branch that is still
    // checked out somewhere, which is itself a useful property of the isolation.
    await worktrees.release('member-1')
    await git(cwd, ['branch', '-D', 'freecodego/team/member-1'])
    const outcome = await worktrees.integrate('member-1')
    expect(outcome.merged).toBe(false)
    expect(outcome.detail).toContain('no longer exists')
  })

  it('keeps the branch when a worktree is released, and deletes it only once merged', async () => {
    const { cwd, worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    await writeFile(join(allocated.path, 'feature.txt'), 'work\n', 'utf8')
    await git(allocated.path, ['add', '.'])
    await git(allocated.path, ['commit', '-m', 'feature'])
    await worktrees.release('member-1', { deleteBranch: true })
    // Unmerged work survives a release: deleting it here would be the one step
    // in this module that can destroy work, and the member never asked for it.
    expect((await git(cwd, ['rev-parse', allocated.branch]).catch(() => '')).trim()).not.toBe('')
    expect(existsSync(allocated.path)).toBe(false)
    expect((await worktrees.list())[0]?.state).toBe('abandoned')
  })

  it('continues a released member branch instead of refusing to isolate the member again', async () => {
    const { worktrees } = await repository()
    const first = await worktrees.allocate('member-1')
    await writeFile(join(first.path, 'feature.txt'), 'half done\n', 'utf8')
    await git(first.path, ['add', '.'])
    await git(first.path, ['commit', '-m', 'half done'])
    await worktrees.release('member-1')
    // A release keeps the branch on purpose, so this member's next allocation
    // has to continue that branch: asking git to create it again fails outright
    // and leaves the member un-isolatable for the rest of the project, while
    // cutting a fresh branch would orphan the work still on the old one.
    const again = await worktrees.allocate('member-1')
    expect(existsSync(again.path)).toBe(true)
    expect(await git(again.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toContain('freecodego/team/member-1')
    expect(await read(join(again.path, 'feature.txt'))).toBe('half done\n')
    expect((await worktrees.list())[0]?.state).toBe('active')
  })

  it('refuses to hand one member the directory another member already owns', async () => {
    const { worktrees } = await repository()
    // Two member ids that sanitize to the same directory must collide loudly
    // rather than silently share one worktree.
    await worktrees.allocate('member/a')
    await expect(worktrees.allocate('membera')).rejects.toThrow(/worktree add failed/u)
  })

  it('masks a credential git quotes back in its own failure output', async () => {
    const { worktrees } = await repository()
    // Git prints the path it refused, and the path is derived from the member id,
    // so a member id shaped like a token puts one in git's output. `boundedTeamText`
    // collapsed and truncated that text but never masked it.
    const leaked = `ghp_${'A'.repeat(36)}`
    await worktrees.allocate(leaked)
    // A different member id that sanitizes to the same directory: the collision is
    // what makes git fail, and the failure is the boundary under test.
    const failure = await worktrees.allocate(`${leaked}/x`)
      .then(() => new Error('the collision was expected to be refused'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('worktree add failed')
    expect(failure.message).toContain('[redacted credential]')
    expect(failure.message).not.toContain(leaked)
  })

  it('refuses a worktree registry written for a different workspace', async () => {
    const first = await repository()
    await first.worktrees.allocate('member-1')
    const second = await repository()
    const shared = new TeamWorktrees(second.cwd, join(dirname(first.cwd), 'state', 'worktrees.json'))
    expect(await shared.list()).toEqual([])
  })
})

describe('team worktree safety rules', () => {
  it('refuses to isolate a writer while the workspace has uncommitted changes, and creates nothing', async () => {
    const { cwd, worktrees } = await repository()
    await writeFile(join(cwd, 'shared.txt'), 'scratch edit\n', 'utf8')
    await expect(worktrees.allocate('member-1')).rejects.toThrow(/uncommitted changes \(shared.txt\)/u)
    // The refusal has to leave the workspace exactly as it was: a half-made copy
    // would be reused by the next allocation, which is worse than no copy.
    expect(existsSync(join(cwd, '.freecodego', 'worktrees', 'member-1'))).toBe(false)
    expect(await worktrees.list()).toEqual([])
  })

  it('counts an untracked file as a reason to refuse, because a later merge can collide with it', async () => {
    const { cwd, worktrees } = await repository()
    await writeFile(join(cwd, 'notes.txt'), 'not added yet\n', 'utf8')
    await expect(worktrees.allocate('member-1')).rejects.toThrow(/notes.txt/u)
  })

  it('isolates anyway when the caller says the dirty workspace was understood', async () => {
    const { cwd, worktrees } = await repository()
    await writeFile(join(cwd, 'shared.txt'), 'scratch edit\n', 'utf8')
    const allocated = await worktrees.allocate('member-1', { allowDirtyWorkspace: true })
    expect(existsSync(allocated.path)).toBe(true)
    // The dirtiness stays out of the copy: the member branches from HEAD, so its
    // worktree holds committed state and the merge target is the only thing the
    // acknowledgment accepts as undefined.
    expect(await read(join(allocated.path, 'shared.txt'))).toBe('base\n')
  })

  it('hands back the compatible clean worktree it already made instead of failing', async () => {
    const { worktrees } = await repository()
    const first = await worktrees.allocate('member-1')
    // `git worktree add` refuses a path that is already checked out, so without
    // the reuse rule the writer that is *already* isolated is the one whose
    // allocation fails.
    const again = await worktrees.allocate('member-1')
    expect(again.path).toBe(first.path)
    expect(again.branch).toBe(first.branch)
    expect((await worktrees.list()).length).toBe(1)
  })

  it('hands back a copy holding uncommitted work instead of failing the restart', async () => {
    const { worktrees } = await repository()
    const first = await worktrees.allocate('member-1')
    await writeFile(join(first.path, 'feature.txt'), 'half-finished\n', 'utf8')
    // The dirty copy is the one that must come back: allocation used to require a
    // clean copy before handing it back, so a member with work in progress fell
    // through to `git worktree add` on a path git already has checked out, and
    // the member whose work mattered most was the one that could not restart.
    const again = await worktrees.allocate('member-1')
    expect(again.path).toBe(first.path)
    expect(again.branch).toBe(first.branch)
    expect(await read(join(again.path, 'feature.txt'))).toBe('half-finished\n')
  })

  it('makes concurrent allocation for one member idempotent', async () => {
    const { worktrees } = await repository()
    // A retry can overlap its original request before either one records the
    // worktree. Both calls must resolve to the one branch and directory, not
    // leave the retry to fail on a branch the first call just created.
    const [first, second] = await Promise.all([
      worktrees.allocate('member-1'),
      worktrees.allocate('member-1'),
    ])
    expect(second).toMatchObject({ id: first.id, path: first.path, branch: first.branch })
    expect(await worktrees.list()).toHaveLength(1)
  })

  it('keeps a worktree holding uncommitted changes, and names them', async () => {
    const { worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    await writeFile(join(allocated.path, 'feature.txt'), 'half-finished\n', 'utf8')
    const outcome = await worktrees.release('member-1')
    expect(outcome.removed).toBe(false)
    expect(outcome.preserved).toBe(true)
    expect(outcome.detail).toContain('feature.txt')
    // Preserved means preserved: the directory is still there, the file is
    // still in it, and the registration is still active so a later release
    // can be the one that decides.
    expect(existsSync(allocated.path)).toBe(true)
    expect(await read(join(allocated.path, 'feature.txt'))).toBe('half-finished\n')
    expect((await worktrees.list())[0]?.state).toBe('active')
  })

  it('discards it only when the loss of that work is acknowledged', async () => {
    const { worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    await writeFile(join(allocated.path, 'feature.txt'), 'half-finished\n', 'utf8')
    const outcome = await worktrees.release('member-1', { acknowledgeLostWorktree: true })
    expect(outcome.removed).toBe(true)
    expect(outcome.preserved).toBe(false)
    expect(existsSync(allocated.path)).toBe(false)
    expect((await worktrees.list())[0]?.state).toBe('abandoned')
  })

  it('refuses to reuse a registration whose branch no longer matches the member', async () => {
    const { worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    // A record and a naming convention that have parted ways must be named, not
    // guessed at: reusing the entry would hand the caller a copy under a branch
    // it did not ask for, and ignoring it would strand the copy still on disk.
    await worktrees.register({ ...allocated, branch: 'freecodego/team/elsewhere' })
    await expect(worktrees.allocate('member-1')).rejects.toThrow(/refusing to reuse it/u)
  })

  it('treats a worktree it cannot read as holding work, and keeps it', async () => {
    const { cwd, worktrees } = await repository()
    const plain = join(dirname(cwd), 'not-a-repository')
    await mkdir(plain, { recursive: true })
    await worktrees.register({ id: 'wt_plain', memberId: 'plain', branch: 'freecodego/team/plain', path: plain, base: '', createdAt: Date.now(), state: 'active' })
    const outcome = await worktrees.release('wt_plain')
    // Fail closed on the destructive side: "git could not say" is not "clean",
    // because the cost of being wrong is someone's only copy.
    expect(outcome.preserved).toBe(true)
    expect(outcome.detail).toContain('cannot be read as clean')
    expect(existsSync(plain)).toBe(true)
  })

  it('reports a directory that is already gone without claiming it removed one', async () => {
    const { worktrees } = await repository()
    const allocated = await worktrees.allocate('member-1')
    await rm(allocated.path, { recursive: true, force: true })
    const outcome = await worktrees.release('member-1')
    expect(outcome.removed).toBe(false)
    expect(outcome.preserved).toBe(false)
    expect(outcome.detail).toContain('already gone')
    expect((await worktrees.list())[0]?.state).toBe('abandoned')
  })

  it('keeps the registration active when the removal itself fails', async () => {
    const { cwd, worktrees } = await repository()
    // A clean repository that is not a worktree of this one: `git status` answers
    // cleanly, so the removal is attempted, and `git worktree remove` refuses it.
    const foreign = join(dirname(cwd), 'foreign-repo')
    await mkdir(foreign, { recursive: true })
    await git(foreign, ['init', '-b', 'main'])
    await git(foreign, ['config', 'user.email', 'foreign@example.test'])
    await git(foreign, ['config', 'user.name', 'Foreign'])
    await writeFile(join(foreign, 'a.txt'), 'x\n', 'utf8')
    await git(foreign, ['add', '.'])
    await git(foreign, ['commit', '-m', 'base'])
    await worktrees.register({ id: 'wt_foreign', memberId: 'foreign', branch: 'freecodego/team/foreign', path: foreign, base: '', createdAt: Date.now(), state: 'active' })
    const outcome = await worktrees.release('wt_foreign')
    // Marking an entry abandoned while its directory is still there is how a
    // worktree becomes invisible: nothing lists it as live, and no later cleanup
    // is told it exists.
    expect(outcome.removed).toBe(false)
    expect(outcome.preserved).toBe(true)
    expect(outcome.detail).toContain('`git worktree remove` failed')
    expect(existsSync(foreign)).toBe(true)
    expect((await worktrees.list()).find(entry => entry.id === 'wt_foreign')?.state).toBe('active')
  })

  it('reports that nothing was released for an id it does not know', async () => {
    const { worktrees } = await repository()
    const outcome = await worktrees.release('nobody')
    expect(outcome).toMatchObject({ removed: false, preserved: false })
    expect(outcome.detail).toContain('No worktree is registered')
  })
})

describe('worktree change detection', () => {
  it('reads paths out of porcelain status, codes removed and renames kept whole', () => {
    expect(dirtyPaths(' M shared.txt\n')).toEqual(['shared.txt'])
    expect(dirtyPaths('?? notes.txt\n')).toEqual(['notes.txt'])
    expect(dirtyPaths('MM src/a.ts\nA  added.txt\n')).toEqual(['src/a.ts', 'added.txt'])
    // The arrow is the only place the discarded name appears, and a report that
    // names one side of a rename sends the reader to a path that is gone.
    expect(dirtyPaths('R  old.txt -> new.txt\n')).toEqual(['old.txt -> new.txt'])
    expect(dirtyPaths('')).toEqual([])
    expect(dirtyPaths('\n  \n')).toEqual([])
  })

  it('bounds the list it reports', () => {
    const many = Array.from({ length: 50 }, (_value, index) => ` M file-${String(index)}.txt`).join('\n')
    expect(dirtyPaths(many).length).toBe(20)
  })
})

describe('locked isolation field set', () => {
  const entry: TeamWorktree = { id: 'wt_x', memberId: 'x', branch: 'freecodego/team/x', path: '/repo/.freecodego/worktrees/x', base: 'abc', createdAt: 1, state: 'active' }

  it('is exactly the fields the report carries, so a new one cannot go unreported', () => {
    expect([...LOCKED_ISOLATION_FIELDS]).toEqual([
      'workspaceMode', 'worktreeMode', 'teamStateRoot', 'workingDir',
      'worktreeRepoRoot', 'worktreePath', 'worktreeBranch', 'worktreeDetached',
      'worktreeCreated', 'worktreeState',
    ])
    const reported = Object.keys(worktreeIsolation(entry, { teamStateRoot: '/state', repoRoot: '/repo' })).sort()
    expect(reported).toEqual([...LOCKED_ISOLATION_FIELDS].sort())
  })

  it('names the copy rather than leaving it to be inferred from a directory name', () => {
    expect(worktreeIsolation(entry, { teamStateRoot: '/state', repoRoot: '/repo' })).toEqual({
      workspaceMode: 'worktree',
      worktreeMode: 'git',
      teamStateRoot: '/state',
      workingDir: entry.path,
      worktreeRepoRoot: '/repo',
      worktreePath: entry.path,
      worktreeBranch: entry.branch,
      worktreeDetached: false,
      worktreeCreated: 1,
      worktreeState: 'active',
    })
  })

  it('makes the no-branch case explicit instead of reporting an empty branch', () => {
    const copy = worktreeIsolation({ ...entry, branch: '', strategy: 'fast' }, { teamStateRoot: '/state', repoRoot: '/repo' })
    expect(copy.worktreeBranch).toBeNull()
    expect(copy.worktreeDetached).toBe(true)
    expect(copy.worktreeMode).toBe('fast')
  })
})
