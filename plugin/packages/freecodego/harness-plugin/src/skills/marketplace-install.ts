/**
 * Installing a Skill from the Marketplace — through the installer, not beside it.
 *
 * What this module replaces
 * -------------------------
 * The Marketplace used to clone a repository and copy the Skill directory into
 * place with `promoteSkillDirectory`, which borrowed `installer.ts`'s three rules
 * by hand and stopped there. Three consequences followed, and each is the reason
 * this module exists:
 *
 * - **Nothing recorded what was installed.** `promoteSkillDirectory` writes no
 *   record, so an install could not be checked afterwards, an upgrade could not be
 *   an upgrade, and the same Skill fetched tomorrow was a different Skill with no
 *   way to say so. The payload now goes through `installer.installSkill`, which
 *   writes the lockfile **last** and pins the commit the content actually came
 *   from.
 * - **A same-name Skill was still installed.** The Host's Skill registry resolves
 *   a name conflict by keeping the higher-priority Skill and dropping the other
 *   with a log line, so an install that lost looked exactly like one that worked.
 *   `collisions.checkSkillInstall` now refuses before anything is written, naming
 *   both sides.
 * - **Only the `owner/repo/skill` spelling worked.** That spelling is one of
 *   several in `skills/source.ts`, so a user who wanted a tag, a subdirectory, or
 *   a directory on this machine had no way to say it. The identity is read by that
 *   parser first, and the Marketplace spelling is what remains.
 *
 * The order, and why it is the order
 * ----------------------------------
 * resolve → fetch → refuse-or-install. The fetch happens *before* the collision
 * check on purpose: a Skill's real name is the one inside its `SKILL.md`, so
 * checking the name the user asked for would refuse against a name the install was
 * never going to use. The property that matters is preserved — the fetch writes
 * only into a temp directory, so a refusal still leaves the managed root untouched.
 *
 * What it can see, and what it cannot
 * -----------------------------------
 * Collision detection reads **the lockfile and the managed root this install writes
 * to**, and inside that root a directory with no record is read at its `SKILL.md`
 * rather than at its folder name: the install path that predates the lockfile left
 * flattened identity directories there (`owner-repo-demo`), and the declared name is
 * the one discovery matches on. Skills the runtime discovers from other roots — a
 * repository's `.agents/skills`, the user's `~/.agents/skills` — are not in that
 * record, so a name claimed there is not a collision this module can refuse. Saying
 * so matters: a refusal that claimed to have checked everything would be trusted
 * further than it should be.
 *
 * Payloads are text
 * -----------------
 * `installSkill`'s payload is `{ path, contents: string }`, so a Skill carrying a
 * binary asset is **refused by name** rather than installed with the file silently
 * dropped. That is a limitation of this wiring rather than of the installer, and it
 * is loud because the alternative — writing the files the installer cannot carry
 * some other way — would put two writers back on one destination.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/marketplace-install
 */

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

import { assertSkillPayloadHasNoLinks, findSkillDirectory, runCommand } from '../community-catalog-utils.ts'
import { assertExternalEngineeringAssetSafe } from '../engineering.ts'
import { marketplacePathSegment } from '../marketplace-utils.ts'
import { redactCredentialShapes } from '../secret-scan.ts'
import { checkSkillInstall, findSkillCollisions, type InstalledSkill, type SkillCollision } from './collisions.ts'
import { installSkill, removeSkill, type InstallerFs, type SkillPayload, type SkillPayloadFile } from './installer.ts'
import {
  SKILL_LOCK_FILENAME, compareByPath, digestFile, emptyLockfile, parseLockfile, verifyInstalledSkills,
  type LockedFile, type SkillLockfile, type SkillVerificationFailure,
} from './lockfile.ts'
import { formatSkillSource, parseSkillSource, type SkillSource } from './source.ts'

/** Files one payload may hold before the install refuses to carry it. */
export const SKILL_PAYLOAD_FILE_LIMIT = 512

/** Bytes one payload may hold, summed over its files. */
export const SKILL_PAYLOAD_BYTE_LIMIT = 4 * 1024 * 1024

/** Where an install takes its content from, once the identity has been read. */
export type SkillInstallTarget =
  | { readonly kind: 'github'; readonly source: Extract<SkillSource, { kind: 'github' }>; readonly name: string }
  | { readonly kind: 'local'; readonly source: Extract<SkillSource, { kind: 'local' }>; readonly name: string }

/** A refusal, as a sentence a settings page can show without a stack trace. */
export interface SkillInstallRefusal {
  readonly refused: string
}

/** What one install did, in the terms a report needs. */
export interface SkillInstallReport {
  /** The name it was installed under, which is the one discovery will see. */
  readonly name: string
  /** The source as the lockfile records it — canonical, not as it was typed. */
  readonly source: string
  /** The commit the content came from, or a content id when the source has none. */
  readonly resolvedCommit: string
  /** Whether the lockfile records it; false means the files are there and the record is not. */
  readonly locked: boolean
  /** The version this install replaced, when one was recorded. */
  readonly replacedCommit?: string
  /** True when that same source was already installed and this install re-ran it. */
  readonly idempotent: boolean
  readonly steps: readonly string[]
  /** Set when the files are in place but the record could not be written. */
  readonly lockfileWarning?: string
  /** Every failing check over the root after the install; empty when everything matches. */
  readonly verification: readonly SkillVerificationFailure[]
  /** Name collisions found in this root's own record, for the report. */
  readonly collisions: readonly SkillCollision[]
  /** Where the install landed, when the caller chose a destination rather than the default. */
  readonly placement?: { readonly root: string; readonly provenance: string }
}

/** What a managed root knows about what it holds. */
export interface SkillInstallState {
  readonly lockfile: SkillLockfile
  readonly installed: readonly InstalledSkill[]
  readonly collisions: readonly SkillCollision[]
}

/**
 * What one removal did, in the terms a report needs.
 *
 * Kept apart from {@link SkillInstallReport} because the two answer different
 * questions: an install reports what it pinned, and a removal reports which
 * directory went away and whether anything recorded it.
 */
export interface SkillRemoveReport {
  /** The name the removed Skill was known by — the one inside its `SKILL.md`. */
  readonly name: string
  /**
   * The directory that went away, which is the record's key when there was a record.
   *
   * Kept apart from {@link name} because the two genuinely differ for the older
   * layout: a Skill declaring `widget` in `acme-skills-demo/` was removed from that
   * directory, and a report that named only one of the two could not say which.
   */
  readonly directory: string
  /** The source the record carried, when the removed Skill was recorded at all. */
  readonly source?: string
  /** False when the directory existed with no record: nothing could identify it. */
  readonly recorded: boolean
  /** What the installer reported — which of the directory and the record went. */
  readonly detail: string
  /** Every remaining Skill in the root that no longer matches the record. */
  readonly verification: readonly SkillVerificationFailure[]
}

/**
 * Read an identity as a source specifier, then as a Marketplace id.
 *
 * The order is not a preference. `skills/source.ts` refuses a three-segment
 * Marketplace id (`owner/repo/name` is not `owner/repo`), while the Marketplace
 * reading would happily accept `owner/repo&path:/skills/foo` and then install the
 * wrong directory — so the reader that knows the syntax goes first and the
 * catalog's own spelling is what remains.
 * @param identity - the bare id, any `skill:` prefix already stripped.
 * @returns the target, or the reason neither reading applies.
 */
export function resolveSkillTarget(identity: string): SkillInstallTarget | SkillInstallRefusal {
  const parsed = parseSkillSource(identity)
  if (parsed.ok && parsed.source.kind === 'github') {
    return { kind: 'github', source: parsed.source, name: parsed.source.path === undefined ? parsed.source.repo : basename(parsed.source.path) }
  }
  if (parsed.ok && parsed.source.kind === 'local') {
    return { kind: 'local', source: parsed.source, name: basename(parsed.source.path.replace(/[\\/]+$/u, '')) }
  }
  if (parsed.ok) {
    // Parsed and recordable, but there is no npm fetch path here yet. Saying so
    // beats an install that resolves to nothing, and it names the way out.
    return { refused: `npm sources are parsed and recorded, but this build has no npm fetch path yet; install "${identity}" from its repository instead (owner/repo)` }
  }

  const parts = identity.split('/').filter(Boolean)
  if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_.-]{1,128}$/u.test(part))) {
    return { kind: 'github', source: { kind: 'github', owner: parts[0]!, repo: parts[1]! }, name: parts[2]! }
  }
  return { refused: `${parsed.issue.reason}; a Marketplace id looks like owner/repo/skill-name` }
}

/**
 * Whether a value is a refusal rather than the thing that was asked for.
 *
 * Generic because three different unions are narrowed with it — a target, a
 * fetched payload, and an install outcome — and a non-generic signature would
 * have to name every one of them.
 * @param value - the value a step returned.
 * @returns true when the step refused, narrowing the caller's union to the refusal.
 */
export function isSkillRefusal<T>(value: T | SkillInstallRefusal): value is SkillInstallRefusal {
  return typeof value === 'object' && value !== null && 'refused' in value
}

/** The name a SKILL.md body declares, when it declares one. */
function declaredSkillName(body: string): string | undefined {
  const name = /^---\s*[\s\S]*?^name:\s*([^\r\n]+)[\s\S]*?^---/mu.exec(body)?.[1]?.trim()
  return name === undefined || name === '' ? undefined : name
}

/** Read one directory into a payload, refusing what the installer cannot carry. */
async function readPayloadDirectory(input: { readonly directory: string; readonly label: string }): Promise<{ readonly files: readonly SkillPayloadFile[] } | SkillInstallRefusal> {
  const files: SkillPayloadFile[] = []
  let bytes = 0
  const queue: Array<{ readonly path: string; readonly prefix: string }> = [{ path: input.directory, prefix: '' }]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const location = join(current.path, entry.name)
      const path = current.prefix === '' ? entry.name : `${current.prefix}/${entry.name}`
      if (entry.isDirectory()) {
        queue.push({ path: location, prefix: path })
        continue
      }
      // Only real files: `assertSkillPayloadHasNoLinks` is what refuses a symlink,
      // and this walk must not read through one before that check runs.
      if (!entry.isFile()) continue
      if (files.length >= SKILL_PAYLOAD_FILE_LIMIT) return { refused: `the Skill holds more than ${String(SKILL_PAYLOAD_FILE_LIMIT)} files, which is past what one install carries` }
      const contents = await readFile(location, 'utf8').catch(() => undefined)
      // A binary asset cannot ride through a text payload, and dropping it would
      // install a Skill that refers to files it does not have.
      if (contents === undefined || contents.includes('\u0000') || contents.includes('\uFFFD')) {
        return { refused: `"${path}" is not text, and this installer writes text payloads; remove it from the Skill or install the Skill by hand` }
      }
      bytes += Buffer.byteLength(contents, 'utf8')
      if (bytes > SKILL_PAYLOAD_BYTE_LIMIT) return { refused: `the Skill is larger than ${String(SKILL_PAYLOAD_BYTE_LIMIT)} bytes, which is past what one install carries` }
      files.push({ path, contents })
    }
  }
  if (!files.some(file => file.path === 'SKILL.md')) return { refused: `${input.label} has no SKILL.md at its root` }
  return { files: files.sort((left, right) => left.path.localeCompare(right.path)) }
}

/** Find the Skill directory inside a fetched tree, and the name it will be installed under. */
async function locateSkillDirectory(input: { readonly directory: string; readonly name: string; readonly label: string; readonly path?: string }): Promise<{ readonly directory: string; readonly name: string } | SkillInstallRefusal> {
  const root = await stat(input.directory).then(entry => entry.isDirectory()).catch(() => false)
  if (!root) return { refused: `${input.label} is not a directory this install can read` }
  const named = async (directory: string): Promise<{ readonly directory: string; readonly name: string }> => {
    const body = await readFile(join(directory, 'SKILL.md'), 'utf8')
    // The declared name wins: it is the one discovery matches on, so a collision
    // has to be decided against it rather than against the directory's spelling.
    return { directory, name: declaredSkillName(body) ?? basename(directory) }
  }
  if (input.path !== undefined) {
    const directory = join(input.directory, ...input.path.split('/'))
    const present = await stat(join(directory, 'SKILL.md')).then(entry => entry.isFile()).catch(() => false)
    if (!present) return { refused: `${input.label} has no SKILL.md at &path:${input.path}` }
    return await named(directory)
  }
  const found = await findSkillDirectory(input.directory, input.name)
  if (found === 'exhausted') return { refused: `${input.label} holds more entries than the Skill search walks, so a SKILL.md named "${input.name}" could not be looked for; name its directory with &path:` }
  if (found === 'not-found') return { refused: `${input.label} does not contain a SKILL.md named "${input.name}"; write &path:<directory> to name the one you meant` }
  return await named(found.directory)
}

/**
 * Fetch a Skill payload and the commit it came from.
 *
 * The commit is read back from the clone rather than taken from the ref the caller
 * typed: a ref is what was asked for, and a lockfile's job is to record what was
 * *received*. A local directory has no commit, so the installer derives a content
 * id instead — the same property under a different name.
 * @param target - the resolved target.
 * @returns the payload and its commit, or the reason nothing was fetched.
 */
export async function fetchSkillPayload(target: SkillInstallTarget): Promise<{ readonly payload: SkillPayload; readonly resolvedCommit?: string } | SkillInstallRefusal> {
  if (target.kind === 'local') {
    const located = await locateSkillDirectory({ directory: target.source.path, name: target.name, label: `"${target.source.path}"` })
    if (isSkillRefusal(located)) return located
    await assertSkillPayloadHasNoLinks(located.directory)
    const files = await readPayloadDirectory({ directory: located.directory, label: `"${target.source.path}"` })
    if (isSkillRefusal(files)) return files
    return { payload: { name: located.name, files: files.files } }
  }

  const temporary = await mkdtemp(join(tmpdir(), 'freecodego-skill-install-'))
  try {
    const label = formatSkillSource(target.source)
    const repository = `https://github.com/${target.source.owner}/${target.source.repo}.git`
    const clone = await runCommand('git', [
      'clone', '--depth', '1', '--filter=blob:none',
      ...(target.source.ref === undefined ? [] : ['--branch', target.source.ref]),
      repository, temporary,
    ], process.cwd())
    // git's stderr is upstream text — a server that refused the request writes it,
    // and the shallow clone's own URL is in it — so it becomes a message only after
    // the shared masking, exactly as every other boundary in this package does.
    if (clone.code !== 0) throw new Error(`git could not clone ${label}: ${redactCredentialShapes(clone.stderr.trim() || 'no reason given')}`)

    const located = await locateSkillDirectory({ directory: temporary, name: target.name, label, ...(target.source.path === undefined ? {} : { path: target.source.path }) })
    if (isSkillRefusal(located)) return located
    await assertSkillPayloadHasNoLinks(located.directory)
    const files = await readPayloadDirectory({ directory: located.directory, label })
    if (isSkillRefusal(files)) return files

    const head = await runCommand('git', ['rev-parse', 'HEAD'], temporary, { captureStdout: true })
    const resolvedCommit = (head.stdout ?? '').trim()
    if (head.code !== 0 || !/^[0-9a-f]{40}$/u.test(resolvedCommit)) {
      return { refused: `the clone of ${label} produced no commit id, so the install could not be pinned; refusing rather than recording an unpinned Skill` }
    }
    return { payload: { name: located.name, files: files.files }, resolvedCommit }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Parse the lockfile beside a root, treating anything unreadable as no record. */
async function readLockfileBeside(root: string): Promise<SkillLockfile> {
  const text = await readFile(join(dirname(root), SKILL_LOCK_FILENAME), 'utf8').catch(() => undefined)
  if (text === undefined) return emptyLockfile()
  const parsed = parseLockfile(text)
  // A record this build cannot parse is not silently reset; the install refuses
  // for the same reason rather than writing over what a newer build recorded.
  return parsed.ok ? parsed.lockfile : emptyLockfile()
}

/**
 * Read what a managed root already holds.
 *
 * The lockfile is the record and the directory listing is the check on it: a Skill
 * present on disk but absent from the record is exactly the claim a collision has
 * to consider, because nothing can prove it is the same content.
 * @param root - the managed Skills root.
 * @returns the lockfile, every claim on it, and the collisions between them.
 */
export async function readSkillInstallState(root: string): Promise<SkillInstallState> {
  const lockfile = await readLockfileBeside(root)
  const installed: InstalledSkill[] = []
  for (const [name, skill] of Object.entries(lockfile.skills)) {
    const parsed = parseSkillSource(skill.source)
    installed.push({ name, ...(parsed.ok ? { source: parsed.source } : {}), root: skill.root, directory: name })
  }
  const recorded = new Set(Object.keys(lockfile.skills))
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || recorded.has(entry.name)) continue
    // A dot-directory is this installer's own staging or backup residue from a run
    // that was interrupted, not a Skill somebody installed.
    if (entry.name.startsWith('.')) continue
    // The name an unrecorded directory claims is the one inside its `SKILL.md` —
    // the name discovery matches on, and the name a new install of the same Skill
    // has to be refused against. The directory name alone would miss exactly the
    // case this path creates: an install from before the lockfile existed sits in a
    // flattened identity directory (`owner-repo-demo`), so checking `demo` against
    // it would find nothing and let a second copy of `demo` in — which the registry
    // then resolves by silently dropping one of them.
    const body = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
    const name = body === undefined ? entry.name : declaredSkillName(body) ?? entry.name
    installed.push({ name, root, directory: entry.name })
  }
  return { lockfile, installed, collisions: findSkillCollisions(installed) }
}

/** The names a root's record holds, for a Marketplace listing's installed badge. */
export async function installedSkillNames(root: string): Promise<ReadonlySet<string>> {
  return new Set(Object.keys((await readLockfileBeside(root)).skills))
}

/** Every file under one installed Skill, as verification compares them. */
async function readInstalledFiles(root: string, name: string): Promise<readonly LockedFile[] | undefined> {
  const directory = join(root, name)
  const present = await stat(directory).then(entry => entry.isDirectory()).catch(() => false)
  if (!present) return undefined
  const files: LockedFile[] = []
  const queue: string[] = [directory]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const location = join(current, entry.name)
      if (entry.isDirectory()) queue.push(location)
      else if (entry.isFile()) files.push({ path: relative(directory, location).split(sep).join('/'), sha256: digestFile(await readFile(location, 'utf8')) })
    }
  }
  return files.sort(compareByPath)
}

/**
 * Verify every recorded Skill in one root against the lockfile.
 *
 * This is the half that makes the record worth keeping: "installed" becomes a
 * claim that can be checked, including after something else edited the directory.
 * @param root - the managed Skills root.
 * @returns one failure per Skill that no longer matches, empty when all match.
 */
export async function verifySkillRoot(root: string): Promise<readonly SkillVerificationFailure[]> {
  const lockfile = await readLockfileBeside(root)
  const installed: Record<string, readonly LockedFile[]> = {}
  for (const name of Object.keys(lockfile.skills)) {
    const files = await readInstalledFiles(root, name)
    if (files !== undefined) installed[name] = files
  }
  return verifyInstalledSkills(lockfile, installed)
}

/**
 * Remove one Skill this identity installed, or refuse before anything is deleted.
 *
 * Two spellings have to be understood, because two installers wrote to this root.
 * The current one lands a Skill under the name inside its `SKILL.md` and records the
 * canonical source beside it; the one it replaced copied the Skill into a flattened
 * identity directory (`owner-repo-demo`) and recorded nothing.
 *
 * So the record decides first and by **source**, not by name: a local directory
 * identity is named after its own folder while the Skill inside it landed under the
 * name its `SKILL.md` declares, so name equality is not what identifies the entry an
 * identity installed — the canonical source is. Only when nothing is recorded does
 * the name decide, and then it decides between plausible directory names for
 * something nothing can identify: the install name, and the flattened directory a
 * Marketplace id used to produce.
 *
 * A *recorded* Skill whose name matches but whose source does not is refused rather
 * than removed, and the refusal says which source holds the name.
 *
 * Removal itself is `installer.removeSkill`, which deletes the directory **first**
 * and the record second — the mirror of the install's order, for the mirror of its
 * reason: a record must never describe files that are not there.
 * @param request - the identity to remove, the root it lives in, and the filesystem port.
 * @returns what was removed, or the reason nothing was.
 */
export async function removeSkillFromMarketplace(request: {
  readonly identity: string
  readonly root: string
  /**
   * Restrict the search to what this root's record names.
   *
   * Set by callers searching a root this plugin's placement installs created: the
   * flattened-directory fallback exists because the *previous* installer wrote those
   * directories, and it only ever wrote the community root. Elsewhere the fallback
   * would let a name alone authorize deleting a directory nothing recorded.
   */
  readonly recordedOnly?: boolean
  readonly fs?: InstallerFs
}): Promise<SkillRemoveReport | SkillInstallRefusal> {
  const target = resolveSkillTarget(request.identity)
  if (isSkillRefusal(target)) return target
  const canonical = formatSkillSource(target.source)
  // Only a Marketplace id can own a flattened directory: every other spelling is
  // parsed by the source reader, and those never went through the old installer.
  const flattened = request.recordedOnly === true || parseSkillSource(request.identity).ok ? undefined : marketplacePathSegment(request.identity)

  const state = await readSkillInstallState(request.root)
  /** What this source recorded, whatever name it installed the Skill under. */
  const bySource = state.installed.filter(claim => claim.source !== undefined && formatSkillSource(claim.source) === canonical)
  // One repository can hold several Skills, so one source can own several records.
  // The published name is then the only thing left to tell them apart, and it is
  // consulted only inside a set that is already this source's.
  const recorded = bySource.length === 1 ? bySource[0] : bySource.find(claim => claim.name === target.name)
  if (bySource.length > 1 && recorded === undefined) {
    return { refused: `${canonical} is installed in this managed root as ${[...new Set(bySource.map(claim => claim.name))].join(' and ')}, so "${request.identity}" does not say which of them to remove. Remove the one you meant from the Skills page.` }
  }

  // Both the declared name and the directory name are candidates here: an unrecorded
  // directory can carry either one, because the two installers named these
  // differently — the current one by the declared name, the one before it by the
  // flattened identity.
  const plausibleNames = new Set([target.name, ...(flattened === undefined ? [] : [flattened])])
  const unrecorded = state.installed.filter(claim => claim.source === undefined && (plausibleNames.has(claim.name) || (claim.directory !== undefined && plausibleNames.has(claim.directory))))

  let claim = recorded
  if (claim === undefined && unrecorded.length > 1) {
    // Refused rather than guessed: deleting the wrong one of two plausible
    // directories is the kind of mistake this path must not make on the user's
    // behalf, and the message names both so the choice is theirs.
    return { refused: `two directories in this managed root could be "${request.identity}": ${unrecorded.map(entry => entry.directory ?? entry.name).join(' and ')}. Remove the one you meant, then try again.` }
  }
  if (claim === undefined) claim = unrecorded[0]
  if (claim === undefined) {
    // A name taken by a different source is said apart from a name that is absent:
    // the Marketplace badge matches on the name, so a card can offer Remove for a
    // Skill another source installed, and "not installed" would read as the page
    // being wrong rather than this identity not being the one that wrote it.
    const other = state.installed.filter(entry => entry.source !== undefined && formatSkillSource(entry.source) !== canonical && (plausibleNames.has(entry.name) || (entry.directory !== undefined && plausibleNames.has(entry.directory))))
    if (other.length > 0) {
      for (const candidate of plausibleNames) {
        const claiming = other.filter(entry => entry.name === candidate || entry.directory === candidate)
        if (claiming.length === 0) continue
        return { refused: `a Skill named "${candidate}" is installed in this managed root from ${claiming.map(entry => formatSkillSource(entry.source!)).join(' and ')}, which is a different source than ${canonical}. Remove that one from the Skills page, or install ${request.identity} under a different name.` }
      }
    }
    return { refused: `"${request.identity}" is not installed in this managed root: neither its record nor a directory there names it` }
  }

  // The directory, not the declared name: that is what `removeSkill` deletes and
  // what the lockfile is keyed by. For the older layout the two differ, and passing
  // the declared name would look for a directory that was never created.
  const directory = claim.directory ?? claim.name
  const outcome = await removeSkill({ name: directory, root: request.root, stateDirectory: dirname(request.root) }, request.fs)
  if (!outcome.removed) return { refused: outcome.detail }

  return {
    name: claim.name,
    directory,
    ...(claim.source === undefined ? {} : { source: formatSkillSource(claim.source) }),
    recorded: claim.source !== undefined,
    detail: outcome.detail,
    verification: await verifySkillRoot(request.root),
  }
}

/**
 * Install one Skill into a managed root, or refuse before the root is touched.
 *
 * @param request - the identity to install, the root it belongs in, and the ports.
 * @returns what the install did, or the reason it did nothing.
 */
export async function installSkillFromMarketplace(request: {
  readonly identity: string
  readonly root: string
  /** The destination the caller chose, echoed into the report when there was one. */
  readonly placement?: { readonly root: string; readonly provenance: string }
  readonly fs?: InstallerFs
  readonly now?: () => string
}): Promise<SkillInstallReport | SkillInstallRefusal> {
  const target = resolveSkillTarget(request.identity)
  if (isSkillRefusal(target)) return target

  const fetched = await fetchSkillPayload(target)
  if (isSkillRefusal(fetched)) return fetched

  const state = await readSkillInstallState(request.root)
  const verdict = checkSkillInstall({ name: fetched.payload.name, source: target.source, root: request.root, installed: state.installed })
  if (!verdict.ok) return { refused: verdict.reason }

  const source = formatSkillSource(target.source)
  // Screen the body the way every externally sourced asset is screened, before the
  // installer is handed the content: the same audit the Marketplace ran, at the
  // same point in the order.
  const body = fetched.payload.files.find(file => file.path === 'SKILL.md')?.contents ?? ''
  assertExternalEngineeringAssetSafe(`skill:${source}#${fetched.payload.name}`, body, true)

  const outcome = await installSkill({
    payload: fetched.payload,
    root: request.root,
    source,
    ...(fetched.resolvedCommit === undefined ? {} : { resolvedCommit: fetched.resolvedCommit }),
    stateDirectory: dirname(request.root),
    ...(request.now === undefined ? {} : { now: request.now }),
  }, request.fs)
  if (isSkillRefusal(outcome)) return outcome

  return {
    name: fetched.payload.name,
    source,
    resolvedCommit: outcome.skill.resolvedCommit,
    locked: outcome.locked,
    ...(outcome.replacedCommit === undefined ? {} : { replacedCommit: outcome.replacedCommit }),
    idempotent: verdict.idempotent,
    steps: outcome.steps,
    ...(outcome.lockfileWarning === undefined ? {} : { lockfileWarning: outcome.lockfileWarning }),
    verification: await verifySkillRoot(request.root),
    collisions: (await readSkillInstallState(request.root)).collisions,
    ...(request.placement === undefined ? {} : { placement: request.placement }),
  }
}
