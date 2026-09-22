/**
 * The git port, implemented over a child process.
 *
 * Three properties, all borrowed from the plugin's other git callers because
 * they are the ones that keep a review from hanging or lying:
 *
 * - **A nonzero exit is a result, not a throw.** `git diff` against a ref that
 *   does not exist, or `ls-files` outside a repository, are ordinary answers that
 *   target selection has to reason about. A port that threw would turn every one
 *   of them into a failed run.
 * - **Bounded time and bounded output.** A hung `git` must not hang a review, and
 *   an enormous diff must not be read into memory twice: past the ceiling the
 *   caller gets a truncated stdout, and the size check in target selection is
 *   what decides whether that file is reviewable at all.
 * - **`-C <cwd>` rather than a working directory.** The review is about one
 *   repository; passing the directory explicitly means a caller cannot
 *   accidentally run against the process's own cwd.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/git-port
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ReviewGitPort, ReviewGitResult } from './targets.ts'

const run = promisify(execFile)

/** Longest one git read may take before it is abandoned. */
const GIT_TIMEOUT_MS = 60_000

/** Largest stdout retained from one git command, in bytes. */
const MAX_GIT_OUTPUT = 32 * 1024 * 1024

/** True when a failure object looks like an `execFile` rejection rather than a bug. */
interface ExecFileFailure {
  readonly stdout?: string
  readonly stderr?: string
  readonly code?: number | string
  readonly message?: string
}

/**
 * Build the real git port.
 *
 * `gitPath` is injectable so a deployment that ships its own git — or a test that
 * wants to point at a fixture repository — does not have to change `PATH`.
 */
export function createReviewGitPort(gitPath = 'git'): ReviewGitPort {
  /**
   * Worktree roots, one per workspace, cached for the life of the port.
   *
   * A path from git is relative to the **worktree root**, not to the workspace a
   * review was asked about: `git -C plugin diff` reports `plugin/packages/...`,
   * and `git -C plugin rev-parse --show-toplevel` is what says so. Resolving a git
   * path against the session's cwd therefore reads the wrong file whenever the
   * session is open in a subdirectory — and the failure is silent, because a size
   * that cannot be read becomes zero and zero is under every ceiling. The root is
   * asked for once per workspace and remembered, since it cannot change while a
   * repository is open and every untracked file needs it.
   */
  const roots = new Map<string, string | undefined>()

  const runGit = async (args: readonly string[], cwd: string): Promise<ReviewGitResult> => {
    try {
      const result = await run(gitPath, ['-C', cwd, ...args], {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT,
      })
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as ExecFileFailure
      return {
        // A killed process reports a null code; keeping it distinct from a
        // plain nonzero exit is what lets a caller tell "git said no" from
        // "git never answered".
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message ?? '',
      }
    }
  }

  /** The worktree root, asked for once per workspace and remembered. */
  const rootOf = async (cwd: string): Promise<string | undefined> => {
    if (roots.has(cwd)) return roots.get(cwd)
    // A root git did not answer for is left undetermined rather than assumed, so
    // the caller's fallback is the workspace itself instead of a guess.
    const result = await runGit(['rev-parse', '--show-toplevel'], cwd)
    const root = result.exitCode === 0 ? result.stdout.trim() : ''
    roots.set(cwd, root === '' ? undefined : root)
    return roots.get(cwd)
  }

  return {
    run: runGit,

    async readFileSize(path: string, cwd: string): Promise<number | undefined> {
      try {
        const root = await rootOf(cwd)
        const info = await stat(resolve(root ?? cwd, path))
        return info.isFile() ? info.size : undefined
      } catch {
        return undefined
      }
    },
  }
}
