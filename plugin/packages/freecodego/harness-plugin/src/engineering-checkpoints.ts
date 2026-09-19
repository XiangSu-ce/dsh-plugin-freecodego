/**
 * Workspace checkpoints — a Cline-style shadow snapshot system
 * (https://docs.cline.bot, Apache-2.0 concept): before a file-mutating tool
 * call the Host captures a content-hashed manifest of every tracked source
 * file, and a restore copies the recorded contents back without ever touching
 * git or the user's VCS state.
 *
 * Storage is content-addressed: a checkpoint manifest stores per-file hashes,
 * and file contents live once in a blob store keyed by their SHA-256. Unchanged
 * files across checkpoints share blobs, so snapshots of a large workspace cost
 * only the size of what actually changed.
 *
 * The walk that finds the tracked files is capped (MAX_TRACKED_FILES), so on a
 * workspace larger than the cap a manifest records a prefix of them. What the cap
 * cannot do is answer "did this file exist at capture time?" — the question that
 * gates deletion on restore — so a truncated capture says so (see
 * `capturedTruncated`) instead of letting its tail read as "created afterwards".
 * The same sweep that keeps the manifest list bounded releases the blobs a dropped
 * manifest was the last reference to (see `prune`).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engineering-checkpoints
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { freeCodeGoDataHome } from './data-home.ts'
import { isCredentialPath } from './tool-guards.ts'

export interface CheckpointEntry {
  readonly file: string
  readonly hash: string
  readonly bytes: number
}

export interface Checkpoint {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  readonly entries: readonly CheckpointEntry[]
  /** Pinned checkpoints survive the retention cap. */
  readonly pinned?: boolean
  /**
   * Every tracked file present when the checkpoint was taken — including files
   * whose contents were never stored because the byte budget ran out or the
   * read failed. `entries` is a subset of this list.
   *
   * Restore and diff need it to tell "existed at capture but was not stored"
   * apart from "created after the checkpoint": without it a truncated capture
   * made restore delete real, pre-existing source files. Absent in manifests
   * written before this field existed, where `entries` is all we know.
   */
  readonly captured?: readonly string[]
  /**
   * True when `captured` is a prefix of the workspace rather than all of it,
   * because the walk reached MAX_TRACKED_FILES with directories still unvisited.
   *
   * Restore deletes every tracked file the checkpoint does not name, and diff
   * previews the same judgment, so a prefix cannot be acted on as if it were the
   * whole answer: both withhold that half and report this flag instead. False for
   * manifests written before this field existed, where `captured` is what the
   * walk saw and nothing claimed otherwise.
   */
  readonly capturedTruncated?: boolean
}

/** Files that existed at capture time: the recorded capture list when present,
 * otherwise the stored entries (all a pre-fix manifest can tell us). */
function knownFilesAtCapture(checkpoint: Checkpoint): ReadonlySet<string> {
  return new Set(checkpoint.captured ?? checkpoint.entries.map(entry => entry.file))
}

export interface CheckpointRestoreResult {
  readonly restoredFiles: number
  readonly deletedFiles: number
  readonly missingBlobs: number
  /**
   * True when the checkpoint's capture list is a prefix, so the deletion half of
   * the restore was withheld and `deletedFiles` is 0 rather than a guess. The
   * rewrite half still ran: it acts on `entries`, which is exact.
   */
  readonly captureListTruncated: boolean
}

/** What restoring one checkpoint would change, computed without touching files. */
export interface CheckpointDiffResult {
  readonly modified: readonly string[]
  readonly addedSince: readonly string[]
  readonly deletedSince: readonly string[]
  readonly missingBlobs: number
  /**
   * True when the checkpoint's capture list is a prefix, so `addedSince` is
   * withheld (empty because the walk cannot tell new tracked files from the ones
   * it never reached, not because there are none).
   */
  readonly captureListTruncated: boolean
}

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache',
  'target', '.venv', 'venv', '__pycache__',
])

/**
 * Source extensions a checkpoint stores. Together with the credential rule
 * below this *is* the definition of "tracked", and three consumers read it: what
 * `capture` stores, what `restore` may delete, and what `diff` calls
 * added-since. They must agree, which is why the rule lives in one predicate
 * rather than in each caller.
 */
const TRACKED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.scss',
  '.html', '.yml', '.yaml', '.py', '.go', '.rs', '.java', '.sql', '.sh', '.toml',
])

const MAX_TRACKED_FILE_BYTES = 2 * 1024 * 1024
const MAX_TRACKED_FILES = 8_000
const MAX_TOTAL_TRACKED_BYTES = 96 * 1024 * 1024
const MAX_RETAINED_CHECKPOINTS = 40
/**
 * How long an unreferenced blob is left alone before a sweep may take it.
 *
 * `capture` writes a blob before it commits the manifest that names it, so an
 * unreferenced blob can belong to a capture that is still in flight; two sessions
 * share one store and captures are deliberately not serialised (see
 * `ensureBlob`). A capture of a bounded workspace (8 000 files, 96 MiB) finishes
 * in seconds, so a quarter of an hour only ever covers writes still underway.
 */
const PRUNE_GRACE_MS = 15 * 60_000

type ManifestRow = {
  readonly id: string
  readonly project_id: string
  readonly label: string
  readonly created_at: number
  readonly entries_json: string
  readonly pinned?: number
  /** Added by the truncation fix; NULL for manifests written before it. */
  readonly captured_json?: string | null
  /** Added with it; 0 for manifests written before it. */
  readonly captured_truncated?: number | null
}

/**
 * Whether one stored entry can be acted on.
 *
 * The path must be the workspace-relative, slash-separated form `capture` writes,
 * because `restore` turns it back into a filesystem path with `join(root, ...file
 * .split('/'))`. Anything else is refused: a stored `../x` writes outside the
 * workspace, and on Windows a backslash survives the `/`-split and is still a
 * separator to `join`, which the same check has to catch.
 */
function isRestorableEntry(value: unknown): value is CheckpointEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<CheckpointEntry>
  if (typeof entry.file !== 'string' || typeof entry.hash !== 'string') return false
  if (typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes)) return false
  if (entry.file === '' || entry.file.includes('\\') || entry.file.includes('\0') || isAbsolute(entry.file)) return false
  return !entry.file.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

/**
 * Read one manifest row, or `undefined` when anything in it cannot be trusted.
 *
 * Refusing the whole manifest is the point, not a side effect. A truncated entry
 * list is not a smaller checkpoint: `restore` deletes every tracked file the
 * manifest does not name, so acting on a partially readable list would delete the
 * files that were lost. The same reasoning applies to the capture list, which is
 * what tells "existed but was not stored" apart from "created afterwards" — an
 * unreadable one is not absent, and falling back to `entries` there is exactly the
 * bug that field was added to fix.
 */
function manifestFromRow(row: ManifestRow): Checkpoint | undefined {
  let entriesValue: unknown
  try { entriesValue = JSON.parse(row.entries_json) } catch { return undefined }
  if (!Array.isArray(entriesValue) || !entriesValue.every(isRestorableEntry)) return undefined
  const capturedJson = row.captured_json
  let captured: string[] | undefined
  if (capturedJson !== null && capturedJson !== undefined) {
    let capturedValue: unknown
    try { capturedValue = JSON.parse(capturedJson) } catch { return undefined }
    if (!Array.isArray(capturedValue) || !capturedValue.every((file): file is string => typeof file === 'string')) return undefined
    captured = capturedValue
  }
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    entries: entriesValue,
    ...(Number(row.pinned) === 1 ? { pinned: true } : {}),
    ...(captured === undefined ? {} : { captured }),
    ...(Number(row.captured_truncated) === 1 ? { capturedTruncated: true } : {}),
  }
}

/** Content-addressed checkpoint store for one plugin instance. */
export class EngineeringCheckpointStore {
  private readonly rootDirectory: string
  private readonly blobDirectory: string
  private readonly databasePath: string
  private database: DatabaseSync | undefined

  constructor(rootDirectory = defaultCheckpointDirectory()) {
    this.rootDirectory = resolve(rootDirectory)
    this.blobDirectory = join(this.rootDirectory, 'blobs')
    this.databasePath = join(this.rootDirectory, 'checkpoints.sqlite')
  }

  async open(): Promise<void> {
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 })
    if (lstatSync(this.rootDirectory).isSymbolicLink()) throw new Error('engineering checkpoint directory must not be a symlink')
    const database = new DatabaseSync(this.databasePath)
    database.exec(`
      PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS engineering_checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        entries_json TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        captured_json TEXT,
        captured_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS engineering_checkpoints_project_time ON engineering_checkpoints(project_id, created_at DESC);
    `)
    // Databases created before the pinned column existed get it added once;
    // PRAGMA table_info is the portable existence probe.
    const columns = database.prepare('PRAGMA table_info(engineering_checkpoints)').all() as { name?: unknown }[]
    if (!columns.some(column => column?.name === 'pinned')) {
      database.exec('ALTER TABLE engineering_checkpoints ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    }
    // Manifests written before the capture list existed stay NULL and fall back
    // to their entries, so an old checkpoint keeps working.
    if (!columns.some(column => column?.name === 'captured_json')) {
      database.exec('ALTER TABLE engineering_checkpoints ADD COLUMN captured_json TEXT')
    }
    // Manifests written before the walk reported its own truncation stay 0: for
    // those, `captured` is what the walk saw and nothing claimed otherwise.
    if (!columns.some(column => column?.name === 'captured_truncated')) {
      database.exec('ALTER TABLE engineering_checkpoints ADD COLUMN captured_truncated INTEGER NOT NULL DEFAULT 0')
    }
    this.database = database
  }

  close(): void {
    this.database?.close()
    this.database = undefined
  }

  /** Whether the store has been opened and can accept operations. */
  get available(): boolean {
    return this.database !== undefined
  }

  /**
   * Capture a checkpoint of every tracked source file under the workspace.
   * Files are hashed and their contents stored once in the blob store.
   */
  async capture(input: { readonly cwd: string; readonly label: string; readonly pinned?: boolean }): Promise<Checkpoint> {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const walk = collectTrackedFiles(resolve(input.cwd))
    const files = walk.files
    // Record every tracked file the walk reached, not just the ones whose
    // contents fit: the byte budget below can stop early and a failed read is
    // skipped, so `entries` may be a prefix. Restore must not treat the missing
    // tail as "created after the checkpoint".
    //
    // The walk itself is capped, so on a workspace larger than that cap the list
    // is a prefix too — and a prefix cannot answer "existed at capture time" at
    // all. `capturedTruncated` records that, and both readers of the answer
    // withhold it rather than make it up.
    const captured = files.map(file => relative(resolve(input.cwd), file).split('\\').join('/'))
    const entries: CheckpointEntry[] = []
    let totalBytes = 0
    for (const file of files) {
      try {
        const bytes = statSync(file).size
        if (totalBytes + bytes > MAX_TOTAL_TRACKED_BYTES) break
        const content = readFileSync(file)
        const hash = createHash('sha256').update(content).digest('hex')
        await this.ensureBlob(hash, content)
        entries.push({ file: relative(resolve(input.cwd), file).split('\\').join('/'), hash, bytes: content.length })
        totalBytes += bytes
      } catch {
        continue
      }
    }
    const checkpoint: Checkpoint = {
      id: `ckpt_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      label: input.label.slice(0, 160).trim() || 'checkpoint',
      createdAt: Date.now(),
      entries,
      captured,
      ...(walk.truncated ? { capturedTruncated: true } : {}),
    }
    const checkpoints = this.list({ cwd: input.cwd })
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('INSERT INTO engineering_checkpoints(id, project_id, label, created_at, entries_json, pinned, captured_json, captured_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(checkpoint.id, projectId, checkpoint.label, checkpoint.createdAt, JSON.stringify(entries), input.pinned === true ? 1 : 0, JSON.stringify(captured), walk.truncated ? 1 : 0)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    // Retention: drop the oldest unpinned checkpoints beyond the cap (manifest
    // only; blobs stay because other checkpoints likely reference them).
    if (checkpoints.length >= MAX_RETAINED_CHECKPOINTS) {
      const excess = checkpoints.slice(MAX_RETAINED_CHECKPOINTS - 1).filter(candidate => candidate.pinned !== true)
      for (const stale of excess) {
        database.prepare('DELETE FROM engineering_checkpoints WHERE id = ? AND project_id = ?').run(stale.id, projectId)
      }
      // The dropped manifests may have been the last reference to their blobs:
      // without this sweep the store keeps every distinct content ever captured
      // while the history it can restore stays capped at MAX_RETAINED_CHECKPOINTS.
      if (excess.length > 0) this.prune()
    }
    return checkpoint
  }

  /** List checkpoint manifests for a workspace, newest first. */
  list(input: { readonly cwd: string }): readonly Checkpoint[] {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const rows = database.prepare('SELECT id, label, created_at, entries_json, pinned, captured_json, captured_truncated FROM engineering_checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(projectId) as ManifestRow[]
    // A manifest this reader cannot trust is skipped rather than thrown out of:
    // one damaged row must not take the whole list (and the tool surface that
    // renders it) down with it.
    return rows.flatMap((row): Checkpoint[] => { const parsed = manifestFromRow(row); return parsed === undefined ? [] : [parsed] })
  }

  /** Read one checkpoint's manifest. */
  get(input: { readonly cwd: string; readonly id: string }): Checkpoint | undefined {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const row = database.prepare('SELECT id, label, created_at, entries_json, pinned, captured_json, captured_truncated FROM engineering_checkpoints WHERE project_id = ? AND id = ?').get(projectId, input.id) as ManifestRow | undefined
    return row === undefined ? undefined : manifestFromRow(row)
  }

  /** Set or clear one checkpoint's pin (pinned checkpoints survive retention). */
  setPinned(input: { readonly cwd: string; readonly id: string; readonly pinned: boolean }): { readonly pinned: boolean } {
    const database = this.requireDatabase()
    const result = database.prepare('UPDATE engineering_checkpoints SET pinned = ? WHERE project_id = ? AND id = ?').run(input.pinned ? 1 : 0, projectIdFor(input.cwd), input.id)
    if (result.changes !== 1) throw new Error('engineering checkpoint was not found in this workspace')
    return { pinned: input.pinned }
  }

  /**
   * Preview a restore without touching any file: compare the manifest against
   * the current workspace so the model or user can judge the blast radius
   * first (Cline shows restore previews; all-or-nothing restore was the gap).
   */
  diff(input: { readonly cwd: string; readonly id: string }): CheckpointDiffResult {
    const checkpoint = this.get(input)
    if (checkpoint === undefined) throw new Error('engineering checkpoint was not found in this workspace')
    const root = resolve(input.cwd)
    const modified: string[] = []
    let missingBlobs = 0
    for (const entry of checkpoint.entries) {
      if (this.readBlob(entry.hash) === undefined) {
        missingBlobs += 1
        continue
      }
      const target = join(root, ...entry.file.split('/'))
      try {
        const current = readFileSync(target)
        if (createHash('sha256').update(current).digest('hex') !== entry.hash) modified.push(entry.file)
      } catch {
        modified.push(entry.file)
      }
    }
    // A capture list that is a prefix cannot say which tracked files are new:
    // its tail is full of files that predate the checkpoint, and a preview that
    // listed them as created-since would be describing a deletion nobody asked
    // for. Withheld and reported, rather than empty and silent.
    const truncated = checkpoint.capturedTruncated === true
    const currentFiles = (truncated ? [] : collectTrackedFiles(root).files).map(file => relative(root, file).split('\\').join('/'))
    const known = knownFilesAtCapture(checkpoint)
    const addedSince = currentFiles.filter(file => !known.has(file))
    const addedSet = new Set(addedSince)
    const deletedSince = checkpoint.entries.filter(entry => !addedSet.has(entry.file)).filter(entry => !existsSync(join(root, ...entry.file.split('/')))).map(entry => entry.file)
    return { modified, addedSince, deletedSince, missingBlobs, captureListTruncated: truncated }
  }

  /**
   * Restore the workspace to a checkpoint: rewrite every tracked file from its
   * blob and delete files the checkpoint does not know (they were created
   * after it). Untracked binaries and ignored directories are never touched.
   */
  async restore(input: { readonly cwd: string; readonly id: string }): Promise<CheckpointRestoreResult> {
    const checkpoint = this.get(input)
    if (checkpoint === undefined) throw new Error('engineering checkpoint was not found in this workspace')
    const root = resolve(input.cwd)
    // Compare against the capture list, not the stored entries: an entry can be
    // absent because the capture ran out of budget, and those files predate the
    // checkpoint. Deleting them destroyed real source files.
    // "Delete every tracked file the checkpoint does not name" is the question
    // "did this exist at capture time?" asked of the whole disk, and a truncated
    // capture list answers it wrongly for its tail — which is exactly how a
    // restore deleted real, pre-existing source files before the capture list
    // existed at all. A list the walk admits is incomplete gets no deletion
    // phase; the rewrite below still runs, because `entries` is exact.
    const truncated = checkpoint.capturedTruncated === true
    const known = knownFilesAtCapture(checkpoint)
    let restoredFiles = 0
    let deletedFiles = 0
    let missingBlobs = 0
    // Rewrite files recorded in the checkpoint.
    for (const entry of checkpoint.entries) {
      const target = join(root, ...entry.file.split('/'))
      const blob = this.readBlob(entry.hash)
      if (blob === undefined) {
        missingBlobs += 1
        continue
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, blob)
      restoredFiles += 1
    }
    // Delete files that appeared after the checkpoint. Only tracked source
    // extensions are considered so an agent-created binary artifact or user
    // download is never destroyed by a restore.
    const currentFiles = truncated ? [] : collectTrackedFiles(root).files
    for (const file of currentFiles) {
      const relativeFile = relative(root, file).split('\\').join('/')
      if (known.has(relativeFile)) continue
      try {
        await rm(file, { force: true })
        deletedFiles += 1
      } catch {
        continue
      }
    }
    return { restoredFiles, deletedFiles, missingBlobs, captureListTruncated: truncated }
  }

  /**
   * Delete one checkpoint manifest, then release the blobs no manifest references
   * any more. Blobs are shared with sibling checkpoints and with other
   * workspaces, so what may go is decided store-wide by `prune`, never here.
   */
  remove(input: { readonly cwd: string; readonly id: string }): { readonly deleted: true } {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const result = database.prepare('DELETE FROM engineering_checkpoints WHERE project_id = ? AND id = ?').run(projectId, input.id)
    if (result.changes !== 1) throw new Error('engineering checkpoint was not found in this workspace')
    this.prune()
    return { deleted: true }
  }

  /**
   * Delete the blob files no manifest references any more, and report what went.
   *
   * Retention drops manifests past MAX_RETAINED_CHECKPOINTS and `remove` drops
   * them on request. Without this sweep the bytes they pointed at stay forever:
   * the store would grow with every distinct content ever captured, while the
   * history it can restore stays capped at forty checkpoints. Stale staging files
   * (a capture killed between writing and renaming its blob) are reclaimed the
   * same way, since nothing references them either.
   *
   * Liveness is store-wide. A blob is shared between sibling checkpoints — that is
   * the point of content addressing — and between workspaces whose files happen to
   * match, so the live set is every manifest in the store. Deciding it per project
   * would delete bytes another workspace still needs, and its next restore would
   * report them missing.
   *
   * A blob younger than the grace is left alone: `capture` writes its blobs before
   * it commits the manifest naming them, so an unreferenced blob can belong to a
   * capture still in flight. The residual — a capture stalled longer than the
   * grace — surfaces as a missing blob on the next restore, which is reported
   * rather than restored as the wrong bytes. A grace of zero takes every
   * unreferenced blob, however recently it was written.
   *
   * Nothing is reclaimed while any manifest is unreadable: one unparsable row
   * would drop every hash it names from the live set, and that is the one mistake
   * here that loses bytes another checkpoint needs.
   */
  prune(input: { readonly graceMs?: number } = {}): { readonly deleted: number; readonly bytes: number } {
    const live = this.referencedHashes()
    if (live === undefined) return { deleted: 0, bytes: 0 }
    const grace = input.graceMs ?? PRUNE_GRACE_MS
    const cutoff = Date.now() - grace
    let deleted = 0
    let bytes = 0
    let shards: string[]
    try {
      shards = readdirSync(this.blobDirectory)
    } catch {
      return { deleted: 0, bytes: 0 }
    }
    for (const shard of shards) {
      const shardDirectory = join(this.blobDirectory, shard)
      let candidates: string[]
      try {
        candidates = readdirSync(shardDirectory)
      } catch {
        continue
      }
      for (const candidate of candidates) {
        if (live.has(candidate)) continue
        const path = join(shardDirectory, candidate)
        try {
          const info = statSync(path)
          // A zero grace means "wait for nothing", and that has to be stated
          // rather than left to the comparison: `Date.now()` and the filesystem's
          // timestamp clock are not the same source — on Windows the file time can
          // sit several milliseconds ahead — so a blob written moments ago compares
          // *greater* than a zero cutoff and a sweep told not to wait still left it
          // behind. The grace only has to be honest for a positive value, where the
          // skew is nothing against it.
          if (!info.isFile() || (grace > 0 && info.mtimeMs > cutoff)) continue
          rmSync(path, { force: true })
          deleted += 1
          bytes += info.size
        } catch {
          continue
        }
      }
    }
    return { deleted, bytes }
  }

  /** Every hash any manifest in the store names, or `undefined` when one cannot be
   * read — in which case a sweep must not run at all (see `prune`). */
  private referencedHashes(): ReadonlySet<string> | undefined {
    const database = this.requireDatabase()
    const rows = database.prepare('SELECT entries_json FROM engineering_checkpoints').all() as { readonly entries_json?: unknown }[]
    const live = new Set<string>()
    for (const row of rows) {
      if (typeof row.entries_json !== 'string') return undefined
      let value: unknown
      try {
        value = JSON.parse(row.entries_json)
      } catch {
        return undefined
      }
      if (!Array.isArray(value)) return undefined
      for (const entry of value) {
        const hash = (entry as { readonly hash?: unknown } | null)?.hash
        if (typeof hash !== 'string') return undefined
        live.add(hash)
      }
    }
    return live
  }

  /**
   * Count of stored blobs (for status/diagnostics).
   *
   * Blobs are sharded by the first two characters of their hash, so the top-level
   * listing is the *shard* count — 256 at most, whatever the store holds. The eval
   * case that watches this number ("identical content shares a blob") only ever
   * compares it against itself, so the shard count passed for a blob count until a
   * store with more distinct contents than shards. Staging files are not blobs yet
   * and are not counted.
   */
  blobCount(): number {
    let total = 0
    let shards: string[]
    try {
      shards = readdirSync(this.blobDirectory)
    } catch {
      return 0
    }
    for (const shard of shards) {
      try {
        total += readdirSync(join(this.blobDirectory, shard)).filter(entry => !entry.endsWith('.tmp')).length
      } catch {
        continue
      }
    }
    return total
  }

  private async ensureBlob(hash: string, content: Buffer): Promise<void> {
    const shard = join(this.blobDirectory, hash.slice(0, 2))
    const target = join(shard, hash)
    if (existsSync(target)) return
    await mkdir(shard, { recursive: true, mode: 0o700 })
    // The staging name carries a per-write token rather than the process id, so
    // two captures running at once own one staging file each instead of writing
    // and renaming through a shared one. `trust.ts`, `plan/plan-file.ts`,
    // `media-generation.ts` and `plugin-update.ts` all stage with a token for the
    // same reason.
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    try {
      await rename(temporary, target)
    } catch (error) {
      // Two captures do overlap in one process — the model's
      // `engineering_checkpoint_capture` while the throttled pre-mutation auto
      // capture is still writing, or two sessions doing both — and they hash the
      // same unchanged file to the same target. Losing that commit is success,
      // not failure: the store is content-addressed, so a target that exists
      // once our rename failed already holds exactly the bytes this write wanted
      // to store (Windows is where the loss is reachable at all, refusing a
      // rename onto a destination another writer has just created). The throw is
      // the part that cannot be seen: `capture` skips a file it cannot stage, so
      // the checkpoint lists the file as captured while holding no blob for it,
      // and a later restore leaves that file's post-checkpoint contents in place
      // while reporting success.
      if (existsSync(target)) {
        await rm(temporary, { force: true })
        return
      }
      throw error
    }
  }

  private readBlob(hash: string): Buffer | undefined {
    try {
      return readFileSync(join(this.blobDirectory, hash.slice(0, 2), hash))
    } catch {
      return undefined
    }
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error('engineering checkpoint store is not open')
    return this.database
  }
}

/**
 * Every tracked file under `root`, up to the walk cap.
 *
 * A directory is always taken whole and the cap is checked before visiting the
 * next one, so `truncated` means directories were left unvisited and the list is a
 * prefix of the workspace. Every caller that asks "did this file exist at capture
 * time?" has to carry that fact instead of guessing (see `capture`, `diff`,
 * `restore`). One directory larger than the cap is *not* truncated: it was
 * visited whole, and nothing was left behind.
 */
function collectTrackedFiles(root: string): { readonly files: readonly string[]; readonly truncated: boolean } {
  if (!existsSync(root)) return { files: [], truncated: false }
  const files: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && files.length < MAX_TRACKED_FILES) {
    const directory = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        stack.push(full)
        continue
      }
      const extension = entry.name.includes('.') ? `.${entry.name.split('.').pop()!.toLowerCase()}` : ''
      if (!TRACKED_EXTENSIONS.has(extension)) continue
      // A credential file is never tracked, even when its extension is. The
      // dotfile rule above already drops `.env` and `.npmrc`, but `secrets.json`
      // and `credentials.json` carry a tracked extension and are named by the
      // credential guard everywhere else — a checkpoint would copy their bytes
      // into the blob store, which is a second durable copy under the plugin's
      // data home, outside the repository and so outside anything a `.gitignore`
      // protects. Untracked also means restore never deletes it, because the
      // deletion rule asks this same function what is tracked.
      if (isCredentialPath(full)) continue
      try {
        if (statSync(full).size > MAX_TRACKED_FILE_BYTES) continue
      } catch {
        continue
      }
      files.push(full)
    }
  }
  return { files, truncated: files.length >= MAX_TRACKED_FILES && stack.length > 0 }
}

function projectIdFor(cwd: string): string {
  const identity = resolve(cwd).replaceAll('\\', '/').toLowerCase()
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

function defaultCheckpointDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'checkpoints')
}

