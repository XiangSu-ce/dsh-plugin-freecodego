/**
 * Export durable project memory as a folder of Markdown documents.
 *
 * Why a document library
 * ---------------------
 * The durable memory is a SQLite database. That makes it fast and race-safe and
 * it makes it *invisible*: the only way to see what the project remembers is to
 * ask a model to search it, and the only way to correct a wrong memory is to wait
 * for a review flow. Both are the wrong shape for a store whose whole value is
 * being trusted. `memory-document.ts` already renders and parses the format; this
 * module is the part that was missing — deciding what gets written, and writing
 * it without ever being the step that puts a credential on disk.
 *
 * Three rules this module holds itself to
 * ---------------------------------------
 * 1. **A skipped record is named, never dropped.** Four refusals are reported
 *    with the reason: a malformed id, a body that still carries a credential, an
 *    instant with no ISO form, and a record whose fields the document format
 *    cannot read back — the plan renders
 *    every document and re-parses it before it is written, so nothing lands on disk
 *    that this plugin could not open again. An export that wrote 3 of 40 records
 *    explains itself instead of looking like a store that had 3 records.
 * 2. **An export never deletes.** A file in the target directory that this plan
 *    did not produce — a memory since deleted, or a document the user hand-edited
 *    — is reported as `stale` and left alone. Deleting it would be the module
 *    overwriting a user's edit with its own idea of what the store holds.
 * 3. **Same records, same bytes.** The plan is a pure function of the records and
 *    the clock, so re-exporting an unchanged store rewrites identical files and a
 *    diff of the folder shows only real changes.
 *
 * The index lists exactly the records that were exported, so the folder is
 * self-describing: a reader who opens only `INDEX.md` never sees a row whose file
 * is missing.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/memory-export
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { MEMORY_ID } from '../engineering-memory.ts'
import { containsMemoryRedaction } from './memory-security.ts'
import { memoryFileName, parseMemoryDocument, renderMemoryDocument, renderMemoryIndex, type MemoryDocumentRecord } from './memory-document.ts'

/** Fixed name of the generated index, and the one file the stale scan ignores. */
export const MEMORY_INDEX_FILENAME = 'INDEX.md'

/** Why one record produced no document. Named, so a caller can explain a short export. */
export type MemoryExportSkipReason = 'invalid-id' | 'carries-credential' | 'redacted' | 'unreadable' | 'invalid-date'

export interface MemoryExportSkip {
  /** The record's id as the store gave it, so the skip is traceable even when it is malformed. */
  readonly id: string
  readonly title: string
  readonly reason: MemoryExportSkipReason
}

export interface MemoryExportFile {
  readonly name: string
  readonly text: string
}

/** What an export would write, without touching the filesystem. */
export interface MemoryExportPlan {
  readonly files: readonly MemoryExportFile[]
  readonly index: MemoryExportFile
  readonly skipped: readonly MemoryExportSkip[]
}

/**
 * Decide the document for each record.
 *
 * The reason is determined here rather than inferred from a `undefined` return,
 * so the refusals stay distinguishable: an id that does not match the store's
 * format is a bug in the caller, while a body that still carries a credential is
 * a security outcome the user should see named.
 *
 * @param records - the records to export, in any order.
 * @param now - the clock the index stamps itself with.
 * @returns the files to write, the index, and the records that were skipped.
 */
export function planMemoryExport(records: readonly MemoryDocumentRecord[], now: number): MemoryExportPlan {
  const files: MemoryExportFile[] = []
  const skipped: MemoryExportSkip[] = []
  const exported: MemoryDocumentRecord[] = []
  for (const record of records) {
    // The reasons are derived here rather than inferred from a `undefined` render,
    // because only the caller can distinguish them in the user's terms. The order
    // mirrors `renderMemoryDocument`'s own checks so the two agree; when they ever
    // do not, the render result still wins and the record is skipped, so a
    // divergence costs a misfiled reason rather than a leaked document.
    if (!MEMORY_ID.test(record.id)) {
      skipped.push({ id: record.id, title: record.title, reason: 'invalid-id' })
      continue
    }
    // Checked here rather than left to the renderer, because the *reason* is what
    // the caller reports: an unusable instant is a record fact, not a credential
    // outcome, and `renderMemoryDocument` returns `undefined` for both.
    if (!Number.isFinite(record.createdAt) || (record.reviewedAt !== undefined && !Number.isFinite(record.reviewedAt))) {
      skipped.push({ id: record.id, title: record.title, reason: 'invalid-date' })
      continue
    }
    // The marker check precedes the credential scan: the text is *known* to have
    // held a credential, which a reader of the skip list needs to tell apart from
    // "this merely looks like one".
    if (containsMemoryRedaction(`${record.title}\n${record.body}`)) {
      skipped.push({ id: record.id, title: record.title, reason: 'redacted' })
      continue
    }
    const text = renderMemoryDocument(record, now)
    if (text === undefined) {
      skipped.push({ id: record.id, title: record.title, reason: 'carries-credential' })
      continue
    }
    // The round trip is proved here rather than assumed. The renderer writes the
    // fields the record holds and the parser validates them against the document
    // format's own rules, so a record whose field shapes sit outside those rules —
    // a tag stored before the two vocabularies were shared, for instance — would
    // otherwise be written as a file this plugin cannot read back. The export is
    // the store's lossless projection, so a document that fails its own reader is
    // named as a skip instead of landing on disk.
    if (!parseMemoryDocument(text).ok) {
      skipped.push({ id: record.id, title: record.title, reason: 'unreadable' })
      continue
    }
    files.push({ name: memoryFileName(record.title, record.id), text })
    exported.push(record)
  }
  return { files, index: { name: MEMORY_INDEX_FILENAME, text: renderMemoryIndex(exported, now) }, skipped }
}

/** One document the filesystem would not take, named with its own words. */
export interface MemoryExportFailure {
  /** The document's file name inside the export directory. */
  readonly name: string
  /** What the write reported, verbatim: the reason is the filesystem's, not ours. */
  readonly message: string
}

export interface MemoryExportResult {
  readonly directory: string
  readonly written: readonly string[]
  /**
   * Documents that could not be written. Named for the same reason a skipped
   * record is: an export that wrote 39 of 40 must not read like a store that held
   * 39.
   */
  readonly failed: readonly MemoryExportFailure[]
  readonly skipped: readonly MemoryExportSkip[]
  /** Existing `*.md` files this export did not produce; reported, never removed. */
  readonly stale: readonly string[]
  /**
   * Reviewed records the *store* did not hand over because its own export cap was
   * reached.
   *
   * A separate axis from `skipped`, and the distinction is the point: those records
   * were read and refused, these were never read. `engineering_memory_export`'s
   * description promises the tool "reports records it had to skip", and a cap that
   * says nothing makes a truncated export read like a complete one — which is the
   * failure mode `skipped` and `failed` exist to prevent, one layer further up.
   */
  readonly omittedByLimit: number
}

/**
 * Write a plan into `directory`, creating it if needed.
 *
 * The directory is refused when it is a symlink, matching every sibling store in
 * this plugin: the directory is what the writes follow, so a link there would put
 * the user's memory somewhere they did not choose.
 *
 * A per-file failure does not abandon the rest — the returned `written` list is
 * what actually landed, so a caller cannot report a success the disk did not see,
 * and the failure is named in `failed` rather than swallowed, because a folder one
 * document short has to say which one.
 *
 * @param directory - target directory; created with `0o700` when absent.
 * @param plan - the plan from {@link planMemoryExport}.
 * @param omittedByLimit - reviewed records the store never handed over because its
 * own cap was reached. Carried through rather than recomputed, because only the
 * caller can see past the cap.
 * @returns what was written, what could not be written, what was skipped, what was
 * never read at all, and what was left alone.
 */
export async function writeMemoryExport(directory: string, plan: MemoryExportPlan, omittedByLimit = 0): Promise<MemoryExportResult> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new Error('memory export directory is a symlink; refusing to write')
  }
  const written: string[] = []
  const failed: MemoryExportFailure[] = []
  const stale = staleDocuments(directory, plan)
  for (const file of [...plan.files, plan.index]) {
    try {
      // 0600: the project's own memory is the user's, not the machine's.
      await writeFileAtomic(join(directory, file.name), file.text, { mode: 0o600, dirMode: 0o700 })
      written.push(file.name)
    } catch (error) {
      // Named, never dropped — the same rule the skip list follows. The loop carries
      // on so one unwritable document does not cost the other thirty-nine, and the
      // index is attempted whatever happened, so a folder whose documents landed
      // still describes itself.
      failed.push({ name: file.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { directory, written, failed, skipped: plan.skipped, stale, omittedByLimit }
}

/**
 * Existing documents this plan does not include.
 *
 * Only the flat `*.md` set is inspected, and the index name is excluded because
 * the plan always writes it. Subdirectories are ignored: they are not something
 * this module produces, so they are not something it can report as stale.
 *
 * Deliberately unguarded: the caller has already `mkdir`ed this directory, so a
 * read failure here is a real one (the directory was removed underneath the
 * export) and belongs in the caller's face. Swallowing it would report a clean
 * export over a directory that is no longer there.
 */
function staleDocuments(directory: string, plan: MemoryExportPlan): readonly string[] {
  const expected = new Set(plan.files.map(file => file.name))
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name)
  return entries.filter(name => name !== MEMORY_INDEX_FILENAME && !expected.has(name)).sort()
}
