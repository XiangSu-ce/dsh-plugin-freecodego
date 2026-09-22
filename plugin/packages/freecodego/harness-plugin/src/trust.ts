/**
 * One folder-trust gate for every project-scoped FreeCodeGo surface.
 *
 * Why a gate at all
 * -----------------
 * Two surfaces this plugin mounts are driven by *repository* content rather than
 * by the user's own machine: project MCP servers and project Skill roots. Each
 * of them can execute code or read files on the host, so opening an untrusted
 * checkout must not silently grant both. Before this module each surface made
 * its own guess — MCP leaned on "needs credentials, so it stays manual", and
 * Skill roots had no gate at all — which meant the answer to "is this
 * repository trusted?" lived in two places and could drift in two ways, and the
 * user had no single action that expressed *I trust this repository*.
 *
 * The one candidate that is deliberately **not** gated is the LSP mount, and
 * that is a decision rather than an oversight: `lsp-mount.ts` probes PATH for
 * three well-known server executables and reads nothing the repository
 * supplies, so a gate there would refuse a mount that never consulted the
 * repository — the user would lose their language servers and gain no safety.
 * When project-scoped LSP configuration arrives, it is that configuration which
 * must pass this gate, not the PATH probe.
 *
 * Why the record lives outside the workspace
 * ------------------------------------------
 * A grant stored under `<workspace>/.freecodego/` would let a repository
 * authorise itself: clone the repo, `git checkout`, and the hook is already
 * armed. The record therefore lives under the harness home, and nothing inside
 * the workspace can influence it.
 *
 * What counts as the unit of trust
 * --------------------------------
 * The **repository root**, not the working directory and not a path prefix.
 * Keying on the cwd would re-ask the user again one directory deeper; keying on
 * a path prefix would let `..` or a symlink reach outside the grant. A nested
 * git checkout is a different repository root and is therefore *not* covered by
 * its parent's grant — the same rule the harness's own folder-trust consumers
 * use, and a deliberate one: a vendored checkout is somebody else's code.
 *
 * What this module deliberately does NOT gate
 * -------------------------------------------
 * Global and user-scope configuration is never gated. Those entries are the
 * user's own machine's answer — they were not shipped by the repository — so
 * gating them would only teach the user to distrust a switch that keeps asking.
 * The gate exists for repository-supplied content and nothing else.
 *
 * Fail-soft, loudly
 * -----------------
 * An untrusted repository is an expected state, not an error: the surface is
 * skipped and the skip is reported once. The one outcome that must never happen
 * is a silent skip the user cannot see, so every refusal carries a reason.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trust
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { freeCodeGoDataHome } from './data-home.ts'
import type { FreeCodeGoTrustDecision, FreeCodeGoTrustRecord, FreeCodeGoTrustStatus } from './types.ts'

const run = promisify(execFile)

/** Longest `git rev-parse` this module waits for; a hung git must not hang boot. */
const GIT_TIMEOUT_MS = 10_000

/** Largest `git rev-parse` output this module will parse. */
const MAX_GIT_OUTPUT = 4_096

/** Record schema version; a mismatched version is treated as "no record" rather than migrated. */
export const TRUST_RECORD_VERSION = 1

/** Settings for the gate. Kept in the FreeCodeGo settings namespace. */
export const FreeCodeGoTrustSettingsSchema = z.object({
  /**
   * Master switch for the whole gate.
   *
   * Off means every project-scoped surface is treated as trusted — the
   * pre-gate behaviour, kept reachable so a deployment that already controls
   * which repositories it opens is not forced to grant each one. It is
   * deliberately not the default: the safe state must not be the opt-in one.
   */
  folderTrustEnabled: z.boolean().default(true),
})

/** The folder-trust switches this plugin reads from settings. */
export interface FreeCodeGoTrustSettings {
  readonly folderTrustEnabled: boolean
}

/** Environment escape hatch, matching the harness convention of an uppercase opt-out. */
export const FOLDER_TRUST_ENV = 'FREECODEGO_FOLDER_TRUST'

/**
 * Whether the gate is active for this process.
 *
 * The environment is read first so an operator can disable the gate before the
 * settings service is even available — the same precedence the harness gives
 * `FREECODEGO_DISABLE_PROJECT_CONFIG`.
 * @param settings - the resolved settings, or `undefined` before registration.
 * @returns `true` when project-scoped surfaces must pass the gate.
 */
export function folderTrustEnabled(settings: FreeCodeGoTrustSettings | undefined): boolean {
  const raw = process.env[FOLDER_TRUST_ENV]?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  return settings?.folderTrustEnabled !== false
}

/**
 * The gate's decision for one repository root.
 *
 * Pure: it takes the already-canonical root and the already-loaded record, and
 * performs no IO. Every consumer calls this rather than comparing paths itself,
 * so the three surfaces cannot disagree about what "trusted" means.
 * @param input - canonical repository root, the loaded record, and whether the gate is active.
 * @returns the decision, with a stable refusal reason when untrusted.
 */
export function resolveFolderTrust(input: {
  readonly repoRoot: string | undefined
  readonly record: FreeCodeGoTrustRecord
  readonly enabled: boolean
}): FreeCodeGoTrustDecision {
  if (!input.enabled) return { trusted: true, reason: 'global-disabled' }
  if (input.repoRoot === undefined) {
    // Outside a repository there is no unit of trust to key on, so there is
    // nothing a grant could ever name. Treating that as trusted would make
    // `cd /tmp` an escape hatch; treating it as an error would break every
    // non-repository workspace. It is refused with its own reason instead, and
    // the caller reports which surface was skipped.
    return { trusted: false, reason: 'not-a-repository' }
  }
  const entry = input.record.entries.find(candidate => candidate.root === input.repoRoot)
  if (entry === undefined) return { trusted: false, reason: 'no-record' }
  return { trusted: true, reason: 'granted' }
}

/**
 * Stable identity for a path used as a trust key.
 *
 * Two spellings of one directory must not produce two grants: `DSH` on a
 * case-insensitive filesystem, a trailing separator, and a `~` prefix all name
 * the same tree. Symlinks are resolved by the caller (see {@link repositoryRoot})
 * because doing it here would require IO.
 * @param path - an absolute path from the host.
 * @returns the path with separators normalized and trailing separators removed.
 */
export function canonicalTrustKey(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  // Windows and macOS resolve `C:/Repo` and `c:/repo` to one directory, so the
  // key must fold case there or a grant would not match on the next launch.
  return process.platform === 'linux' ? normalized : normalized.toLowerCase()
}

/**
 * The repository root containing a directory, or `undefined` when there is none.
 *
 * Uses git's own answer rather than walking upward looking for `.git`, because
 * only git knows about worktrees (where `.git` is a *file*), submodules, and
 * `core.worktree` overrides. The result is realpath'd so a symlinked checkout
 * and its target share one grant key.
 * @param directory - an absolute directory to classify.
 * @returns the canonical repository root, or `undefined` outside any repository.
 */
export async function repositoryRoot(directory: string): Promise<string | undefined> {
  const resolved = await realpath(resolve(directory)).catch(() => resolve(directory))
  const stdout = await run('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  })
    .then(result => result.stdout)
    .catch(() => '')
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined
  // git already returns an absolute path, but it is the *pre-realpath* one on
  // macOS (`/private/var` vs `/var`), so it is canonicalized here too.
  const canonical = await realpath(trimmed).catch(() => trimmed)
  return canonicalTrustKey(canonical)
}

/** One grant, as stored. */
export interface TrustEntry {
  /** Canonical repository root this grant covers. */
  readonly root: string
  /** ISO timestamp of the most recent grant, for the settings surface. */
  readonly grantedAt: string
}

/**
 * The grant record.
 *
 * Read and written as a whole: the file is small, the operations are grant and
 * revoke, and a partial write must never be observable, so the write is
 * atomic (temp file plus rename) rather than a read-modify-write on a shared
 * handle.
 */
export class FolderTrustStore {
  private cache: FreeCodeGoTrustRecord | undefined

  /**
   * @param file - absolute path of the record; defaults to the harness home's
   *   `state/freecodego/trusted-folders.json`.
   */
  constructor(private readonly file: string = defaultTrustRecordPath()) {}

  /**
   * The file this store reads and writes.
   *
   * Exposed so a caller that must act on the record *file* — the first-sight seed
   * below, which has to know whether the file exists at all — does so through the
   * same instance the gate reads with, rather than through a second one whose
   * write the gate's cache would never see.
   */
  get path(): string {
    return this.file
  }

  /**
   * Load the record, or an empty one.
   *
   * A malformed or future-versioned file is reported as an empty record rather
   * than throwing: an unreadable advisory record must not block boot, and
   * failing closed here would lock a user out of their own trusted
   * repositories. The consequence is visible — nothing is trusted until the
   * next grant — so it cannot pass unnoticed.
   * @returns the loaded record, cached once a read has actually answered.
   */
  async read(): Promise<FreeCodeGoTrustRecord> {
    return (await this.load()).record
  }

  /**
   * One read, and whether it is the whole truth about the file.
   *
   * `readable: false` — a file that is there and that no read or parse of ours
   * could account for — is never cached and never built upon. That is the
   * difference between a lost file and a lost record: absence is an answer the
   * next write may legitimately record over, while an unreadable file may hold
   * grants this process failed to see, so remembering it as empty (or writing a
   * fresh record derived from it) would persist the miss into every later read.
   * The user's trusted repositories would come back as `no-record` — the same
   * reason a repository that was never granted gets — with nothing on screen to
   * say their record was there all along.
   * @returns the record, and whether the read that produced it can be trusted.
   */
  private async load(): Promise<{ readonly record: FreeCodeGoTrustRecord; readonly readable: boolean }> {
    if (this.cache !== undefined) return { record: this.cache, readable: true }
    const read = await readFile(this.file, 'utf8')
      .then((content): { readonly ok: true; readonly content: string } => ({ ok: true, content }))
      .catch((error: unknown): { readonly ok: false; readonly error: unknown } => ({ ok: false, error }))
    if (read.ok) {
      let parsed: unknown
      try {
        parsed = JSON.parse(read.content)
      } catch {
        return { record: emptyTrustRecord(), readable: false }
      }
      const record = parseTrustRecord(parsed)
      this.cache = record
      return { record, readable: true }
    }
    // An absent file says nothing and will be recorded by the next write; any
    // other failure says that something is there that this process could not
    // read (a lock held by another instance, or a permission it lacks).
    if ((read.error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      const record = emptyTrustRecord()
      this.cache = record
      return { record, readable: true }
    }
    return { record: emptyTrustRecord(), readable: false }
  }

  /**
   * Refuse to write a record built on a read that failed.
   *
   * `grant` and `revoke` rewrite the file as a whole, so a new record built from
   * an unreadable one silently drops every grant it held. Refusing is the one
   * outcome that keeps the file, and it is a failure the caller can report —
   * which is what separates it from the loss it replaces.
   * @param readable - whether the read that this write would build on answered.
   */
  private refuseToRewrite(readable: boolean): void {
    if (readable) return
    // Existence is the second half of the question: with no file there is
    // nothing to destroy, so a read that failed for a reason other than absence
    // must not be allowed to block a first grant.
    if (!existsSync(this.file)) return
    throw new Error(`the folder trust record at ${this.file} could not be read, so writing it would discard the grants it holds`)
  }

  /**
   * Record a grant for one repository root.
   * @param root - a canonical root from {@link repositoryRoot}.
   * @returns the record after the grant.
   */
  async grant(root: string): Promise<FreeCodeGoTrustRecord> {
    const loaded = await this.load()
    this.refuseToRewrite(loaded.readable)
    const current = loaded.record
    const key = canonicalTrustKey(root)
    const entries = [
      ...current.entries.filter(entry => entry.root !== key),
      { root: key, grantedAt: new Date().toISOString() },
    ]
    return await this.write({ version: TRUST_RECORD_VERSION, entries })
  }

  /**
   * Remove a grant.
   * @param root - a canonical root from {@link repositoryRoot}.
   * @returns the record after the revoke.
   */
  async revoke(root: string): Promise<FreeCodeGoTrustRecord> {
    const loaded = await this.load()
    this.refuseToRewrite(loaded.readable)
    const current = loaded.record
    const key = canonicalTrustKey(root)
    return await this.write({
      version: TRUST_RECORD_VERSION,
      entries: current.entries.filter(entry => entry.root !== key),
    })
  }

  /**
   * Whether a canonical root currently holds a grant.
   *
   * Does not consult the master switch: a caller that already checked
   * {@link folderTrustEnabled} must not have the answer change underneath it.
   * @param root - a canonical root, or `undefined` outside a repository.
   * @returns `true` only for a root with a recorded grant.
   */
  async isTrusted(root: string | undefined): Promise<boolean> {
    if (root === undefined) return false
    const record = await this.read()
    return record.entries.some(entry => entry.root === root)
  }

  /**
   * The record as the settings surface shows it.
   *
   * `enabled` is the caller's answer rather than this class's: the field is
   * documented as "the resolved master switch (settings and environment folded)",
   * and this store can see neither the settings document nor which surface is
   * asking. It used to report `true` unconditionally, which made the one field a
   * user checks to find out whether the gate is even running the one field the
   * store could not support. Required rather than defaulted, so a caller cannot
   * get a guess by omission.
   * @param enabled - whether the gate is active, as the caller resolved it.
   * @returns the trust Status.
   */
  async status(enabled: boolean): Promise<FreeCodeGoTrustStatus> {
    const record = await this.read()
    return {
      enabled,
      recordPath: this.file,
      entries: record.entries.map(entry => ({ root: entry.root, grantedAt: entry.grantedAt })),
    }
  }

  /**
   * Stage and install the record, one write at a time.
   *
   * The staging name carries a per-write token rather than the process id, which
   * is the difference between two concurrent grants and a lost one: with the pid
   * alone both writes share one path, so the second `rename` finds the file the
   * first already moved — or finds a file holding a mix of the two — and the
   * failure is one the caller has no way to notice — and in this store that means
   * a repository quietly failing to gain the grant a user just gave it.
   */
  private async write(record: FreeCodeGoTrustRecord): Promise<FreeCodeGoTrustRecord> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
    this.cache = record
    return record
  }
}

/**
 * The record that stands for a file this module cannot use.
 *
 * A fresh object per call rather than one shared constant: `entries` is an array
 * a caller may hold on to, and two stores answering from one array is how a
 * mutation in one surface becomes visible in another.
 */
function emptyTrustRecord(): FreeCodeGoTrustRecord {
  return { version: TRUST_RECORD_VERSION, entries: [] }
}

/**
 * Default location of the grant record, under the plugin's own data root.
 *
 * Derived from {@link freeCodeGoDataHome} rather than the harness home directly,
 * so `FREECODEGO_HOME` can aim it at a sandbox. The record is plugin-private
 * state like engineering memory and checkpoints, and those already follow that
 * override; resolving this path by hand would have made the grant record the one
 * piece of plugin state a redirected build still wrote to the real user's home.
 * The default is unchanged: `~/.dsh/state/freecodego/trusted-folders.json`.
 * @returns the default trust record path.
 */
export function defaultTrustRecordPath(): string {
  return join(freeCodeGoDataHome(), 'state', 'freecodego', 'trusted-folders.json')
}

/**
 * Seed the grant record on first sight, trusting the repository we booted in.
 *
 * Why this exists: the gate is fail-closed, so a user upgrading from a build
 * that had no gate would find every project-scoped MCP server and Skill root
 * silently gone — which reads as "the update broke my setup" rather than as a
 * safety improvement, and would teach them to switch the gate off. The record
 * is therefore written once, for the repository the process is already working
 * in, and only when the record file is entirely absent.
 *
 * A record that exists is never touched, even an empty one: absence and "the
 * user revoked everything" are different states, and only the first is
 * eligible for seeding. Callers must remount afterwards, because the initial
 * reconcile may have already refused entries against the empty record.
 * @param input - the directory the plugin launched in, whether the gate is active,
 *   and the store the caller's gate reads through.
 * @returns `true` when a record was written.
 */
export async function seedTrustRecordOnce(input: {
  readonly directory: string
  readonly enabled: boolean
  /**
   * The store the caller already holds.
   *
   * Required in practice for the seed to have any effect: a second instance would
   * write the file and keep its own copy, while the gate went on answering from the
   * empty record it cached during its first reconcile. The seed would report success
   * and change nothing until the next launch — which is precisely the state the seed
   * exists to prevent, so the grant goes through the caller's instance.
   */
  readonly store?: FolderTrustStore
}): Promise<boolean> {
  // A disabled gate treats everything as trusted, so a record written now would
  // only be a claim the settings surface later has to explain away.
  if (!input.enabled) return false
  const store = input.store ?? new FolderTrustStore()
  const file = store.path
  // `readFile` is the existence test as well as the read, on purpose: the
  // store collapses "missing" and "malformed" into one answer, and only the
  // first is ours to act on. A malformed file is the user's record, and
  // overwriting it would silently re-grant a repository they may have removed.
  const exists = await readFile(file, 'utf8').then(() => true).catch(() => false)
  if (exists) return false
  const root = await repositoryRoot(input.directory)
  // Outside a repository there is no unit of trust, so there is nothing a seed
  // could name and no surface that would consult it.
  if (root === undefined) return false
  await store.grant(root)
  return true
}

/**
 * Parse a stored record defensively.
 *
 * Validation is intentionally shallow and total: anything that is not the
 * expected shape yields an empty record, because the cost of trusting a
 * malformed entry is arbitrary code execution in a repository that was never
 * granted.
 * @param value - the parsed JSON value, if any.
 * @returns a valid record, never throwing.
 */
export function parseTrustRecord(value: unknown): FreeCodeGoTrustRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { version: TRUST_RECORD_VERSION, entries: [] }
  }
  const candidate = value as { readonly version?: unknown; readonly entries?: unknown }
  if (candidate.version !== TRUST_RECORD_VERSION || !Array.isArray(candidate.entries)) {
    return { version: TRUST_RECORD_VERSION, entries: [] }
  }
  const entries = candidate.entries.flatMap((entry): TrustEntry[] => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const shape = entry as { readonly root?: unknown; readonly grantedAt?: unknown }
    if (typeof shape.root !== 'string' || shape.root === '') return []
    if (typeof shape.grantedAt !== 'string') return []
    return [{ root: canonicalTrustKey(shape.root), grantedAt: shape.grantedAt }]
  })
  return { version: TRUST_RECORD_VERSION, entries }
}
