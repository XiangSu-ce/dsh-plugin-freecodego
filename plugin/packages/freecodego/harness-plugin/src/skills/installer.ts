/**
 * Installing a skill: staged, validated, and promoted atomically.
 *
 * Why an installer rather than a copy
 * ----------------------------------
 * A skill directory is read by an agent at discovery time. A copy that fails
 * halfway leaves a skill whose `SKILL.md` promises tools that are not there, and
 * every later session reads that half-skill as if it were whole — nothing in the
 * system can tell an interrupted install from an intentionally small one. So the
 * payload is materialized somewhere else, checked, and then **renamed** into
 * place: `rename` on one filesystem is the only step here that cannot half-happen.
 *
 * The three rules this file exists to enforce
 * ------------------------------------------
 * 1. **Nothing appears at the destination until the payload is complete.** The
 *    staging directory lives *under the destination's parent* rather than in the
 *    system temp directory, because a rename across filesystems is a copy, and a
 *    copy is exactly the non-atomic step this is avoiding.
 * 2. **A replaced skill is recoverable.** If a skill of the same name is already
 *    installed it is renamed aside first, and renamed back if the promotion
 *    fails — an upgrade that fails must leave the previous version working.
 * 3. **The lockfile is written last.** It is what tells the next session what is
 *    installed, so writing it before the files exist would make it the record of
 *    an install that did not happen. A promotion that succeeded but whose
 *    lockfile write failed is reported as exactly that, with the skill's path, so
 *    the mismatch is visible rather than silent.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/installer
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  SKILL_LOCK_FILENAME,
  compareByPath,
  digestFile,
  digestSkill,
  emptyLockfile,
  parseLockfile,
  serializeLockfile,
  type LockedFile,
  type LockedSkill,
  type SkillLockfile,
} from './lockfile.ts'

/** One file of a skill payload, as the fetcher produced it. */
export interface SkillPayloadFile {
  /** Path relative to the skill root, forward-slashed. */
  readonly path: string
  readonly contents: string
}

/** The skill to install. */
export interface SkillPayload {
  /** Directory name the skill will occupy, and its name in the lockfile. */
  readonly name: string
  readonly files: readonly SkillPayloadFile[]
}

/** The filesystem operations the installer needs, injected so failures are testable. */
export interface InstallerFs {
  readonly mkdir: (path: string) => Promise<void>
  readonly writeFile: (path: string, contents: string) => Promise<void>
  readonly readFile: (path: string) => Promise<string | undefined>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
}

/** The real filesystem, as the installer uses it. */
export const NODE_INSTALLER_FS: InstallerFs = {
  mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }) },
  writeFile: async (path, contents) => { await writeFile(path, contents, { mode: 0o600 }) },
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
  rename: async (from, to) => { await rename(from, to) },
  remove: async (path) => { await rm(path, { recursive: true, force: true }) },
}

/** What an install did. */
export interface InstallOutcome {
  readonly skill: LockedSkill
  /** The version this install replaced, when there was one. */
  readonly replacedCommit?: string
  /** Whether the lockfile now records this skill. */
  readonly locked: boolean
  /** The steps taken, in order — the evidence `--verbose` prints. */
  readonly steps: readonly string[]
  /** Set when the files are in place but the lockfile could not be updated. */
  readonly lockfileWarning?: string
}

/** Why an install was refused before anything was written. */
export interface InstallRefusal {
  readonly refused: string
}

/**
 * Screen a payload name before it is used as a path segment.
 *
 * The same screen the persona and plan-file stores apply, for the same reason: a
 * name that reaches `join` unchecked is a name that can leave the root.
 * @param name - the requested skill name.
 * @returns the name, or the reason it cannot be used.
 */
export function validateSkillName(name: string): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string } {
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: 'a skill needs a name' }
  if (name.length > 64) return { ok: false, reason: `the skill name is ${name.length} characters; the limit is 64` }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return { ok: false, reason: `"${name}" is not a single directory name` }
  }
  if (/[\u0000-\u001f<>:"|?*]/u.test(name)) return { ok: false, reason: `"${name}" contains a character no path segment may carry` }
  return { ok: true, name }
}

/** Device names Windows resolves to something other than a file. */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  ...['com', 'lpt'].flatMap(prefix => ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit => `${prefix}${digit}`)),
])

/**
 * Whether one path segment is a name this platform cannot create.
 *
 * The extension is stripped before the test because `nul.txt` is the device too:
 * Windows resolves the name before the extension.
 * @param segment - one forward-slashed path segment.
 * @returns true when the segment names a reserved device.
 */
function isReservedDeviceName(segment: string): boolean {
  const stem = segment.split('.')[0]?.toLowerCase() ?? ''
  return WINDOWS_DEVICE_NAMES.has(stem)
}

/**
 * Screen a payload's file list.
 *
 * Every refusal here is a file that would land outside the skill root, be
 * written twice, or — on Windows — be written nowhere at all, which is why the
 * check runs before any directory is made: a rejection that has already created a
 * staging tree has already written something.
 * @param files - the payload's files.
 * @returns the files, or the reason the payload is refused as a whole.
 */
export function validatePayloadFiles(files: readonly SkillPayloadFile[]): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (files.length === 0) return { ok: false, reason: 'the payload has no files' }
  const seen = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    if (file.path === '' || file.path.startsWith('/') || /^[A-Za-z]:/u.test(file.path)) {
      return { ok: false, reason: `"${file.path}" is not a relative path` }
    }
    if (segments.some(segment => segment === '..' || segment === '' || segment === '.')) {
      return { ok: false, reason: `"${file.path}" contains a path segment that would leave the skill root` }
    }
    // A backslash is a separator on Windows and an ordinary character everywhere
    // else, so splitting on `/` alone would leave `a\..\..\b` as one innocent-looking
    // segment and let `join` resolve it out of the staging root on the one platform
    // where it parses. The field contract is forward-slashed, and this is where that
    // contract is enforced rather than assumed.
    if (file.path.includes('\\')) {
      return { ok: false, reason: `"${file.path}" uses a backslash; payload paths are forward-slashed relative paths` }
    }
    // Checked on every platform rather than only on Windows: the payload is
    // installed into a shared root another machine may read, so a name that cannot
    // exist on one of them is refused everywhere rather than producing an install
    // that verifies here and never does there.
    const reserved = segments.find(isReservedDeviceName)
    if (reserved !== undefined) {
      return { ok: false, reason: `"${file.path}" contains "${reserved}", a name this filesystem may resolve to a device rather than a file` }
    }
    if (seen.has(file.path)) return { ok: false, reason: `"${file.path}" appears twice in the payload` }
    seen.add(file.path)
  }
  return { ok: true }
}

/**
 * Write a state document so a failure cannot leave a half-written one.
 *
 * The lockfile is read before every install and remove, and a malformed one is
 * **refused** rather than treated as empty (`readLockfile` throws, deliberately, so
 * a newer schema is not overwritten). Put together, an in-place write torn by a
 * crash does not merely lose a file: its truncated JSON refuses every later install
 * and removal until somebody deletes the lockfile by hand. Writing a sibling temp
 * file and renaming it into place makes the visible state the old document or the
 * new one, never a mixture.
 *
 * The temp file is a sibling rather than a system-temp entry because a rename
 * across filesystems is a copy, and a copy is the non-atomic step being avoided.
 * What is *not* reproduced here is `@deepseek-ai/dsh-atomic-write`'s retry around
 * Windows' transient `EACCES`/`EBUSY`/`EPERM` rename failures: this module's writes
 * go through the injected port, which is also how the tests produce a failure, and
 * a port that only the real implementation can satisfy would take that ability away.
 * A rename that fails anyway is reported the same way the write failure is.
 * @param fs - the injected filesystem.
 * @param path - the document's final path.
 * @param text - the complete next contents.
 */
async function writeStateFile(fs: InstallerFs, path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, text)
    await fs.rename(temp, path)
  } catch (error) {
    await fs.remove(temp).catch(() => undefined)
    throw error
  }
}

/**
 * A staging directory inside the destination's root.
 *
 * One path segment — a prefix and one opaque token — and deliberately not derived
 * from the skill name: it is under the same parent as the destination, which is
 * what makes the promotion a rename rather than a cross-filesystem copy.
 */
function stagingPath(root: string): string {
  return join(root, `.freecodego-staging-${randomUUID()}`)
}

function backupPath(root: string): string {
  return join(root, `.freecodego-backup-${randomUUID()}`)
}

/**
 * Install one skill into a root.
 * @param request - the payload, its destination root, and where the lockfile lives.
 * @returns what was installed, or a refusal with nothing written.
 */
export async function installSkill(
  request: {
    readonly payload: SkillPayload
    /** The skills root, e.g. `<workspace>/.dsh/skills`. */
    readonly root: string
    /** The source as the user spelled it, recorded in the lockfile. */
    readonly source: string
    /**
     * The commit the content came from, when the source has one.
     *
     * Omitted for a source that has no version control behind it — a local
     * directory, a tarball — and then a **content id** is derived instead
     * ({@link payloadCommitId}). What must never happen is a placeholder: the
     * lockfile's whole job is pinning, and a value that does not change when the
     * content does pins nothing.
     */
    readonly resolvedCommit?: string
    /** Directory holding `skill-lock.json`; usually the parent of `root`. */
    readonly stateDirectory: string
    readonly now?: () => string
  },
  fs: InstallerFs = NODE_INSTALLER_FS,
): Promise<InstallOutcome | InstallRefusal> {
  const name = validateSkillName(request.payload.name)
  if (!name.ok) return { refused: name.reason }
  const files = validatePayloadFiles(request.payload.files)
  if (!files.ok) return { refused: files.reason }

  const steps: string[] = []
  const staging = stagingPath(request.root)
  const destination = join(request.root, name.name)
  // Read the record before anything is written: it is what tells an upgrade from
  // a first install, and the answer has to be from before this call's writes.
  let previous: LockedSkill | undefined
  const lockfilePath = join(request.stateDirectory, SKILL_LOCK_FILENAME)
  try {
    previous = (await readLockfile(fs, lockfilePath)).skills[name.name]
  } catch (error) {
    // A lockfile this build cannot use is a refusal rather than a reset: writing
    // over it would discard what a newer build recorded.
    return { refused: error instanceof Error ? error.message : String(error) }
  }

  try {
    await fs.mkdir(staging)
    steps.push(`staged at ${staging}`)
    for (const file of request.payload.files) {
      const target = join(staging, ...file.path.split('/'))
      await fs.mkdir(dirname(target))
      await fs.writeFile(target, file.contents)
    }
    steps.push(`wrote ${request.payload.files.length} file(s) into staging`)
  } catch (error) {
    // Nothing at the destination was touched, so a failure here is a failure to
    // install and never a partially replaced skill.
    await fs.remove(staging).catch(() => undefined)
    return { refused: `staging failed and nothing was installed: ${error instanceof Error ? error.message : String(error)}` }
  }

  const lockedFiles: LockedFile[] = request.payload.files
    .map(file => ({ path: file.path, sha256: digestFile(file.contents) }))
    .sort(compareByPath)
  const resolvedCommit = request.resolvedCommit ?? payloadCommitId(lockedFiles)

  // Promote. A previous install of the same name is moved aside first, and put
  // back if the promotion fails: an upgrade that fails must leave the working
  // version working.
  let backup: string | undefined
  await fs.mkdir(request.root).catch(() => undefined)
  {
    const candidate = backupPath(request.root)
    try {
      // A rename is the existence probe as well as the move: one operation, so
      // there is no window between "is it there" and "move it" for another
      // installer to slip into.
      await fs.rename(destination, candidate)
      backup = candidate
      steps.push(`moved the existing skill aside to ${candidate}`)
    } catch (error) {
      const code = (error as { readonly code?: string }).code
      // ENOENT is the ordinary case — nothing installed under this name yet.
      if (code !== 'ENOENT') {
        // Anything else means the destination is there and could not be moved
        // aside, so promoting over it would not be atomic. Refused, with nothing
        // written.
        await fs.remove(staging).catch(() => undefined)
        return { refused: `the existing skill at ${destination} could not be moved aside: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }

  try {
    await fs.rename(staging, destination)
    steps.push(`promoted into ${destination}`)
  } catch (error) {
    if (backup !== undefined) {
      await fs.rename(backup, destination).catch(() => undefined)
      steps.push('restored the previous version')
    }
    await fs.remove(staging).catch(() => undefined)
    return { refused: `promotion failed: ${error instanceof Error ? error.message : String(error)}${backup === undefined ? '' : '; the previous version was restored'}` }
  }
  if (backup !== undefined) await fs.remove(backup).catch(() => undefined)

  const skill: LockedSkill = {
    source: request.source,
    resolvedCommit,
    integrity: digestSkill(lockedFiles),
    files: lockedFiles,
    root: request.root,
    installedAt: request.now?.() ?? new Date().toISOString(),
  }

  try {
    const current = await readLockfile(fs, lockfilePath)
    const next: SkillLockfile = { version: current.version, skills: { ...current.skills, [name.name]: skill } }
    await fs.mkdir(request.stateDirectory)
    await writeStateFile(fs, lockfilePath, serializeLockfile(next))
    steps.push(`recorded in ${lockfilePath}`)
    return {
      skill,
      locked: true,
      steps,
      ...(previous === undefined ? {} : { replacedCommit: previous.resolvedCommit }),
    }
  } catch (error) {
    // The files are in place; saying "installed" without saying "unrecorded"
    // would make the next session's verification report a skill nobody
    // installed, which is worse than an install the user has to repeat.
    return {
      skill,
      locked: false,
      steps,
      lockfileWarning: `the skill was installed at ${destination} but could not be recorded in ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}. Re-run the install to record it; until then verification reports it as unrecorded.`,
    }
  }
}

/**
 * A content id for a payload whose source has no commit.
 *
 * 40 hex characters, because the lockfile schema validates `resolvedCommit` as a
 * commit id and that constraint is worth keeping: it is what stops a placeholder
 * like `"latest"` from being recorded as a pin. Derived from every file's path
 * and digest in sorted order, so the id changes exactly when the content does.
 * @param files - the payload's files, already digested.
 * @returns a stable hex id.
 */
export function payloadCommitId(files: readonly LockedFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort(compareByPath)) {
    hash.update(file.path)
    hash.update('\u0000')
    hash.update(file.sha256)
    hash.update('\u0001')
  }
  return hash.digest('hex').slice(0, 40)
}

/** Read a lockfile, treating an absent or unusable one as empty rather than failing. */
async function readLockfile(fs: InstallerFs, path: string): Promise<SkillLockfile> {
  const text = await fs.readFile(path)
  if (text === undefined) return emptyLockfile()
  const parsed = parseLockfile(text)
  // A lockfile from a newer build is refused by `parseLockfile`; installing over
  // it would drop whatever that build recorded, so the refusal propagates and
  // the caller sees the reason instead of a silently rewritten file.
  if (!parsed.ok) throw new Error(`the existing ${SKILL_LOCK_FILENAME} cannot be used: ${parsed.issue.reason}`)
  return parsed.lockfile
}

/**
 * Remove an installed skill and its lockfile entry.
 *
 * The directory is removed first and the entry second, for the same reason the
 * install writes files first: the record must never describe files that are not
 * there. A removal that fails leaves both alone.
 * @param request - the skill name, its root and the lockfile's directory.
 * @returns what was removed.
 */
export async function removeSkill(
  request: { readonly name: string; readonly root: string; readonly stateDirectory: string },
  fs: InstallerFs = NODE_INSTALLER_FS,
): Promise<{ readonly removed: boolean; readonly detail: string }> {
  const name = validateSkillName(request.name)
  if (!name.ok) return { removed: false, detail: name.reason }
  const destination = join(request.root, name.name)
  try {
    await fs.remove(destination)
  } catch (error) {
    return { removed: false, detail: `could not remove ${destination}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const lockfilePath = join(request.stateDirectory, SKILL_LOCK_FILENAME)
  try {
    const current = await readLockfile(fs, lockfilePath)
    if (!(name.name in current.skills)) return { removed: true, detail: `removed ${destination}; it was not in the lockfile` }
    const skills = { ...current.skills }
    delete skills[name.name]
    await writeStateFile(fs, lockfilePath, serializeLockfile({ version: current.version, skills }))
    return { removed: true, detail: `removed ${destination} and its lockfile entry` }
  } catch (error) {
    return {
      removed: true,
      detail: `removed ${destination}, but the lockfile still names it: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
