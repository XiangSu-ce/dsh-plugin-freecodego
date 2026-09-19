/**
 * The user-editable face of engineering memory.
 *
 * Why a document view at all
 * --------------------------
 * The durable store is `engineering-memory.sqlite`: a database a user cannot
 * read, diff, or bulk-edit, reachable only through the plugin's tools and
 * Remotes. OpenClaude's memdir showed the alternative shape — memories as
 * Markdown files with YAML frontmatter that a user opens in an editor, checks
 * into a repository, and fixes by hand when a fact goes stale. The store stays
 * authoritative (the review pipeline, sources, and recall all live there); this
 * module is the **lossless projection** a human can actually own.
 *
 * What "lossless" buys, and what it forbids
 * ----------------------------------------
 * Round-tripping is the whole contract: `parseMemoryDocument` accepts exactly
 * what `renderMemoryDocument` writes, and the parse is validated field by field
 * rather than trusted. Anything this module could not read back is a field it
 * must not write, because an export a later import silently corrupts is worse
 * than one that fails loudly.
 *
 * Three decisions worth stating:
 *
 * - **The id is in the frontmatter, not the filename.** The store's ids are
 *   opaque (`mem_<32 hex>`), so a name like `fix-nginx-retry.md` would need a
 *   separate id map to round-trip. The filename is therefore cosmetic — set
 *   from the title, never parsed back — which keeps renaming a file from
 *   breaking its identity.
 * - **`unknown` values are written as strings, not dropped.** A future store
 *   writing a kind this build does not know must survive an export/import
 *   cycle; dropping the field would silently re-classify the memory on import.
 * - **Secret screening runs here too.** The document is the one representation
 *   a user might commit to a public repository, so it gets the same screening
 *   the store's persistence path gets — not because the store is careless, but
 *   because this copy has further to travel.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/memory-document
 */

import { MEMORY_ID } from '../engineering-memory.ts'
import { describeMemoryAge } from './memory-age.ts'
import { sanitizeMemoryIdentifier, screenMemoryForPersistence } from './memory-security.ts'


/** One memory as the document view represents it. */
export interface MemoryDocumentRecord {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly kind: string
  readonly trust: string
  readonly createdAt: number
  /** Absent before the first review decision. */
  readonly reviewedAt?: number
  /** The store's per-record tags; free-text only, so any string survives here. */
  readonly tags: readonly string[]
  /** Absent when the record carries no engine attribution. */
  readonly sourceEngine?: string
}

/** Why a document could not be parsed, in the caller's own terms. */
export interface MemoryDocumentParseError {
  readonly field: string
  readonly reason: string
}

export type MemoryDocumentParseResult =
  | { readonly ok: true; readonly record: MemoryDocumentRecord }
  | { readonly ok: false; readonly errors: readonly MemoryDocumentParseError[] }

/** Longest filename stem, before the id suffix that carries the identity. */
const MEMORY_FILENAME_STEM_CHARS = 60

/**
 * A filesystem-safe filename stem derived from the title; the id stays the identity.
 *
 * The reduction is `sanitizeMemoryIdentifier`'s, at a filename's length: a second
 * character rule here would let a title be safe in one place and not the other,
 * and the title reaches both this function and the store. That function throws on
 * a title with nothing usable left, which is a caller error for an identifier and
 * an ordinary case for a filename — an all-CJK title still deserves a document — so
 * the empty result falls back rather than propagating.
 */
export function memoryFileName(title: string, id: string): string {
  let stem: string
  try { stem = sanitizeMemoryIdentifier(title, MEMORY_FILENAME_STEM_CHARS) } catch { stem = '' }
  // The id suffix keeps two same-titled memories from overwriting each other's
  // documents; it is the store's identity made visible, not a parsed field.
  return `${stem === '' ? 'memory' : stem}--${id}.md`
}

/**
 * Render one memory as a Markdown document with YAML frontmatter.
 *
 * The body is fenced off from the frontmatter by the standard `---` delimiters
 * and appended verbatim after one blank line, so an editor's rendering matches
 * what the store holds. Returns `undefined` when the record should not be
 * exported at all: a malformed id, or a body that still carries a credential —
 * an export must never be the step that writes a secret to disk in plaintext.
 */
/**
 * The trailing freshness comment, matched exactly so the parser can remove the
 * note the renderer added without touching anything a user wrote.
 *
 * Anchored to the end, and that anchor is the whole rule. The renderer appends
 * this note last (`:142`), so only a note at the end is the renderer's; an
 * unanchored pattern removed the *first* occurrence anywhere in the body, so a
 * body that quoted the form — a memory recording "the export appends a
 * `<!-- freshness: … -->` note", or a sample pasted out of a document — came
 * back one line shorter, silently, having passed every other check. That is
 * worse than a rejection: the document is the store's lossless projection, and
 * this was a field it rewrote without saying so.
 *
 * It consumes the renderer's `\n\n` separator and **not** the trailing newline,
 * via a lookahead. Both halves matter and only together:
 *
 * - The separator is the renderer's, so it goes; `\n*` instead ate *the body's
 *   own* trailing newlines, which is why a body of `"plain\n"` read back as
 *   `"plain"` when a freshness note was present and `"plain\n"` when it was not.
 *   The same record has to read back the same either way.
 * - The trailing newline is also the renderer's, and `:241`'s `replace(/\n$/u,'')`
 *   is what removes it — in the no-note path that is the only newline there is.
 *   Consuming it here too made the two paths disagree by exactly one character,
 *   so the fix is to leave it for the code that already handles it.
 *
 * The lookahead also keeps a body that ends in the same form intact: such a body
 * is followed by the renderer's separator rather than by the end of the text, so
 * the match skips it and lands on the real note.
 */
const FRESHNESS_COMMENT = /\n\n<!-- freshness: [^\n]*-->(?=\n$)/u

export function renderMemoryDocument(record: MemoryDocumentRecord, now?: number): string | undefined {
  if (!MEMORY_ID.test(record.id)) return undefined
  // A record whose instant is not a finite number has no ISO form, and
  // `toISOString()` throws on it — one such row used to abort a whole export
  // rather than being reported as a record that could not be written.
  if (!Number.isFinite(record.createdAt)) return undefined
  if (record.reviewedAt !== undefined && !Number.isFinite(record.reviewedAt)) return undefined
  const screen = screenMemoryForPersistence({ title: record.title, body: record.body })
  if (!screen.ok || screen.redacted) return undefined
  const frontmatter = [
    '---',
    `id: ${JSON.stringify(record.id)}`,
    `title: ${JSON.stringify(record.title)}`,
    `kind: ${JSON.stringify(record.kind)}`,
    `trust: ${JSON.stringify(record.trust)}`,
    `created: ${new Date(record.createdAt).toISOString()}`,
    ...(record.reviewedAt === undefined ? [] : [`reviewed: ${new Date(record.reviewedAt).toISOString()}`]),
    ...(record.sourceEngine === undefined ? [] : [`engine: ${JSON.stringify(record.sourceEngine)}`]),
    ...(record.tags.length === 0 ? [] : [`tags: [${record.tags.map(tag => JSON.stringify(tag)).join(', ')}]`]),
    '---',
    '',
  ]
  // `now` is what makes the age a fact about this export rather than a figure
  // baked into the record: the same memory exported next month says so.
  const note = now === undefined ? '' : `\n\n${memoryDocumentAgeNote(record, now)}`
  return `${frontmatter.join('\n')}${record.body}${note}\n`
}

/**
 * Parse one rendered document back into a record.
 *
 * Every field is validated, and *all* problems are collected before failing, so
 * a user fixing a hand-edited document sees everything wrong in one pass rather
 * than one error per attempt. An `unknown` kind or trust is accepted verbatim:
 * the document is the faithful transport, and re-classifying is the store's
 * decision, not the file format's.
 */
export function parseMemoryDocument(text: string): MemoryDocumentParseResult {
  const errors: MemoryDocumentParseError[] = []
  const normalized = text.replace(/\r\n?/gu, '\n')
  if (!normalized.startsWith('---\n')) {
    return { ok: false, errors: [{ field: 'document', reason: 'the document does not start with a frontmatter block' }] }
  }
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) {
    return { ok: false, errors: [{ field: 'document', reason: 'the frontmatter block is never closed' }] }
  }
  const header = normalized.slice(4, end)
  // The renderer's freshness comment is removed before the body is read, so the
  // parse yields the characters the record held and not the note added for a
  // preview renderer. Only the exact form is stripped; anything else the body
  // ends with is the body.
  let body = normalized.slice(end + 5).replace(FRESHNESS_COMMENT, '')
  if (!body.endsWith('\n')) body += '\n'

  const fields = new Map<string, string>()
  let tags: readonly string[] = []
  for (const [index, rawLine] of header.split('\n').entries()) {
    const line = rawLine.trim()
    if (line === '') continue
    const separator = line.indexOf(':')
    if (separator === -1) {
      errors.push({ field: `frontmatter line ${index + 1}`, reason: 'the line is not a key: value pair' })
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === 'tags') {
      // The whole value is handed to the JSON parser, not split on commas: a
      // comma is legal inside a tag (`"a,b"` is one tag), and a split would turn
      // that single tag into two fragments that no longer parse — reporting a
      // syntax error about a document this module had rendered itself.
      const inner = value.startsWith('[') && value.endsWith(']') ? value : value === '' ? '[]' : `[${value}]`
      try {
        const parsed: unknown = JSON.parse(inner)
        tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
        if (Array.isArray(parsed) && tags.length !== parsed.length) {
          errors.push({ field: 'tags', reason: 'the tags value must be a list of strings' })
        }
      } catch {
        errors.push({ field: 'tags', reason: 'the tags value is not a list of quoted strings' })
      }
      continue
    }
    // Quoted values are JSON strings (the renderer writes every text field
    // quoted); bare values are the ISO timestamps the renderer emits unquoted.
    // JSON-parsing a timestamp throws — `2026-09-10T…` is not a JSON literal —
    // so the raw value is kept instead of forcing every field through one form.
    if (value.startsWith('"')) {
      try {
        fields.set(key, JSON.parse(value) as string)
        continue
      } catch {
        errors.push({ field: key, reason: 'the quoted value is not valid JSON' })
        continue
      }
    }
    fields.set(key, value)
  }

  const id = fields.get('id') ?? ''
  if (!MEMORY_ID.test(id)) errors.push({ field: 'id', reason: 'the id is missing or is not a mem_<32 hex> identity' })
  const title = fields.get('title') ?? ''
  if (title === '') errors.push({ field: 'title', reason: 'the title is missing or empty' })
  const kind = fields.get('kind') ?? ''
  if (typeof kind !== 'string' || kind === '') errors.push({ field: 'kind', reason: 'the kind is missing' })
  const trust = fields.get('trust') ?? ''
  if (typeof trust !== 'string' || trust === '') errors.push({ field: 'trust', reason: 'the trust is missing' })
  const created = fields.get('created')
  const createdAt = created === undefined ? Number.NaN : Date.parse(created)
  if (Number.isNaN(createdAt)) errors.push({ field: 'created', reason: 'the created stamp is missing or not an ISO timestamp' })
  const reviewedRaw = fields.get('reviewed')
  let reviewedAt: number | undefined
  if (reviewedRaw !== undefined) {
    const parsed = Date.parse(reviewedRaw)
    if (Number.isNaN(parsed)) errors.push({ field: 'reviewed', reason: 'the reviewed stamp is not an ISO timestamp' })
    else reviewedAt = parsed
  }
  const engine = fields.get('engine')
  // An empty attribution is a value the record held, so it is transported like any
  // Tags are transported, not re-classified, for the reason `unknown` kinds are:
  // `MemoryDocumentRecord.tags` documents them as free text, the store owns the
  // narrower vocabulary it accepts (`MEMORY_TAG_PATTERN`), and a row written
  // before that vocabulary was shared still holds shapes the store no longer
  // mints. A reader that refused them would make those memories unexportable —
  // and it refused them on documents this module had written itself.
  // `planMemoryExport` still checks the round trip before anything reaches disk.
  if (errors.length > 0) return { ok: false, errors }

  const record: MemoryDocumentRecord = {
    id,
    title,
    body: body.replace(/\n$/u, ''),
    // `unknown` members of either vocabulary pass through verbatim: the parse
    // already proved both are non-empty strings, and the round-trip contract
    // says this module transports values, it does not re-classify them.
    kind,
    trust,
    createdAt,
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    tags,
    ...(engine === undefined ? {} : { sourceEngine: engine }),
  }
  return { ok: true, record }
}

/**
 * The freshness annotation a rendered document carries in its HTML comment, so
 * the age is visible in preview renderers without becoming frontmatter.
 *
 * At the end rather than in the frontmatter for the reason the format is
 * frontmatter-plus-body at all: a preview renderer shows the body, and an age the
 * reader cannot see is not doing its job. Which is also why the parser strips
 * this exact comment before it yields a body — the note is transport metadata, and
 * a round-trip that folded it into the body would grow the body on every export.
 */
export function memoryDocumentAgeNote(record: MemoryDocumentRecord, now: number): string {
  const age = describeMemoryAge(record.createdAt, now)
  if (age.freshness === 'fresh') return `<!-- freshness: fresh (${age.label}) -->`
  return `<!-- freshness: ${age.freshness} (${age.label}) — verify before relying on it -->`
}

/**
 * Render the Markdown index that lists exported memories, oldest first.
 * A directory of documents without an index forces a user to open each file to
 * see what exists; the index is what makes the directory browsable.
 */
export function renderMemoryIndex(records: readonly MemoryDocumentRecord[], now: number): string {
  const lines = ['---', 'title: Engineering memory', `generated: ${new Date(now).toISOString()}`, '---', '', '| id | title | kind | trust | recorded |', '| --- | --- | --- | --- | --- |']
  for (const record of [...records].sort((left, right) => left.createdAt - right.createdAt)) {
    // A Markdown table cell ends at the first unescaped pipe, so titles that
    // contain one get a backslash before it — otherwise the row splits and the
    // index silently loses columns.
    const title = record.title.replaceAll('|', '\u{005c}|')
    lines.push(`| ${record.id} | ${title} | ${record.kind} | ${record.trust} | ${new Date(record.createdAt).toISOString()} |`)
  }
  lines.push('')
  return lines.join('\n')
}
