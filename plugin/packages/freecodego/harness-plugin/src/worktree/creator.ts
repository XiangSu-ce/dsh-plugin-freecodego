/**
 * One way to create a worktree, over two strategies that must agree.
 *
 * Why a single entry point
 * -----------------------
 * `git worktree add` and the copy-based clone in `fast.ts` produce the same
 * thing by different means, and which one a caller gets must not change what the
 * caller sees. Two entry points would let the child session's *content* depend on
 * which one ran, and the difference would surface as "the tests pass on my
 * machine" with a worktree strategy as the hidden variable.
 *
 * So this module owns three things and nothing else:
 *
 * - **Which strategy runs**, and — more importantly — **why the other one did
 *   not**. A silent fallback is the failure mode this file exists to prevent: the
 *   caller asked for a git worktree because it wanted git's own bookkeeping, and
 *   getting a plain copy without being told is how a `git status` in the child
 *   reports a repository that is not the one the parent is in.
 * - **The creation itself**, with the git plumbing and the copy primitive both
 *   injected, so both strategies are exercisable without a repository.
 * - **The fingerprint** the equivalence test compares. A worktree's identity is
 *   its file set and each file's content, which is what the two strategies must
 *   match on; comparing directory listings alone would pass while every file
 *   differed.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/worktree/creator
 */

import { createHash } from 'node:crypto'
import { redactCredentialShapes } from '../secret-scan.ts'
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { copyTree, type CopyTreeResult } from './fast.ts'

/** Which implementation produces the working copy. */
export type WorktreeStrategy = 'git' | 'fast'

/** What the caller asked for. `auto` picks git when it can. */
export type WorktreeStrategyRequest = WorktreeStrategy | 'auto'

/** What the creator decided, and why it is not the other one. */
export interface WorktreeStrategyPlan {
  readonly strategy: WorktreeStrategy
  /**
   * Set whenever the chosen strategy is not the one a `'git'` request names —
   * including for `'auto'`, where the reason is what the caller needs in order to
   * know its `git`-dependent assumptions do not hold.
   */
  readonly fallbackReason?: string
}

/**
 * Decide which strategy to use.
 *
 * `'git'` is a request, not a guarantee, and it degrades loudly: a workspace that
 * is not a repository, or a machine without `git` on PATH, still gets a working
 * copy, plus the sentence that says which assumption failed. A caller that asked
 * for git because it intended to run git commands in the child can then decide
 * whether to proceed.
 * @param input - the request, plus what is actually available.
 * @returns the strategy and, when it is not the requested one, why.
 */
export function resolveWorktreeStrategy(input: {
  readonly requested: WorktreeStrategyRequest
  readonly gitAvailable: boolean
  readonly fastAvailable: boolean
}): WorktreeStrategyPlan {
  if (input.requested === 'fast') {
    return input.fastAvailable
      ? { strategy: 'fast' }
      : { strategy: 'fast', fallbackReason: 'the copy primitive is unavailable, so this will fail rather than fall back to git' }
  }
  if (input.gitAvailable) return { strategy: 'git' }
  // Neither availability is implied by the other, so a reason that names only one
  // of them can promise a working copy that will not appear. The two inputs
  // differ in how real they are: `gitAvailable` is probed per call by the only
  // production caller (`rev-parse --is-inside-work-tree`), while `fastAvailable`
  // is never passed there and defaults to true — the copy primitive is pure Node
  // and degrades internally from reflink to a full copy, so it has no
  // unavailable state to report today. The branch stays honest for the caller
  // that does pass it (a test, or an environment whose copy path is genuinely
  // missing) rather than reporting a fast clone on the way to a failure.
  if (!input.fastAvailable) {
    return {
      strategy: 'fast',
      fallbackReason: 'neither strategy is available: git is unavailable (no repository, or no `git` on PATH) and the copy primitive is unavailable, so creating the working copy will fail',
    }
  }
  return {
    strategy: 'fast',
    fallbackReason: input.requested === 'git'
      ? 'git is unavailable (no repository, or no `git` on PATH), so the working copy is a fast clone rather than a git worktree'
      : 'git is unavailable, so the working copy is a fast clone',
  }
}

/** What one creation produced. */
export interface WorktreeCreation {
  readonly strategy: WorktreeStrategy
  readonly path: string
  /** Files materialized, counted the same way by both strategies. */
  readonly files: number
  /** How the copy reached the destination; absent for the git strategy. */
  readonly mechanism?: CopyTreeResult['mechanism']
  readonly fallbackReason?: string
}

/** A file the creator must place, with its content digest. */
export interface WorktreeFile {
  /** Path relative to the worktree root, using forward slashes. */
  readonly path: string
  /** Digest of the entry kind plus regular-file contents or symbolic-link target. */
  readonly sha256: string
}

/** A command result, as the git plumbing reports it. */
export interface GitCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Everything the creator needs, injected so both strategies are testable. */
export interface WorktreeCreatorDeps {
  /** Run `git` in the repository. */
  readonly runGit: (args: readonly string[]) => Promise<GitCommandResult>
  /** The fast clone, which materializes the tree itself. */
  readonly copyTree: (input: { readonly source: string; readonly target: string }) => Promise<CopyTreeResult>
  /** List a tree's files with digests, for the fingerprint and the count. */
  readonly fingerprint: (root: string) => Promise<readonly WorktreeFile[]>
}

/**
 * Hash a worktree's identity: its file set and every file's content.
 *
 * Paths are sorted so that a different traversal order is not a different
 * worktree, and the path is hashed alongside the digest so that two files
 * swapping contents is not a match.
 * @param files - the worktree's files.
 * @returns a stable digest.
 */
export function worktreeFingerprint(files: readonly WorktreeFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update('\u0000')
    hash.update(file.sha256)
    hash.update('\u0001')
  }
  return hash.digest('hex')
}

/**
 * What is wrong with the target path, if anything.
 *
 * A target that already holds a working copy is the one input both strategies
 * fail on, and they fail in different directions: `git worktree add` refuses a
 * branch and a path that already exist, while the copy fallback is handed the
 * occupied directory and silently merges the source tree into it file by file.
 * The quiet one is the dangerous one — a copy kept for review is overwritten and
 * the result is reported as a successful clone of a mixture — so this is checked
 * before either strategy runs.
 * @param path - the destination directory.
 * @returns a reason the target is not a fresh copy, or `undefined` when it is.
 */
function occupiedTarget(path: string): string | undefined {
  const info = statSync(path, { throwIfNoEntry: false })
  if (info === undefined) return undefined
  if (! info.isDirectory()) return 'the path is not a directory'
  const entries = readdirSync(path)
  return entries.length === 0
    ? undefined
    : `it already contains files (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, starting with ${entries[0]})`
}

/**
 * Create one worktree.
 *
 * Both strategies are given the same contract: on success the target directory
 * holds the repository's files, and on failure nothing is reported as created.
 * The git path runs `git worktree add` and then reads the resulting tree through
 * the same fingerprint reader the copy path uses, which is what makes the two
 * comparable rather than merely similar.
 * @param input - the repository root, the destination, and the request.
 * @param deps - the injected git plumbing and copy primitive.
 * @returns what was created, including any fallback reason.
 */
export async function createWorktree(
  input: {
    readonly repoRoot: string
    readonly targetPath: string
    readonly requested: WorktreeStrategyRequest
    /** Passed through from the caller's own availability probe. */
    readonly gitAvailable: boolean
    readonly fastAvailable?: boolean
    /**
     * Branch to create the worktree on.
     *
     * Given one, the git path runs `git worktree add -b <branch> <path>`, so the
     * copy has a name a reviewer can find and a merge can name. Omitted, the copy
     * is detached at `ref` (or at HEAD), which is right for a throwaway read-only
     * checkout and wrong for anything whose work is meant to come back — a
     * detached HEAD has no branch to merge, and reporting a branch name for one
     * would be reporting something that does not exist.
     */
    readonly branch?: string
    /** Commit or branch the git path should start from. */
    readonly ref?: string
  },
  deps: WorktreeCreatorDeps,
): Promise<WorktreeCreation> {
  // Refused before the strategy is even chosen: a caller that wanted the copy it
  // already has must ask for that copy, because this function only ever creates
  // a new one, and "creates a new one" over an occupied directory is a copy that
  // overwrites someone's work without saying so.
  const occupied = occupiedTarget(input.targetPath)
  if (occupied !== undefined) {
    throw new Error(`${input.targetPath} is not a fresh copy: ${occupied}. Remove it first, or reuse the copy that is already there.`)
  }
  const plan = resolveWorktreeStrategy({
    requested: input.requested,
    gitAvailable: input.gitAvailable,
    fastAvailable: input.fastAvailable ?? true,
  })

  if (plan.strategy === 'git') {
    const tail = input.ref === undefined ? [] : [input.ref]
    const args = input.branch === undefined
      ? ['worktree', 'add', '--detach', input.targetPath, ...tail]
      : ['worktree', 'add', '-b', input.branch, input.targetPath, ...tail]
    const result = await deps.runGit(args)
    if (result.code !== 0) {
      // A failed `git worktree add` is reported as the fallback it becomes
      // rather than as a failure to create anything: the caller's next question
      // is "so what did I get", and the answer is a fast clone.
      const copied = await deps.copyTree({ source: input.repoRoot, target: input.targetPath })
      const files = await deps.fingerprint(input.targetPath)
      // Git's own output, quoted into a result the caller reads. Git prints the
      // URL it failed against, and for an authenticated remote that URL carries
      // the token — the same channel the team worktree reports through, which is
      // why this is masked with the same call. (Reachability is weaker here: the
      // target path is derived by the planner rather than from a caller-supplied
      // member id, so a credential shape is not known to reach it today. It is
      // masked because a reader cannot tell the two paths apart.)
      const stderr = redactCredentialShapes(result.stderr.trim())
      return {
        strategy: 'fast',
        path: input.targetPath,
        files: files.length,
        mechanism: copied.mechanism,
        fallbackReason: `\`git worktree add\` failed (${stderr || `exit ${result.code}`}), so the working copy is a fast clone`,
      }
    }
    const files = await deps.fingerprint(input.targetPath)
    return { strategy: 'git', path: input.targetPath, files: files.length }
  }

  const copied = await deps.copyTree({ source: input.repoRoot, target: input.targetPath })
  const files = await deps.fingerprint(input.targetPath)
  return {
    strategy: 'fast',
    path: input.targetPath,
    files: files.length,
    mechanism: copied.mechanism,
    ...(plan.fallbackReason === undefined ? {} : { fallbackReason: plan.fallbackReason }),
  }
}

/** The real copy primitive, bound so the default creator needs no injection. */
export const FAST_COPY: WorktreeCreatorDeps['copyTree'] = async input =>
  copyTree({ from: input.source, to: input.target })

/**
 * List a tree's files with digests, relative to the tree, forward-slashed.
 *
 * Skips `.git`, and that is a decision rather than an omission: a worktree's
 * identity is the files a reader will see, and git's metadata differs between a
 * worktree and a plain copy by construction — comparing it would make the two
 * strategies unequal by definition, which is the opposite of what the
 * equivalence test is checking.
 *
 * Two shapes are skipped rather than followed, and both are about the walk
 * terminating on what a checkout contains rather than on what the machine's
 * filesystem happens to point at. A link to a directory is not descended into: it
 * is a link in the tree, and a link that points back into the tree would
descend forever (the same reason `fast.ts` recreates them instead of copying
 * them). A dangling link has no contents to digest, and it is the same shape on
 * both strategies, so skipping it compares the two on equal terms. Every other
 * read failure — a permission error, a locked file — is reported, because a
 * fingerprint that quietly covers fewer files is a comparison that quietly proves
 * less.
 * @param root - the directory to walk.
 * @returns one entry per readable file, in traversal order.
 */
export function fingerprintTree(root: string): readonly WorktreeFile[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      // A link is not a directory to `readdir`, so it is tested here: following it
      // is what would not terminate, and `readFileSync` on one that names a
      // directory throws EISDIR.
      if (entry.isSymbolicLink() && statSync(full, { throwIfNoEntry: false })?.isDirectory() === true) continue
      files.push(full)
    }
  }
  walk(root)
  return files.flatMap((full): WorktreeFile[] => {
    try {
      return [{
        path: relative(root, full).split('\\').join('/'),
        sha256: (() => {
          const link = lstatSync(full).isSymbolicLink()
          const digest = createHash('sha256').update(link ? 'link\u0000' : 'file\u0000')
          digest.update(link ? readlinkSync(full) : readFileSync(full))
          return digest.digest('hex')
        })(),
      }]
    } catch (error) {
      const code = (error as { readonly code?: string }).code
      if (code === 'ENOENT' || code === 'EISDIR') return []
      throw error
    }
  })
}

/**
 * The real plumbing, for a caller that has git and nothing to mock.
 *
 * Exists so a wiring site does not hand-roll the two adapters and get one of them
 * subtly wrong — the failure being a creator that compares a git worktree against
 * a copy by listing different things.
 * @param runGit - the caller's git runner, already bound so `args` is a `git` argv.
 * @returns deps the creator can execute both strategies with.
 */
export function realCreatorDeps(
  runGit: (args: readonly string[]) => Promise<GitCommandResult>,
): WorktreeCreatorDeps {
  return {
    runGit,
    copyTree: FAST_COPY,
    fingerprint: async root => fingerprintTree(root),
  }
}
