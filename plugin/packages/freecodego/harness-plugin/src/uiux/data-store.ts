/**
 * Read the packaged UI/UX catalog data and validate it against the search contract.
 *
 * Why this is not a fallback loader
 * ---------------------------------
 * A missing table and a table with no matches are different claims. Returning an
 * empty array for both makes a package that forgot its assets look like a catalog
 * that found nothing, so this loader returns a discriminated outcome and leaves the
 * refusal visible to the caller. The same applies to a changed header: no search is
 * run against a shape the scoring constants and output projection were not measured
 * for.
 *
 * Why rows are cached but the index is not
 * ----------------------------------------
 * Loading the same small, packaged file repeatedly wastes work; caching its parsed
 * rows is safe because the module-owned assets are immutable for this process. The
 * cache key includes the required schema as well as the path, so a prior load under
 * a weaker contract cannot satisfy a stricter caller by accident.
 *
 * The expected row counts are drift alarms, not logic
 * --------------------------------------------------
 * The table manifest pins file names and column names. This second check pins the
 * number of records in the snapshot as a cheap notice that upstream changed the
 * corpus. It does not reject a new upstream release: the caller can update the
 * manifest only after reviewing the change and re-measuring the calibrated floors.
 *
 * @module uiux/data-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOMAIN_TABLES,
  STACK_COLUMNS,
  STACKS,
  UI_REASONING_TABLE,
  type Domain,
  type DomainTable,
} from './catalog.ts'
import { duplicateColumns, parseCsv, toRows } from './csv.ts'
import { projectRow, type SearchRow } from './search.ts'

/** Asset directory used by a source-tree run and copied beside the built package. */
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the static data directory from either the source tree or published package.
 *
 * At runtime this module can be under `src/`, a compiled `lib/types/` tree, or inside
 * `bundle-latest/dist/`; the data are package assets, not generated JS modules. The
 * finite path list makes those layouts explicit and lets a missing package asset stay
 * missing instead of searching the user's workspace for a coincidental `data/` folder.
 *
 * @returns the first packaged data directory that exists.
 */
function resolveDataDirectory(): string {
  const candidates = [
    // The bundle's bootstrap runs from dist/ and receives assets beside itself.
    resolve(MODULE_DIRECTORY, 'assets', 'uiux', 'data'),
    // Source runs from src/uiux/; package builds can run from lib/types/uiux/.
    resolve(MODULE_DIRECTORY, '..', '..', 'assets', 'uiux', 'data'),
    resolve(MODULE_DIRECTORY, '..', 'assets', 'uiux', 'data'),
    resolve(MODULE_DIRECTORY, '..', '..', '..', 'assets', 'uiux', 'data'),
    resolve(MODULE_DIRECTORY, '..', '..', '..', '..', 'assets', 'uiux', 'data'),
  ]
  return candidates.find(path => existsSync(path)) ?? candidates[0] ?? resolve(MODULE_DIRECTORY, 'assets', 'uiux', 'data')
}

/** The resolved catalog root; tests can point a loader at a fixture directory instead. */
export const UIUX_DATA_DIRECTORY = resolveDataDirectory()

/** Stable packaged row counts, keyed by path relative to the UI/UX data root. */
export const EXPECTED_ROW_COUNTS: Readonly<Record<string, number>> = {
  'app-interface.csv': 32,
  'charts.csv': 25,
  'colors.csv': 192,
  'icons.csv': 105,
  'landing.csv': 34,
  'motion.csv': 17,
  'products.csv': 192,
  'react-performance.csv': 44,
  'stacks/angular.csv': 50,
  'stacks/astro.csv': 53,
  'stacks/avalonia.csv': 56,
  'stacks/flutter.csv': 52,
  'stacks/html-tailwind.csv': 59,
  'stacks/javafx.csv': 75,
  'stacks/jetpack-compose.csv': 52,
  'stacks/laravel.csv': 50,
  'stacks/nextjs.csv': 60,
  'stacks/nuxt-ui.csv': 76,
  'stacks/nuxtjs.csv': 67,
  'stacks/react-native.csv': 51,
  'stacks/react.csv': 66,
  'stacks/shadcn.csv': 68,
  'stacks/svelte.csv': 55,
  'stacks/swiftui.csv': 50,
  'stacks/threejs.csv': 53,
  'stacks/uno.csv': 59,
  'stacks/uwp.csv': 55,
  'stacks/vue.csv': 49,
  'stacks/winui.csv': 59,
  'stacks/wpf.csv': 56,
  'styles.csv': 88,
  'typography.csv': 74,
  'ui-reasoning.csv': 192,
  'ux-guidelines.csv': 119,
}

/** Why a file load could not produce a trustworthy table. */
export type CatalogLoadFailure =
  | 'missing-file'
  | 'read-error'
  | 'empty-file'
  | 'blank-lines'
  | 'empty-column-name'
  | 'duplicate-columns'
  | 'ragged-rows'
  | 'missing-columns'
  | 'unknown-domain'
  | 'unknown-stack'

/** A successful load, or an explicit refusal naming the file and failed contract. */
export type CatalogLoadOutcome =
  | {
    readonly kind: 'loaded'
    readonly file: string
    readonly rows: readonly SearchRow[]
    readonly warnings: readonly string[]
  }
  | {
    readonly kind: 'refused'
    readonly file: string
    readonly reason: CatalogLoadFailure
    readonly message: string
  }

/** Separator that cannot occur in an accepted relative path. */
const CACHE_SEPARATOR = '\0'

/** Parsed immutable table snapshots, cached by path and schema. */
const TABLE_CACHE = new Map<string, CatalogLoadOutcome>()

/**
 * Make one immutable refusal object.
 *
 * Cache values are shared with callers, so freezing the discriminant is part of the
 * same immutability guarantee as freezing loaded rows.
 *
 * @param file - the root-relative file name.
 * @param reason - the contract that could not be met.
 * @param message - the diagnostic shown to the caller.
 * @returns the immutable refusal.
 */
function refused(file: string, reason: CatalogLoadFailure, message: string): CatalogLoadOutcome {
  return Object.freeze({ kind: 'refused', file, reason, message })
}

/**
 * Whether every required column appears in a file header.
 *
 * Required columns may have optional columns between them; the catalog's projection
 * names values, not positions, so the data can append columns without changing that
 * contract. Repeated names are checked separately before row objects are built.
 *
 * @param columns - the file's parsed header.
 * @param table - the domain's search/output contract.
 * @returns the required names absent from the header, in contract order.
 */
function missingColumns(columns: readonly string[], table: DomainTable): readonly string[] {
  const actual = new Set(columns)
  return [...table.searchColumns, ...table.outputColumns].filter((column, index, all) =>
    !actual.has(column) && all.indexOf(column) === index)
}

/**
 * Load one root-relative CSV with strict structural checks.
 *
 * @param root - the data directory.
 * @param relativeFile - a path below that directory, including `stacks/` when applicable.
 * @param table - the required search/output columns.
 * @returns parsed rows or an explicit refusal; malformed records never reach scoring.
 */
export function loadCsvTable(
  root: string,
  relativeFile: string,
  table: DomainTable,
): CatalogLoadOutcome {
  const normalizedFile = relativeFile.replaceAll('\\', '/')
  const pathSegments = normalizedFile.split('/')
  if (isAbsolute(normalizedFile) || normalizedFile.startsWith('/') || normalizedFile.includes('\0')
    || pathSegments.some(part => part === '..' || part === '.' || part === '' || /^[a-z]:/iu.test(part))) {
    return refused(normalizedFile, 'read-error', `Catalog path is not root-relative: ${normalizedFile}`)
  }
  const path = resolve(root, ...pathSegments)
  // Column order is part of a schema: the search scorer and returned projection
  // both consume these lists, so different orderings do not share a cache entry.
  const contract = JSON.stringify([table.searchColumns, table.outputColumns])
  const cacheKey = `${resolve(root)}${CACHE_SEPARATOR}${normalizedFile}${CACHE_SEPARATOR}${contract}`
  const cached = TABLE_CACHE.get(cacheKey)
  if (cached !== undefined) return cached
  if (!existsSync(path)) {
    const outcome = refused(normalizedFile, 'missing-file', `Catalog data file is missing: ${normalizedFile}.`)
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const outcome = refused(
      normalizedFile,
      'read-error',
      `Unable to read catalog file ${normalizedFile}: ${error instanceof Error ? error.message : String(error)}`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }

  let parsed: ReturnType<typeof parseCsv>
  try {
    parsed = parseCsv(text)
  } catch (error) {
    const outcome = refused(
      normalizedFile,
      'read-error',
      `Unable to parse catalog file ${normalizedFile}: ${error instanceof Error ? error.message : String(error)}`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  if (parsed.records.length === 0) {
    const outcome = refused(normalizedFile, 'empty-file', `Catalog file is empty: ${normalizedFile}.`)
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  if (parsed.blankLines.length > 0) {
    const outcome = refused(
      normalizedFile,
      'blank-lines',
      `Catalog file ${normalizedFile} contains blank line(s): ${parsed.blankLines.join(', ')}.`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  const unnamedColumns = (parsed.records[0]?.fields ?? [])
    .flatMap((column, index) => column.trim() === '' ? [String(index + 1)] : [])
  if (unnamedColumns.length > 0) {
    const outcome = refused(
      normalizedFile,
      'empty-column-name',
      `Catalog file ${normalizedFile} has empty header column(s) at position(s): ${unnamedColumns.join(', ')}.`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  const duplicates = duplicateColumns(parsed.records)
  if (duplicates.length > 0) {
    const outcome = refused(
      normalizedFile,
      'duplicate-columns',
      `Catalog file ${normalizedFile} repeats header(s): ${duplicates.join(', ')}.`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  const converted = toRows(parsed.records)
  if (converted.ragged.length > 0) {
    const details = converted.ragged.map(row => `${String(row.line)} (${String(row.fields)} fields)`).join(', ')
    const outcome = refused(
      normalizedFile,
      'ragged-rows',
      `Catalog file ${normalizedFile} has row(s) with a field count different from its header: ${details}.`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  const missing = missingColumns(converted.columns, table)
  if (missing.length > 0) {
    const outcome = refused(
      normalizedFile,
      'missing-columns',
      `Catalog file ${normalizedFile} is missing required column(s): ${missing.join(', ')}.`,
    )
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }
  if (converted.rows.length === 0) {
    const outcome = refused(normalizedFile, 'empty-file', `Catalog file ${normalizedFile} has a header but no data rows.`)
    TABLE_CACHE.set(cacheKey, outcome)
    return outcome
  }

  const expected = EXPECTED_ROW_COUNTS[normalizedFile]
  const warnings = expected !== undefined && expected !== converted.rows.length
    ? Object.freeze([`Expected ${String(expected)} rows; read ${String(converted.rows.length)}. Recheck the upstream corpus and calibration before updating this snapshot.`])
    : Object.freeze([])
  const rows = Object.freeze(converted.rows.map(row => Object.freeze(row)))
  const outcome: CatalogLoadOutcome = Object.freeze({
    kind: 'loaded', file: normalizedFile, rows, warnings,
  })
  TABLE_CACHE.set(cacheKey, outcome)
  return outcome
}

/** Whether a caller's key names one of the domains in the routed catalog. */
function isDomain(domain: string): domain is Domain {
  return Object.hasOwn(DOMAIN_TABLES, domain)
}

/**
 * Load one search domain from the packaged corpus.
 *
 * @param domain - the requested domain key; unknown values are explicitly refused.
 * @param root - optional alternate data root for test fixtures.
 * @returns the table's explicit loaded/refused outcome.
 */
export function loadDomain(domain: string, root = UIUX_DATA_DIRECTORY): CatalogLoadOutcome {
  if (!isDomain(domain)) {
    return refused(domain, 'unknown-domain', `Unknown catalog domain ${JSON.stringify(domain)}.`)
  }
  const table = DOMAIN_TABLES[domain]
  return loadCsvTable(root, table.file, table)
}

/**
 * Clear the cached table outcomes.
 *
 * @param root - when supplied, clear only this resolved data root; otherwise clear every root.
 */
export function clearCatalogCache(root?: string): void {
  if (root === undefined) {
    TABLE_CACHE.clear()
    return
  }
  const prefix = `${resolve(root)}${CACHE_SEPARATOR}`
  for (const key of TABLE_CACHE.keys()) if (key.startsWith(prefix)) TABLE_CACHE.delete(key)
}

/**
 * Load one framework table from the packaged corpus.
 *
 * @param stack - one of the catalog's 22 stack identifiers.
 * @param root - optional alternate data root for test fixtures.
 * @returns its table or a refusal for an unknown/missing stack.
 */
export function loadStack(stack: string, root = UIUX_DATA_DIRECTORY): CatalogLoadOutcome {
  if (!STACKS.includes(stack)) {
    return refused(`stacks/${stack}.csv`, 'unknown-stack', `Unknown stack ${JSON.stringify(stack)}.`)
  }
  return loadCsvTable(root, `stacks/${stack}.csv`, STACK_COLUMNS)
}

/**
 * Load the auxiliary product-reasoning profiles without exposing empty explanation fields.
 *
 * `Reasoning` and `Confidence` are empty in every shipped row, so returning them
 * would suggest the table supplies evidence it does not contain. The catalog schema
 * deliberately omits them from the projection used by this wrapper.
 *
 * @param root - optional alternate data root for test fixtures.
 * @returns the loaded profile fields or the same explicit structural refusal as any catalog table.
 */
export function loadReasoningProfiles(root = UIUX_DATA_DIRECTORY): CatalogLoadOutcome {
  const outcome = loadCsvTable(root, UI_REASONING_TABLE.file, UI_REASONING_TABLE)
  if (outcome.kind !== 'loaded') return outcome
  const rows = Object.freeze(outcome.rows.map(row => Object.freeze(projectRow(row, UI_REASONING_TABLE.outputColumns))))
  return Object.freeze({ ...outcome, rows })
}

