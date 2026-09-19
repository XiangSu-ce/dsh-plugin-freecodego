/**
 * One git worktree per writer, and a merge step that refuses to guess.
 *
 * Parallel writers sharing one directory is the largest correctness gap in a
 * multi-agent setup: two members editing the same tree interleave their writes,
 * each sees a half-applied version of the other's work, and neither can be
 * reverted independently. Claude Code made worktree enter/exit a first-class
 * tool for exactly this reason, and the multi-agent plugins carry a merge
 * coordinator and a commit cadence beside it.
 *
 * So: a writer gets its own worktree on its own branch, work is merged branch by
 * branch in dependency order, and a conflicting merge is **aborted** before it
 * is reported. Aborting matters — leaving a half-merged tree behind would turn
 * one failed integration into a workspace nobody can build, and the point of
 * isolation is that a failure stays local.
 *
 * Worktrees live under `<workspace>/.freecodego/worktrees/<member>` and that path
 * is added to `.git/info/exclude`, so the isolation mechanism does not itself
 * show up as untracked noise in every member's `git status`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/worktree
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { redactCredentialShapes } from '../secret-scan.ts'
import { TeamJsonStore, boundedTeamText } from './state.ts'

const run = promisify(execFile)

/**
 * Whether two paths name the same location.
 *
 * The registry is durable, so an entry may have been written by a session whose
 * workspace root was spelled differently: a symlinked checkout, a path opened with
 * a trailing separator, or — on Windows, and observed on this very machine — the
 * 8.3 short name `os.tmpdir()` hands back (`ADMINI~1` against `Administrator`).
 * Both spellings open the same file, so the registry is found either way and the
 * entry is then compared as a string against a freshly derived path.
 *
 * Compared by location rather than by spelling because the refusal that uses this
 * is only meaningful when the record and the convention have genuinely parted
 * ways. Two spellings of one directory produced a message that named the same
 * location twice and told the user to release a worktree that was already theirs —
 * a refusal with no action behind it.
 *
 * Deliberately not `realpath`: this runs on the allocation path, the directory may
 * legitimately not exist yet, and a syscall that throws there would turn a
 * comparison into a new failure mode. Case-folding is applied on Windows only,
 * where the filesystem does it too.
 * @param left - one path.
 * @param right - the other.
 * @returns whether both resolve to the same location.
 */
function sameLocation(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const unified = resolve(value).replaceAll('\\', '/').replace(/\/+$/u, '')
    return process.platform === 'win32' ? unified.toLowerCase() : unified
  }
  return normalize(left) === normalize(right)
}

/** Where worktrees sit inside the workspace, relative to its root. */
export const WORKTREE_RELATIVE_DIRECTORY = join('.freecodego', 'worktrees')

/** Longest git invocation this module waits for. A hung merge must not hang a session. */
const GIT_TIMEOUT_MS = 120_000

const MAX_GIT_OUTPUT = 64_000

export interface TeamWorktree {
  readonly id: string
  readonly memberId: string
  /**
   * The branch the worktree is on, or the empty string when there is none.
   *
   * Empty is a real state, not a missing value: a `fast` creator makes a plain
   * working copy with no git branch behind it (see `worktree/creator.ts`), and
   * writing an intended branch name here would make `integrating` a copy claim a
   * branch that does not exist. A reader that needs a mergeable worktree checks
   * this field rather than assuming one.
   */
  readonly branch: string
  readonly path: string
  /** Commit the branch was cut from, or the empty string when unknown. */
  readonly base: string
  readonly createdAt: number
  readonly mergedAt?: number | undefined
  readonly state: 'active' | 'merged' | 'abandoned'
  /** Which creator produced it, when the writer recorded one. */
  readonly strategy?: 'git' | 'fast'
  /** Session that holds it, when a session rather than a team member owns it. */
  readonly sessionId?: string
}

interface WorktreeDocument {
  readonly version: 1
  /** Workspace the worktrees belong to; a mismatched registry is refused. */
  readonly cwd: string
  readonly worktrees: readonly TeamWorktree[]
}

/**
 * The durable isolation facts about one writer, named once.
 *
 * A restarted Host has to answer "where is this writer's work" from the record
 * rather than by walking the filesystem: the design these names come from is
 * explicit that a reader must read `worktree_path` / `worktree_branch` instead of
 * reconstructing them from a directory name, because a reconstruction is exactly
 * what silently disagrees once a second naming convention exists. So the fields
 * are written when the worktree is made and reported from the record afterwards.
 *
 * `workspaceMode` is stored rather than inferred for the same reason: whether the
 * writers shared one tree or each had a copy is the fact a coordinator needs, and
 * a reader that derives it from "is there a branch" gets the fast-copy case wrong.
 */
export interface WorktreeIsolation {
  /** `shared` when writers share the workspace tree, `worktree` when each gets a copy. */
  readonly workspaceMode: 'shared' | 'worktree'
  /** How this writer's copy was made. */
  readonly worktreeMode: 'git' | 'fast'
  /** Directory the team's durable state lives in. */
  readonly teamStateRoot: string
  /** Directory the writer's own file and shell tools resolve against. */
  readonly workingDir: string
  /** Repository the copy was cut from. */
  readonly worktreeRepoRoot: string
  /** The copy itself. */
  readonly worktreePath: string
  /** Branch the copy is on, or `null` when it has none. */
  readonly worktreeBranch: string | null
  /** True when the copy has no branch to merge. */
  readonly worktreeDetached: boolean
  /** When the copy was created, in epoch milliseconds. */
  readonly worktreeCreated: number
  /** Registration lifecycle, so a reader can tell a live copy from a finished one. */
  readonly worktreeState: TeamWorktree['state']
}

/**
 * The exact field set a status report carries, in report order.
 *
 * This list is the contract rather than a description: `engineering_team_recover`
 * selects these keys, and a test pins the list itself, so a field added to
 * `WorktreeIsolation` but left out of the report is a failing test instead of a
 * silently unreported fact.
 */
export const LOCKED_ISOLATION_FIELDS = [
  'workspaceMode',
  'worktreeMode',
  'teamStateRoot',
  'workingDir',
  'worktreeRepoRoot',
  'worktreePath',
  'worktreeBranch',
  'worktreeDetached',
  'worktreeCreated',
  'worktreeState',
] as const satisfies readonly (keyof WorktreeIsolation)[]

/**
 * Project one registered worktree into the locked field set.
 * @param entry - the registry entry.
 * @param input - the registry's own directory, and the repository the copy came from.
 * @returns every locked field, with the no-branch case spelled as `null`.
 */
export function worktreeIsolation(
  entry: TeamWorktree,
  input: { readonly teamStateRoot: string; readonly repoRoot: string },
): WorktreeIsolation {
  const branch = entry.branch === '' ? null : entry.branch
  return {
    workspaceMode: 'worktree',
    worktreeMode: entry.strategy ?? (entry.branch === '' ? 'fast' : 'git'),
    teamStateRoot: input.teamStateRoot,
    workingDir: entry.path,
    worktreeRepoRoot: input.repoRoot,
    worktreePath: entry.path,
    worktreeBranch: branch,
    worktreeDetached: branch === null,
    worktreeCreated: entry.createdAt,
    worktreeState: entry.state,
  }
}

/**
 * The paths a working tree has changed, from `git status --porcelain`.
 *
 * Untracked files count as changes, and that is the point rather than an
 * oversight: the collision this guards against is a worker that adds a path the
 * shared tree already holds as an untracked file, which shows up here as `??`
 * and nowhere else.
 * @param porcelain - the raw `git status --porcelain` output.
 * @returns changed paths, without status codes, bounded to a reportable length.
 */
export function dirtyPaths(porcelain: string): readonly string[] {
  return porcelain
    .split('\n')
    // Rename lines read `R  old -> new`; the arrow is kept because it is the only
    // place the discarded name appears, and a report that names one side of a
    // rename is a report that sends the reader to a path that is gone.
    .map(line => line.trim().replace(/^[A-Z?!]{1,2}\s+/u, '').replace(/^"|"$/gu, ''))
    .filter(line => line !== '')
    .slice(0, 20)
}

/** What `release` did, and why it may have done nothing. */
export interface WorktreeReleaseOutcome {
  /** True only when this call removed the directory. */
  readonly removed: boolean
  /**
   * True when the working copy is still on disk afterwards — whether because it
   * held uncommitted work, or because the removal itself failed. The two are
   * different reasons for the same outcome, and `detail` is where they separate;
   * a caller that only needs "is there still a copy to deal with" reads this.
   */
  readonly preserved: boolean
  readonly worktree?: TeamWorktree
  readonly detail: string
}

export interface MergeOutcome {
  readonly worktree: TeamWorktree
  readonly merged: boolean
  readonly conflicts: readonly string[]
  readonly detail: string
}

function parseWorktrees(cwd: string): (input: unknown) => WorktreeDocument | undefined {
  return (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
    const document = input as Partial<WorktreeDocument>
    if (!Array.isArray(document.worktrees) || resolve(document.cwd ?? '') !== resolve(cwd)) return undefined
    return {
      version: 1,
      cwd: resolve(cwd),
      worktrees: document.worktrees.filter(entry => entry !== null && typeof entry === 'object' && typeof (entry as TeamWorktree).id === 'string'),
    }
  }
}

async function git(cwd: string, args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly code: number }> {
  try {
    const result = await run('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_GIT_OUTPUT })
    return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const failure = error as { readonly stdout?: string; readonly stderr?: string; readonly code?: number; readonly message?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
      code: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

export class TeamWorktrees {
  /** Git's index is shared by every registry wrapper for one repository. */
  private static readonly workspaceTails = new Map<string, Promise<void>>()
  private readonly store: TeamJsonStore<WorktreeDocument>
  private readonly root: string

  constructor(cwd: string, filePath: string) {
    this.root = resolve(cwd)
    this.store = new TeamJsonStore<WorktreeDocument>(filePath, () => ({ version: 1, cwd: this.root, worktrees: [] }), parseWorktrees(this.root))
  }

  async list(): Promise<readonly TeamWorktree[]> {
    return (await this.store.read()).worktrees
  }

  /**
   * Whether this workspace can isolate writers at all.
   *
   * A worktree needs a repository with at least one commit; a caller that asked
   * for isolation in a plain directory must be told, not silently given the
   * shared tree.
   */
  async available(): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const inside = await git(this.root, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, reason: 'the workspace is not a git work tree' }
    const head = await git(this.root, ['rev-parse', 'HEAD'])
    if (!head.ok) return { ok: false, reason: 'the repository has no commit to branch from yet' }
    return { ok: true }
  }

  /**
   * Cut a branch and a worktree for one member.
   *
   * The workspace's own dirtiness is deliberately not copied: a member branches
   * from `HEAD` so its worktree starts from committed state, which keeps a merge
   * reviewable instead of mixing in whatever was uncommitted when it started.
   *
   * A member whose branch already exists — the case a release leaves behind,
   * since a release deliberately keeps the branch — is given a worktree on that
   * branch instead of a new one. Asking git to create the branch again fails
   * outright and would leave the member un-isolatable for the rest of the
   * project, while cutting a fresh branch would strand the work already on the
   * old one. Only a branch the registry already credits to *this* member is
   * continued, so two member ids that sanitize to the same directory still
   * collide loudly rather than silently sharing one worktree. An explicit
   * `base` therefore applies only to a freshly cut branch: a continued branch
   * starts at its own tip, which is where the member's work actually is.
   *
   * Three rules are checked before anything is created, and each one exists
   * because the alternative is a silent inconsistency rather than a visible
   * error:
   *
   * - **A registered entry that disagrees with the derived location is refused.**
   *   A path or branch that differs from what this call would derive means the
   *   record and the convention have parted ways; reusing the entry hands the
   *   caller a copy under a name it did not ask for, and ignoring it strands the
   *   old one. Naming both is the only answer that does not guess.
   * - **A compatible copy already on disk is handed back, dirty or not.** `git
   *   worktree add` refuses a path that is already checked out, so without this
   *   the writer that is *already* correctly isolated is the one whose allocation
   *   fails. A copy holding uncommitted changes is refused by that same rule, and
   *   it is the copy that matters most: the fall-through re-added the same path,
   *   git refused it, the member's start rolled back, and a writer holding
   *   half-finished work became one nobody could restart while its work sat in a
   *   directory no other tool reaches. Dirtiness is a reason to hand the copy
   *   back — that is where the member's work is — and the only alternative would
   *   be re-creating it, which discards the changes. This is the same rule the
   *   session-side `enter` applies with the same fact.
   * - **A dirty workspace refuses the allocation.** The worker branches from
   *   HEAD, so dirtiness never reaches the copy — but it *is* the state a later
   *   merge lands on, and "merge into a tree with uncommitted edits" has no
   *   defined base. `allowDirtyWorkspace` is the explicit way to say that was
   *   understood.
   */
  async allocate(
    memberId: string,
    options: { readonly base?: string; readonly allowDirtyWorkspace?: boolean } = {},
  ): Promise<TeamWorktree> {
    return await this.withWorkspaceLock(async () => {
    const usable = await this.available()
    if (!usable.ok) throw new Error(`cannot isolate this writer: ${usable.reason ?? 'worktrees are unavailable'}`)
    const safe = memberId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) || 'member'
    const branch = `freecodego/team/${safe}`
    const path = join(this.root, WORKTREE_RELATIVE_DIRECTORY, safe)
    const owned = (await this.list()).find(entry => entry.memberId === memberId)
    if (owned !== undefined && (owned.branch !== branch || !sameLocation(owned.path, path))) {
      throw new Error(`the worktree registered for "${memberId}" is ${owned.path} on "${owned.branch || '(no branch)'}", not ${path} on "${branch}"; refusing to reuse it. Release it first, or register it under the member id it belongs to.`)
    }
    // Existence is the whole test. Asking whether the copy is clean first is what
    // made a dirty copy fall through to `git worktree add` on a path that is
    // already checked out, so the member with uncommitted work was the one whose
    // restart failed.
    if (owned !== undefined && owned.state === 'active' && existsSync(path)) return owned
    if (options.allowDirtyWorkspace !== true) {
      const dirty = await this.changedPaths(this.root)
      if (dirty !== undefined && dirty.length > 0) {
        throw new Error(`the workspace has uncommitted changes (${dirty.join(', ')}), so a merge back into it would have no defined base; commit or stash them, or pass allowDirtyWorkspace: true to isolate the writer anyway`)
      }
    }
    const continueBranch = owned !== undefined && (await git(this.root, ['rev-parse', '--verify', '--quiet', branch])).ok
    const base = continueBranch
      ? (await git(this.root, ['rev-parse', branch])).stdout.trim()
      : options.base ?? (await git(this.root, ['rev-parse', 'HEAD'])).stdout.trim()
    await mkdir(join(this.root, WORKTREE_RELATIVE_DIRECTORY), { recursive: true, mode: 0o700 })
    await this.excludeFromStatus()
    const add = () => continueBranch
      ? git(this.root, ['worktree', 'add', path, branch])
      : git(this.root, ['worktree', 'add', '-b', branch, path, base])
    const created = await add()
    if (!created.ok) {
      // A leftover registration from a killed process is the common failure, and
      // it is recoverable without touching anyone's work.
      await git(this.root, ['worktree', 'prune'])
      const retry = await add()
      // Masked before it is bounded: this is git's own output, and git prints the
      // URL it failed against, which for an authenticated remote is the URL with
      // the token inside it. `boundedTeamText` collapses and truncates only.
      if (!retry.ok) throw new Error(`git worktree add failed: ${redactCredentialShapes(boundedTeamText(retry.stderr || retry.stdout, 500))}`)
    }
    // `strategy` is recorded rather than left to be inferred from the branch:
    // this path only ever produces a git worktree (it requires `available()`
    // first), and a reader that derives the creator from "is there a branch" is
    // the inference the durable field exists to replace.
    const worktree: TeamWorktree = { id: `wt_${safe}`, memberId, branch, path, base, createdAt: Date.now(), state: 'active', strategy: 'git' }
    await this.store.update(current => ({ ...current, worktrees: [...current.worktrees.filter(entry => entry.id !== worktree.id), worktree] }))
    return worktree
    })
  }

  /**
   * Merge one member's branch into the workspace branch.
   *
   * On conflict the merge is aborted and the unmerged paths are returned, which
   * is what lets a caller route the conflict to the two owners instead of
   * leaving a tree that does not build. Conflicts are read *before* the abort,
   * because after it git no longer reports them.
   */
  async integrate(id: string, options: { readonly message?: string } = {}): Promise<MergeOutcome> {
    return await this.withWorkspaceLock(async () => {
      // Read after joining the repository queue. A prior integration may have
      // committed and marked this branch merged while this caller waited.
      const worktree = (await this.list()).find(entry => entry.id === id || entry.memberId === id)
      if (worktree === undefined) throw new Error(`no worktree is registered for "${id}"`)
      if (worktree.state === 'merged') return { worktree, merged: true, conflicts: [], detail: 'already merged' }
      const branchExists = await git(this.root, ['rev-parse', '--verify', '--quiet', worktree.branch])
      if (!branchExists.ok) return { worktree, merged: false, conflicts: [], detail: `branch "${worktree.branch}" no longer exists` }
      const merged = await git(this.root, ['merge', '--no-ff', '--no-edit', '-m', options.message ?? `team: merge ${worktree.branch}`, worktree.branch])
      if (merged.ok) {
        const stored: TeamWorktree = { ...worktree, state: 'merged', mergedAt: Date.now() }
        await this.store.update(current => ({ ...current, worktrees: current.worktrees.map(entry => entry.id === worktree.id ? stored : entry) }))
        return { worktree: stored, merged: true, conflicts: [], detail: boundedTeamText(merged.stdout, 300) }
      }
      const unmerged = await git(this.root, ['diff', '--name-only', '--diff-filter=U'])
      const conflicts = unmerged.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      const abort = await git(this.root, ['merge', '--abort'])
      return {
        worktree,
        merged: false,
        conflicts,
        detail: `${boundedTeamText(merged.stderr || merged.stdout, 400)}${abort.ok ? '' : ' (merge --abort failed; the workspace needs manual attention)'}`,
      }
    })
  }

  /**
   * Record a worktree a caller created itself.
   *
   * Session worktrees (`worktree/tools.ts`) live in this same document on
   * purpose: two registries over one directory of worktrees would each report
   * the other's entries as missing, and the orphan that produces is a worktree
   * nobody can find to clean up.
   * @param entry - the worktree to record, replacing any entry with the same id.
   */
  async register(entry: TeamWorktree): Promise<void> {
    await this.store.update(current => ({ ...current, worktrees: [...current.worktrees.filter(existing => existing.id !== entry.id), entry] }))
  }

  /**
   * Add the worktree directory to `.git/info/exclude`.
   *
   * Public because a session worktree is created outside this class and must
   * still keep the directory out of `git status` — the invariant is about the
   * directory, not about who created the entry.
   */
  async excludeWorktreeDirectory(): Promise<void> {
    await this.excludeFromStatus()
  }

  /**
   * Stop using a worktree, discarding it only when that is what was asked for.
   *
   * Three corrections to "remove the directory and record it gone", each of them
   * a case where the tidy version loses something:
   *
   * - **A copy holding uncommitted changes is kept, not deleted.** Those changes
   *   may be the only copy of a member's work, and a cleanup that discards them
   *   is the one step in this module that destroys something nobody asked it to.
   *   `acknowledgeLostWorktree` is the token that says the loss was understood.
   * - **A removal that failed is reported, and the entry stays active.** Marking
   *   it abandoned while the directory is still on disk is how a worktree becomes
   *   invisible: nothing lists it as live, and nothing tells a later cleanup it is
   *   there. The module already names this failure for session worktrees; this is
   *   the same rule for team ones.
   * - **The branch survives unless `deleteBranch` is set**, and that is unchanged,
   *   because deleting a branch is still the other step that can destroy work.
   * @param id - the worktree id, or the member id that owns it.
   * @param options - whether to delete a merged branch, and the loss acknowledgment.
   * @returns what happened, including the reason nothing did.
   */
  async release(
    id: string,
    options: { readonly deleteBranch?: boolean; readonly acknowledgeLostWorktree?: boolean } = {},
  ): Promise<WorktreeReleaseOutcome> {
    const worktree = (await this.list()).find(entry => entry.id === id || entry.memberId === id)
    if (worktree === undefined) {
      return { removed: false, preserved: false, detail: `No worktree is registered for "${id}".` }
    }
    if (!existsSync(worktree.path)) {
      // Already gone — by the user, or by a `git worktree prune` elsewhere. The
      // registration is the stale part, so it is the part that changes.
      await git(this.root, ['worktree', 'prune'])
      await this.markAbandoned(worktree)
      return { removed: false, preserved: false, worktree: { ...worktree, state: 'abandoned' }, detail: `The directory ${worktree.path} was already gone; the registration is marked abandoned.` }
    }
    const dirty = await this.changedPaths(worktree.path)
    const holdsWork = dirty === undefined || dirty.length > 0
    if (holdsWork && options.acknowledgeLostWorktree !== true) {
      return {
        removed: false,
        preserved: true,
        worktree,
        detail: `Kept ${worktree.path}: it ${dirty === undefined
          ? 'cannot be read as clean, so it may hold changes'
          : `has uncommitted changes (${dirty.join(', ')})`}${worktree.branch === '' ? '' : `, and its branch ${worktree.branch} is the only reference to whatever else it committed`}. Merge or commit them, or pass acknowledgeLostWorktree: true to discard them.`,
      }
    }
    const removal = await git(this.root, ['worktree', 'remove', ...(options.acknowledgeLostWorktree === true ? ['--force'] : []), worktree.path])
    if (!removal.ok) {
      return {
        removed: false,
        preserved: true,
        worktree,
        detail: `Kept ${worktree.path}: \`git worktree remove\` failed (${boundedTeamText(removal.stderr || removal.stdout, 300)}), so the registration stays active for a later attempt.`,
      }
    }
    await git(this.root, ['worktree', 'prune'])
    if (options.deleteBranch === true && worktree.state === 'merged') await git(this.root, ['branch', '-D', worktree.branch])
    await this.markAbandoned(worktree)
    return {
      removed: true,
      preserved: false,
      worktree: { ...worktree, state: 'abandoned' },
      detail: `Removed ${worktree.path}${options.deleteBranch === true && worktree.state === 'merged' && worktree.branch !== '' ? `; branch ${worktree.branch} was deleted` : worktree.branch === '' ? ' (the copy had no branch)' : `; branch ${worktree.branch} was kept`}.`,
    }
  }

  /** Record one entry as abandoned, leaving every other field as it was. */
  private async markAbandoned(worktree: TeamWorktree): Promise<void> {
    await this.store.update(current => ({ ...current, worktrees: current.worktrees.map(entry => entry.id === worktree.id ? { ...entry, state: 'abandoned' } : entry) }))
  }

  /**
   * The paths a directory has changed, or `undefined` when git cannot say.
   *
   * `undefined` is deliberately not folded into the empty list, because the two
   * callers fail in opposite directions and only one of them is destructive:
   * allocation treats "cannot tell" as "not dirty", since a refused allocation is
   * a writer that cannot work at all; release treats it as "dirty", since it
   * decides whether to delete a directory that may hold the only copy of someone's
   * work. Fail-closed belongs on the destructive side.
   * @param directory - the working tree to ask about.
   * @returns changed paths, or `undefined` when the question could not be answered.
   */
  private async changedPaths(directory: string): Promise<readonly string[] | undefined> {
    const status = await git(directory, ['status', '--porcelain'])
    return status.ok ? dirtyPaths(status.stdout) : undefined
  }

  /** Serialize index-mutating operations across every wrapper for this repository. */
  private async withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.root)
    const previous = TeamWorktrees.workspaceTails.get(key) ?? Promise.resolve()
    const run = previous.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    TeamWorktrees.workspaceTails.set(key, tail)
    void tail.finally(() => {
      if (TeamWorktrees.workspaceTails.get(key) === tail) TeamWorktrees.workspaceTails.delete(key)
    })
    return await run
  }

  /** The repository this registry's worktrees are cut from. */
  get repoRoot(): string { return this.root }

  /** The directory the team's durable state lives in. */
  get stateRoot(): string { return dirname(this.store.path) }

  /** Add the worktree directory to `.git/info/exclude` once. */
  private async excludeFromStatus(): Promise<void> {
    const info = await git(this.root, ['rev-parse', '--git-dir'])
    if (!info.ok) return
    const gitDirectory = resolve(this.root, info.stdout.trim())
    const exclude = join(gitDirectory, 'info', 'exclude')
    const pattern = `${WORKTREE_RELATIVE_DIRECTORY.replaceAll('\\', '/')}/`
    try {
      const existing = existsSync(exclude) ? await readFile(exclude, 'utf8') : ''
      if (existing.split('\n').some(line => line.trim() === pattern)) return
      await mkdir(join(gitDirectory, 'info'), { recursive: true })
      await appendFile(exclude, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}# FreeCodeGo team worktrees\n${pattern}\n`, 'utf8')
    } catch {
      // A workspace whose git directory is not writable still gets working
      // isolation; only the status noise remains, which is not worth failing on.
    }
  }
}
