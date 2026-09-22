/**
 * Forgetting with precise evidence, never with a pattern.
 *
 * The design problem
 * -----------------
 * "Forget what you know about X" is the request users make, and it is the one
 * request this subsystem must not answer directly. Turning X into a set of files
 * requires a *decision about relevance*, and a decision that lands slightly too
 * broadly has just deleted records the user wanted to keep — with no undo, in a
 * store whose entire value is that it remembers.
 *
 * So the caller does the one thing only the caller can do: it reads the bytes it
 * intends to remove and hands them over with their hash. The bytes are the
 * evidence. This module's job is then purely mechanical — verify the evidence
 * against the file on disk, and remove exactly that file.
 *
 * The seven refusals, and why each is a refusal rather than a warning
 * ------------------------------------------------------------------
 * A directory or a glob is refused because "everything under here" is a decision
 * again, and the evidence for it is not something a caller can have read. A hash
 * mismatch is refused because the file changed since it was read, so the caller
 * would be deleting something it never saw — the classic case being a topic that
 * a concurrent dream rewrote between the read and the forget. A path that escapes
 * the archive root, or that resolves through a symlink, is refused because the
 * evidence describes a file and not a route to a different file. Protected files
 * — the manifest and the schema — are refused because they are structure, not
 * content. An archive this build does not know is refused because it cannot say
 * what its records mean. A live lease is refused because a dream is mid-write.
 *
 * Ordering is not a detail: the tombstone and the audit record are written
 * *before* the delete. A tombstone after the delete means a crash between the two
 * leaves content gone with no record that anyone asked for it to be gone, which
 * is indistinguishable from corruption.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/forget
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Why a forget request was refused. Each has a test. */
export type ForgetRefusal =
  | 'broad-request'
  | 'stale-evidence'
  | 'path-traversal'
  | 'symlink'
  | 'protected'
  | 'unknown-archive'
  | 'lease-active'

/** The outcome of a forget request. */
export type ForgetResult =
  | { readonly ok: true; readonly path: string; readonly tombstone: string; readonly audit: string }
  | { readonly ok: false; readonly refusal: ForgetRefusal; readonly message: string }

/** Files that are structure rather than content, and never forgettable. */
export const PROTECTED_MEMORY_FILES: readonly string[] = ['MEMORY.md', 'manifest.json', 'schema.json']

/** A record the caller read, and the hash of exactly what it read. */
export interface ForgetEvidence {
  /** Path to the file, relative to `root` or absolute. */
  readonly path: string
  /** `sha256` hex of the bytes the caller read. */
  readonly sha256: string
}

/** Where a forget request may act, and what it may consult. */
export interface ForgetContext {
  /** The observations archive root; nothing outside it may be removed. */
  readonly root: string
  /** Directory the tombstone and audit records are written into. */
  readonly tombstoneRoot: string
  /** True while a dream holds its lease; forbids forgetting mid-consolidation. */
  readonly leaseActive: boolean
  /** Archives this build knows how to read. */
  readonly knownArchives?: readonly string[]
  /**
   * Injected writer, so the ordering can be asserted without touching disk.
   *
   * Whole-file semantics, which is what a tombstone wants: one file per forgotten
   * path, so a second forget of the same path replaces its record rather than
   * stacking a second one.
   */
  readonly write?: (path: string, contents: string) => void
  /**
   * Injected appender for the audit log.
   *
   * Separate from {@link write} because the audit log is the *opposite* shape: one
   * line per forget, and a writer that replaced the file would leave the trail with
   * a single entry — the one thing an audit log may not do.
   */
  readonly append?: (path: string, contents: string) => void
  /** Injected remover, so a refusal matrix needs no real files. */
  readonly remove?: (path: string) => void
  /** Injected existence check. */
  readonly exists?: (path: string) => boolean
  /** Injected reader, for the evidence check. */
  readonly read?: (path: string) => string
  /** Injected symlink check. */
  readonly isSymlink?: (path: string) => boolean
  /** Injected real-path resolver. */
  readonly realPath?: (path: string) => string
}

/** Hash the bytes of a file the way the evidence format specifies.
 * @param bytes - the file contents to hash.
 * @returns the hex SHA-256 digest.
 */
export function hashEvidence(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Refuse a request that names a set rather than a file.
 * @param path - the requested path.
 * @returns the refusal when the request is broad, otherwise undefined.
 */
function refuseBroad(path: string): ForgetResult | undefined {
  const hasGlob = /[*?[\]{}]/.test(path)
  if (hasGlob) {
    return { ok: false, refusal: 'broad-request', message: 'a glob is a set, and a set has no evidence to check; name one file at a time' }
  }
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed !== path) {
    return { ok: false, refusal: 'broad-request', message: 'a directory is a set, and a set has no evidence to check; name one file at a time' }
  }
  return undefined
}

/**
 * Forget exactly one file, given the bytes the caller read.
 * @param evidence - the file and the hash of the bytes the caller read.
 * @param context - roots, lease state, and the injected file operations.
 * @returns the outcome; a refusal is an answer, not an exception.
 */
export function forgetObservation(evidence: ForgetEvidence, context: ForgetContext): ForgetResult {
  const broad = refuseBroad(evidence.path)
  if (broad !== undefined) return broad

  if (context.leaseActive) {
    return { ok: false, refusal: 'lease-active', message: 'a consolidation pass holds the archive lease; retry once it finishes so the evidence still describes the file' }
  }

  const base = resolve(context.root)
  const target = isAbsolute(evidence.path) ? resolve(evidence.path) : resolve(base, evidence.path)
  const escapes = relative(base, target)
  // A `..` *step* is a climb, and so is `..${sep}…`; a name that merely begins
  // with two dots (`..notes.json`) is a file inside the root. The check used to be
  // a bare `startsWith('..')`, which refused that file as traversal and said so in
  // a message about a root it had never left — a record that could not be
  // forgotten, with no reason a reader could act on.
  const climbsOut = escapes === '..' || escapes.startsWith(`..${sep}`)
  if (climbsOut) {
    return { ok: false, refusal: 'path-traversal', message: `"${evidence.path}" resolves outside the archive root` }
  }
  // The root itself is not a record; saying "outside" about it sends the reader
  // looking for a path that is not there.
  if (isAbsolute(escapes) || escapes === '') {
    return { ok: false, refusal: 'path-traversal', message: `"${evidence.path}" resolves to the archive root itself, which is not a record; name one file inside it` }
  }

  const name = target.split(sep).pop() ?? ''
  if (PROTECTED_MEMORY_FILES.includes(name)) {
    return { ok: false, refusal: 'protected', message: `"${name}" is memory structure, not a record; forgetting it would remove the index rather than what the index points at` }
  }
  // The same question asked by identity rather than by spelling, and asked *here*
  // rather than after the archive guard: a case-insensitive filesystem reaches one
  // file through both spellings (`memory.md` is `MEMORY.md`), so the name check
  // above misses it while the evidence check below passes on the same bytes and the
  // delete lands on the index. The name beside a protected file, spelled the way
  // the list spells it, leading to *this* file is the question that holds on a
  // case-insensitive filesystem without refusing a genuinely different lowercase
  // file where those are two files.
  const structuralName = PROTECTED_MEMORY_FILES.find(candidate => candidate !== name && isSameFile(target, join(dirname(target), candidate)))
  if (structuralName !== undefined) {
    return { ok: false, refusal: 'protected', message: `"${evidence.path}" is "${structuralName}", memory structure rather than a record; forgetting it would remove the index rather than what the index points at` }
  }

  const archive = target.split(sep).slice(-2, -1)[0]
  const known = context.knownArchives
  if (known !== undefined && archive !== undefined && !known.includes(archive)) {
    return { ok: false, refusal: 'unknown-archive', message: `"${archive}" is not an archive this build knows (${known.join(', ')}); its records cannot be interpreted` }
  }

  const stat = statPath(target, context)
  if (stat === undefined) {
    // A missing file is not a silent success: the caller's evidence described
    // something, and if it is gone the caller's model of the archive is wrong.
    return { ok: false, refusal: 'stale-evidence', message: `"${evidence.path}" no longer exists, so the evidence cannot describe it` }
  }
  if (stat.symlink) {
    return { ok: false, refusal: 'symlink', message: `"${evidence.path}" is a symlink; evidence describes a file, not a route to another one` }
  }
  if (stat.directory) {
    // The trailing-slash spelling of this request is already refused as a set
    // (see `refuseBroad`); without this, the natural spelling travels on to
    // `readFileSync` and leaves as an `EISDIR` exception, which is the one thing
    // this matrix promises not to do. Only the real filesystem can answer it — the
    // injected ports have no stat — so a caller that injects them owns that case.
    return { ok: false, refusal: 'broad-request', message: `"${evidence.path}" is a directory, and a directory is a set with no evidence to check; name one file at a time` }
  }

  const realBase = realPathOf(base, context)
  const realTarget = realPathOf(target, context)
  if (realBase !== undefined && realTarget !== undefined && !isWithin(realTarget, realBase)) {
    return { ok: false, refusal: 'path-traversal', message: `"${evidence.path}" resolves outside the archive root through a link` }
  }


  const bytes = readPath(target, context)
  if (hashEvidence(bytes) !== evidence.sha256) {
    return { ok: false, refusal: 'stale-evidence', message: `"${evidence.path}" changed since it was read; the caller would be deleting bytes it never saw` }
  }

  // Tombstone and audit first: a crash between write and delete must leave a
  // record that someone asked, which is the difference between intent and
  // corruption.
  const relativePath = escapes.split(sep).join('/')
  const tombstone = join(context.tombstoneRoot, `${hashEvidence(relativePath).slice(0, 16)}.tombstone`)
  const audit = join(context.tombstoneRoot, 'audit.log')
  writePath(tombstone, `${JSON.stringify({ path: relativePath, sha256: evidence.sha256 })}\n`, context)
  appendPath(audit, `${JSON.stringify({ at: new Date().toISOString(), path: relativePath, sha256: evidence.sha256, outcome: 'forgotten' })}\n`, context)
  removePath(target, context)
  return { ok: true, path: relativePath, tombstone, audit }
}

/**
 * Look at a path, tolerating a missing one, and report whether it is a directory.
 *
 * The directory answer comes from the real filesystem only: the injected ports
 * describe a path for a refusal matrix, and none of them stats. That is enough for
 * every refusal but this one, which exists because "a directory is a set" has to
 * hold for the spelling without the trailing slash too.
 */
function statPath(path: string, context: ForgetContext): { readonly symlink: boolean; readonly directory: boolean } | undefined {
  if (context.exists !== undefined || context.isSymlink !== undefined) {
    const exists = context.exists?.(path) ?? true
    if (!exists) return undefined
    return { symlink: context.isSymlink?.(path) ?? false, directory: false }
  }
  if (!existsSync(path)) return undefined
  const stats = lstatSync(path)
  return { symlink: stats.isSymbolicLink(), directory: stats.isDirectory() }
}

/** Resolve a path through links, when the path exists. */
function realPathOf(path: string, context: ForgetContext): string | undefined {
  if (context.realPath !== undefined) return context.realPath(path)
  if (!existsSync(path)) return undefined
  return realpathSync(path)
}

/** Read a path through the injected reader, or from disk. */
function readPath(path: string, context: ForgetContext): string {
  if (context.read !== undefined) return context.read(path)
  return readFileSync(path, 'utf8')
}

/**
 * Whether two names lead to one file.
 *
 * The volume and inode pair, compared as bigints because a Windows file index is
 * wider than a double can hold. Two stats that fail are two different files as far
 * as a refusal is concerned: this check may add a refusal, never remove one.
 * @param path - the requested target.
 * @param sibling - the protected name beside it.
 * @returns whether both lead to the same file.
 */
function isSameFile(path: string, sibling: string): boolean {
  try {
    const target = statSync(path, { bigint: true })
    const incumbent = statSync(sibling, { bigint: true })
    return target.dev === incumbent.dev && target.ino === incumbent.ino
  } catch {
    return false
  }
}

/**
 * Whether a resolved path is the root itself or inside it.
 *
 * By whole segments rather than by string prefix, which is the difference between a
 * check and a check-shaped thing: `/srv/memory-backup/x` starts with `/srv/memory`,
 * and a directory link inside the archive pointing at such a sibling is exactly the
 * route this test exists to refuse. A missing separator is not a smaller version of
 * the check; it is the half of it that a name coincidence defeats.
 * @param realTarget - the target's resolved path.
 * @param realBase - the root's resolved path.
 * @returns whether the target is contained by the root.
 */
function isWithin(realTarget: string, realBase: string): boolean {
  if (realTarget === realBase) return true
  const boundary = realBase.endsWith(sep) ? realBase : `${realBase}${sep}`
  return realTarget.startsWith(boundary)
}

/**
 * Write a path whole, through the injected writer or to disk.
 *
 * The fallback is why this is a function rather than an optional call: with no writer
 * injected the tombstone used not to be written at all, while the result still named
 * it and the ordering argument above still claimed a crash could not lose the intent.
 * A failed write throws here, before the delete, which is the order that argument
 * depends on.
 * @param path - the file to replace.
 * @param contents - its complete contents.
 * @param context - the injected ports.
 */
function writePath(path: string, contents: string, context: ForgetContext): void {
  if (context.write !== undefined) {
    context.write(path, contents)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

/**
 * Append to a path, through the injected appender or to disk.
 * @param path - the log to append to.
 * @param contents - the line to add.
 * @param context - the injected ports.
 */
function appendPath(path: string, contents: string, context: ForgetContext): void {
  if (context.append !== undefined) {
    context.append(path, contents)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, contents, 'utf8')
}

/** Remove a path through the injected remover, or from disk. */
function removePath(path: string, context: ForgetContext): void {
  if (context.remove !== undefined) {
    context.remove(path)
    return
  }
  // `force` is deliberately absent: the evidence check above proved the file
  // exists, so a missing file here means something else removed it and that is
  // worth an exception rather than a quiet success.
  rmSync(path)
}
