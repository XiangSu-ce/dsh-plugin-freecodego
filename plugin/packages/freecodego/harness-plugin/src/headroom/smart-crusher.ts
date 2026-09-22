/**
 * Smart statistical JSON compression — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/smart_crusher/compaction/`
 * (TabularCompactor + CsvSchemaFormatter + document walker), © Headroom
 * Maintainers, Apache-2.0.
 *
 * Uniform JSON arrays of objects become a `[N]{col:type,...}` declaration +
 * CSV rows: the schema appears once instead of repeating per row. Heterogeneous
 * arrays partition into buckets by a discriminator field. Opaque string cells
 * (long strings, base64 blobs, HTML chunks) become `<<ccr:HASH,KIND,SIZE>>`
 * markers with the original stashed in the CCR store. Savings below the
 * acceptance threshold fall back to the original text.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/smart-crusher
 */

import { computeKey, stagedWrites, type CcrStore } from './ccr.ts'
import { computeOptimalK } from './adaptive-sizer.ts'
import { scoreBatch } from './relevance.ts'
import { omitRecordKey } from '../record-utils.ts'
import { tokensFromChars } from '../token-estimate.ts'
import { decodeConcatenatedObjects, findBulkJsonSpan, findJsonSpan } from './json-span.ts'

/**
 * Tunables for the tabular crusher: when compaction is attempted, how buckets
 * are split, which cells count as opaque, and how far the lossy path may cut.
 */
export interface SmartCrusherConfig {
  /** Minimum item count to attempt tabular compaction. */
  minItems: number
  /** A field is "core" when it appears in at least this fraction of rows. */
  coreFieldFraction: number
  /** Heterogeneity threshold on the core-key ratio. */
  heterogeneousCoreRatio: number
  /** Cap on inner-key count for nested-uniform flattening. */
  maxFlattenInnerKeys: number
  minBuckets: number
  maxBuckets: number
  /** Strings longer than this are opaque-cell candidates. */
  opaqueMinBytes: number
  base64AlphabetRatio: number
  htmlMinOpenBrackets: number
  /** Minimum savings ratio to accept the lossless compressed rendering. */
  minSavingsRatio: number
  /** Payload token-estimate floor below which nothing is crushed. */
  minTokensToCrush: number
  /** Cap on items kept after lossy sampling (original `max_items_after_crush`). */
  maxItemsAfterCrush: number
  /** Anchor fractions of the kept budget (original first/last_fraction). */
  firstFraction: number
  lastFraction: number
  /** BM25 score at/above which a row is pinned by query relevance. */
  relevanceThreshold: number
  /** Enable the `_ccr_dropped` sentinel + CCR offload on the lossy path. */
  enableCcrMarker: boolean
}

/** Default smart-crusher tunables, matching the analyzer's shipped values. */
export const SMART_CRUSHER_DEFAULTS: SmartCrusherConfig = {
  minItems: 5,
  coreFieldFraction: 0.8,
  heterogeneousCoreRatio: 0.6,
  maxFlattenInnerKeys: 6,
  minBuckets: 2,
  maxBuckets: 8,
  opaqueMinBytes: 256,
  base64AlphabetRatio: 0.95,
  htmlMinOpenBrackets: 3,
  minSavingsRatio: 0.3,
  /** Whole-payload token floor below which the crusher never engages. */
  minTokensToCrush: 200,
  maxItemsAfterCrush: 15,
  /** Anchor fractions of the kept budget (original first_fraction/last_fraction). */
  firstFraction: 0.3,
  lastFraction: 0.15,
  /** Pin items scoring at/above this BM25 relevance to the query. */
  relevanceThreshold: 0.25,
  enableCcrMarker: true,
}

type JsonScalar = null | boolean | number | string
type JsonValue = JsonScalar | { readonly [key: string]: JsonValue } | readonly JsonValue[]
/** A JSON value that is an object map, as the crusher's parsers produce. */
export type JsonObject = { readonly [key: string]: JsonValue }

type OpaqueKind = 'base64' | 'string' | 'html'
type Cell =
  | { readonly kind: 'missing' }
  | { readonly kind: 'scalar'; readonly value: JsonValue }
  | { readonly kind: 'nested'; readonly text: string }
  | { readonly kind: 'opaque'; readonly hash: string; readonly size: number; readonly opaqueKind: OpaqueKind }

interface FieldSpec {
  readonly name: string
  readonly typeTag: string
  readonly nullable: boolean
}

/**
 * A compacted array rendered as one table: the field specs that form the
 * schema declaration, the cell rows, and the pre-compaction item count.
 */
export interface Table {
  readonly kind: 'table'
  readonly fields: readonly FieldSpec[]
  readonly rows: readonly (readonly Cell[])[]
  readonly originalCount: number
}

interface Buckets {
  readonly kind: 'buckets'
  readonly discriminator: string
  readonly buckets: readonly { readonly key: string; readonly table: Table }[]
  readonly originalCount: number
}

// ─── Cell classification ──────────────────────────────────────────────────

const CCR_MARKER_PREFIX = '<<ccr:'

function looksLikeBase64(s: string, ratioThreshold: number): boolean {
  if (s.length < 64 || s.includes('<') || s.includes('>') || /\s/u.test(s)) return false
  let alphabet = 0
  for (const c of s) {
    if (/[A-Za-z0-9+/=_-]/u.test(c)) alphabet += 1
  }
  return alphabet / s.length >= ratioThreshold
}

function looksLikeHtml(s: string, minOpenBrackets: number): boolean {
  let open = 0
  for (const c of s) {
    if (c === '<') open += 1
    if (open >= minOpenBrackets) return true
  }
  return false
}

type Classified = { readonly kind: 'scalar' } | { readonly kind: 'json'; readonly value: JsonValue } | { readonly kind: 'opaque'; readonly opaqueKind: OpaqueKind }

function classifyString(s: string, cfg: SmartCrusherConfig): Classified {
  // Never re-offload our own markers: the real bytes already live in the
  // store under the marker's hash (Headroom issue #2694).
  if (s.includes(CCR_MARKER_PREFIX)) return { kind: 'scalar' }
  const trimmed = s.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as JsonValue
      if (typeof parsed === 'object' && parsed !== null) return { kind: 'json', value: parsed }
    } catch { /* not stringified JSON */ }
  }
  if (Buffer.byteLength(s, 'utf8') <= cfg.opaqueMinBytes) return { kind: 'scalar' }
  if (looksLikeBase64(s, cfg.base64AlphabetRatio)) return { kind: 'opaque', opaqueKind: 'base64' }
  if (looksLikeHtml(s, cfg.htmlMinOpenBrackets)) return { kind: 'opaque', opaqueKind: 'html' }
  return { kind: 'opaque', opaqueKind: 'string' }
}

function classifyValue(value: JsonValue, cfg: SmartCrusherConfig, store: CcrStore | undefined): Cell {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { kind: 'scalar', value }
  if (Array.isArray(value)) {
    // Recurse for arrays of objects; else render verbatim.
    if (value.length >= cfg.minItems && value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
      const sub = compactArray(value as readonly JsonObject[], cfg, store)
      return { kind: 'nested', text: formatCompaction(sub, cfg) }
    }
    return { kind: 'scalar', value }
  }
  if (typeof value === 'string') {
    const classified = classifyString(value, cfg)
    if (classified.kind === 'opaque') {
      // 24-hex key so `headroom_retrieve`'s pattern matches every marker
      // the crusher emits (the 12-char hashOpaque variant could never be
      // retrieved — the retrieve tool validates 24 hex chars).
      const hash = computeKey(value)
      // A refused write means this attempt has already queued as many entries as
      // the store holds (`StagedCcrStore.put`), and the next one would be evicted by
      // the writes that follow it — leaving this cell's marker pointing at nothing.
      // The value is then rendered verbatim: a cell that cannot be offloaded is
      // still a cell, and the table gets larger instead of wrong.
      if (store?.put(hash, value) === true) {
        return { kind: 'opaque', hash, size: Buffer.byteLength(value, 'utf8'), opaqueKind: classified.opaqueKind }
      }
      return { kind: 'scalar', value }
    }
    if (classified.kind === 'json') {
      const parsed = classified.value
      if (Array.isArray(parsed) && parsed.length >= cfg.minItems && parsed.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
        const sub = compactArray(parsed as readonly JsonObject[], cfg, store)
        return { kind: 'nested', text: formatCompaction(sub, cfg) }
      }
      return { kind: 'scalar', value: parsed }
    }
    return { kind: 'scalar', value }
  }
  return { kind: 'scalar', value }
}

// ─── Tabular compaction ───────────────────────────────────────────────────

function typeTagFor(v: JsonValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'string') return 'string'
  return 'json'
}

function inferTypeTag(items: readonly JsonObject[], key: string): { tag: string; nullable: boolean } {
  let tag: string | undefined
  let nullable = false
  for (const item of items) {
    const v = item[key]
    if (v === undefined) {
      nullable = true
      continue
    }
    if (v === null) {
      nullable = true
      continue
    }
    const t = typeTagFor(v)
    if (tag === undefined) tag = t
    else if (tag !== t) tag = 'json'
  }
  return { tag: tag ?? 'json', nullable }
}

function computeKeyFreqs(items: readonly JsonObject[]): Map<string, number> {
  const freqs = new Map<string, number>()
  for (const item of items) {
    for (const key of Object.keys(item)) freqs.set(key, (freqs.get(key) ?? 0) + 1)
  }
  return freqs
}

function detectDiscriminator(items: readonly JsonObject[], keyFreqs: ReadonlyMap<string, number>, cfg: SmartCrusherConfig): string | undefined {
  const total = items.length
  let best: { key: string; score: number } | undefined
  for (const [key, freq] of keyFreqs) {
    if (freq < total) continue
    const values: string[] = []
    let allStrings = true
    for (const item of items) {
      const v = item[key]
      if (typeof v === 'string') values.push(v)
      else {
        allStrings = false
        break
      }
    }
    if (!allStrings) continue
    const distinct = new Set(values)
    const n = distinct.size
    if (n < cfg.minBuckets || n > cfg.maxBuckets) continue
    if (n / total > 0.7) continue
    if (best === undefined || n > best.score) best = { key, score: n }
  }
  return best?.key
}

function buildTable(items: readonly JsonObject[], cfg: SmartCrusherConfig, store: CcrStore | undefined): Table | Buckets {
  const keyFreqs = computeKeyFreqs(items)
  const total = items.length
  const coreThreshold = Math.ceil(total * cfg.coreFieldFraction)
  let coreCount = 0
  for (const freq of keyFreqs.values()) {
    if (freq >= coreThreshold) coreCount += 1
  }
  const coreRatio = keyFreqs.size === 0 ? 1 : coreCount / keyFreqs.size

  if (coreRatio < cfg.heterogeneousCoreRatio) {
    const discriminator = detectDiscriminator(items, keyFreqs, cfg)
    if (discriminator !== undefined) {
      const groups = new Map<string, JsonObject[]>()
      for (const item of items) {
        const key = typeof item[discriminator] === 'string' ? item[discriminator] : '__missing__'
        const group = groups.get(key) ?? []
        group.push(item)
        groups.set(key, group)
      }
      const buckets = [...groups.entries()].map(([key, groupItems]) => {
        const inner = buildTable(groupItems, cfg, store)
        if (inner.kind === 'table') return { key, table: inner }
        // Degenerate single-column table for nested heterogeneous groups.
        return {
          key,
          table: {
            kind: 'table' as const,
            fields: [{ name: 'value', typeTag: 'json', nullable: false }],
            rows: groupItems.map(item => [{ kind: 'scalar' as const, value: item }]),
            originalCount: groupItems.length,
          },
        }
      }).sort((a, b) => a.key.localeCompare(b.key))
      return { kind: 'buckets', discriminator, buckets, originalCount: total }
    }
    // No clean discriminator — fall through to a sparse table.
  }

  // Schema: union of all keys, descending frequency then alphabetical.
  const orderedKeys = [...keyFreqs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
  const fields: FieldSpec[] = []
  for (const key of orderedKeys) {
    const { tag, nullable } = inferTypeTag(items, key)
    fields.push({ name: key, typeTag: tag, nullable })
  }
  const rows = items.map(item => orderedKeys.map((key) => {
    const v = item[key]
    // `as const` on the discriminant, not on the object: without it the union
    // widens to `{ kind: string }` and stops being a `Cell` at all.
    if (v === undefined) return { kind: 'missing' as const }
    return classifyValue(v, cfg, store)
  }))
  const table: Table = { kind: 'table', fields, rows, originalCount: total }
  return flattenUniformNested(table, cfg)
}

/** Promote fields whose every row holds an object with the same key set into dotted columns. */
function flattenUniformNested(table: Table, cfg: SmartCrusherConfig): Table {
  const fields = [...table.fields]
  const rows = table.rows.map(row => [...row])
  let i = 0
  while (i < fields.length) {
    if (fields[i]!.name.includes('.')) {
      i += 1
      continue
    }
    let canonical: string[] | undefined
    let uniform = true
    for (const row of rows) {
      const cell = row[i]
      if (cell === undefined || cell.kind === 'missing') continue
      if (cell.kind !== 'scalar' || typeof cell.value !== 'object' || cell.value === null || Array.isArray(cell.value)) {
        uniform = false
        break
      }
      const keys = Object.keys(cell.value).sort()
      if (keys.length === 0 || keys.length > cfg.maxFlattenInnerKeys) {
        uniform = false
        break
      }
      if (canonical === undefined) canonical = keys
      else if (canonical.join('\u0000') !== keys.join('\u0000')) {
        uniform = false
        break
      }
    }
    if (!uniform || canonical === undefined) {
      i += 1
      continue
    }
    const parent = fields[i]!.name
    const newFields = canonical.map(key => ({ name: `${parent}.${key}`, typeTag: 'string', nullable: false }))
    fields.splice(i, 1, ...newFields)
    for (const row of rows) {
      const original = row.splice(i, 1)[0]
      const inner = original !== undefined && original.kind === 'scalar' && typeof original.value === 'object' && original.value !== null && !Array.isArray(original.value)
        ? original.value as JsonObject
        : undefined
      const expanded = canonical.map((key) => {
        const v = inner?.[key]
        return v === undefined ? { kind: 'missing' as const } : { kind: 'scalar' as const, value: v }
      })
      row.splice(i, 0, ...expanded)
    }
    i += newFields.length
  }
  return { ...table, fields, rows }
}

/**
 * Compact an array of JSON objects into a table, or into discriminator buckets
 * when the rows are heterogeneous. Arrays below `cfg.minItems`, or holding any
 * non-object entry, fall back to a single-column `value` table.
 * @param items - the array items to compact.
 * @param cfg - the smart-crusher settings to apply.
 * @param store - the CCR store used to offload opaque cells, when mounted.
 * @returns the compacted table or bucketed table.
 */
export function compactArray(items: readonly JsonObject[], cfg: SmartCrusherConfig, store: CcrStore | undefined): Table | Buckets {
  if (items.length < cfg.minItems || !items.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
    return { kind: 'table', fields: [{ name: 'value', typeTag: 'json', nullable: false }], rows: items.map(item => [{ kind: 'scalar', value: item }]), originalCount: items.length }
  }
  return buildTable(items, cfg, store)
}

// ─── CSV-schema formatter ─────────────────────────────────────────────────

function csvQuote(s: string): string {
  return `"${s.replaceAll('"', '""')}"`
}

function needsCsvQuote(s: string): boolean {
  return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
}

function scalarToCsv(v: JsonValue): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return needsCsvQuote(v) ? csvQuote(v) : v
  return csvQuote(JSON.stringify(v))
}

function humanizeBytes(n: number): string {
  if (n < 1024) return `${n}B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)}KB`
  return `${(kb / 1024).toFixed(1)}MB`
}

function formatCell(cell: Cell): string {
  switch (cell.kind) {
    case 'missing': return ''
    case 'scalar': return scalarToCsv(cell.value)
    case 'nested': return csvQuote(cell.text)
    case 'opaque': return `<<ccr:${cell.hash},${cell.opaqueKind},${humanizeBytes(cell.size)}>>`
  }
}

function formatTable(table: Table): string {
  const declaration = `[${table.rows.length}]{${table.fields.map(field => `${field.name}:${field.typeTag}${field.nullable ? '?' : ''}`).join(',')}}`
  const lines = [declaration, ...table.rows.map(row => row.map(formatCell).join(','))]
  return lines.join('\n')
}

/**
 * Render a compaction as the CSV-schema form: a `[n]{field:type,...}`
 * declaration line followed by one line per row, or `__buckets:`/`__key:`
 * prefixed sections when the compaction is bucketed.
 * @param compaction - the table or bucketed table to render.
 * @param cfg - the smart-crusher settings to apply.
 * @returns the rendered compaction text.
 */
export function formatCompaction(compaction: Table | Buckets, cfg: SmartCrusherConfig): string {
  if (compaction.kind === 'table') return formatTable(compaction)
  const lines = [`__buckets:${compaction.discriminator}`]
  for (const bucket of compaction.buckets) {
    lines.push(`__key:${scalarToCsv(bucket.key)}`)
    lines.push(formatTable(bucket.table))
  }
  void cfg
  return lines.join('\n')
}

// ─── Crushability gate (original analyzer.rs analyze_crushability) ─────────

interface FieldStats {
  readonly name: string
  readonly fieldType: 'string' | 'numeric' | 'other'
  readonly uniqueRatio: number
  readonly uniqueCount: number
  readonly avgLength: number | undefined
  readonly meanVal: number | undefined
  readonly variance: number | undefined
  readonly constant: boolean
  /** Fraction of rows carrying this field. */
  readonly presence: number
  readonly minVal: number | undefined
  readonly maxVal: number | undefined
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u

/** Normalized Shannon entropy over characters (original calculate_string_entropy). */
function stringEntropy(s: string): number {
  const n = Array.from(s).length
  if (n < 2) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / n
    if (p > 0) entropy -= p * Math.log2(p)
  }
  const maxEntropy = Math.log2(Math.min(freq.size, n))
  return maxEntropy > 0 ? entropy / maxEntropy : 0
}

/** Numeric sequential detection (original detect_sequential_pattern, order-checked). */
function isSequential(values: readonly JsonValue[]): boolean {
  const nums: number[] = []
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    nums.push(value)
  }
  if (nums.length < 3) return false
  const delta = nums[1]! - nums[0]!
  if (delta === 0) return false
  for (let i = 2; i < Math.min(nums.length, 20); i += 1) {
    if (nums[i]! - nums[i - 1]! !== delta) return false
  }
  return true
}

/** Statistical ID-field detection (original detect_id_field_statistically).
 * Confidence ordering matters: a high-entropy string column is a far stronger
 * ID signal than a sequential numeric — timestamps, sizes, and counters are
 * sequential all the time. A numeric candidate must never outrank a string
 * one, or semantic columns hijack the ID slot and unique-entity arrays get
 * refused compaction entirely (regression observed on {id,name,size} rows). */
function detectIdField(stats: FieldStats, values: readonly JsonValue[]): { isId: boolean; confidence: number } {
  if (stats.uniqueRatio < 0.9) return { isId: false, confidence: 0 }
  if (stats.fieldType === 'string') {
    const sample = values.slice(0, 20).filter((v): v is string => typeof v === 'string')
    if (sample.length > 0) {
      const uuidCount = sample.filter(s => UUID_RE.test(s)).length
      if (uuidCount / sample.length > 0.8) return { isId: true, confidence: 0.95 }
      const avgEntropy = sample.reduce((sum, s) => sum + stringEntropy(s), 0) / sample.length
      if (avgEntropy > 0.7 && stats.uniqueRatio > 0.95) return { isId: true, confidence: 0.9 }
    }
  }
  if (stats.fieldType === 'numeric') {
    if (isSequential(values) && stats.uniqueRatio > 0.95) return { isId: true, confidence: 0.7 }
    if (stats.minVal !== undefined && stats.maxVal !== undefined && stats.maxVal - stats.minVal > 0 && stats.uniqueRatio > 0.95) {
      return { isId: true, confidence: 0.65 }
    }
  }
  return { isId: false, confidence: 0 }
}

/**
 * Smallest and largest of a numeric column, in one pass.
 *
 * `Math.min(...numeric)` is the same arithmetic but spreads the whole column
 * into the argument list, which V8 caps (a `RangeError` from ~100k elements on).
 * That ceiling lands exactly on the payloads this stage exists for: a large JSON
 * array of objects. The throw escaped `crushJson`, so the whole compression was
 * skipped for the biggest inputs — the ones worth compressing — while ordinary
 * sizes kept working.
 */
function numericBounds(numeric: readonly number[]): { readonly min: number; readonly max: number } {
  let min = numeric[0] ?? 0
  let max = min
  for (const value of numeric) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

function analyzeField(name: string, items: readonly JsonObject[], cfg: SmartCrusherConfig): FieldStats {
  void cfg
  const values = items.map(item => item[name]).filter(v => v !== undefined)
  const presence = values.length / Math.max(1, items.length)
  const stringish = values.filter((v): v is string => typeof v === 'string')
  const numeric = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const unique = new Set(values.map(v => JSON.stringify(v)))
  const uniqueRatio = values.length === 0 ? 0 : unique.size / values.length
  if (stringish.length === values.length && values.length > 0) {
    const avgLength = stringish.reduce((sum, s) => sum + s.length, 0) / stringish.length
    return { name, fieldType: 'string', uniqueRatio, uniqueCount: unique.size, avgLength, meanVal: undefined, variance: undefined, constant: unique.size <= 1, presence, minVal: undefined, maxVal: undefined }
  }
  if (numeric.length === values.length && values.length > 0) {
    const meanVal = numeric.reduce((sum, n) => sum + n, 0) / numeric.length
    const variance = numeric.length > 1 ? numeric.reduce((sum, n) => sum + (n - meanVal) ** 2, 0) / (numeric.length - 1) : 0
    const bounds = numericBounds(numeric)
    return {
      name, fieldType: 'numeric', uniqueRatio, uniqueCount: unique.size, avgLength: undefined, meanVal, variance,
      constant: unique.size <= 1, presence, minVal: bounds.min, maxVal: bounds.max,
    }
  }
  return { name, fieldType: 'other', uniqueRatio, uniqueCount: unique.size, avgLength: undefined, meanVal: undefined, variance: undefined, constant: unique.size <= 1, presence, minVal: undefined, maxVal: undefined }
}

/** Pareto rare-status detection (original outliers.rs Bug #3 fix): a common
 * categorical field whose top-K (K ≤ 5) values cover ≥80% flags the rest. */
function detectRareStatusOutliers(items: readonly JsonObject[], commonFields: readonly string[]): Set<number> {
  const outliers = new Set<number>()
  for (const field of commonFields) {
    const values = items.map(item => item[field]).filter(v => v !== undefined && v !== null)
    const unique = new Set(values.filter(v => typeof v !== 'object').map(v => JSON.stringify(v)))
    if (unique.size < 2 || unique.size > 50) continue
    const freq = new Map<string, number>()
    for (const value of values) {
      const key = JSON.stringify(value)
      freq.set(key, (freq.get(key) ?? 0) + 1)
    }
    const sorted = [...freq.values()].sort((a, b) => b - a)
    let covered = 0
    let topK = 0
    for (const count of sorted) {
      covered += count
      topK += 1
      if (covered >= 0.8 * values.length) break
    }
    if (topK > 5) continue
    const commonValues = new Set([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([key]) => key))
    items.forEach((item, index) => {
      const value = item[field]
      if (value === undefined || value === null) return
      if (!commonValues.has(JSON.stringify(value))) outliers.add(index)
    })
  }
  return outliers
}

/** Items containing a rare field (<20% presence) or rare status value are outliers. */
function detectStructuralOutliers(items: readonly JsonObject[], fieldStats: readonly FieldStats[]): Set<number> {
  if (items.length < 5) return new Set()
  const rareFields = fieldStats.filter(stats => stats.presence < 0.2).map(stats => stats.name)
  const commonFields = fieldStats.filter(stats => stats.presence >= 0.8).map(stats => stats.name)
  const outliers = new Set<number>()
  if (rareFields.length > 0) {
    items.forEach((item, index) => {
      if (rareFields.some(field => item[field] !== undefined)) outliers.add(index)
    })
  }
  for (const index of detectRareStatusOutliers(items, commonFields)) outliers.add(index)
  return outliers
}

/**
 * Whether an array may be compacted at all, and the human-readable reason
 * behind the decision.
 */
export interface CrushabilityVerdict {
  readonly crushable: boolean
  readonly reason: string
}

/** Statistical score-field detection (original detect_score_field_statistically):
 * bounded-range numeric, non-sequential, preferably descending or fractional. */
function detectScoreField(stats: FieldStats, items: readonly JsonObject[]): { isScore: boolean; confidence: number } {
  if (stats.fieldType !== 'numeric' || stats.minVal === undefined || stats.maxVal === undefined) return { isScore: false, confidence: 0 }
  let confidence = 0
  const { minVal, maxVal } = stats
  if (minVal >= 0 && minVal <= 1 && maxVal >= 0 && maxVal <= 1) confidence += 0.4
  else if (minVal >= 0 && minVal <= 10 && maxVal >= 0 && maxVal <= 10) confidence += 0.3
  else if (minVal >= 0 && minVal <= 100 && maxVal >= 0 && maxVal <= 100) confidence += 0.25
  else if (minVal >= -1 && maxVal <= 1) confidence += 0.35
  else return { isScore: false, confidence: 0 }

  // Sequential sample (first 50 values) — IDs are sequential, scores aren't.
  const sample = items.slice(0, 50).map(item => item[stats.name]).filter(v => v !== undefined)
  if (isSequential(sample)) return { isScore: false, confidence: 0 }

  // Descending order bonus (ranked results).
  const ordered = items.map(item => item[stats.name]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (ordered.length >= 5) {
    let descending = 0
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i - 1]! >= ordered[i]!) descending += 1
    }
    if (descending / (ordered.length - 1) > 0.7) confidence += 0.3
  }
  // Fractional-part bonus.
  const first20 = ordered.slice(0, 20)
  if (first20.length > 0) {
    const fractional = first20.filter(v => v !== Math.trunc(v)).length
    if (fractional > first20.length * 0.3) confidence += 0.1
  }
  const isScore = confidence >= 0.4
  return { isScore, confidence: Math.min(0.95, confidence) }
}

/**
 * Decide whether an array is safe to sample at all (original
 * `analyze_crushability` decision tree). Fully-unique entity arrays with no
 * preservation signal are refused; repetitive or low-uniqueness data passes.
 * @param items - the array items to analyze.
 * @param cfg - the smart-crusher settings to apply.
 * @returns the crushability verdict.
 */
export function analyzeCrushability(items: readonly JsonObject[], cfg: SmartCrusherConfig): CrushabilityVerdict {
  const fieldStats = [...new Set(items.flatMap(item => Object.keys(item)))].map(name => analyzeField(name, items, cfg))

  // Error-keyword preservation signal (original ERROR_KEYWORDS fallback).
  let errorCount = 0
  for (const item of items) {
    if (itemHasErrorKeyword(item)) errorCount += 1
  }
  const outlierCount = detectStructuralOutliers(items, fieldStats).size
  const hasAnomaly = fieldStats.some((stats) => {
    if (stats.fieldType !== 'numeric' || stats.variance === undefined || stats.variance <= 0 || stats.meanVal === undefined) return false
    const std = Math.sqrt(stats.variance)
    const threshold = cfg.minItems > 0 ? 2.0 * std : 0
    return items.some((item) => {
      const value = item[stats.name]
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value - stats.meanVal!) > threshold
    })
  })

  // Score-field signal (original search_results → TopN): a bounded,
  // non-sequential numeric column is a ranking signal worth sampling under.
  const hasScoreField = fieldStats.some(stats => detectScoreField(stats, items).isScore)
  const hasSignal = errorCount > 0 || outlierCount > 0 || hasAnomaly || hasScoreField

  // ID-field detection: statistical confidence (entropy/UUID/sequential).
  let idField: FieldStats | undefined
  let idConfidence = 0
  for (const stats of fieldStats) {
    if (stats.presence < 0.8) continue
    const values = items.map(item => item[stats.name]).filter(v => v !== undefined)
    const detected = detectIdField(stats, values)
    if (detected.isId && detected.confidence > idConfidence) {
      idField = stats
      idConfidence = detected.confidence
    }
  }
  const maxUniqueness = Math.max(0, ...fieldStats.filter(stats => stats.name !== idField?.name).map(stats => stats.uniqueRatio))
  const idUniqueness = idField?.uniqueRatio ?? 0
  const nonIdNumeric = fieldStats.filter(stats => stats.fieldType === 'numeric' && stats.name !== idField?.name).map(stats => stats.uniqueRatio)
  const nonIdString = fieldStats.filter(stats => stats.fieldType === 'string' && stats.name !== idField?.name).map(stats => stats.uniqueRatio)
  const avgNonId = [...nonIdNumeric, ...nonIdString]
  const nonIdContentUniqueness = avgNonId.length === 0 ? 0 : avgNonId.reduce((sum, r) => sum + r, 0) / avgNonId.length

  if (nonIdContentUniqueness < 0.1 && idField !== undefined) return { crushable: true, reason: 'repetitive_content_with_ids' }
  // Case 1 (original order): low uniqueness.
  if (maxUniqueness < 0.3 && idUniqueness < 0.3) return { crushable: true, reason: 'low_uniqueness_safe_to_sample' }
  // Repetitive non-ID content (constant/sampled columns): safe even with a
  // strong ID field — the tabular compactor keeps every row.
  if (nonIdContentUniqueness < 0.3 && idField !== undefined) return { crushable: true, reason: 'repetitive_content_with_ids' }
  if (idField !== undefined && maxUniqueness > 0.8 && !hasSignal) return { crushable: false, reason: 'unique_entities_no_signal' }
  if (maxUniqueness > 0.8) return { crushable: true, reason: 'unique_entities_with_signal' }
  if (!hasSignal) return { crushable: false, reason: 'medium_uniqueness_no_signal' }
  return { crushable: true, reason: 'medium_uniqueness_with_signal' }
}

// ─── Lossy sampling path (original crusher.rs keep-indices pipeline) ───────

/** Error keywords that force an item's survival (original ERROR_KEYWORDS). */
const ERROR_KEYWORDS = ['error', 'exception', 'failed', 'failure', 'critical', 'fatal', 'crash', 'panic', 'abort', 'timeout', 'denied', 'rejected'] as const

function itemHasErrorKeyword(item: JsonObject): boolean {
  const serialized = JSON.stringify(item).toLowerCase()
  return ERROR_KEYWORDS.some(keyword => serialized.includes(keyword))
}

/**
 * Outcome of the lossy sampling path: the rendering to send, plus how many
 * items survived and how many were offloaded to the CCR store.
 */
export interface LossySampleResult {
  /** JSON rendering of the kept items plus the `_ccr_dropped` sentinel. */
  readonly output: string
  readonly kept: number
  readonly dropped: number
}

/**
 * Sample a large array down to its information-saturation budget: keep
 * first/last anchors, every error-keyword item, numeric outliers (>2σ),
 * query-relevant rows, then fill the remaining budget in original order,
 * preferring rows the sample does not already carry (identical-item dedup).
 * Dropped rows are summarized by a
 * `<<ccr:HASH N_rows_offloaded>>` sentinel whose hash retrieves the full
 * array from the CCR store.
 * @param items - the array items to sample.
 * @param cfg - the smart-crusher settings to apply.
 * @param store - the store to read, when one is mounted.
 * @param query - the caller's query, used to pin relevance-scored rows.
 * @returns the sampled rendering, or undefined when nothing would be dropped.
 */
export function lossySampleArray(items: readonly JsonObject[], cfg: SmartCrusherConfig, store: CcrStore | undefined, query = ''): LossySampleResult | undefined {
  const itemStrings = items.map(item => JSON.stringify(item))
  const k = computeOptimalK(itemStrings, 1, 3, cfg.maxItemsAfterCrush)
  if (k >= items.length) return undefined

  const keep = new Set<number>()
  // Anchors: first ~30% / last ~15% of the budget (original fractions).
  const firstCount = Math.max(1, Math.round(k * cfg.firstFraction))
  const lastCount = Math.max(1, Math.round(k * cfg.lastFraction))
  for (let i = 0; i < Math.min(firstCount, items.length); i += 1) keep.add(i)
  for (let i = Math.max(0, items.length - lastCount); i < items.length; i += 1) keep.add(i)
  // Errors always survive.
  for (let i = 0; i < items.length; i += 1) {
    if (keep.has(i)) continue
    if (itemHasErrorKeyword(items[i]!)) keep.add(i)
  }
  // Numeric anomalies (>2σ from a per-field mean) always survive.
  const anomalyKeep = numericAnomalyIndices(items)
  anomalyKeep.forEach(index => keep.add(index))
  // Query-relevant rows pinned by BM25 (original relevance_threshold).
  if (query.trim() !== '') {
    const scores = scoreBatch(itemStrings, query)
    scores.forEach((score, index) => {
      if (score.score >= cfg.relevanceThreshold) keep.add(index)
    })
  }
  // Top-N by score field (original TopN strategy): ranked/scored data keeps
  // its best rows — anchors + top-K by the detected score column.
  const scoreField = detectScoreFieldInItems(items)
  if (scoreField !== undefined) {
    const scored = items
      .map((item, index) => ({ score: item[scoreField], index }))
      .filter((entry): entry is { score: number; index: number } => typeof entry.score === 'number' && Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score || a.index - b.index)
    for (const { index } of scored.slice(0, Math.max(0, k - keep.size))) keep.add(index)
  }
  // Identical-item dedup: later duplicates of a kept row are droppable. The
  // budget is therefore spent on rows the sample does not already carry, and
  // only falls back to the original order once every remaining row is a
  // duplicate of one already kept. Filling straight from index 0 was how a
  // twelve-row budget came back as three distinct rows and nine byte-identical
  // copies of one of them, while a hundred distinct rows sat unused behind it.
  const seen = new Set<string>()
  for (const index of keep) seen.add(itemStrings[index]!)
  const duplicates: number[] = []
  for (let i = 0; i < items.length && keep.size < k; i += 1) {
    if (keep.has(i)) continue
    const key = itemStrings[i]!
    if (seen.has(key)) {
      duplicates.push(i)
      continue
    }
    seen.add(key)
    keep.add(i)
  }
  // Under-filling is worse than repeating: when distinct rows run out before the
  // budget does, take the duplicates back in original order.
  for (const index of duplicates) {
    if (keep.size >= k) break
    keep.add(index)
  }
  const keptItems = items.filter((_, i) => keep.has(i))
  const dropped = items.length - keptItems.length
  if (dropped === 0) return undefined

  // The marker-less form is the fallback for two cases that are the same case: no
  // store to write to, and no room left in the one attempt (`StagedCcrStore.put`
  // refuses rather than let the commit evict this attempt's own earlier writes).
  // Either way the summary still reports the count — it just cannot name a hash.
  let sentinel: JsonObject = { _ccr_dropped: `<<${dropped} rows offloaded>>` }
  if (cfg.enableCcrMarker && store !== undefined) {
    const canonical = `[${itemStrings.join(',')}]`
    const hash = computeKey(canonical)
    if (store.put(hash, canonical) === true) sentinel = { _ccr_dropped: `<<ccr:${hash} ${dropped}_rows_offloaded>>` }
  }
  const output = JSON.stringify([...keptItems, sentinel])
  return { output, kept: keptItems.length, dropped }
}

/** Numeric anomalies: >2σ from a per-field mean over finite numbers. */
function numericAnomalyIndices(items: readonly JsonObject[]): readonly number[] {
  const keys = [...new Set(items.flatMap(item => Object.keys(item)))]
  const anomalies = new Set<number>()
  for (const key of keys) {
    const values = items.map((item, index) => ({ value: item[key], index })).filter((entry): entry is { value: number; index: number } => typeof entry.value === 'number' && Number.isFinite(entry.value))
    if (values.length < 5) continue
    const mean = values.reduce((sum, entry) => sum + entry.value, 0) / values.length
    const variance = values.reduce((sum, entry) => sum + (entry.value - mean) ** 2, 0) / (values.length - 1)
    if (variance <= 0) continue
    const std = Math.sqrt(variance)
    for (const entry of values) {
      if (Math.abs(entry.value - mean) > 2.0 * std) anomalies.add(entry.index)
    }
  }
  return [...anomalies]
}

/** Locate a usable score column for the TopN keep pass (best-confidence field). */
function detectScoreFieldInItems(items: readonly JsonObject[]): string | undefined {
  const keys = [...new Set(items.flatMap(item => Object.keys(item)))]
  let best: string | undefined
  let bestConfidence = 0
  for (const key of keys) {
    const values = items.map(item => item[key]).filter(v => v !== undefined)
    const numeric = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (numeric.length !== values.length || values.length === 0) continue
    const unique = new Set(numeric)
    const uniqueRatio = values.length === 0 ? 0 : unique.size / values.length
    const bounds = numericBounds(numeric)
    const stats: FieldStats = {
      name: key,
      fieldType: 'numeric',
      uniqueRatio,
      uniqueCount: unique.size,
      avgLength: undefined,
      meanVal: numeric.reduce((sum, n) => sum + n, 0) / numeric.length,
      variance: 0,
      constant: unique.size <= 1,
      presence: values.length / Math.max(1, items.length),
      minVal: bounds.min,
      maxVal: bounds.max,
    }
    const detected = detectScoreField(stats, items)
    if (detected.isScore && detected.confidence > bestConfidence) {
      best = key
      bestConfidence = detected.confidence
    }
  }
  return best
}

// ─── Document-level entry point ───────────────────────────────────────────

/**
 * Result of crushing one JSON document: the text to send downstream and
 * whether the compressed rendering was accepted.
 */
export interface SmartCrusherResult {
  /** Compressed rendering, or the original text when compaction declined. */
  readonly output: string
  /** True when the compressed rendering was accepted. */
  readonly applied: boolean
}

/**
 * Compress one pure-JSON text. Falls back to the original whenever the
 * rendering does not save enough, JSON parsing fails, the payload is under
 * the token floor, or the array is not crushable.
 * @param text - the text to process.
 * @param cfg - the smart-crusher settings to apply.
 * @param store - the store to read, when one is mounted.
 * @param query - the caller's query, used to pin relevance-scored rows.
 * @returns the crushing result.
 */
export function crushJson(text: string, cfg: SmartCrusherConfig, store: CcrStore | undefined, query = ''): SmartCrusherResult {
  let parsed: JsonValue
  try {
    parsed = JSON.parse(text) as JsonValue
  } catch {
    return { output: text, applied: false }
  }
  // Token floor: tiny payloads gain nothing from crushing. The lossless
  // whitespace-minify reformat is exempt (pure reformat, zero information
  // change — mirrors the Rust pipeline where JsonMinifier runs as its own
  // unconditional stage).
  if (tokensFromChars(text.length) >= cfg.minTokensToCrush) {
    const out = crushParsed(parsed, cfg, store, text, query)
    if (out !== undefined) return { output: out, applied: true }
  }
  const minified = JSON.stringify(parsed)
  if (minified.length < text.length) return { output: minified, applied: true }
  return { output: text, applied: false }
}

/** Best rendering of an already-parsed JSON container, or undefined when nothing beats the source. */
function crushParsed(parsed: JsonValue, cfg: SmartCrusherConfig, store: CcrStore | undefined, text: string, query = ''): string | undefined {
  // Stage 0 — lossless reformat (original json_minifier): a compact
  // serde-style round-trip that strips whitespace and never grows the input.
  // Whatever later stages decline, the minified text is already accepted when
  // it is shorter than the source.
  const minified = JSON.stringify(parsed)
  const useMinified = minified.length < text.length

  if (Array.isArray(parsed)) {
    if (parsed.length < cfg.minItems) {
      return useMinified ? minified : undefined
    }
    if (parsed.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
      const objects = parsed as readonly JsonObject[]
      // Stage 1 — lossless tabular compaction (ungated: it keeps every row,
      // so the crushability refusal does not apply — matches the Rust
      // pipeline where compaction runs before the Skip check).
      // The table's opaque cells are writes, so they belong to a stage that is
      // only committed if the table is the rendering that ships.
      const compaction = stagedWrites(store, stage => formatCompaction(compactArray(objects, cfg, stage), cfg))
      const tableOutput = compaction.value
      const savings = 1 - Buffer.byteLength(tableOutput, 'utf8') / Math.max(1, Buffer.byteLength(text, 'utf8'))
      if (savings >= cfg.minSavingsRatio) {
        compaction.commit()
        return tableOutput
      }
      // Stage 2 — lossy sampling: gated by the crushability analysis (fully
      // unique entity arrays with no preservation signal are refused), then
      // sampled by anchors + error rows + information budget.
      if (!analyzeCrushability(objects, cfg).crushable) {
        return useMinified ? minified : undefined
      }
      const lossy = stagedWrites(store, stage => lossySampleArray(objects, cfg, stage, query))
      if (lossy.value !== undefined && lossy.value.output.length < (useMinified ? minified.length : text.length)) {
        lossy.commit()
        return lossy.value.output
      }
    }
    return useMinified ? minified : undefined
  }
  if (typeof parsed === 'object' && parsed !== null) {
    // Object containers: compact any top-level array-of-objects member.
    const entries = Object.entries(parsed)
    const arrayMember = entries.find(([, v]) => Array.isArray(v) && (v as readonly JsonValue[]).length >= cfg.minItems && (v as readonly JsonValue[]).every(item => typeof item === 'object' && item !== null && !Array.isArray(item)))
    if (arrayMember === undefined) {
      return useMinified ? minified : undefined
    }
    const [key, value] = arrayMember
    const objects = value as readonly JsonObject[]
    // Lossless tabular compaction first (ungated — keeps every row), then the
    // crushability gate for the lossy sampling fallback.
    const compaction = stagedWrites(store, stage => {
      const inner = compactArray(objects, cfg, stage)
      const remaining = JSON.stringify(omitRecordKey(parsed as JsonObject, key))
      return `${remaining}\n${key}:\n${formatCompaction(inner, cfg)}`
    })
    const remaining = JSON.stringify(omitRecordKey(parsed as JsonObject, key))
    const savings = 1 - Buffer.byteLength(compaction.value, 'utf8') / Math.max(1, Buffer.byteLength(text, 'utf8'))
    if (savings >= cfg.minSavingsRatio) {
      compaction.commit()
      return compaction.value
    }
    if (!analyzeCrushability(objects, cfg).crushable) {
      return useMinified ? minified : undefined
    }
    const lossy = stagedWrites(store, stage => lossySampleArray(objects, cfg, stage, query))
    if (lossy.value !== undefined) {
      const lossyOutput = `${remaining}\n${key}:\n${lossy.value.output}`
      if (lossyOutput.length < (useMinified ? minified.length : text.length)) {
        lossy.commit()
        return lossyOutput
      }
    }
    return useMinified ? minified : undefined
  }
  return undefined
}

// ─── Document-level JSON: wrapped, concatenated, embedded spans ───────────
// Port of content_detector._try_detect_json / normalize_concatenated_json
// (issue #1741) and recursive_json.py. Tool output frequently carries a JSON
// body inside a little harness wrapper (`Exit code: 0\n{...}`), as
// whitespace-separated objects (`{...} {...}` from web-search backends), or
// embedded inside otherwise non-JSON text (gh api / curl output).
//
// The span scanner and the concatenated-object decoder are shared with the
// detector that decides a payload is JSON in the first place — they used to be
// two hand-maintained copies of the same reading.

/** True when the value contains an array of length ≥2 that is ≥80% objects. */
function hasRoutableArray(value: JsonValue): boolean {
  if (Array.isArray(value)) {
    if (value.length >= 2) {
      const dicts = value.filter(item => typeof item === 'object' && item !== null && !Array.isArray(item)).length
      if (dicts >= 0.8 * value.length) return true
    }
    return value.some(hasRoutableArray)
  }
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasRoutableArray)
  return false
}

/** Render one embedded span; accept only on a per-span token gain (original: tok=len//4). */
function renderSpan(chunk: string, cfg: SmartCrusherConfig, store: CcrStore | undefined, query = ''): string | undefined {
  if (chunk.includes('<<ccr:')) return undefined
  try {
    const parsed = JSON.parse(chunk) as JsonValue
    if (typeof parsed !== 'object' || parsed === null) return undefined
    if (!hasRoutableArray(parsed)) return undefined
    // One span, one stage: a span whose rendering loses the price comparison
    // leaves nothing behind for a marker that never reached the model.
    const attempt = stagedWrites(store, stage => crushParsed(parsed, cfg, stage, chunk, query))
    const out = attempt.value
    if (out === undefined || out === chunk) return undefined
    // Priced through the shared estimator, so "did this help?" is asked in the
    // same units the caller's budget is expressed in.
    if (tokensFromChars(out.length) >= tokensFromChars(chunk.length)) return undefined
    attempt.commit()
    return out
  } catch {
    return undefined
  }
}

/**
 * Document-level JSON compression: pure JSON, whitespace-separated object
 * runs, harness-wrapped JSON bodies (≥60% bulk), and embedded routable spans
 * spliced in place. Everything is result-driven — only strictly smaller
 * renderings are accepted.
 * @param text - the text to process.
 * @param cfg - the smart-crusher settings to apply.
 * @param store - the store to read, when one is mounted.
 * @param query - the caller's query, used to pin relevance-scored rows.
 * @returns the crushing result.
 */
export function crushJsonDocument(text: string, cfg: SmartCrusherConfig, store: CcrStore | undefined, query = ''): SmartCrusherResult {
  const pure = crushJson(text, cfg, store, query)
  if (pure.applied) return pure

  const stripped = text.trim()
  // Concatenated web-search shape: normalize to a real array first (#1741).
  if (stripped.startsWith('{')) {
    const items = decodeConcatenatedObjects(stripped)
    if (items !== undefined) {
      const attempt = stagedWrites(store, stage => crushParsed(items, cfg, stage, stripped, query))
      const out = attempt.value
      if (out !== undefined && Buffer.byteLength(out, 'utf8') < Buffer.byteLength(stripped, 'utf8')) {
        attempt.commit()
        return { output: out, applied: true }
      }
    }
  }

  // Harness-wrapped JSON: one JSON value that is the bulk of the content. The
  // container is located by the same reader the detector uses, so a bracketed
  // word in the wrapper line cannot make one side find the body and the other
  // side miss it.
  const wrapped = findBulkJsonSpan(text)
  if (wrapped !== undefined) {
    const [a, b] = wrapped.span
    const slice = text.slice(a, b)
    if (!slice.includes('<<ccr:')) {
      const parsed = wrapped.value
      if (typeof parsed === 'object' && parsed !== null) {
        const attempt = stagedWrites(store, stage => crushParsed(parsed, cfg, stage, slice, query))
        if (attempt.value !== undefined && attempt.value !== slice) {
          attempt.commit()
          return { output: `${text.slice(0, a)}${attempt.value}${text.slice(b)}`, applied: true }
        }
      }
    }
  }

  // Embedded routable spans inside non-JSON text (recursive_json).
  let out = ''
  let pos = 0
  let changed = false
  while (pos < text.length) {
    const next = findJsonSpan(text, pos)
    if (next === undefined) break
    const [a, b] = next
    out += text.slice(pos, a)
    const chunk = text.slice(a, b)
    const rendered = renderSpan(chunk, cfg, store, query)
    if (rendered === undefined) out += chunk
    else {
      out += rendered
      changed = true
    }
    pos = b
  }
  out += pos < text.length ? text.slice(pos) : ''
  if (changed) return { output: out, applied: true }

  return { output: text, applied: false }
}
