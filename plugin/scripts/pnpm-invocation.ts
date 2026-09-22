/** Resolve shell-free child-process invocations for the package manager a package script runs under. */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Resolve pnpm's executable and arguments from its lifecycle environment.
 * @param args - Arguments to pass to pnpm.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('pnpm invocation: npm_execpath is unavailable; invoke the script through pnpm run.')
  }
  if (/\.[cm]?js$/iu.test(entrypoint)) {
    return { command: process.execPath, args: [entrypoint, ...args] }
  }
  return { command: entrypoint, args: [...args] }
}

/**
 * Resolve npm's executable and arguments without a shell.
 *
 * On Windows `npm` is a `.cmd` shim: a direct spawn cannot execute it at all,
 * and running it through a shell concatenates the arguments unquoted, so a path
 * containing a space breaks the command. Both are avoided by invoking npm's CLI
 * entry point with the Node that is already running, which is the same remedy
 * {@link pnpmInvocation} applies to `npm_execpath`. The entry point sits beside
 * that Node in the standard installation layout; the plain command name is the
 * fallback, which is where a POSIX run lands anyway, since `npm` there is an
 * executable rather than a shim.
 * @param args - Arguments to pass to npm.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function npmInvocation(args: readonly string[]): { command: string; args: string[] } {
  const entrypoint = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(entrypoint)) return { command: process.execPath, args: [entrypoint, ...args] }
  return { command: 'npm', args: [...args] }
}
