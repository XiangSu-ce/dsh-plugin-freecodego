/**
 * The packaged UI/UX corpus contract: file inventory, schemas, counts and honest refusals.
 *
 * Why this reads every real file
 * ------------------------------
 * The schema lives in the TypeScript catalog and the rows live in 34 separately
 * vendored CSVs. A test of a hand-built row proves only that its fixture agrees with
 * itself; the promise is that every declared column exists in every shipped table,
 * and every stack table follows the shared contract. The real corpus is small enough
 * to read as the test that guards that seam.
 *
 * Why the warning threshold is not the failure branch
 * ---------------------------------------------------
 * A future reviewed upstream update is expected to change row counts sometimes; it
 * is the calibration and semantic drift that require a human gate. The loader warns
 * with the old and new counts rather than answering "missing data" or silently
 * rejecting a corpus that has been deliberately updated. Structural corruption
 * (missing files, malformed CSV, absent columns) is a refusal.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-data-store
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DOMAIN_TABLES, STACKS, STACK_COLUMNS, UI_REASONING_TABLE, type DomainTable } from '../src/uiux/catalog.ts'
import {
  clearCatalogCache,
  EXPECTED_ROW_COUNTS,
  loadCsvTable,
  loadDomain,
  loadReasoningProfiles,
  loadStack,
  UIUX_DATA_DIRECTORY,
} from '../src/uiux/data-store.ts'
import { duplicateColumns, parseCsv, toRows } from '../src/uiux/csv.ts'

/** Every CSV in the reviewed package snapshot, including all 22 stack assets. */
const CORPUS_FILES = Object.keys(EXPECTED_ROW_COUNTS).sort()

/** The assets must be found at the package-relative location the runtime loader uses. */
const ASSET_ROOT = resolve(import.meta.dirname, '..', 'assets', 'uiux', 'data')

/** The provenance record is shipped beside the source CSVs, outside their data directory. */
const PROVENANCE_PATH = resolve(import.meta.dirname, '..', 'assets', 'uiux', 'PROVENANCE.md')

/** Package and bundle manifests that must carry the exact assets the loader reads. */
const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const BUNDLE_ROOT = resolve(PACKAGE_ROOT, '..', 'bundle-latest')

/** Cached-source-compatible table contract used in explicit loader failure fixtures. */
const TEST_TABLE: DomainTable = {
  file: 'fixture.csv',
  searchColumns: ['id'],
  outputColumns: ['value'],
}

/** Temporary catalogue roots used to test loader failures without modifying shipped assets. */
const TEMPORARY_ROOTS: string[] = []

/** Read one manifest count or fail the test when the corpus manifest omitted that file. */
function expectedRowCount(file: string): number {
  const count = EXPECTED_ROW_COUNTS[file]
  if (count === undefined) throw new Error(`No pinned row count for ${file}.`)
  return count
}

afterEach(async () => {
  await Promise.all(TEMPORARY_ROOTS.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Make one isolated directory containing the requested fixture file. */
async function fixtureRoot(file: string, contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-uiux-'))
  TEMPORARY_ROOTS.push(root)
  const path = join(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
  return root
}

/** Extract the exact-byte digest declarations in the vendored provenance record. */
function provenanceHashes(text: string): ReadonlyMap<string, string> {
  const entries = [...text.matchAll(/^\| `([^`]+\.csv)` \| `([^`]+)` \|$/gmu)]
    .flatMap(match => match[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]] as const])
  return new Map(entries)
}

describe('the committed corpus snapshot', () => {
  it('has 11 routed domains and a separate reasoning table in the 12-file core corpus', () => {
    expect(Object.values(DOMAIN_TABLES).map(table => table.file).sort()).toStrictEqual([
      'app-interface.csv', 'charts.csv', 'colors.csv', 'icons.csv', 'landing.csv', 'motion.csv',
      'products.csv', 'react-performance.csv', 'styles.csv', 'typography.csv', 'ux-guidelines.csv',
    ].sort())
    expect(Object.keys(DOMAIN_TABLES)).not.toContain('google-fonts')
    expect(UI_REASONING_TABLE.file).toBe('ui-reasoning.csv')
    expect(loadDomain('style').kind).toBe('loaded')
    expect(loadDomain('typography').kind).toBe('loaded')
  })

  it('loads every routed core table and validates its real search and output fields', () => {
    for (const [domain, table] of Object.entries(DOMAIN_TABLES)) {
      const outcome = loadDomain(domain)
      expect(outcome.kind, table.file).toBe('loaded')
      if (outcome.kind !== 'loaded') continue
      expect(outcome.rows).toHaveLength(expectedRowCount(table.file))
      expect(outcome.warnings).toStrictEqual([])
      const missing = [...table.searchColumns, ...table.outputColumns]
        .filter(column => !(column in (outcome.rows[0] ?? {})))
      expect(missing, table.file).toStrictEqual([])
    }
  })

  it('loads all 22 stack tables with the same declared columns and pinned row counts', () => {
    expect(STACKS).toHaveLength(22)
    for (const stack of STACKS) {
      const file = `stacks/${stack}.csv`
      const outcome = loadStack(stack)
      expect(outcome.kind, file).toBe('loaded')
      if (outcome.kind !== 'loaded') continue
      expect(outcome.rows).toHaveLength(expectedRowCount(file))
      expect(outcome.warnings, file).toStrictEqual([])
      const missing = [...STACK_COLUMNS.searchColumns, ...STACK_COLUMNS.outputColumns]
        .filter(column => !(column in (outcome.rows[0] ?? {})))
      expect(missing, file).toStrictEqual([])
    }
  })

  it('loads reasoning profiles without returning empty Reasoning or Confidence cells', () => {
    const outcome = loadReasoningProfiles()
    expect(outcome.kind).toBe('loaded')
    if (outcome.kind !== 'loaded') return
    expect(outcome.rows).toHaveLength(expectedRowCount(UI_REASONING_TABLE.file))
    expect(outcome.warnings).toStrictEqual([])
    for (const row of outcome.rows) {
      expect(row['UI_Category']).toBeDefined()
      expect('Reasoning' in row).toBe(false)
      expect('Confidence' in row).toBe(false)
    }
  })

  it('uses the installed data path and both published manifests include its assets', async () => {
    expect(resolve(UIUX_DATA_DIRECTORY)).toBe(resolve(ASSET_ROOT))
    expect(CORPUS_FILES).toHaveLength(34)
    const rowCount = CORPUS_FILES.reduce((total, file) => total + (EXPECTED_ROW_COUNTS[file] ?? 0), 0)
    expect(rowCount).toBe(2385)

    const packageManifest = await readFile(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')
    const bundleManifest = await readFile(resolve(BUNDLE_ROOT, 'package.json'), 'utf8')
    const bundleScript = await readFile(resolve(PACKAGE_ROOT, '..', '..', '..', 'scripts', 'build-freecodego-bundle.mjs'), 'utf8')
    expect(packageManifest).toContain('"assets/uiux/**/*"')
    expect(bundleManifest).toContain('"dist/assets/**/*"')
    expect(bundleScript).toContain("cpSync(harnessAssets, join(output, 'assets'), { recursive: true })")
  })

  it('verifies the exact SHA-256 of all 34 vendored CSVs against provenance', async () => {
    const hashes = provenanceHashes(await readFile(PROVENANCE_PATH, 'utf8'))
    const normalizedHashes = new Map([...hashes].map(([file, hash]) => [file.replaceAll('\\\\', '/'), hash]))
    expect([...normalizedHashes.keys()].sort()).toStrictEqual(CORPUS_FILES.map(file => `data/${file}`).sort())
    expect(hashes.size).toBe(34)
    for (const [file, expectedHash] of normalizedHashes) {
      expect(expectedHash, `${file} hash must be lowercase SHA-256`).toMatch(/^[0-9a-f]{64}$/u)
      const bytes = await readFile(resolve(ASSET_ROOT, file.slice('data/'.length)))
      const actualHash = createHash('sha256').update(bytes).digest('hex')
      expect(actualHash, file).toBe(expectedHash)
    }
  })
})

describe('loadCsvTable refusals and cache contract', () => {
  it('distinguishes a missing file, an empty file, and a header without rows', async () => {
    const root = await fixtureRoot('fixture.csv', '')
    const missing = loadCsvTable(root, 'absent.csv', TEST_TABLE)
    expect(missing.kind).toBe('refused')
    if (missing.kind === 'refused') expect(missing.reason).toBe('missing-file')

    const empty = loadCsvTable(root, 'fixture.csv', TEST_TABLE)
    expect(empty.kind).toBe('refused')
    if (empty.kind === 'refused') expect(empty.reason).toBe('empty-file')

    await writeFile(join(root, 'fixture.csv'), 'id,value\n', 'utf8')
    clearCatalogCache(root)
    const headerOnly = loadCsvTable(root, 'fixture.csv', TEST_TABLE)
    expect(headerOnly.kind).toBe('refused')
    if (headerOnly.kind === 'refused') expect(headerOnly.reason).toBe('empty-file')
  })

  it('rejects missing, empty, or duplicate column names and ragged rows', async () => {
    const cases: readonly { readonly content: string; readonly reason: string }[] = [
      { content: 'id,other\n1,x\n', reason: 'missing-columns' },
      { content: 'id,,value\n1,x,y\n', reason: 'empty-column-name' },
      { content: 'id,id,value\n1,2,3\n', reason: 'duplicate-columns' },
      { content: 'id,value\n1\n', reason: 'ragged-rows' },
    ]
    for (const [index, entry] of cases.entries()) {
      const root = await fixtureRoot(`case-${String(index)}.csv`, entry.content)
      const result = loadCsvTable(root, `case-${String(index)}.csv`, TEST_TABLE)
      expect(result.kind, entry.content).toBe('refused')
      if (result.kind === 'refused') expect(result.reason, entry.content).toBe(entry.reason)
    }
  })

  it('refuses malformed quoting with the loader diagnostic instead of a partial row', async () => {
    const root = await fixtureRoot('fixture.csv', 'id,value\n1,"closed"oops\n')
    const result = loadCsvTable(root, 'fixture.csv', TEST_TABLE)
    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.reason).toBe('read-error')
      expect(result.message).toContain('after closing quote')
    }
  })

  it('does not accept traversal, drive-qualified, dot, empty-segment, or absolute paths', () => {
    for (const path of ['../styles.csv', 'C:/styles.csv', 'sub/../../styles.csv', './styles.csv', 'stacks//react.csv', '/styles.csv']) {
      const outcome = loadCsvTable(UIUX_DATA_DIRECTORY, path, TEST_TABLE)
      expect(outcome.kind, path).toBe('refused')
      if (outcome.kind === 'refused') {
        expect(outcome.reason, path).toBe('read-error')
        expect(outcome.message, path).toContain('not root-relative')
      }
    }
  })

  it('keys cached results by schema and makes parsed rows immutable', async () => {
    const root = await fixtureRoot('fixture.csv', 'id,value\nitem,answer\n')
    const valid = loadCsvTable(root, 'fixture.csv', TEST_TABLE)
    expect(valid.kind).toBe('loaded')
    if (valid.kind !== 'loaded') return
    expect(Object.isFrozen(valid.rows)).toBe(true)
    expect(Object.isFrozen(valid.rows[0])).toBe(true)

    const stricter: DomainTable = { file: 'fixture.csv', searchColumns: ['id', 'missing'], outputColumns: ['value'] }
    const rejected = loadCsvTable(root, 'fixture.csv', stricter)
    expect(rejected.kind).toBe('refused')
    if (rejected.kind === 'refused') expect(rejected.reason).toBe('missing-columns')
  })

  it('warns rather than refusing when a known table has a reviewed row-count drift', async () => {
    const columns = [...new Set([...DOMAIN_TABLES.style.searchColumns, ...DOMAIN_TABLES.style.outputColumns])]
    const cells = columns.map(column => column === 'Style ID' ? 'minimal' : '')
    const root = await fixtureRoot('styles.csv', `${columns.join(',')}\n${cells.join(',')}\n`)
    const result = loadCsvTable(root, 'styles.csv', DOMAIN_TABLES.style)
    expect(result.kind).toBe('loaded')
    if (result.kind === 'loaded') {
      expect(result.rows).toHaveLength(1)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('Expected 88 rows; read 1')
    }
  })

  it('reports unknown stack and domain names as explicit refusals', () => {
    const unknownStack = loadStack('missing-stack')
    expect(unknownStack.kind).toBe('refused')
    if (unknownStack.kind === 'refused') expect(unknownStack.reason).toBe('unknown-stack')

    const unknownDomain = loadDomain('unknown-domain')
    expect(unknownDomain.kind).toBe('refused')
    if (unknownDomain.kind === 'refused') expect(unknownDomain.reason).toBe('unknown-domain')
  })
})

describe('the exported CSV conversion helpers', () => {
  it('reports duplicate columns and ragged row locations without padding', () => {
    const parsed = parseCsv('id,name,name\n1,one,two\n2,short\n')
    expect(duplicateColumns(parsed.records)).toStrictEqual(['name'])
    const converted = toRows(parsed.records)
    expect(converted.columns).toStrictEqual(['id', 'name', 'name'])
    expect(converted.rows).toStrictEqual([{ id: '1', name: 'two' }])
    expect(converted.ragged).toStrictEqual([{ line: 3, fields: 2 }])
  })
})
