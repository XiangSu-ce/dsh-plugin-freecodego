/**
 * The fast working-copy cloner.
 *
 * What it is for
 * --------------
 * A worktree's cost is one thing: writing out a copy of the repository's files. `git
 * worktree add` does that with a checkout, which reads and writes every byte. Where
 * the filesystem can share extents — reflink on Linux and macOS's APFS, block
 * cloning on ReFS — the same directory can exist twice while the bytes exist once,
 * and the copy becomes metadata work.
 *
 * Reporting what actually happened, not what was available
 * --------------------------------------------------------
 * `COPYFILE_FICLONE` falls back to an ordinary copy *silently*, so a caller cannot
 * tell afterwards whether it paid for a clone or a copy. The cloner therefore asks
 * with `COPYFILE_FICLONE_FORCE` first: that mode fails loudly on a filesystem without
 * the capability, so the failure is the signal, and the per-file counts below are a
 * measurement rather than a guess. This matters because the mechanism is what decides
 * whether a pool is worth its disk — a deployment that believes it has reflink and
 * does not would size its pool for metadata and pay for full copies.
 *
 * Sharded, not sequential
 * -----------------------
 * Copying thousands of small files is latency-bound; one file at a time leaves the
 * storage idle between operations. Files are dealt into buckets by a stable hash of
 * their relative path rather than by round-robin, so the split does not depend on
 * directory iteration order — two runs of the same tree produce the same assignment,
 * which is what makes a failure reproducible.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/worktree/fast
 */

import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readlink, stat, symlink, unlink } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

/** How the copy actually reached the destination, for the honest report. */
export type CopyMechanism = 'reflink' | 'copy' | 'mixed'

/** What one clone produced. */
export interface CopyTreeResult {
  /** Files written. */
  readonly files: number
  /** Files the filesystem shared extents for. */
  readonly cloned: number
  /** Files written out in full. */
  readonly copied: number
  /**
   * Symbolic links recreated as links rather than materialized as file content.
   *
   * Counted separately from `files` because it is the one part of the tree this
   * primitive does not materialize as content, and a caller reading `files` as
   * "everything in the copy" should not have to guess that.
   */
  readonly linked: number
  /** Which mechanism dominated; `mixed` when the filesystem answered differently per file. */
  readonly mechanism: CopyMechanism
  /** How many parallel copy chains ran. */
  readonly concurrency: number
}

/** The copy primitive, injectable so a test can present a filesystem without reflink. */
export interface CopyPrimitive {
  /** @param mode - a `COPYFILE_*` flag. */
  readonly copyFile: (from: string, to: string, mode: number) => Promise<void>
  /** The loud clone flag: throws when the filesystem cannot share extents. */
  readonly cloneForce: number
  /** The quiet clone flag: falls back to a full copy without saying so. */
  readonly clone: number
}

/** The real filesystem. */
export const NODE_COPY_PRIMITIVE: CopyPrimitive = {
  copyFile: async (from, to, mode) => { await copyFile(from, to, mode) },
  cloneForce: constants.COPYFILE_FICLONE_FORCE,
  clone: constants.COPYFILE_FICLONE,
}

/**
 * The default number of parallel copy chains.
 *
 * `availableParallelism()` rather than `cpus().length`: the former respects the
 * container's or cgroup's own limit, so a plugin running inside a small allocation
 * does not start sixteen chains on two available cores.
 * @returns a concurrency of at least one.
 */
export function defaultCopyConcurrency(): number {
  return Math.max(1, Math.min(16, availableParallelism()))
}

/**
 * Distribute an ordered list into `buckets` groups by a stable hash of the item.
 * @param items - the ordered list to distribute.
 * @param buckets - how many groups to spread it across; at least one is used.
 * @param keyOf - the stable key an item is hashed by, usually its path.
 * @returns One group per bucket, in bucket order, each keeping the input order.
 */
export function shard<T>(items: readonly T[], buckets: number, keyOf: (item: T) => string): readonly (readonly T[])[] {
  const groups: T[][] = Array.from({ length: Math.max(1, buckets) }, () => [])
  for (const item of items) {
    // A stable hash of the path itself, not the position: iteration order is not part
    // of the contract, and a position-based split would move a file between buckets
    // when an unrelated file is added — which is what makes a failure hard to repeat.
    groups[hash(keyOf(item)) % groups.length]!.push(item)
  }
  return groups
}

/** A small deterministic string hash (FNV-1a, 32-bit). */
function hash(value: string): number {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return result
}

/**
 * Clone one directory tree.
 *
 * The destination is created if needed and existing files are overwritten, because a
 * caller cloning into a warm directory is the ordinary case for a pooled worktree.
 * @param input - the source and destination, plus optional concurrency and primitive.
 * @returns what was written and which mechanism did it.
 */
export async function copyTree(input: {
  readonly from: string
  readonly to: string
  readonly concurrency?: number
  readonly primitive?: CopyPrimitive
}): Promise<CopyTreeResult> {
  const primitive = input.primitive ?? NODE_COPY_PRIMITIVE
  const concurrency = Math.max(1, input.concurrency ?? defaultCopyConcurrency())
  const entries = await readdir(input.from, { recursive: true, withFileTypes: true })
  // Directory links are classified first, because `readdir` reports the entries
  // *inside* one as ordinary entries of the walk. Copying those would write
  // through the link this clone is about to recreate — into the source tree the
  // link points at — so everything under a linked directory is dropped here.
  const linkRoots = new Set<string>()
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    const full = join(entry.parentPath, entry.name)
    // A `stat` that fails is a dangling link: it is a link in both strategies, so
    // it takes the link path rather than the copy path, which has no contents.
    if (await stat(full).then(info => info.isDirectory(), () => true)) linkRoots.add(`${full}${sep}`)
  }
  const files: string[] = []
  const links: string[] = []
  for (const entry of entries) {
    // Directories are created on demand when a file inside them is written, so the
    // walk only has to collect files; empty directories are not part of a working
    // copy's meaning and creating them would be a second traversal.
    if (entry.isDirectory()) continue
    const full = join(entry.parentPath, entry.name)
    let underLink = false
    for (const root of linkRoots) if (full.startsWith(root)) { underLink = true; break }
    if (underLink) continue
    if (!entry.isSymbolicLink()) {
      files.push(full)
      continue
    }
    // A Git checkout preserves symbolic links, including links to files. Turning
    // a file link into a regular file makes the fast clone behave differently
    // whenever its target is edited, so every link is recreated from its own
    // target text. Directory links additionally suppress their walked children
    // above, preventing a cyclic or pnpm-style link from duplicating a tree.
    links.push(full)
  }
  const counts = { cloned: 0, copied: 0 }
  const chains = shard(files, concurrency, file => relative(input.from, file))
  await Promise.all(chains.map(async (chain) => {
    for (const file of chain) {
      const destination = join(input.to, relative(input.from, file))
      await mkdir(dirname(destination), { recursive: true })
      // Ask loudly first: `COPYFILE_FICLONE_FORCE` throws where the filesystem cannot
      // share extents, and that throw is the only way to *know* a clone happened
      // rather than a silent fallback to a full copy.
      try {
        await primitive.copyFile(file, destination, primitive.cloneForce)
        counts.cloned += 1
      } catch {
        await primitive.copyFile(file, destination, primitive.clone)
        counts.copied += 1
      }
    }
  }))
  const linked = await Promise.all(links.map(async (source): Promise<number> => {
    const destination = join(input.to, relative(input.from, source))
    await mkdir(dirname(destination), { recursive: true })
    // Match copyFile's overwrite behavior for a warm destination. `unlink`
    // removes only a regular file or link; a directory collision still fails
    // rather than recursively deleting data the worktree does not own.
    await unlink(destination).catch((error: unknown) => {
      if ((error as { readonly code?: string }).code !== 'ENOENT') throw error
    })
    // The link's own target text is recreated verbatim: resolving it would turn
    // a relative link into an absolute one and make the copy non-portable. On
    // Windows a directory link needs its type declared.
    await symlink(
      await readlink(source),
      destination,
      process.platform === 'win32' && linkRoots.has(`${source}${sep}`) ? 'junction' : undefined,
    )
    return 1
  })).then(counts => counts.reduce((sum, value) => sum + value, 0))
  return {
    files: files.length,
    cloned: counts.cloned,
    copied: counts.copied,
    linked,
    mechanism: counts.cloned === 0 ? 'copy' : counts.copied === 0 ? 'reflink' : 'mixed',
    concurrency,
  }
}
