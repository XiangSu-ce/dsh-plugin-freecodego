/**
 * The resolution tier's resolver, shared by both guards that read a path.
 *
 * Two guards judge the path a tool call names — the credential shield
 * (`tool-guards.ts`) and the sandbox profile's deny list
 * (`sandbox/profiles.ts`) — and each answers twice: once about the name as
 * written, and once about the file it resolves to. The two *lexical* tiers are
 * different rules on purpose (one protects credential material by name, the other
 * enforces the user's own globs), but the resolution itself is the same syscall
 * for both, so it lives here rather than in either of them. A copy in each is how
 * one tier ends up resolving through a missing tail and the other stops at the
 * first `ENOENT` — the same path, two answers, which is the failure both modules
 * document at length.
 *
 * Measured, on the platform this Host runs on:
 *
 * - A symlink or a directory junction is resolved to its target, for the leaf and
 *   for any component above it.
 * - A short-name *leaf* is resolved to its long name (`ID_RSA~1` → `id_rsa`),
 *   which is why a basename rule survives an alternate spelling.
 * - A short-name *prefix* is **not** expanded back to its long spelling: when the
 *   starting path already spells a directory `ADMINI~1`, the answer keeps that
 *   spelling. A pattern written with the long spelling therefore cannot match a
 *   resolved path under a short prefix; patterns that name a suffix
 *   (`**​/secrets/**`, `*.pem`) are unaffected. This is recorded rather than
 *   repaired because expanding it needs `GetLongPathName`, which Node does not
 *   expose.
 * - A hard link is **not** resolved: it has no target to follow, and the two paths
 *   are one file with no relation between their names.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/sandbox/realpath
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Resolve a path through every symlink and short name on the way to it.
 *
 * `realpath` needs the leaf to exist, but a `write` legitimately targets a file
 * that does not exist yet, so the walk climbs to the nearest existing ancestor,
 * resolves *that*, and re-appends the missing tail. The hop budget turns a
 * symlink cycle into `undefined` instead of an unbounded walk.
 *
 * @param target - the path to resolve, absolute or relative to the process cwd.
 * @returns the resolved absolute path, or `undefined` when no ancestor resolves.
 */
export async function realpathThroughMissingTail(target: string): Promise<string | undefined> {
  let current = resolve(target)
  const missing: string[] = []
  for (let hops = 0; hops < 64; hops += 1) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch {
      const parent = dirname(current)
      // The filesystem root is always real; a failure here means the path is
      // malformed or unreadable, and inventing an answer would be worse than
      // leaving the lexical tier to decide.
      if (parent === current) return undefined
      missing.unshift(basename(current))
      current = parent
    }
  }
  return undefined
}
