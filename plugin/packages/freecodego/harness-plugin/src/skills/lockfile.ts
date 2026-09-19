/**
 * The skill lockfile: skills as reproducible dependencies.
 *
 * Why a lockfile rather than the cache that exists
 * -----------------------------------------------
 * A skill directory under `$DSH_HOME` reproduces nothing. Two machines install
 * "the same" skill and get different content, because a repository's default
 * branch moved between them, and neither machine can say which revision it has.
 * The lockfile records the resolved commit and a per-file digest, so "installed"
 * becomes a claim that can be checked rather than assumed.
 *
 * `resolvedCommit` is what `upgrade` pins to; `ref` is only ever used for the
 * *first* resolution. That distinction is the entire value: an upgrade that
 * re-resolves a branch tag is not an upgrade, it is a second install.
 *
 * This is not the same record as `plugin-update.ts`, and the difference is worth
 * stating because they look alike: `plugin-update` tracks the *plugin package*,
 * and this tracks *skill content*. They share the atomic-promote technique and
 * nothing else — sharing the record would mean a plugin rollback silently
 * reverting the skills too.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/lockfile
 */

import { createHash } from 'node:crypto'
import { redactCredentialShapes } from '../secret-scan.ts'

/** File name of the lockfile inside the skill state directory. */
export const SKILL_LOCK_FILENAME = 'skill-lock.json'

/** Lockfile schema version this build writes. */
export const SKILL_LOCK_VERSION = 1

/** One file inside an installed skill. */
export interface LockedFile {
  /** Path relative to the skill root. */
  readonly path: string
  /** `sha256` hex of the file's bytes. */
  readonly sha256: string
}

/** One installed skill. */
export interface LockedSkill {
  /** The source as the user spelled it, for display and for re-resolution. */
  readonly source: string
  /** The commit the content was taken from; what an upgrade pins to. */
  readonly resolvedCommit: string
  /** Digest of the whole skill payload. */
  readonly integrity: string
  readonly files: readonly LockedFile[]
  /** Which root the skill was placed in. */
  readonly root: string
  readonly installedAt: string
}

/** The lockfile document. */
export interface SkillLockfile {
  readonly version: number
  readonly skills: Readonly<Record<string, LockedSkill>>
}

/** An empty lockfile. */
export function emptyLockfile(): SkillLockfile {
  return { version: SKILL_LOCK_VERSION, skills: {} }
}

/** Why a lockfile was refused. */
export interface LockfileIssue {
  readonly reason: string
}

/** The parse outcome. */
export type LockfileParseResult =
  | { readonly ok: true; readonly lockfile: SkillLockfile }
  | { readonly ok: false; readonly issue: LockfileIssue }

/**
 * Parse a lockfile, refusing anything not exactly in this build's schema.
 *
 * A future version is refused rather than read optimistically: an unknown
 * version means a field exists that this build does not know the meaning of, and
 * treating `resolvedCommit` as pinned when a later schema redefined it would
 * silently install content nobody asked for.
 * @param text - the file's text.
 * @returns the lockfile, or the reason it cannot be used.
 */
export function parseLockfile(text: string): LockfileParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Masked: the lockfile arrives with a community install, and the reason here
    // is thrown by the installer. V8 quotes only the first ten characters of the
    // text it failed on, so a prefixed key cannot come out whole; this covers the
    // shapes short enough to fit inside that window.
    return { ok: false, issue: { reason: `not valid JSON: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}` } }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, issue: { reason: 'a lockfile must be an object' } }
  }
  const candidate = parsed as { version?: unknown; skills?: unknown }
  if (candidate.version !== SKILL_LOCK_VERSION) {
    return { ok: false, issue: { reason: `lockfile version ${String(candidate.version)} is not the version this build writes (${SKILL_LOCK_VERSION})` } }
  }
  if (typeof candidate.skills !== 'object' || candidate.skills === null || Array.isArray(candidate.skills)) {
    return { ok: false, issue: { reason: '`skills` must be an object' } }
  }
  const skills: Record<string, LockedSkill> = {}
  for (const [name, entry] of Object.entries(candidate.skills)) {
    const read = readLockedSkill(entry)
    if ('issue' in read) return { ok: false, issue: { reason: `${name}: ${read.issue}` } }
    skills[name] = read.skill
  }
  return { ok: true, lockfile: { version: SKILL_LOCK_VERSION, skills } }
}

/** Read one lockfile entry. */
function readLockedSkill(entry: unknown): { readonly skill: LockedSkill } | { readonly issue: string } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { issue: 'must be an object' }
  const record = entry as Record<string, unknown>
  const source = record.source
  const resolvedCommit = record.resolvedCommit
  const integrity = record.integrity
  const root = record.root
  const installedAt = record.installedAt
  if (typeof source !== 'string' || source === '') return { issue: 'has no source' }
  if (typeof resolvedCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(resolvedCommit)) return { issue: 'resolvedCommit must be a hex commit id' }
  if (typeof integrity !== 'string' || !integrity.startsWith('sha256-')) return { issue: 'integrity must be a sha256- digest' }
  if (typeof root !== 'string' || root === '') return { issue: 'has no root' }
  if (typeof installedAt !== 'string' || Number.isNaN(Date.parse(installedAt))) return { issue: 'installedAt must be an ISO timestamp' }
  if (!Array.isArray(record.files)) return { issue: 'files must be an array' }
  const files: LockedFile[] = []
  for (const file of record.files) {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) return { issue: 'every file entry must be an object' }
    const item = file as Record<string, unknown>
    if (typeof item.path !== 'string' || item.path === '') return { issue: 'a file entry has no path' }
    // A backslash is a separator on Windows and an ordinary character elsewhere, so
    // it is refused rather than translated: `..\..\x` is one segment to
    // `split('/')` and therefore invisible to the `..` check below, while a joiner
    // that hands the whole segment to the filesystem does resolve it. The payload
    // paths this file records are produced by `skills/installer.ts`, which refuses a
    // backslash for the same reason, so nothing this build writes is rejected here.
    if (item.path.includes('\\')) return { issue: `file path "${item.path}" uses a backslash; lockfile paths are forward-slashed relative paths` }
    if (item.path.startsWith('/') || item.path.split('/').includes('..')) return { issue: `file path "${item.path}" escapes the skill root` }
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) return { issue: `file "${item.path}" has no valid sha256` }
    files.push({ path: item.path, sha256: item.sha256 })
  }
  return { skill: { source, resolvedCommit, integrity, files, root, installedAt } }
}

/**
 * Order two files by path, byte-wise.
 *
 * Deliberately not `localeCompare`: these diffs feed the payload digest, and the
 * digest is written in one process and compared in another. `localeCompare`
 * orders `scripts/x` before `SKILL.md` under ICU collation and the reverse under
 * byte order, so a lockfile written on one machine and verified on another would
 * report that files were "added or removed" while nothing had changed.
 * @param left - one file.
 * @param right - the other.
 * @returns the comparison, in byte order.
 */
export function compareByPath(left: LockedFile, right: LockedFile): number {
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}

/** Serialize a lockfile deterministically. */
export function serializeLockfile(lockfile: SkillLockfile): string {
  const skills: Record<string, LockedSkill> = {}
  for (const name of Object.keys(lockfile.skills).sort()) {
    const skill = lockfile.skills[name]!
    skills[name] = { ...skill, files: [...skill.files].sort(compareByPath) }
  }
  return `${JSON.stringify({ version: lockfile.version, skills }, null, 2)}\n`
}

/** Digest one file's bytes the way the lockfile records them. */
export function digestFile(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Digest a whole skill payload, order-independently. */
export function digestSkill(files: readonly LockedFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort(compareByPath)) {
    hash.update(file.path)
    hash.update('\u0000')
    hash.update(file.sha256)
    hash.update('\u0001')
  }
  return `sha256-${hash.digest('base64')}`
}

/** Why an installed skill no longer matches the lockfile. */
export interface SkillVerificationFailure {
  readonly name: string
  readonly reason: string
  readonly path?: string
}

/**
 * Verify installed content against the lockfile.
 *
 * Both halves are checked — the whole-payload digest and every file's digest —
 * because they fail differently. A wrong file digest says *which* file drifted; a
 * wrong payload digest says something was added or removed, which no per-file
 * check can see.
 * @param lockfile - the recorded state.
 * @param installed - the content found on disk, keyed by skill name.
 * @returns the first failure per skill, or an empty array when everything matches.
 */
export function verifyInstalledSkills(
  lockfile: SkillLockfile,
  installed: Readonly<Record<string, readonly LockedFile[]>>,
): readonly SkillVerificationFailure[] {
  const failures: SkillVerificationFailure[] = []
  for (const [name, expected] of Object.entries(lockfile.skills)) {
    const actual = installed[name]
    if (actual === undefined) {
      failures.push({ name, reason: 'the skill is recorded as installed but was not found' })
      continue
    }
    const byPath = new Map(actual.map(file => [file.path, file.sha256]))
    for (const file of expected.files) {
      const digest = byPath.get(file.path)
      if (digest === undefined) {
        failures.push({ name, path: file.path, reason: 'recorded file is missing' })
        continue
      }
      if (digest !== file.sha256) failures.push({ name, path: file.path, reason: 'file content changed since it was installed' })
    }
    if (failures.some(failure => failure.name === name)) continue
    const payload = digestSkill(actual)
    if (payload !== expected.integrity) {
      failures.push({ name, reason: `the installed payload does not match the recorded integrity (${expected.integrity}); files were added or removed` })
    }
  }
  return failures
}
