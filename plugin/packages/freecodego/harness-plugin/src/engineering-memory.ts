/** Local, bounded project long-term memory shared by every Agent engine. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { freeCodeGoDataHome } from './data-home.ts'
import { ENGINEERING_MEMORY_TRUSTS } from './engineering-remote-utils.ts'
import { MEMORY_TAG_PATTERN, looksLikeMemorySecretValue } from './memory/memory-security.ts'
import { KEYWORD_SECRET_PATTERN, describeSecretFindings, redactSecretSpans, scanForSecrets } from './secret-scan.ts'
import { tokensFromChars } from './token-estimate.ts'
import { ENGINEERING_MEMORY_KINDS } from './types.ts'
import type {
  FreeCodeGoEngineeringMemoryDetail,
  FreeCodeGoEngineeringMemoryBackup,
  FreeCodeGoEngineeringMemoryConsolidation,
  FreeCodeGoEngineeringMemoryConsolidationItem,
  FreeCodeGoEngineeringMemoryIndex,
  FreeCodeGoEngineeringMemoryKind,
  FreeCodeGoEngineeringMemoryPage,
  FreeCodeGoEngineeringMemoryReviewDecision,
  FreeCodeGoEngineeringMemoryRecall,
  FreeCodeGoEngineeringMemoryRelation,
  FreeCodeGoEngineeringMemoryRelationKind,
  FreeCodeGoEngineeringMemoryRetentionResult,
  FreeCodeGoEngineeringMemorySource,
  FreeCodeGoEngineeringMemoryTimeline,
  FreeCodeGoEngineeringMemoryTrust,
} from './types.ts'

/**
 * The trust level carried by a durable memory record.
 */
export type EngineeringMemoryTrust = FreeCodeGoEngineeringMemoryTrust
/**
 * The kind of knowledge a memory record holds.
 */
export type EngineeringMemoryKind = FreeCodeGoEngineeringMemoryKind
/**
 * A memory record's index row, carrying no body text.
 */
export type EngineeringMemoryIndex = FreeCodeGoEngineeringMemoryIndex
/**
 * A memory record with its full body and originating sources.
 */
export type EngineeringMemoryDetail = FreeCodeGoEngineeringMemoryDetail
/**
 * One page of memory index rows with its optional continuation cursor.
 */
export type EngineeringMemoryPage = FreeCodeGoEngineeringMemoryPage
/**
 * A memory record with its surrounding time neighborhood.
 */
export type EngineeringMemoryTimeline = FreeCodeGoEngineeringMemoryTimeline
/**
 * A user review decision applied to a pending record.
 */
export type EngineeringMemoryReviewDecision = FreeCodeGoEngineeringMemoryReviewDecision
/**
 * The ranked memory selection injected at session start.
 */
export type EngineeringMemoryRecall = FreeCodeGoEngineeringMemoryRecall
/**
 * The session event a memory record was derived from.
 */
export type EngineeringMemorySource = FreeCodeGoEngineeringMemorySource
/**
 * The identity and size of one database backup.
 */
export type EngineeringMemoryBackup = FreeCodeGoEngineeringMemoryBackup
/**
 * How many records and outbox entries a retention sweep removed.
 */
export type EngineeringMemoryRetentionResult = FreeCodeGoEngineeringMemoryRetentionResult
/**
 * The outcome of distilling one observation into memory facts.
 */
export type EngineeringMemoryConsolidation = FreeCodeGoEngineeringMemoryConsolidation
/**
 * One fact written by a consolidation pass.
 */
export type EngineeringMemoryConsolidationItem = FreeCodeGoEngineeringMemoryConsolidationItem
/**
 * An edge between two memory records.
 */
export type EngineeringMemoryRelation = FreeCodeGoEngineeringMemoryRelation
/**
 * The kind of edge between two memory records.
 */
export type EngineeringMemoryRelationKind = FreeCodeGoEngineeringMemoryRelationKind

const MAX_BODY_BYTES = 64 * 1024
/**
 * Byte cap on a stored title.
 *
 * Deliberately not 200. The tool schemas bound a title at 200 *code points*
 * (`maxLength` in `engineering_memory_save` and `engineering_handoff_create`),
 * and JSON Schema counts characters while this store counts UTF-8 bytes: at a
 * 200-byte cap a title of 67 CJK characters passed the schema and was then
 * refused here, so a call the model was told was valid failed on a limit it could
 * not see. The cap is the worst case for a 200-code-point string — four bytes
 * each — so the schema's promise is always satisfiable, while the byte cap
 * survives as the storage bound it was meant to be.
 */
const MAX_TITLE_BYTES = 800
const MAX_EXPORT_RECORDS = 500
/**
 * The identity shape every durable memory carries. Exported so the document
 * view (`memory/memory-document.ts`) validates an id the same way the store
 * does; two id grammars would let a document pass one and fail the other.
 */
export const MEMORY_ID = /^mem_[a-f0-9]{32}$/i
/**
 * Screen content that is about to become durable memory.
 *
 * Two scanners with two different jobs. `KEYWORD_SECRET_PATTERN`
 * (`secret-scan.ts`, which is now the only place either pattern is written) is the
 * original keyword rule: it catches `api_key = "…"` wherever the field name already says
 * what the value is. The curated vendor-prefix rules catch a credential that
 * appears in file text with no label at all — a token pasted into a README, a key
 * inside a dumped config — which is the case the keyword rule structurally
 * cannot see. Neither replaces the other, so both run.
 *
 * The asymmetry between them is deliberate: a **labelled** credential refuses
 * the write (the caller did something it should not retry), while a
 * **shape-only** match is redacted in place and the write proceeds. A memory
 * entry outlives the session and is re-injected into later conversations, so
 * silently keeping a JWT in it costs more than losing an opaque identifier that
 * happened to look like one.
 *
 * @param title - already-sanitized memory title.
 * @param body - already-sanitized memory body.
 * @returns both fields, with shape-only matches redacted in the field they were
 *   found in.
 */
function screenMemoryCredentials(title: string, body: string): { readonly title: string; readonly body: string } {
  const source = `${title}\n${body}`
  if (KEYWORD_SECRET_PATTERN.test(source)) throw new Error('engineering memory rejected a suspected secret')
  const scanned = scanForSecrets(source)
  if (scanned.blocked.length > 0) throw new Error(`engineering memory rejected a suspected secret (${describeSecretFindings(scanned.blocked)})`)
  // Offsets are relative to `source`, so a finding inside the title is redacted in the
  // title and only the body's findings are shifted onto the body. The title used to be
  // left alone, on the reasoning that a finding inside it "has nothing to redact in the
  // body" — true, and the wrong conclusion: the title is stored, listed and handed to
  // the recall selector on its own, so a token that landed there survived verbatim a
  // rule whose whole promise is "redacted in place".
  const shapeOnly = scanned.findings.filter(finding => !scanned.blocked.includes(finding))
  const inTitle = shapeOnly.filter(finding => finding.index + finding.length <= title.length)
  const inBody = shapeOnly
    .filter(finding => finding.index > title.length)
    .map(finding => ({ ...finding, index: finding.index - title.length - 1 }))
  return {
    title: inTitle.length === 0 ? title : redactSecretSpans(title, inTitle),
    body: inBody.length === 0 ? body : redactSecretSpans(body, inBody),
  }
}

/**
 * Refuse a tag that carries a credential.
 *
 * `screenMemoryCredentials` above builds its source from the title and the body
 * only, and `normalizeTags` is a shape filter — charset, length, dedup — not a
 * content check. A vendor key passes that shape: `sk-…` is lowercase
 * alphanumerics and hyphens, and a JWT is dots, hyphens and underscores. So a
 * tag was the one field of a durable record nothing screened, on the path that
 * writes `tags_json` verbatim. The canonical `screenMemoryForPersistence` in
 * `memory/memory-security.ts` takes a `tags` argument for exactly this reason;
 * this is the same rule, stated where the other screen's callers can see it.
 *
 * Tags are refused rather than redacted, and refused loudly: a redacted tag is
 * not a shorter tag, it is a tag that means nothing, and a silent drop would
 * leave the caller believing it recorded a label it did not.
 *
 * @param tags - the already-normalized tags about to be persisted.
 * @throws when a tag is, or contains, a suspected credential.
 */
function screenMemoryTags(tags: readonly string[]): void {
  for (const [index, tag] of tags.entries()) {
    if (looksLikeMemorySecretValue(tag)) throw new Error(`engineering memory rejected a suspected secret in tags[${index}]`)
    // Any finding, not only the blocked tier. `memory/memory-security.ts` is
    // explicit that a durable entry refuses the shape-only tier as well — a
    // memory is re-injected into every later conversation that recalls it and
    // leaves the machine with team memory — and the tier is load-bearing here
    // rather than theoretical: the scanner *reports* `sk-…` without blocking it,
    // so gating on `blocked` alone let the one shape this plugin's own providers
    // use through the guard that was added to stop it.
    const scanned = scanForSecrets(tag)
    if (scanned.findings.length > 0) throw new Error(`engineering memory rejected a suspected secret in tags[${index}] (${describeSecretFindings(scanned.findings)})`)
  }
}

/**
 * The states this store reads, from the list the remote validator accepts.
 *
 * The membership used to be written out here as well, which is how a store and
 * the boundary in front of it drift apart: a state the store writes and the
 * validator refuses is one no caller can ask for.
 */
const TRUSTS: readonly EngineeringMemoryTrust[] = ENGINEERING_MEMORY_TRUSTS
const USER_VISIBLE_TRUSTS: readonly EngineeringMemoryTrust[] = ['reviewed']

type Cursor = { readonly createdAt: number; readonly id: string }
type MemoryRow = {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly trust: string
  readonly project_id: string
  readonly body: string
  readonly tags_json?: string
  readonly source_engine?: string | null
  readonly created_at: number
  /** Reconciliation identity of a distilled fact; null on drafts and pre-subject rows. */
  readonly subject?: string | null
}

type SourceRow = {
  readonly session_id: string
  readonly event_sequence: number
  readonly event_type: string
  readonly turn?: number | null
  readonly engine?: string | null
  readonly provider?: string | null
  readonly model?: string | null
  readonly files_read_json: string
  readonly files_written_json: string
  readonly captured_at: number
}

type ObservationPayload = {
  readonly cwd: string
  readonly sessionId: string
  readonly generation: string
  readonly kind: EngineeringMemoryKind
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
  readonly sourceEngine?: string
  readonly sources: readonly EngineeringMemorySource[]
}

/** SQLite-backed per-project store. All caller paths are reduced to a hash before persistence. */
export class EngineeringMemoryStore {
  private readonly databasePath: string
  private database: DatabaseSync | undefined

  constructor(rootDirectory = defaultMemoryDirectory()) {
    this.databasePath = resolve(rootDirectory, 'engineering-memory.sqlite')
  }

/**
 * Open the store's SQLite database, create or migrate its schema, and drain queued observations.
 */
  async open(): Promise<void> {
    const root = dirname(this.databasePath)
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('engineering memory directory must not be a symlink')
    const database = new DatabaseSync(this.databasePath)
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    database.exec(`
      CREATE TABLE IF NOT EXISTS engineering_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        subject TEXT,
        kind TEXT NOT NULL,
        trust TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_engine TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS engineering_memories_project_time ON engineering_memories(project_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS engineering_memories_project_hash ON engineering_memories(project_id, content_hash);
      CREATE TABLE IF NOT EXISTS engineering_memory_sources (
        memory_id TEXT NOT NULL REFERENCES engineering_memories(id) ON DELETE CASCADE,
        source_index INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        turn INTEGER,
        engine TEXT,
        provider TEXT,
        model TEXT,
        files_read_json TEXT NOT NULL,
        files_written_json TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        PRIMARY KEY(memory_id, source_index)
      );
      CREATE INDEX IF NOT EXISTS engineering_memory_sources_session ON engineering_memory_sources(session_id, event_sequence);
      CREATE TABLE IF NOT EXISTS engineering_memory_outbox (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        generation_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, generation_key)
      );
      CREATE INDEX IF NOT EXISTS engineering_memory_outbox_state ON engineering_memory_outbox(state, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS engineering_memories_fts USING fts5(
        id UNINDEXED, project_id UNINDEXED, title, body, tags
      );
      CREATE TRIGGER IF NOT EXISTS engineering_memories_fts_insert AFTER INSERT ON engineering_memories BEGIN
        INSERT INTO engineering_memories_fts(id, project_id, title, body, tags) VALUES (new.id, new.project_id, new.title, new.body, new.tags_json);
      END;
      CREATE TRIGGER IF NOT EXISTS engineering_memories_fts_update AFTER UPDATE ON engineering_memories BEGIN
        DELETE FROM engineering_memories_fts WHERE id = old.id;
        INSERT INTO engineering_memories_fts(id, project_id, title, body, tags) VALUES (new.id, new.project_id, new.title, new.body, new.tags_json);
      END;
      CREATE TRIGGER IF NOT EXISTS engineering_memories_fts_delete AFTER DELETE ON engineering_memories BEGIN
        DELETE FROM engineering_memories_fts WHERE id = old.id;
      END;
    `)
    // Reinforcement columns: every FTS hit strengthens the record and feeds
    // recall ranking (mem0-style usage signal); the retention sweep ages out
    // records that were never hit again. Columns are added defensively for
    // databases created before they existed.
    const memoryColumns = new Set((database.prepare('PRAGMA table_info(engineering_memories)').all() as { readonly name?: unknown }[]).flatMap(column => typeof column.name === 'string' ? [column.name] : []))
    // The subject a distilled fact reconciles against. Older databases only
    // stored the rendered title, which is not the same identity: two sessions
    // that both verify render one title but are different knowledge. Rows
    // without a subject keep reconciling by title (see `reconcileTarget`).
    if (!memoryColumns.has('subject')) database.exec('ALTER TABLE engineering_memories ADD COLUMN subject TEXT')
    if (!memoryColumns.has('hit_count')) database.exec('ALTER TABLE engineering_memories ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0')
    if (!memoryColumns.has('last_hit_at')) database.exec('ALTER TABLE engineering_memories ADD COLUMN last_hit_at INTEGER NOT NULL DEFAULT 0')
    // Behavior version 1 stored automatic observations as captured/draft
    // records that required a user promotion step. Version 2 keeps those trust
    // values intact so the Remote review pipeline can promote a current draft.
    // The one-time promotion therefore runs only for databases still on
    // version 1, and new databases start directly at version 2.
    const userVersion = Number((database.prepare('PRAGMA user_version').get() as { readonly user_version?: number | string } | undefined)?.user_version ?? 0)
    if (userVersion < 2) {
      database.prepare("UPDATE engineering_memories SET trust = 'reviewed', updated_at = ? WHERE trust IN ('captured', 'draft')").run(Date.now())
      database.exec('PRAGMA user_version = 2')
    }
    this.database = database
    // Observations are deterministic and locally queued, so recovery never needs
    // to replay a model request or a project command after a Host restart.
    this.drainOutbox()
  }

/**
 * Close the underlying database handle if it is open.
 */
  close(): void {
    this.database?.close()
    this.database = undefined
  }

/**
 * Save an agent-authored draft record.
 * @param input - the draft's cwd, title, body, and optional kind, tags, and source engine.
 * @returns the stored memory detail.
 */
  saveDraft(input: { readonly cwd: string; readonly title: string; readonly body: string; readonly kind?: EngineeringMemoryKind; readonly tags?: readonly string[]; readonly sourceEngine?: string }): EngineeringMemoryDetail {
    const database = this.requireDatabase()
    const draftedTitle = sanitizeText(stripPrivateSections(input.title), MAX_TITLE_BYTES, 'memory title')
    const draftedBody = sanitizeText(stripPrivateSections(input.body), MAX_BODY_BYTES, 'memory body')
    const screened = screenMemoryCredentials(draftedTitle, draftedBody)
    const title = screened.title
    const body = screened.body
    const tags = normalizeTags(input.tags)
    screenMemoryTags(tags)
    const projectId = projectIdFor(input.cwd)
    const kind = input.kind ?? 'note'
    const sourceEngine = input.sourceEngine?.trim() || undefined
    // The hash is the *whole* save, not just its prose. It used to cover only
    // `projectId`, `title`, and `body`, which made a second save that changed the
    // kind or the tags return the first record's detail — the tool reported a
    // record it had not written, carrying the old kind and the old tags. The
    // fields below are the ones a caller can state, so they are the ones that make
    // two saves the same save. `sourceEngine` is deliberately left out: it is
    // derived from whichever engine happened to be driving, not stated by the
    // caller, so folding it in would split one piece of knowledge into a row per
    // engine. This is the same reasoning `saveCaptured` applies when it mixes the
    // generation into its own hash (see the NOOP note below): a hash narrower than
    // the thing it identifies collapses records that are not the same.
    // Tags are a set — `normalizeTags` already dedups them — so the order they were
    // typed in must not be what makes two saves differ. Sorted here only for the
    // hash; the stored `tags_json` keeps the caller's order.
    // Tags are a set — `normalizeTags` already dedups them — so the order they were
    // typed in must not be what makes two saves differ. Sorted here only for the
    // hash; the stored `tags_json` keeps the caller's order.
    const hash = createHash('sha256').update(`${projectId}\u0000${title}\u0000${body}\u0000${kind}\u0000${JSON.stringify([...tags].sort())}`).digest('hex')
    const duplicate = database.prepare('SELECT id, title, kind, trust, project_id, body, tags_json, source_engine, created_at FROM engineering_memories WHERE project_id = ? AND content_hash = ? ORDER BY created_at DESC LIMIT 1').get(projectId, hash) as MemoryRow | undefined
    if (duplicate !== undefined) return this.detailFor(database, duplicate)
    const id = `mem_${randomUUID().replaceAll('-', '')}`
    const now = Date.now()
    database.prepare('INSERT INTO engineering_memories(id, project_id, title, kind, trust, body, tags_json, source_engine, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, title, kind, 'draft', body, JSON.stringify(tags), sourceEngine ?? null, now, now, hash)
    // A freshly saved draft has no observations yet, so it has no edges to derive.
    return { id, title, kind, trust: 'draft', projectId, body, tags, sources: [], related: [], ...(sourceEngine === undefined ? {} : { sourceEngine }), createdAt: now, detailTokens: estimateTokens(body) }
  }

/**
 * Queue a deterministic, allowlisted observation. A restart can safely drain this SQLite outbox.
 * @param input - the observation payload to queue.
 * @returns whether the row was queued and its outbox id.
 */
  enqueueObservation(input: ObservationPayload): { readonly queued: boolean; readonly id: string } {
    const database = this.requireDatabase()
    const payload = normalizeObservation(input)
    const projectId = projectIdFor(payload.cwd)
    const now = Date.now()
    const id = `out_${randomUUID().replaceAll('-', '')}`
    const result = database.prepare('INSERT OR IGNORE INTO engineering_memory_outbox(id, project_id, generation_key, payload_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, projectId, payload.generation, JSON.stringify(payload), 'queued', now, now)
    return { queued: result.changes === 1, id }
  }

/**
 * Convert queued observations to captured records. Failed jobs remain for a later local retry.
 * @param limit - the maximum number of queued rows to process.
 * @returns how many rows drained and how many failed.
 */
  drainOutbox(limit = 20): { readonly drained: number; readonly failed: number } {
    const database = this.requireDatabase()
    // A permanently poisoned payload (storage corruption, newer schema fields)
    // must not occupy the retry budget forever: past MAX_ATTEMPTS the row is
    // dead-lettered so each drain spends its limit on rows that can succeed.
    const MAX_ATTEMPTS = 5
    const rows = database.prepare("SELECT id, payload_json FROM engineering_memory_outbox WHERE state IN ('queued', 'failed') AND attempts < ? ORDER BY created_at ASC LIMIT ?").all(MAX_ATTEMPTS, clamp(limit, 1, 100)) as { readonly id: string; readonly payload_json: string }[]
    let drained = 0
    let failed = 0
    for (const row of rows) {
      try {
        this.saveCaptured(parseObservation(row.payload_json))
        database.prepare("UPDATE engineering_memory_outbox SET state = 'done', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(Date.now(), row.id)
        drained += 1
      } catch {
        database.prepare("UPDATE engineering_memory_outbox SET state = 'failed', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(Date.now(), row.id)
        failed += 1
      }
    }
    return { drained, failed }
  }

  /**
   * Run one logical write as a single SQLite transaction.
   *
   * The multi-statement writes here are pairs whose halves must not diverge: a
   * consolidation retires the record it replaces and inserts its replacement.
   * Committed separately, a crash between them leaves the retired record gone
   * and the replacement never written — knowledge that disappears from every
   * search without ever being replaced. `BEGIN IMMEDIATE` additionally takes the
   * write lock up front, so the read half of a read-then-write pair cannot
   * interleave with another writer.
   */
  private inTransaction<T>(database: DatabaseSync, work: () => T): T {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Persist one host-derived observation as immediately searchable memory. 
   * @returns the engineering Memory Detail.
 * @param input - the observation payload to persist.
   */
  saveCaptured(input: ObservationPayload): EngineeringMemoryDetail {
    const database = this.requireDatabase()
    return this.inTransaction(database, () => this.insertCaptured(database, input))
  }

  /**
   * The live record a distilled fact replaces, or undefined for a new fact.
   *
   * Identity is the fact's subject — stored alongside the record — and not the
   * title it happens to render. Titles are presentation: two sessions that each
   * pass a verification render the same one, and the same session flipping
   * pass → fail renders two, yet both are one subject whose older outcome has to
   * be retired. Rows written before the subject column existed still reconcile by
   * title, so an upgrade neither duplicates nor loses what it already holds; a
   * subject match always wins over that fallback so a legacy row can never
   * outrank the fact's own current record.
   */
  private reconcileTarget(database: DatabaseSync, projectId: string, fact: MemoryFact): { readonly id: string; readonly title: string; readonly body: string; readonly trust: string } | undefined {
    return database.prepare("SELECT id, title, body, trust FROM engineering_memories WHERE project_id = ? AND trust IN ('captured', 'reviewed') AND (subject = ? OR (subject IS NULL AND title = ?)) ORDER BY (subject IS NULL), created_at DESC LIMIT 1").get(projectId, fact.subject, fact.title) as { readonly id: string; readonly title: string; readonly body: string; readonly trust: string } | undefined
  }

  /**
   * Insert one captured record and its sources.
   *
   * Deliberately runs inside the caller's transaction: {@link saveCaptured}
   * wraps it alone, while consolidation commits it together with the retirement
   * of the record it replaces.
   */
  private insertCaptured(database: DatabaseSync, input: ObservationPayload, subject?: MemoryFact['subject']): EngineeringMemoryDetail {
    const payload = normalizeObservation(input)
    const projectId = projectIdFor(payload.cwd)
    const observedTitle = sanitizeText(stripPrivateSections(payload.title), MAX_TITLE_BYTES, 'observation title')
    const observedBody = sanitizeText(stripPrivateSections(payload.body), MAX_BODY_BYTES, 'observation body')
    // The same screen the draft path applies. Capture is unattended and reads what the
    // agent read, so this is the path a credential reaches most easily — a token inside
    // a log line or a config the turn touched. Until this call existed the store kept
    // such a value verbatim here while the curated path refused it, which made the
    // difference between the two paths a function of which one a user happened to use
    // rather than of what the content was.
    const screened = screenMemoryCredentials(observedTitle, observedBody)
    const title = screened.title
    const body = screened.body
    screenMemoryTags(payload.tags)
    const hash = createHash('sha256').update(`${projectId}\u0000${payload.generation}\u0000${title}\u0000${body}`).digest('hex')
    const duplicate = database.prepare('SELECT id, title, kind, trust, project_id, body, tags_json, source_engine, created_at FROM engineering_memories WHERE project_id = ? AND content_hash = ? LIMIT 1').get(projectId, hash) as MemoryRow | undefined
    if (duplicate !== undefined) return this.detailFor(database, duplicate)
    const id = `mem_${randomUUID().replaceAll('-', '')}`
    const now = Date.now()
    database.prepare('INSERT INTO engineering_memories(id, project_id, title, subject, kind, trust, body, tags_json, source_engine, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, title, subject ?? null, payload.kind, 'captured', body, JSON.stringify(payload.tags), payload.sourceEngine ?? null, now, now, hash)
    const insertSource = database.prepare('INSERT INTO engineering_memory_sources(memory_id, source_index, session_id, event_sequence, event_type, turn, engine, provider, model, files_read_json, files_written_json, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    payload.sources.forEach((source, index) => insertSource.run(id, index, source.sessionId, source.eventSequence, source.eventType, source.turn ?? null, source.engine ?? null, source.provider ?? null, source.model ?? null, JSON.stringify(source.filesRead), JSON.stringify(source.filesWritten), source.capturedAt))
    return this.detailFor(database, { id, title, subject: subject ?? null, kind: payload.kind, trust: 'captured', project_id: projectId, body, tags_json: JSON.stringify(payload.tags), source_engine: payload.sourceEngine ?? null, created_at: now })
  }

  /**
   * Consolidate one turn's observation into atomic, queryable facts
   * (mem0-style pipeline, deterministic local reimplementation).
   *
   * The whole pass is one transaction: the facts of a single observation are
   * halves of the same knowledge, and a record that lands without its siblings
   * (or without its own source rows) is a half-written turn.
   *
   * The Host distills the raw observation body into candidate facts, then
   * each fact is reconciled against existing memory before anything is
   * written:
   *  - a near-duplicate fact whose content contradicts an existing record
   *    folds forward: the old record is superseded and a fresh one carries
   *    the corrected knowledge (UPDATE + DELETE semantics, edge invalidation
   *    rather than history erasure);
   *  - a fact that adds genuinely new knowledge becomes its own record (ADD);
   *  - a fact fully covered by an existing record is dropped (NOOP).
   *
   * Facts are extracted structurally — verification outcomes, tool failures
   * with their call sites, file-level decisions, blockers — so no model call
   * is needed and the pipeline stays reproducible after a crash. Atomic facts
   * also make retrieval precise: recall picks the handful of records that
   * matter instead of one monolithic turn dump.
   * @returns the engineering Memory Consolidation.
 * @param input - the observation payload to distil into facts.
   */
  consolidateObservation(input: ObservationPayload): EngineeringMemoryConsolidation {
    const database = this.requireDatabase()
    const payload = normalizeObservation(input)
    const projectId = projectIdFor(payload.cwd)
    const now = Date.now()
    const facts = extractFacts(payload)
    // One observation is one logical write: every fact it distills commits
    // together, so a crash mid-pipeline cannot make half a turn's knowledge
    // durable. The write lock BEGIN IMMEDIATE takes also serializes the
    // read-then-write reconcile below against a concurrent writer.
    return this.inTransaction(database, () => {
      const items: EngineeringMemoryConsolidationItem[] = []
      // Every fact is the same observation replayed under its own subject: only
      // its title, body, and kind differ from the turn that produced it.
      const asFact = (fact: MemoryFact): ObservationPayload => ({ ...payload, title: fact.title, body: fact.body, kind: fact.kind, tags: [...payload.tags, 'consolidated'], sources: payload.sources })
      for (const fact of facts) {
        // The NOOP check must be independent of turn/generation: facts are keyed
        // by (kind, subject), and the identical body means the knowledge is
        // already recorded exactly. saveCaptured's own content_hash mixes in the
        // generation, so it cannot be used to recognize the same fact twice.
        const existingFact = this.reconcileTarget(database, projectId, fact)
        if (existingFact !== undefined) {
          if (existingFact.body.trim() === fact.body) {
            items.push({ fact: fact.title, action: 'noop', memoryId: existingFact.id, supersededIds: [], reason: 'already recorded with identical content' })
            continue
          }
          // Mark the stale record superseded in place — its id never changes, so
          // the sources foreign key is untouched and the audit trail (what the
          // record used to say, and which sources backed it) remains intact.
          // Graphiti-style edge invalidation: history is annotated, not erased.
          //
          // The retirement and its replacement share the caller's transaction:
          // either half alone is a silent loss. A retired record with no
          // replacement is gone from every search, while a replacement that
          // never lands leaves the stale statement as the newest word.
          database.prepare("UPDATE engineering_memories SET trust = 'superseded', updated_at = ? WHERE id = ? AND trust IN ('captured', 'reviewed')").run(now, existingFact.id)
          const detail = this.insertCaptured(database, asFact(fact), fact.subject)
          items.push({ fact: fact.title, action: existingFact.trust === 'reviewed' ? 'superseded' : 'updated', memoryId: detail.id, supersededIds: [existingFact.id], reason: 'same subject with changed content; older record superseded' })
          continue
        }
        const detail = this.insertCaptured(database, asFact(fact), fact.subject)
        items.push({ fact: fact.title, action: 'added', memoryId: detail.id, supersededIds: [], reason: 'new knowledge for this project' })
      }
      return { projectId, items }
    })
  }

  /**
   * Compact project history selected for session start. Candidates are ranked
   * by recency-weighted importance (half-life decay over `created_at`, with a
   * bonus for blocker/decision records that outlive fashion) and packed into
   * the token budget highest-value first; ties resolve oldest-first so the
   * injected list stays stable across sessions.
   * @returns the engineering Memory Recall.
 * @param input - the workspace cwd and the session-start token budget.
   */
  recall(input: { readonly cwd: string; readonly tokenBudget: number }): EngineeringMemoryRecall {
    const projectId = projectIdFor(input.cwd)
    const tokenBudget = clamp(input.tokenBudget, 0, 4_000)
    if (tokenBudget === 0) return { projectId, tokenBudget, usedTokens: 0, records: [] }
    const candidates = this.searchByTrust({ cwd: input.cwd, limit: 50, trusts: ['reviewed'] })
    const now = Date.now()
    const hitState = this.hitStateFor(candidates.map(record => record.id))
    const ranked = candidates
      .map(record => ({ record, score: recallScore(record.createdAt, record.kind, now) * recallHitBoost(hitState.get(record.id)) }))
      .sort((left, right) => right.score - left.score || left.record.createdAt - right.record.createdAt)
    const picked: Array<{ record: EngineeringMemoryIndex; tokens: number }> = []
    let usedTokens = 0
    for (const { record } of ranked) {
      if (record.detailTokens > tokenBudget - usedTokens) continue
      picked.push({ record, tokens: record.detailTokens })
      usedTokens += record.detailTokens
    }
    // Session-start context reads chronologically; undo the score ordering so
    // the packed selection presents oldest → newest.
    const records = picked.sort((left, right) => left.record.createdAt - right.record.createdAt).map(entry => entry.record)
    return { projectId, tokenBudget, usedTokens, records }
  }

  /** Agent-facing search over active AI-managed project memory. 
   * @returns the engineering Memory Index rows, in backend order.
 * @param input - the cwd, optional query, row limit, and whether captured records are included.
   */
  search(input: { readonly cwd: string; readonly query?: string; readonly limit?: number; readonly includeCaptured?: boolean }): readonly EngineeringMemoryIndex[] {
    const trusts: readonly EngineeringMemoryTrust[] = input.includeCaptured === true ? ['reviewed', 'captured'] : ['reviewed']
    // Agent-facing searches reinforce: a queried record is a used record.
    return this.searchByTrust({ ...input, trusts, reinforce: (input.query?.trim() ?? '') !== '' })
  }

  /** User-facing list. It exposes no body text and can be safely paged in the settings surface. 
   * @returns the engineering Memory Page.
 * @param input - the cwd, optional trust filter, page limit, and cursor.
   */
  list(input: { readonly cwd: string; readonly trusts?: readonly EngineeringMemoryTrust[]; readonly limit?: number; readonly cursor?: string }): EngineeringMemoryPage {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const limit = clamp(input.limit ?? 40, 1, 100)
    const trusts = normalizeTrusts(input.trusts, USER_VISIBLE_TRUSTS)
    const cursor = decodeCursor(input.cursor)
    const conditions = ['project_id = ?', `trust IN (${trusts.map(() => '?').join(', ')})`]
    const parameters: Array<string | number> = [projectId, ...trusts]
    if (cursor !== undefined) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))')
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }
    parameters.push(limit + 1)
    const rows = database.prepare(`SELECT id, title, kind, trust, project_id, body, created_at FROM engineering_memories WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters) as MemoryRow[]
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map(toIndex)
    const last = page.at(-1)
    return { records: page, ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last) } : {}) }
  }

  /** User-facing time neighborhood. Bodies remain behind an explicit Get call. 
   * @returns the engineering Memory Timeline.
 * @param input - the cwd, anchor id, before/after counts, and trust filter.
   */
  timeline(input: { readonly cwd: string; readonly id: string; readonly before?: number; readonly after?: number; readonly trusts?: readonly EngineeringMemoryTrust[] }): EngineeringMemoryTimeline {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const id = validateMemoryId(input.id)
    const trusts = normalizeTrusts(input.trusts, USER_VISIBLE_TRUSTS)
    const trustPlaceholders = trusts.map(() => '?').join(', ')
    const anchor = database.prepare(`SELECT id, title, kind, trust, project_id, body, created_at FROM engineering_memories WHERE project_id = ? AND id = ? AND trust IN (${trustPlaceholders})`).get(projectId, id, ...trusts) as MemoryRow | undefined
    if (anchor === undefined) throw new Error('engineering memory record was not found in this workspace')
    const beforeLimit = clamp(input.before ?? 10, 0, 10)
    const afterLimit = clamp(input.after ?? 10, 0, 10)
    const before = beforeLimit === 0 ? [] : (database.prepare(`SELECT id, title, kind, trust, project_id, body, created_at FROM engineering_memories WHERE project_id = ? AND trust IN (${trustPlaceholders}) AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`).all(projectId, ...trusts, anchor.created_at, anchor.created_at, anchor.id, beforeLimit) as MemoryRow[]).map(toIndex).reverse()
    const after = afterLimit === 0 ? [] : (database.prepare(`SELECT id, title, kind, trust, project_id, body, created_at FROM engineering_memories WHERE project_id = ? AND trust IN (${trustPlaceholders}) AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?`).all(projectId, ...trusts, anchor.created_at, anchor.created_at, anchor.id, afterLimit) as MemoryRow[]).map(toIndex)
    return { anchor: toIndex(anchor), before, after }
  }

  /** Read hit_count/last_hit_at for a bounded id set (recall ranking input). */
  private hitStateFor(ids: readonly string[]): Map<string, { hitCount: number; lastHitAt: number }> {
    const state = new Map<string, { hitCount: number; lastHitAt: number }>()
    if (ids.length === 0) return state
    try {
      const rows = this.requireDatabase().prepare(`SELECT id, hit_count, last_hit_at FROM engineering_memories WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids.slice(0, MAX_HIT_STATE_IDS)) as { id: string; hit_count?: number; last_hit_at?: number }[]
      for (const row of rows) state.set(row.id, { hitCount: (row.hit_count ?? 0), lastHitAt: (row.last_hit_at ?? 0) })
    } catch { /* older schema: rank without hit data */ }
    return state
  }

  /** Agent-facing body lookup for active project memory. 
   * @returns the engineering Memory Detail rows, in backend order.
 * @param input - the cwd, record ids, and whether captured records are included.
   */
  get(input: { readonly cwd: string; readonly ids: readonly string[]; readonly includeCaptured?: boolean }): readonly EngineeringMemoryDetail[] {
    const trusts: readonly EngineeringMemoryTrust[] = input.includeCaptured === true ? ['reviewed', 'captured'] : ['reviewed']
    return this.getByTrust({ cwd: input.cwd, ids: input.ids, trusts })
  }

  /** User-facing lookup used to inspect and review a draft without exposing it to the Agent. 
   * @returns the engineering Memory Detail rows, in backend order.
 * @param input - the cwd and the ids to inspect.
   */
  getForReview(input: { readonly cwd: string; readonly ids: readonly string[] }): readonly EngineeringMemoryDetail[] {
    return this.getByTrust({ cwd: input.cwd, ids: input.ids, trusts: TRUSTS })
  }

  /** Only a user Remote may promote, reject, or supersede a pending record. 
   * @returns the engineering Memory Detail.
 * @param input - the cwd, the record id, and the review decision.
   */
  review(input: { readonly cwd: string; readonly id: string; readonly trust: EngineeringMemoryReviewDecision }): EngineeringMemoryDetail {
    const database = this.requireDatabase()
    const id = validateMemoryId(input.id)
    if (!['reviewed', 'rejected', 'superseded'].includes(input.trust)) throw new Error('engineering memory review decision is invalid')
    // Both pending states are reviewable: agent saveDraft writes 'draft' and
    // the automatic observation pipeline writes 'captured'; without this the
    // automatic pipeline could never become agent-visible knowledge.
    const result = database.prepare("UPDATE engineering_memories SET trust = ?, updated_at = ? WHERE project_id = ? AND id = ? AND trust IN ('draft', 'captured')").run(input.trust, Date.now(), projectIdFor(input.cwd), id)
    if (result.changes !== 1) throw new Error('only a pending draft or captured record in this workspace can be reviewed')
    const row = database.prepare('SELECT id, title, kind, trust, project_id, body, tags_json, source_engine, created_at FROM engineering_memories WHERE id = ?').get(id) as MemoryRow | undefined
    if (row === undefined) throw new Error('engineering memory review could not read its committed record')
    return this.detailFor(database, row)
  }

/**
 * Permanently erase one user-selected record from the current project.
 * @param input - the cwd and the record id.
 * @returns confirmation that the record was deleted.
 */
  delete(input: { readonly cwd: string; readonly id: string }): { readonly deleted: true } {
    const result = this.requireDatabase().prepare('DELETE FROM engineering_memories WHERE project_id = ? AND id = ?').run(projectIdFor(input.cwd), validateMemoryId(input.id))
    if (result.changes !== 1) throw new Error('engineering memory record was not found in this workspace')
    return { deleted: true }
  }

/**
 * Clear derived records by default. Drafts are always purgeable; reviewed project knowledge requires explicit inclusion.
 * @param input - the cwd and whether reviewed records are included.
 * @returns how many records were deleted.
 */
  purgeProject(input: { readonly cwd: string; readonly includeReviewed?: boolean }): { readonly deleted: number } {
    // "Everything except the reviewed state", expressed as a filter rather than a
    // second hand-written list: a trust added to the vocabulary is then included
    // here automatically instead of silently missing from the default read.
    const trusts: readonly EngineeringMemoryTrust[] = input.includeReviewed === true ? TRUSTS : TRUSTS.filter(trust => trust !== 'reviewed')
    const result = this.requireDatabase().prepare(`DELETE FROM engineering_memories WHERE project_id = ? AND trust IN (${trusts.map(() => '?').join(', ')})`).run(projectIdFor(input.cwd), ...trusts)
    return { deleted: Number(result.changes) }
  }

  /**
   * Export only reviewed records. It never serializes drafts, rejected records, or
   * database paths.
   *
   * `omitted` is how many reviewed records the cap kept out of `records`. The cap
   * bounds one tool response, but a bound the caller cannot see makes a truncated
   * export read like a complete one — and `engineering_memory_export`'s description
   * promises the opposite in as many words: "Reports records it had to skip". The
   * `skipped` and `failed` lists in `memory-export.ts` report the records that were
   * *read and refused*; this is the other axis, the ones never read at all.
 * @param input - the cwd whose reviewed records are exported.
 * @returns the export payload, with `omitted` counting reviewed records the cap left out.
   */
  exportReviewed(input: { readonly cwd: string }): { readonly version: 1; readonly exportedAt: number; readonly projectId: string; readonly records: readonly EngineeringMemoryDetail[]; readonly omitted: number } {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    const rows = database.prepare("SELECT id, title, kind, trust, project_id, body, tags_json, source_engine, created_at FROM engineering_memories WHERE project_id = ? AND trust = 'reviewed' ORDER BY created_at DESC, id DESC LIMIT ?").all(projectId, MAX_EXPORT_RECORDS) as MemoryRow[]
    // Counted rather than inferred from `rows.length === MAX_EXPORT_RECORDS`: a project
    // holding exactly the cap is not truncated, and calling it truncated would be the
    // mirror of the defect this field closes.
    const reviewed = database.prepare("SELECT COUNT(*) AS n FROM engineering_memories WHERE project_id = ? AND trust = 'reviewed'").get(projectId) as { readonly n: number }
    return { version: 1, exportedAt: Date.now(), projectId, records: rows.map(row => this.detailFor(database, row)), omitted: Math.max(0, reviewed.n - rows.length) }
  }

  /** Create a consistent plugin-private snapshot without copying a live WAL file. 
   * @returns the engineering Memory Backup.
   */
  async backup(): Promise<EngineeringMemoryBackup> {
    const database = this.requireDatabase()
    const createdAt = Date.now()
    const id = `backup_${createdAt}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const directory = join(dirname(this.databasePath), 'backups')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('engineering memory backup directory must not be a symlink')
    const file = resolve(directory, `${id}.sqlite`)
    // file is generated by this module, never supplied by an Agent or the UI.
    database.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
    return { id, createdAt, bytes: (await stat(file)).size }
  }

  /** Retain reviewed knowledge and active drafts while trimming stale derived records. 
   * @returns the engineering Memory Retention Result.
 * @param retentionDays - how many days of derived records to retain.
   */
  retentionSweep(retentionDays: number): EngineeringMemoryRetentionResult {
    const days = clamp(retentionDays, 1, 365)
    const threshold = Date.now() - days * 86_400_000
    const database = this.requireDatabase()
    // Recently-reinforced derived records survive one extra retention window:
    // a captured observation that keeps getting hit behaves like knowledge.
    const reinforcedCutoff = Date.now() - days * 2 * 86_400_000
    const memories = database.prepare("DELETE FROM engineering_memories WHERE trust IN ('captured', 'rejected', 'superseded') AND updated_at < ? AND NOT (trust = 'captured' AND hit_count >= 3 AND last_hit_at >= ?)").run(threshold, reinforcedCutoff)
    const outbox = database.prepare("DELETE FROM engineering_memory_outbox WHERE state IN ('done', 'failed') AND updated_at < ?").run(threshold)
    return { retentionDays: days, deletedMemories: Number(memories.changes), deletedOutboxEntries: Number(outbox.changes) }
  }

  private searchByTrust(input: { readonly cwd: string; readonly query?: string; readonly limit?: number; readonly trusts: readonly EngineeringMemoryTrust[]; readonly reinforce?: boolean }): readonly EngineeringMemoryIndex[] {
    const database = this.requireDatabase()
    const projectId = projectIdFor(input.cwd)
    // The bound is the store's row bound, not a page size. A page size is a
    // property of the surface that shows the page, and every such surface
    // already declares one (the `engineering_memory_search` tool and the
    // `engineeringMemorySearch` Remote both cap at 20). Capping *here* at 20 as
    // well silently shrank the one caller that is not a page: `recall` asks for
    // a 50-record candidate pool so its recency-weighted importance ranking —
    // including the durable-kind bonus that exists to lift an old blocker or
    // decision over a younger note — can consider more than the newest 20
    // records. It could not, so the bonus never reached anything older than
    // that window and session-start context was drawn from a recency slice of
    // a large project's knowledge instead of from its knowledge.
    const limit = clamp(input.limit ?? 20, 1, MAX_MEMORY_SEARCH_ROWS)
    const trusts = normalizeTrusts(input.trusts, ['reviewed'])
    const query = input.query?.trim() ?? ''
    // Recall wider than the caller's page size so the rerank can promote a
    // record that bm25 ranked outside the top `limit`.
    const recallLimit = query === '' ? limit : Math.min(limit * 5, 100)
    const rows = query === ''
      ? database.prepare(`SELECT id, title, kind, trust, project_id, body, created_at FROM engineering_memories WHERE project_id = ? AND trust IN (${trusts.map(() => '?').join(', ')}) ORDER BY created_at DESC, id DESC LIMIT ?`).all(projectId, ...trusts, limit)
      : database.prepare(`SELECT m.id, m.title, m.kind, m.trust, m.project_id, m.body, m.created_at FROM engineering_memories_fts f JOIN engineering_memories m ON m.id = f.id WHERE f.project_id = ? AND engineering_memories_fts MATCH ? AND m.trust IN (${trusts.map(() => '?').join(', ')}) ORDER BY bm25(engineering_memories_fts) LIMIT ?`).all(projectId, ftsQueryRecall(query), ...trusts, recallLimit)
    const recalled = rows as MemoryRow[]
    // Rerank by lexical relevance, keeping bm25's order as the tie-break so a
    // record with no term overlap at all (possible under OR recall semantics)
    // never outranks one that matched. Without a query there is nothing to
    // rerank against, so recency keeps the order.
    const hits = query === ''
      ? recalled.slice(0, limit)
      : recalled
        .map((row, index) => ({ row, index, score: lexicalRelevance(memoryQueryTokens(query), row.title, (row.body ?? '')) }))
        .filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, limit)
        .map(entry => entry.row)
    // Reinforce on keyword hits: a used memory is a live one. Best-effort —
    // reinforcement failure must never break the search itself.
    if (input.reinforce === true && hits.length > 0) {
      try {
        const now = Date.now()
        const bump = database.prepare('UPDATE engineering_memories SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?')
        for (const row of hits) bump.run(now, row.id)
      } catch { /* advisory only */ }
    }
    return hits.map(toIndex)
  }

  private getByTrust(input: { readonly cwd: string; readonly ids: readonly string[]; readonly trusts: readonly EngineeringMemoryTrust[] }): readonly EngineeringMemoryDetail[] {
    const database = this.requireDatabase()
    const ids = [...new Set(input.ids.map(value => value.trim()).filter(value => MEMORY_ID.test(value)))].slice(0, MAX_MEMORY_LOOKUP_IDS)
    if (ids.length === 0) return []
    const trusts = normalizeTrusts(input.trusts, ['reviewed'])
    const rows = database.prepare(`SELECT id, title, kind, trust, project_id, body, tags_json, source_engine, created_at FROM engineering_memories WHERE project_id = ? AND id IN (${ids.map(() => '?').join(', ')}) AND trust IN (${trusts.map(() => '?').join(', ')})`).all(projectIdFor(input.cwd), ...ids, ...trusts) as MemoryRow[]
    const byId = new Map(rows.map(row => [row.id, this.detailFor(database, row)]))
    return ids.flatMap((id) => {
      const record = byId.get(id)
      return record === undefined ? [] : [record]
    })
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error('engineering memory store is not open')
    return this.database
  }

  private detailFor(database: DatabaseSync, row: MemoryRow): EngineeringMemoryDetail {
    const rows = database.prepare('SELECT session_id, event_sequence, event_type, turn, engine, provider, model, files_read_json, files_written_json, captured_at FROM engineering_memory_sources WHERE memory_id = ? ORDER BY source_index ASC LIMIT 32').all(row.id) as SourceRow[]
    const sources = rows.map(toSource)
    return { ...toDetail(row, sources), related: relatedMemories(database, row.id, row.project_id, sources) }
  }
}

/**
 * Most rows one store search may consider.
 *
 * A ceiling rather than a page size: it exists so a caller cannot ask for an
 * unbounded scan, and it is set well above every candidate pool in this module
 * so the pool a caller declares is the pool it gets.
 */
const MAX_MEMORY_SEARCH_ROWS = 100

/**
 * Most ids one detail lookup may carry.
 *
 * The agent-facing `engineering_memory_get` declares `maxItems: 20` in its own
 * schema, so that path is bounded before it reaches the store. Every *internal*
 * caller declares a larger pool and then looks its ids up: `skillDraftGenerate`
 * and the consolidation pass both `list(… limit: 100)`, and the post-compaction
 * rehydration resolves the ids `recall` packed under a 50-record candidate pool.
 * A ceiling of 20 here therefore did not bound those callers — it truncated
 * them, and silently: skill drafts were derived from the twenty most recent
 * reviewed records, and a consolidation pass only ever saw the twenty most
 * recent captured observations, while the call site said 100. The ceiling's job
 * is to keep the `IN (…)` list finite, which is what `MAX_MEMORY_SEARCH_ROWS`
 * already is for every pool in this module.
 */
const MAX_MEMORY_LOOKUP_IDS = MAX_MEMORY_SEARCH_ROWS

/** Most ids one hit-state read may carry; `recall` packs under a 50-record pool. */
const MAX_HIT_STATE_IDS = 50

/** Most neighbours returned for one record, so a hub cannot flood a detail read. */
const MAX_RELATIONS = 8

/** Relations at or below this score are dropped as noise. */
const MIN_RELATION_SCORE = 1

/**
 * Build this record's edges from the evidence its sources already carry.
 *
 * Two records are connected when they observed the same thing — the same file,
 * the same session, or the same turn. Only `reviewed` and `captured` records are
 * eligible neighbours: a draft or a rejected record must not become reachable
 * through a graph, or the trust ladder the store enforces elsewhere would be
 * bypassable by association.
 *
 * Weights are deliberately coarse (a shared file counts 2, a shared session 1,
 * a shared turn 1). The point of the number is to rank the neighbours a reader
 * or model should look at first, not to model a probability.
 *
 * @param database - open store connection.
 * @param id - the record whose edges are being built.
 * @param projectId - memory is project-scoped; edges never cross projects.
 * @param sources - the record's own source rows.
 * @returns bounded, ranked relations.
 */
function relatedMemories(database: DatabaseSync, id: string, projectId: string, sources: readonly EngineeringMemorySource[]): readonly FreeCodeGoEngineeringMemoryRelation[] {
  if (sources.length === 0) return []
  const files = [...new Set(sources.flatMap(source => [...source.filesRead, ...source.filesWritten]))]
  // (session_id, turn) pairs identify a single turn; session ids alone identify
  // a conversation. Both are useful, so they are tracked separately.
  const sessions = [...new Set(sources.map(source => source.sessionId))]
  const turns = [...new Set(sources.filter(source => source.turn !== undefined).map(source => `${source.sessionId}\u0000${String(source.turn)}`))]
  if (files.length === 0 && sessions.length === 0) return []
  const rows = database.prepare(`
    SELECT m.id, m.title, m.kind, m.trust, s.session_id, s.turn, s.files_read_json, s.files_written_json
    FROM engineering_memory_sources s
    JOIN engineering_memories m ON m.id = s.memory_id
    WHERE m.project_id = ? AND m.id != ? AND m.trust IN ('reviewed', 'captured')
    LIMIT 2000
  `).all(projectId, id) as { readonly id: string; readonly title: string; readonly kind: string; readonly trust: string; readonly session_id: string; readonly turn?: number | null; readonly files_read_json: string; readonly files_written_json: string }[]
  const fileSet = new Set(files)
  const sessionSet = new Set(sessions)
  const turnSet = new Set(turns)
  const edges = new Map<string, { readonly title: string; readonly kind: string; readonly trust: string; readonly relation: FreeCodeGoEngineeringMemoryRelationKind; readonly via: string; score: number }>()
  for (const neighbour of rows) {
    const neighbourFiles = [...parseTags(neighbour.files_read_json), ...parseTags(neighbour.files_written_json)]
    const sharedFile = neighbourFiles.find(file => fileSet.has(file))
    const sameTurn = neighbour.turn !== undefined && neighbour.turn !== null && turnSet.has(`${neighbour.session_id}\u0000${String(neighbour.turn)}`)
    const sameSession = sessionSet.has(neighbour.session_id)
    // Rank each neighbour once, by its strongest connection: a file overlap is
    // far more actionable than sharing a long session.
    const candidate = sharedFile !== undefined
      ? { relation: 'shared-file' as const, via: sharedFile, score: 2 }
      : sameTurn
        ? { relation: 'same-turn' as const, via: neighbour.session_id, score: 1 }
        : sameSession
          ? { relation: 'same-session' as const, via: neighbour.session_id, score: 1 }
          : undefined
    if (candidate === undefined) continue
    const existing = edges.get(neighbour.id)
    edges.set(neighbour.id, {
      title: neighbour.title,
      kind: neighbour.kind,
      trust: neighbour.trust,
      relation: existing !== undefined && existing.score >= candidate.score ? existing.relation : candidate.relation,
      via: existing !== undefined && existing.score >= candidate.score ? existing.via : candidate.via,
      // Keep the strongest connection seen for this neighbour. The previous
      // `max(c,e) + c - e` was neither a max nor an accumulation: it doubled a
      // first sighting (e=0) and, when a weaker relation arrived after a
      // stronger one (c<e), it lowered the score below the relation it kept.
      score: Math.max(candidate.score, existing?.score ?? 0),
    })
  }
  return [...edges]
    .filter(([, edge]) => edge.score >= MIN_RELATION_SCORE)
    // Rank by strength, then title, so the order is stable across reads rather
    // than dependent on SQLite's row order.
    .sort((left, right) => right[1].score - left[1].score || left[1].title.localeCompare(right[1].title) || left[0].localeCompare(right[0]))
    .slice(0, MAX_RELATIONS)
    .map(([neighbourId, edge]) => ({
      id: neighbourId,
      title: edge.title,
      kind: edge.kind as EngineeringMemoryKind,
      trust: edge.trust as EngineeringMemoryTrust,
      relation: edge.relation,
      via: edge.via,
      weight: edge.score,
    }))
}

function defaultMemoryDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'memory')
}

function projectIdFor(cwd: string): string {
  const workspace = resolve(cwd)
  const gitRemote = gitRemoteFor(workspace)
  // Windows paths are case-insensitive; lowercase the whole identity so a
  // differently cased cwd still maps to the same project memory.
  const identity = gitRemote ?? (process.platform === 'win32' ? workspace.replaceAll('\\', '/').toLowerCase() : workspace.replaceAll('\\', '/'))
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

function gitRemoteFor(cwd: string): string | undefined {
  // Subdirectories and linked worktrees keep `.git` as a file pointing at the
  // real git dir (or nothing local at all). Walk upward so every directory of
  // one repository resolves to the same project identity.
  let directory = resolve(cwd)
  for (;;) {
    try {
      const config = readFileSync(join(directory, '.git', 'config'), 'utf8')
      const match = /\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*([^\n\r]+)/i.exec(config)
      const value = match?.[1]?.trim().toLowerCase().replace(/\.git$/, '')
      if (value !== undefined && value !== '') return value
    } catch {
      // Not a git config at this level; keep walking.
    }
    const gitPath = join(directory, '.git')
    try {
      const stat = lstatSync(gitPath)
      if (stat.isFile()) {
        // A `.git` file means this is a worktree/submodule checkout; its
        // gitdir lives elsewhere and shares the parent repository's config.
        const parent = gitRemoteFor(dirname(directory))
        if (parent !== undefined) return parent
      }
    } catch { /* no .git entry here */ }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function sanitizeText(value: string, maxBytes: number, label: string): string {
  const normalized = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '').trim() : ''
  if (normalized === '') throw new Error(`${label} is required`)
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`)
  return normalized
}

/** Remove nested/private-tag content before it reaches the outbox or model. */
function stripPrivateSections(value: string): string {
  const matcher = /<\/?private(?:\s[^>]*)?>/gi
  let output = ''
  let cursor = 0
  let depth = 0
  for (const match of value.matchAll(matcher)) {
    const start = match.index ?? 0
    if (depth === 0) output += value.slice(cursor, start)
    if (match[0].startsWith('</')) depth = Math.max(0, depth - 1)
    else depth += 1
    cursor = start + match[0].length
  }
  if (depth === 0) output += value.slice(cursor)
  return output
}

function normalizeTags(value: readonly string[] | undefined): readonly string[] {
  // The shared pattern, not a copy: this one used to allow 64 characters while
  // the document view's parser allowed 63, so a tag stored through this function
  // made an export its own reader refused.
  return [...new Set((value ?? []).map(tag => tag.trim().toLowerCase()).filter(tag => MEMORY_TAG_PATTERN.test(tag)))].slice(0, 32)
}

function normalizeTrusts(value: readonly EngineeringMemoryTrust[] | undefined, fallback: readonly EngineeringMemoryTrust[]): readonly EngineeringMemoryTrust[] {
  const selected = [...new Set(value ?? fallback)].filter((trust): trust is EngineeringMemoryTrust => TRUSTS.includes(trust))
  return selected.length === 0 ? fallback : selected
}

/** Query terms shared by FTS recall and the lexical rerank. Distinct, lowercased,
 * and capped so one pasted paragraph cannot turn into an unbounded MATCH.
 *
 * Exported because the semantic recall layer (`memory/memory-recall.ts`) must
 * tokenize a query exactly the way the lexical rerank it falls back to does; two
 * tokenizers would let the selector and its fallback disagree about what the
/**
 * uery contains.
 * @param value - the raw query text.
 * @returns the distinct lowercased query tokens, capped at 12.
 */
export function memoryQueryTokens(value: string): readonly string[] {
  const matched = value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
  return [...new Set(matched)].slice(0, 12)
}

/**
 * Recall form of the query. Every distinct term is an independent candidate, so
 * a record matching only part of a multi-word query still reaches the rerank
 * instead of being filtered out by strict AND semantics. Recall is deliberately
 * permissive here because `searchByTrust` reorders its results afterwards.
 */
function ftsQueryRecall(value: string): string {
  const tokens = memoryQueryTokens(value)
  if (tokens.length === 0) throw new Error('engineering memory query has no searchable terms')
  return tokens.map(token => `"${token.replaceAll('"', '')}"`).join(' OR ')
}

/** A title match is a far stronger relevance signal than a body mention. */
const TITLE_MATCH_WEIGHT = 3
const BODY_MATCH_WEIGHT = 1
/** Body characters per "unit" of text; used to length-normalize density. */
const DENSITY_NORMALIZER_CHARS = 200

/**
 * Deterministic lexical relevance, the local stand-in for the embedding rerank
 * a hosted memory service would use. Three signals, in descending importance:
 *
 * 1. **Coverage** — how many distinct query terms the record matches at all.
 *    Scored quadratically, because matching 3 of 3 terms is qualitatively
 *    better than matching 2, not merely 1.5x better.
 * 2. **Placement** — a term in the title outweighs the same term in the body.
 * 3. **Density** — matches per normalized body length, so a focused note is
 *    not buried under a long record that merely repeats one term.
 *
 * The function is pure and synchronous: no model call, no network, no new
 * dependency, and identical inputs always produce identical ordering.
 * @param tokens - the query tokens to score against.
 * @param title - the record title.
 * @param body - the record body.
 * @returns the lexical relevance score, 0 when nothing matches.
 */
export function lexicalRelevance(tokens: readonly string[], title: string, body: string): number {
  if (tokens.length === 0) return 0
  const haystackTitle = title.toLowerCase()
  const haystackBody = body.toLowerCase()
  let matched = 0
  let weight = 0
  for (const token of tokens) {
    const inTitle = haystackTitle.includes(token)
    const inBody = haystackBody.includes(token)
    if (!inTitle && !inBody) continue
    matched += 1
    weight += inTitle ? TITLE_MATCH_WEIGHT : BODY_MATCH_WEIGHT
  }
  if (matched === 0) return 0
  const coverage = matched / tokens.length
  const density = weight / (1 + Math.log(1 + haystackBody.length / DENSITY_NORMALIZER_CHARS))
  return coverage * coverage * 10 + density + (coverage === 1 ? 5 : 0)
}

function validateMemoryId(value: string): string {
  if (!MEMORY_ID.test(value)) throw new Error('engineering memory id is invalid')
  return value
}

function encodeCursor(record: EngineeringMemoryIndex): string {
  return Buffer.from(`${record.createdAt}:${record.id}`, 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined || value.trim() === '') return undefined
  let decoded = ''
  try { decoded = Buffer.from(value, 'base64url').toString('utf8') } catch { throw new Error('engineering memory cursor is invalid') }
  const match = /^(\d+):(mem_[a-f0-9]{32})$/i.exec(decoded)
  if (match === null) throw new Error('engineering memory cursor is invalid')
  const createdAt = Number(match[1])
  if (!Number.isSafeInteger(createdAt)) throw new Error('engineering memory cursor is invalid')
  return { createdAt, id: match[2]! }
}

/**
 * The compact shape list, search, and timeline return.
 *
 * It carries no source count. `sourceCount` was declared on this shape and read
 * from a `source_count` column that no `SELECT` in this module ever projected —
 * `git log -S "AS source_count"` finds nothing in any revision, so the field was
 * never produced, and nothing in this plugin or in the UI ever read it. The
 * provenance a caller actually wants is on the detail shape, where `detailFor`
 * attaches the `sources` rows themselves; a count on the index would be a second,
 * weaker copy of a fact that is already there in full.
 */
function toIndex(row: MemoryRow): EngineeringMemoryIndex {
  return { id: row.id, title: row.title, kind: row.kind as EngineeringMemoryKind, trust: row.trust as EngineeringMemoryTrust, projectId: row.project_id, createdAt: row.created_at, detailTokens: estimateTokens((row.body ?? '')) }
}

function toDetail(row: MemoryRow, sources: readonly EngineeringMemorySource[] = []): EngineeringMemoryDetail {
  const sourceEngine = typeof row.source_engine === 'string' && row.source_engine !== '' ? row.source_engine : undefined
  //  is attached by detailFor, which owns the store connection and
  // the source rows the edges are derived from.
  return { ...toIndex(row), body: row.body, tags: parseTags(row.tags_json), sources, related: [], ...(sourceEngine === undefined ? {} : { sourceEngine }) }
}

function toSource(row: SourceRow): EngineeringMemorySource {
  return {
    sessionId: row.session_id,
    eventSequence: row.event_sequence,
    eventType: row.event_type,
    ...(typeof row.turn === 'number' ? { turn: row.turn } : {}),
    ...(typeof row.engine === 'string' && row.engine !== '' ? { engine: row.engine } : {}),
    ...(typeof row.provider === 'string' && row.provider !== '' ? { provider: row.provider } : {}),
    ...(typeof row.model === 'string' && row.model !== '' ? { model: row.model } : {}),
    filesRead: parseTags(row.files_read_json),
    filesWritten: parseTags(row.files_written_json),
    capturedAt: row.captured_at,
  }
}

function normalizeObservation(input: ObservationPayload): ObservationPayload {
  const sources = input.sources.slice(0, 32).map(source => ({
    sessionId: sanitizeText(source.sessionId, 256, 'observation session id'),
    eventSequence: Math.max(0, Math.floor(source.eventSequence)),
    eventType: sanitizeText(source.eventType, 80, 'observation event type'),
    ...(source.turn === undefined ? {} : { turn: Math.max(0, Math.floor(source.turn)) }),
    ...(source.engine === undefined ? {} : { engine: sanitizeText(source.engine, 80, 'observation engine') }),
    ...(source.provider === undefined ? {} : { provider: sanitizeText(source.provider, 160, 'observation provider') }),
    ...(source.model === undefined ? {} : { model: sanitizeText(source.model, 400, 'observation model') }),
    filesRead: normalizeFileEvidence(source.filesRead),
    filesWritten: normalizeFileEvidence(source.filesWritten),
    capturedAt: Number.isSafeInteger(source.capturedAt) ? source.capturedAt : Date.now(),
  }))
  if (sources.length === 0) throw new Error('observation requires at least one source')
  return {
    cwd: input.cwd,
    sessionId: sanitizeText(input.sessionId, 256, 'observation session id'),
    generation: sanitizeText(input.generation, 256, 'observation generation'),
    kind: isMemoryKind(input.kind) ? input.kind : 'note',
    title: stripPrivateSections(input.title),
    body: stripPrivateSections(input.body),
    tags: normalizeTags(input.tags),
    ...(input.sourceEngine === undefined ? {} : { sourceEngine: sanitizeText(input.sourceEngine, 80, 'observation engine') }),
    sources,
  }
}

function parseObservation(value: string): ObservationPayload {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('engineering memory outbox payload is invalid') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('engineering memory outbox payload is invalid')
  const item = parsed as Record<string, unknown>
  if (typeof item.cwd !== 'string' || typeof item.sessionId !== 'string' || typeof item.generation !== 'string' || typeof item.title !== 'string' || typeof item.body !== 'string' || !Array.isArray(item.sources)) throw new Error('engineering memory outbox payload is invalid')
  return normalizeObservation({
    cwd: item.cwd,
    sessionId: item.sessionId,
    generation: item.generation,
    kind: isMemoryKind(item.kind) ? item.kind : 'note',
    title: item.title,
    body: item.body,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    ...(typeof item.sourceEngine === 'string' ? { sourceEngine: item.sourceEngine } : {}),
    sources: item.sources as EngineeringMemorySource[],
  })
}

function normalizeFileEvidence(value: readonly string[]): readonly string[] {
  return [...new Set(value.map(file => file.replaceAll('\\', '/').replace(/^\/+/, '').trim()).filter(file => file !== '' && file.length <= 512 && !file.split('/').includes('..')))].slice(0, 64)
}

/** The kind vocabulary as a lookup: a second binding, not a second list. */
const MEMORY_KIND_NAMES: ReadonlySet<string> = new Set(ENGINEERING_MEMORY_KINDS)

function isMemoryKind(value: unknown): value is EngineeringMemoryKind {
  // The list this reads is the one the schema offers, so a kind added there is
  // recognised here instead of being coerced to `'note'`. Spelling the eight
  // names out again made an added kind survive the schema, the type, and the
  // write path, and then lose its name on the way back through the outbox.
  return typeof value === 'string' && MEMORY_KIND_NAMES.has(value)
}

// ─── Fact extraction (deterministic mem0-style distillation) ───────────────

interface MemoryFact {
  readonly kind: EngineeringMemoryKind
  /** Stable subject key: facts about the same subject merge/supersede. */
  readonly subject: string
  readonly title: string
  readonly body: string
}


function extractFacts(payload: ObservationPayload): readonly MemoryFact[] {
  const facts: MemoryFact[] = []
  const engine = payload.sourceEngine
  const lines = payload.body.split('\n').map(line => line.trim()).filter(line => line !== '')
  // 1. Verification outcome: a single authoritative fact per subject.
  //
  // The verdict comes from the structured status line the turn compiler writes,
  // not from the word "failure" anywhere in the body. Every healthy turn carries
  // "Tool result status: no structured failures observed", which a bare
  // `failures? observed` test reads as a failure, and prose such as "fixed the
  // failing verification" reads as one too — either turns a green verification
  // into durable knowledge that says the opposite. Only an observed non-zero
  // count, or an explicit "verification failed", claims a failure; a body with
  // no status line counts as passed, because inventing a failure is the worse
  // error (the evidence itself is still in the fact body for a reader).
  const observedFailures = Number.parseInt(/Tool result status:\s*(\d+)\s+structured failures?/i.exec(payload.body)?.[1] ?? '0', 10)
  const failedVerification = observedFailures > 0 || /verification failed\b/i.test(payload.body)
  if (payload.kind === 'verification') {
    facts.push({
      kind: 'verification',
      subject: `verification:${payload.sessionId}`,
      title: failedVerification ? 'Verification failed — see turn evidence' : 'Verification passed for the recorded turn',
      body: lines.slice(0, 8).join('\n').slice(0, 2_000),
    })
  }
  // 2. Tool failures: one fact per failed call site (subject = tool name), so
  // a fix later supersedes the failure instead of accumulating duplicates.
  for (const line of lines) {
    const failure = /^Tool result status: (\d+) structured failures?/i.exec(line)
    if (failure !== null && failure[1] !== '0') {
      const toolNames = lines.find(candidate => candidate.startsWith('Tools:'))?.slice(6, 200).trim() ?? 'unknown tools'
      facts.push({
        kind: 'bugfix',
        subject: `failure:${toolNames}`,
        title: `Tool failures observed across ${toolNames}`,
        body: `${line}\nTurn ${payload.sources.at(0)?.turn ?? 'unknown'} on engine ${engine ?? 'unknown'}. Tools involved: ${toolNames}.`,
      })
      break
    }
  }
  // 3. File-level change facts: which files a turn actually wrote. The body
  // intentionally records only "this file was changed by turn N on engine E" —
  // a stable subject (the path) with evolving content is exactly what the
  // update/supersede path above reconciles; embedding per-turn evidence here
  // would turn every turn into a new fact instead of a refreshed one.
  const writtenFiles = [...new Set(payload.sources.flatMap(source => source.filesWritten))].slice(0, 8)
  for (const file of writtenFiles) {
    facts.push({
      kind: 'change',
      subject: `file:${file}`,
      title: `Changed ${file}`,
      body: `File ${file} was written during turn ${payload.sources.at(0)?.turn ?? 'unknown'} on engine ${engine ?? 'unknown'}.`,
    })
  }
  // 4. Explicit blocker lines become first-class blockers.
  for (const line of lines) {
    if (/^(blocker|blocked|cannot proceed)\b/i.test(line) && line.length > 12) {
      facts.push({
        kind: 'blocker',
        subject: `blocker:${line.slice(0, 80).toLowerCase()}`,
        title: line.slice(0, 160),
        body: line.slice(0, 2_000),
      })
      break
    }
  }
  // 5. Nothing structural matched → keep the whole observation as one
  // discovery fact so recall never loses the turn entirely.
  if (facts.length === 0 && lines.length > 0) {
    facts.push({
      kind: payload.kind === 'note' ? 'discovery' : payload.kind,
      subject: `turn:${payload.sessionId}:${payload.sources.at(0)?.turn ?? 0}`,
      title: payload.title,
      body: lines.slice(0, 12).join('\n').slice(0, 4_000),
    })
  }
  return facts.slice(0, 12)
}

function parseTags(value: unknown): readonly string[] {
  try { const parsed: unknown = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [] } catch { return [] }
}

function estimateTokens(value: string): number { return tokensFromChars(Buffer.byteLength(value, 'utf8')) }
function clamp(value: number, min: number, max: number): number { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : min }

/** Recency half-life for session-start recall (7 days, matching a typical project sprint). */
const RECALL_HALF_LIFE_MS = 7 * 24 * 60 * 60_000
/** Kinds whose records keep extra weight as they age: old blockers and decisions stay more load-bearing than old notes. */
const RECALL_DURABLE_KINDS: ReadonlySet<string> = new Set(['blocker', 'decision', 'bugfix'])
/** Extra weight multiplier for durable kinds. */
const RECALL_DURABLE_BONUS = 1.5

/** Exponential recency decay (1.0 now → 0.5 one half-life ago) with a durable-kind bonus. */
function recallScore(createdAt: number, kind: string, now: number): number {
  const age = Math.max(0, now - createdAt)
  const decay = Math.pow(0.5, age / RECALL_HALF_LIFE_MS)
  return decay * (RECALL_DURABLE_KINDS.has(kind) ? RECALL_DURABLE_BONUS : 1)
}

/** Usage reinforcement (Vestige-style, deterministic local version): every
 * prior FTS hit multiplies the recall score, with diminishing returns so a
 * record hit many times cannot crowd out fresh knowledge entirely. A record
 * never hit keeps the neutral 1.0 factor. */
function recallHitBoost(hit: { readonly hitCount: number; readonly lastHitAt: number } | undefined): number {
  if (hit === undefined || hit.hitCount <= 0) return 1
  return 1 + Math.min(0.5, 0.1 * Math.sqrt(hit.hitCount))
}
