import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMORY_INDEX_FILENAME,
  planMemoryExport,
  writeMemoryExport,
} from '../src/memory/memory-export.ts'
import { memoryFileName, parseMemoryDocument, renderMemoryDocument, type MemoryDocumentRecord } from '../src/memory/memory-document.ts'
import { MEMORY_REDACTION_MARKER } from '../src/memory/memory-security.ts'

const NOW = 1_800_000_000_000
const ID = 'mem_abc123def4567890abcdef1234567890'

/**
 * A Stripe-shaped live key, composed rather than written out.
 *
 * GitHub's push protection refuses a push carrying the literal `sk_live_…` even
 * inside a fixture, and it reads the committed bytes instead of the runtime
 * value. Every assertion below still sees the same key.
 */
const STRIPE_LIVE_KEY = 'sk_live_' + 'ABCDEFGHIJKLMNOPQRSTUVWX'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function record(overrides: Partial<MemoryDocumentRecord> = {}): MemoryDocumentRecord {
  return {
    id: ID,
    title: 'Retry backoff policy',
    body: 'Bounded retry with exponential backoff.',
    kind: 'decision',
    trust: 'reviewed',
    createdAt: NOW - 60_000,
    tags: ['retry'],
    ...overrides,
  }
}

describe('planMemoryExport', () => {
  it('plans no files for an empty memory', () => {
    const plan = planMemoryExport([], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.index.name).toBe(MEMORY_INDEX_FILENAME)
    expect(plan.index.text).toContain('title: Engineering memory')
  })

  it('names each document from the record and renders the same bytes as the document view', () => {
    const only = record()
    const plan = planMemoryExport([only], NOW)
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]!.name).toBe(memoryFileName(only.title, only.id))
    expect(plan.files[0]!.text).toBe(renderMemoryDocument(only, NOW))
    expect(plan.skipped).toEqual([])
  })

  it('writes only documents its own reader accepts, whatever the field shapes are', () => {
    // The closure this export owes the store: every file it decides to write has
    // to come back through `parseMemoryDocument`. The shapes below are exactly the
    // ones the document format and the store disagree about, and they are not
    // hypothetical — a 64-character tag, an uppercase tag, a colon, a comma and
    // CJK all reach a record through rows written before the two vocabularies were
    // shared, or through the observation path, which does not normalise tags. So
    // the plan has to decide per record instead of assuming the store only ever
    // hands it conforming tags.
    const shapes: readonly (readonly string[])[] = [
      [],
      ['retry'],
      ['a'.repeat(63)],
      ['a'.repeat(64)],
      ['P0'],
      ['scope:api'],
      ['a,b'],
      ['中文标签'],
      ['tab\there'],
      [''],
    ]
    for (const tags of shapes) {
      const plan = planMemoryExport([record({ tags })], NOW)
      // Either the record produced a document, or it is named in `skipped`. What
      // must never happen is a document this module itself cannot read.
      expect(plan.files.length + plan.skipped.length, `tags=${JSON.stringify(tags)}`).toBe(1)
      for (const file of plan.files) {
        expect(parseMemoryDocument(file.text).ok, `tags=${JSON.stringify(tags)}`).toBe(true)
        expect(plan.skipped).toEqual([])
      }
    }
  })

  it('exports a record carrying a legacy tag shape, and the file reads back', () => {
    // The store no longer mints `scope:api`-style tags, but a row written before the
    // vocabulary was shared still holds one. Refusing it made that memory
    // unexportable — the file was the bug, then the skip was, and both were aimed
    // at a document this module had rendered itself.
    const legacy = record({ title: 'Legacy tags', tags: ['scope:api', '中文标签', 'a,b'] })
    const plan = planMemoryExport([legacy], NOW)
    expect(plan.skipped).toEqual([])
    expect(plan.files).toHaveLength(1)
    expect(plan.index.text).toContain('Legacy tags')
    const parsed = parseMemoryDocument(plan.files[0]!.text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.record).toEqual(legacy)
  })

  it('never throws for a record it cannot render, so one bad row cannot stop a plan', () => {
    // The renderer is the plan's inner loop; a throw there is an export that
    // reports nothing at all.
    expect(renderMemoryDocument(record({ createdAt: Number.NaN }), NOW)).toBeUndefined()
    expect(renderMemoryDocument(record({ reviewedAt: Number.POSITIVE_INFINITY }), NOW)).toBeUndefined()
  })

  it('parses each written document back into the record it came from', () => {
    const original = record({ tags: ['retry', 'p0'], sourceEngine: 'codex' })
    const plan = planMemoryExport([original], NOW)
    const parsed = parseMemoryDocument(plan.files[0]!.text)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok ? parsed.record : undefined).toEqual(original)
  })

  it('skips a record with an instant that has no ISO form, instead of aborting the export', () => {
    // `toISOString()` throws on a non-finite date, so one such row used to take the
    // whole export down — every other memory lost to a single bad row, and the
    // caller told nothing. The reason is the record's, not a credential outcome.
    const broken = record({ id: 'mem_dddddddddddddddddddddddddddddddd', title: 'No instant', createdAt: Number.NaN })
    const plan = planMemoryExport([record(), broken], NOW)
    expect(plan.files.map(file => file.name)).toEqual([memoryFileName('Retry backoff policy', ID)])
    expect(plan.skipped).toEqual([{ id: 'mem_dddddddddddddddddddddddddddddddd', title: 'No instant', reason: 'invalid-date' }])
  })

  it('stamps each exported document with its freshness at export time', () => {
    // The age is what tells a reader of the exported directory whether to trust
    // what it says, and it is a fact about *this* export rather than the record.
    const only = record()
    const fresh = planMemoryExport([only], NOW).files[0]!.text
    const stale = planMemoryExport([only], NOW + 90 * 24 * 60 * 60 * 1_000).files[0]!.text
    expect(fresh).toContain('<!-- freshness: fresh')
    expect(stale).toContain('verify before relying on it')
    expect(stale).not.toContain('<!-- freshness: fresh')
    expect(stale).not.toBe(fresh)
  })

  it('is a pure function of the records and the clock', () => {
    const records = [record(), record({ id: 'mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Second', createdAt: NOW })]
    expect(planMemoryExport(records, NOW)).toEqual(planMemoryExport(records, NOW))
  })

  it('lists only exported records in the index', () => {
    const plan = planMemoryExport([
      record(),
      record({ id: 'not-a-memory-id', title: 'Malformed' }),
    ], NOW)
    expect(plan.files).toHaveLength(1)
    expect(plan.index.text).toContain(ID)
    expect(plan.index.text).not.toContain('Malformed')
  })

  it('orders index rows oldest first and escapes a pipe in a title', () => {
    const older = record({ createdAt: NOW - 120_000, title: 'Older' })
    const newer = record({ id: 'mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Newer | piped', createdAt: NOW })
    const table = planMemoryExport([newer, older], NOW).index.text.split('\n').filter(line => line.startsWith('| mem_'))
    expect(table).toHaveLength(2)
    expect(table[0]).toContain('Older')
    expect(table[1]).toContain('Newer \\| piped')
  })

  it('skips a record whose id is not the store format, naming the reason', () => {
    const plan = planMemoryExport([record({ id: 'MEM_upper', title: 'Upper' })], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped).toEqual([{ id: 'MEM_upper', title: 'Upper', reason: 'invalid-id' }])
  })

  it('skips a record that already carries a redaction marker, and says so distinctly', () => {
    const plan = planMemoryExport([record({ body: `key ${MEMORY_REDACTION_MARKER}` })], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.reason).toBe('redacted')
  })

  it('skips a record whose body still carries a credential', () => {
    const plan = planMemoryExport([record({ body: `token: ${STRIPE_LIVE_KEY}` })], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.reason).toBe('carries-credential')
  })

  it('skips a record carrying only a shape-only credential, and names why', () => {
    // The export writes plaintext outside the workspace, so the tier the
    // transient scan merely reports has to be refused here. This is also the
    // case rule 1 covers: the skip is named, so a short export explains itself.
    const secret = `sk-${'aB3'.repeat(16)}`
    const plan = planMemoryExport([record({ title: 'Deploy token', body: `the token is ${secret}` })], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped).toEqual([{ id: 'mem_abc123def4567890abcdef1234567890', title: 'Deploy token', reason: 'carries-credential' }])
    // And the document that would have carried it does not exist at all.
    expect([...plan.files, plan.index].some(file => file.text.includes(secret))).toBe(false)
  })

  it('skips a record whose title carries a named credential', () => {
    // The scan covers the title too, so a secret in the title is the same failure
    // as one in the body — and it is the failure an export must never write out.
    const plan = planMemoryExport([record({ title: `key ${STRIPE_LIVE_KEY}` })], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped[0]!.reason).toBe('carries-credential')
  })

  it('skips a record whose title is nothing but an unnamed opaque value', () => {
    // The second screen arm: a whole field that is only a high-entropy blob is not
    // a memory, so it is refused even though no named pattern matched it.
    const plan = planMemoryExport([record({ title: '9f2c7a4b1d8e3506af41c0be27d95a3e8b614f20' })], NOW)
    expect(plan.files).toEqual([])
    expect(plan.skipped[0]!.reason).toBe('carries-credential')
  })

  it('keeps exporting the records that are exportable when one is not', () => {
    const plan = planMemoryExport([
      record(),
      record({ id: 'bad', title: 'Bad' }),
      record({ id: 'mem_cccccccccccccccccccccccccccccccc', title: 'Also fine', createdAt: NOW }),
    ], NOW)
    expect(plan.files.map(file => file.name)).toEqual([
      memoryFileName('Retry backoff policy', ID),
      memoryFileName('Also fine', 'mem_cccccccccccccccccccccccccccccccc'),
    ])
    expect(plan.skipped.map(skip => skip.id)).toEqual(['bad'])
  })
})

describe('writeMemoryExport', () => {
  it('creates the directory and writes every planned document plus the index', async () => {
    const plan = planMemoryExport([
      record(),
      record({ id: 'mem_dddddddddddddddddddddddddddddddd', title: 'Second record', createdAt: NOW }),
    ], NOW)
    const directory = join(await temporaryDirectory('freecodego-memory-export-'), 'docs')

    const result = await writeMemoryExport(directory, plan)

    expect(result.directory).toBe(directory)
    expect(result.written).toEqual([...plan.files.map(file => file.name), MEMORY_INDEX_FILENAME])
    expect(result.skipped).toEqual([])
    expect(result.stale).toEqual([])
    for (const file of [...plan.files, plan.index]) {
      expect(await readFile(join(directory, file.name), 'utf8')).toBe(file.text)
    }
  })

  it('reports the skips it was handed rather than dropping them', async () => {
    const plan = planMemoryExport([record({ id: 'bad', title: 'Bad' })], NOW)
    const result = await writeMemoryExport(await temporaryDirectory('freecodego-memory-export-'), plan)
    expect(result.written).toEqual([MEMORY_INDEX_FILENAME])
    expect(result.skipped).toEqual([{ id: 'bad', title: 'Bad', reason: 'invalid-id' }])
  })

  it('reports a document it did not produce and leaves it untouched', async () => {
    const directory = await temporaryDirectory('freecodego-memory-export-')
    await writeFile(join(directory, 'hand-edited.md'), 'my own note\n', 'utf8')
    await writeFile(join(directory, 'notes.txt'), 'not a document\n', 'utf8')
    await mkdir(join(directory, 'nested'), { recursive: true })

    const result = await writeMemoryExport(directory, planMemoryExport([record()], NOW))

    expect(result.stale).toEqual(['hand-edited.md'])
    // Untouched, not cleaned up: the export must not overwrite a user's edit with
    // its own idea of what the store holds.
    expect(await readFile(join(directory, 'hand-edited.md'), 'utf8')).toBe('my own note\n')
  })

  it('never reports the index it just wrote as stale', async () => {
    const directory = await temporaryDirectory('freecodego-memory-export-')
    await writeMemoryExport(directory, planMemoryExport([], NOW))
    const second = await writeMemoryExport(directory, planMemoryExport([], NOW))
    expect(second.stale).toEqual([])
  })

  it('sorts the stale list so an unchanged store reports a stable order', async () => {
    const directory = await temporaryDirectory('freecodego-memory-export-')
    await writeFile(join(directory, 'zulu.md'), 'z\n', 'utf8')
    await writeFile(join(directory, 'alpha.md'), 'a\n', 'utf8')
    const result = await writeMemoryExport(directory, planMemoryExport([], NOW))
    expect(result.stale).toEqual(['alpha.md', 'zulu.md'])
  })

  it('refuses a symlinked directory instead of writing through it', async () => {
    const root = await temporaryDirectory('freecodego-memory-export-')
    const real = join(root, 'real')
    const link = join(root, 'link')
    await mkdir(real, { recursive: true })
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(writeMemoryExport(link, planMemoryExport([record()], NOW)))
      .rejects.toThrow('memory export directory is a symlink; refusing to write')
  })

  it('names a document it could not write and keeps going', async () => {
    // The module's own rule: a skipped record is named, never dropped. The same
    // holds for one the filesystem would not take, and the loop has to survive it —
    // an export that wrote 3 of 4 documents and failed as a whole leaves the caller
    // with an errno and no way to say which document is missing.
    //
    // Mutation: without the per-file guard this rejects, so `written` never
    // arrives and the index is never attempted.
    const target = await temporaryDirectory('freecodego-memory-export-')
    const plan = planMemoryExport([
      record(),
      record({ id: 'mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Second decision' }),
    ], NOW)
    const blocked = plan.files[1]!.name
    // A directory where the document belongs is how a real filesystem refuses one
    // write without a full or read-only volume.
    await mkdir(join(target, blocked), { recursive: true })
    const result = await writeMemoryExport(target, plan)
    expect(result.written).not.toContain(blocked)
    expect(result.failed.map(entry => entry.name)).toEqual([blocked])
    // The index is attempted whatever happened to the documents, so a folder whose
    // documents landed still describes itself.
    expect(result.written).toContain(MEMORY_INDEX_FILENAME)
    expect(await readFile(join(target, plan.files[0]!.name), 'utf8')).toBe(plan.files[0]!.text)
    expect(await readFile(join(target, MEMORY_INDEX_FILENAME), 'utf8')).toBe(plan.index.text)
  })
})
