/**
 * Re-entering a working copy a session already has.
 *
 * `exit` keeps the copy by default — "the reviewer's next question is what did it
 * change, and removing the tree answers that by destroying the evidence" — and
 * `enter`'s own description promises that "re-entering returns the copy the
 * session already holds". Those two promises meet in one state the module had no
 * path for: an entry that is no longer `active` while its directory is still
 * there, which is exactly what the default `exit` leaves behind.
 *
 * Entering again in that state walked straight into `create` with an occupied
 * target path. Both real strategies fail there, and they fail in the two ways
 * that destroy the thing being reviewed:
 *
 * - the git strategy runs `git worktree add -b <same branch> <same path>` for a
 *   branch and a path that still exist, so git refuses (verified against a real
 *   repository: `fatal: a branch named '<branch>' already exists`);
 * - the fallback copy is then handed the occupied directory. Over a fast copy it
 *   merges the source tree back over the session's edits, and over a git worktree
 *   it throws (`EEXIST: mkdir '<path>\\.git'`, because a worktree's `.git` is a
 *   file) — and that throw is what reaches `enter`'s cleanup, which deletes the
 *   directory it was told a failed creation had half-made.
 *
 * The fix is the same decision the team allocator already makes for its own
 * members — "Existence is the whole test" — read one step wider: a copy this
 * session left in place is still this session's copy.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { createWorktree, type WorktreeCreation } from '../src/worktree/creator.ts'
import { WORKTREE_RELATIVE_DIRECTORY, type WorktreeEntry } from '../src/worktree/registry.ts'
import {
  SessionWorktrees,
  sessionWorktreePlan,
  type SessionWorktreePorts,
  type WorktreeRegistryPort,
} from '../src/worktree/tools.ts'

const scratch = mkdtempSync(join(tmpdir(), 'worktree-reenter-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** An in-memory registry, like the sibling spec's: these tests are about the operations. */
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

/** A workspace directory, created on demand so each test owns its own. */
function workspace(name: string): string {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'tracked.txt'), 'from the workspace\n')
  return root
}

/** How many times a copy was produced, and where. */
interface CreateCalls {
  count: number
  paths: string[]
}

/** A copy that reports what it did, so a second creation is visible as a second call. */
function recordingCreate(calls: CreateCalls, strategy: 'git' | 'fast' = 'git'): SessionWorktreePorts['create'] {
  return async (input): Promise<WorktreeCreation> => {
    calls.count += 1
    calls.paths.push(input.targetPath)
    mkdirSync(input.targetPath, { recursive: true })
    writeFileSync(join(input.targetPath, 'session-work.txt'), 'written by the session\n')
    return { strategy, path: input.targetPath, files: 1 }
  }
}

function ports(create: SessionWorktreePorts['create'], registry = new MemoryRegistry()): SessionWorktreePorts {
  return {
    registry,
    create,
    remove: async (input) => { rmSync(input.path, { recursive: true, force: true }) },
  }
}

describe('re-entering after a kept exit', () => {
  test('walks back into the copy instead of making a second one over it', async () => {
    const calls: CreateCalls = { count: 0, paths: [] }
    const registry = new MemoryRegistry()
    const sessions = new SessionWorktrees(ports(recordingCreate(calls), registry))
    const root = workspace('reuse')

    const first = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-1' })
    expect(first.reused).toBe(false)
    const kept = join(first.worktree.path, 'session-work.txt')
    expect(existsSync(kept)).toBe(true)

    // The default exit: the copy and its branch stay for review.
    const exited = await sessions.exit({ sessionId: 'sess-1' })
    expect(exited.removed).toBe(false)
    expect(registry.entries[0]?.state).toBe('abandoned')
    expect(existsSync(first.worktree.path)).toBe(true)

    const again = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-1' })
    expect(again.reused).toBe(true)
    expect(again.worktree.path).toBe(first.worktree.path)
    // The whole point: one directory, one copy, one creation.
    expect(calls.count).toBe(1)
    expect(existsSync(kept)).toBe(true)
    expect(readFileSync(kept, 'utf8')).toBe('written by the session\n')
    // And it is live again rather than an entry nothing names as held.
    expect(await sessions.held('sess-1')).toMatchObject({ path: first.worktree.path, state: 'active' })
    expect(registry.entries).toHaveLength(1)
  })

  test('reports the strategy the copy was actually made with', async () => {
    const calls: CreateCalls = { count: 0, paths: [] }
    const sessions = new SessionWorktrees(ports(recordingCreate(calls, 'fast')))
    const root = workspace('reuse-fast')

    const first = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-fast' })
    expect(first.worktree.branch).toBe('')
    await sessions.exit({ sessionId: 'sess-fast' })

    const again = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-fast' })
    expect(again.strategy).toBe('fast')
    expect(again.worktree.branch).toBe('')
    expect(calls.count).toBe(1)
  })

  test('still creates a fresh copy when remove: true really discarded the old one', async () => {
    const calls: CreateCalls = { count: 0, paths: [] }
    const sessions = new SessionWorktrees(ports(recordingCreate(calls)))
    const root = workspace('discarded')

    const first = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-2' })
    const discarded = await sessions.exit({ sessionId: 'sess-2', remove: true })
    expect(discarded.removed).toBe(true)
    expect(existsSync(first.worktree.path)).toBe(false)

    const again = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-2' })
    expect(again.reused).toBe(false)
    expect(calls.count).toBe(2)
    expect(existsSync(again.worktree.path)).toBe(true)
  })

  test('still replaces a copy whose directory is gone', async () => {
    const calls: CreateCalls = { count: 0, paths: [] }
    const sessions = new SessionWorktrees(ports(recordingCreate(calls)))
    const root = workspace('vanished')

    const first = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-3' })
    await sessions.exit({ sessionId: 'sess-3' })
    rmSync(first.worktree.path, { recursive: true, force: true })

    const again = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-3' })
    expect(again.reused).toBe(false)
    expect(calls.count).toBe(2)
  })

  test('another session is not given the copy this one kept', async () => {
    const calls: CreateCalls = { count: 0, paths: [] }
    const sessions = new SessionWorktrees(ports(recordingCreate(calls)))
    const root = workspace('two-sessions')

    const mine = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-mine' })
    await sessions.exit({ sessionId: 'sess-mine' })

    const theirs = await sessions.enter({ workspaceRoot: root, sessionId: 'sess-theirs' })
    expect(theirs.worktree.path).not.toBe(mine.worktree.path)
    expect(calls.count).toBe(2)
    expect(sessionWorktreePlan({ workspaceRoot: root, sessionId: 'sess-theirs' }).path).toBe(theirs.worktree.path)
  })
})

describe('the creator refuses a target that is already a working copy', () => {
  test('reports the occupied path instead of copying the source over it', async () => {
    const root = workspace('occupied-source')
    const target = join(root, WORKTREE_RELATIVE_DIRECTORY, 'taken')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'tracked.txt'), 'the session edited this\n')

    const creation = createWorktree({
      repoRoot: root,
      targetPath: target,
      requested: 'auto',
      gitAvailable: true,
      branch: 'freecodego/session/taken',
    }, {
      // The real failure for a branch and a path that still exist.
      runGit: async () => ({ code: 128, stdout: '', stderr: "fatal: a branch named 'freecodego/session/taken' already exists" }),
      // The refusal lands before any copy; a fake that answered instead would hide
      // the copy this case exists to prove never runs.
      copyTree: async () => { throw new Error('copy must not run for a refused worktree') },
      fingerprint: async () => [],
    })

    await expect(creation).rejects.toThrow(/already contains files/)
    // The reason this is a refusal rather than a fallback: the copy would have
    // written the source tree over the session's edit, and nothing would say so.
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('the session edited this\n')
  })

  test('a fresh path still creates, with the git strategy it asked for', async () => {
    const root = workspace('fresh-source')
    const target = join(root, WORKTREE_RELATIVE_DIRECTORY, 'fresh')

    const creation = await createWorktree({
      repoRoot: root,
      targetPath: target,
      requested: 'auto',
      gitAvailable: true,
      branch: 'freecodego/session/fresh',
    }, {
      runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
      // The one file the source tree holds, materialized as a full copy rather than
      // a clone — the shape `CopyTreeResult` reports it in.
      copyTree: async () => ({ files: 1, cloned: 0, copied: 1, linked: 0, mechanism: 'copy', concurrency: 1 }),
      fingerprint: async () => [{ path: 'a.txt', sha256: 'x' }],
    })

    expect(creation).toMatchObject({ strategy: 'git', path: target, files: 1 })
  })
})
