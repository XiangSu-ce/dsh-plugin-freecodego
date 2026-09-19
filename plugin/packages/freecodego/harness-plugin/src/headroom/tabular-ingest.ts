/**
 * Tabular ingest bridge — TypeScript port of Headroom's
 * `headroom/transforms/tabular_ingest.py` plus the CSV/TSV/markdown-table
 * detectors from `content_detector.py`, © Headroom Maintainers, Apache-2.0.
 *
 * A detected table is converted to header-keyed records and handed to the
 * SmartCrusher csv-schema compactor. Adoption is result-driven: the rendering
 * must be strictly smaller than the ORIGINAL table text (issue #1652 — a
 * compressed table must never state facts the original did not have, so
 * jagged rows abort the transform entirely).
 *
 * The same rule runs the other way: a fact the original DID have must not be
 * dropped. A markdown table may be preceded by a caption or a lead-in sentence,
 * and the detector reports the table wherever it sits in the payload, so those
 * leading lines are rendered ahead of the compacted table rather than discarded.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/tabular-ingest
 */

import type { CcrStore } from './ccr.ts'
import type { SmartCrusherConfig } from './smart-crusher.ts'
import { compactArray, formatCompaction, lossySampleArray, type JsonObject } from './smart-crusher.ts'
// The shape rules (delimiter preference, prose guard, markdown separator) are
// shared with the content detector, which routes a payload here: two copies had
// already drifted on delimiter order and on whether an empty cell counts as a
// word, so the detector could claim a shape this parser then refused.
import { detectDelimited, detectMarkdownTable, isMdSeparator } from './table-shape.ts'

export interface TabularDetection {
  readonly format: 'markdown' | 'csv'
  readonly delimiter: string
  readonly confidence: number
}

/** Detect a whole-content table. Prose rows around a table abort the transform. */
export function detectTabular(content: string): TabularDetection | undefined {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  if (lines.length < 3) return undefined
  const shape = detectMarkdownTable(lines) ?? detectDelimited(lines)
  if (shape === undefined) return undefined
  return { format: shape.format, delimiter: shape.delimiter, confidence: shape.confidence }
}

/** Quote-aware single-line CSV cell splitter (RFC-4180 subset; no embedded newlines). */
function splitCsvLine(line: string, delim: string): string[] {
  if (delim !== ',') return line.split(delim)
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    // `charAt` rather than `line[i]`: indexing a string is `string | undefined`
    // under `noUncheckedIndexedAccess`, and `undefined` appended to a cell
    // would spell "undefined" into the table.
    const c = line.charAt(i)
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (c === '"') inQuotes = false
      else current += c
    } else if (c === '"') inQuotes = true
    else if (c === delim) {
      cells.push(current)
      current = ''
    } else current += c
  }
  cells.push(current)
  return cells
}

export interface TabularResult {
  readonly output: string
  readonly applied: boolean
}

/**
 * Compress a detected table through the SmartCrusher csv-schema pipeline.
 * Jagged rows (cell count ≠ header width) abort: never invent structure.
 */
export function compressTabular(content: string, detection: TabularDetection, cfg: SmartCrusherConfig, store: CcrStore | undefined): TabularResult {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  let headerCells: string[]
  let dataLines: readonly string[]
  // Lines above the table's header are the caller's text, not table chrome. The
  // detector accepts a table anywhere in the payload, so dropping them quietly
  // threw away a caption a reader had asked for; they are carried through and
  // rendered ahead of the table instead.
  let preamble: readonly string[] = []
  if (detection.format === 'markdown') {
    let sepIndex = -1
    for (let i = 0; i + 1 < lines.length; i += 1) {
      const line = lines[i]
      const next = lines[i + 1]
      if (line === undefined || next === undefined) continue
      if (line.includes('|') && isMdSeparator(next)) {
        sepIndex = i
        break
      }
    }
    if (sepIndex < 0 || lines[sepIndex] === undefined) return { output: content, applied: false }
    preamble = lines.slice(0, sepIndex)
    headerCells = lines[sepIndex]!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    dataLines = lines.filter((_, i) => i !== sepIndex && i !== sepIndex + 1 && i >= sepIndex)
  } else {
    const headerLine = lines[0]
    if (headerLine === undefined) return { output: content, applied: false }
    headerCells = splitCsvLine(headerLine, detection.delimiter).map(c => c.trim())
    dataLines = lines.slice(1)
  }
  if (headerCells.length < 2) return { output: content, applied: false }
  // Jagged abort (#1652): every row must match the header width exactly.
  const records: JsonObject[] = []
  for (const line of dataLines) {
    const cells = detection.format === 'markdown'
      ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      : splitCsvLine(line, detection.delimiter)
    if (cells.length !== headerCells.length) return { output: content, applied: false }
    const record: Record<string, string> = {}
    headerCells.forEach((h, i) => {
      record[h === '' ? `col${i}` : h] = cells[i] ?? ''
    })
    records.push(record)
  }
  if (records.length === 0) return { output: content, applied: false }

  const compaction = compactArray(records, cfg, store)
  const tableOutput = formatCompaction(compaction, cfg)
  let output = tableOutput
  if (1 - Buffer.byteLength(tableOutput, 'utf8') / Math.max(1, Buffer.byteLength(content, 'utf8')) < cfg.minSavingsRatio) {
    const lossy = lossySampleArray(records, cfg, store)
    if (lossy === undefined) return { output: content, applied: false }
    output = lossy.output
  }
  const rendered = preamble.length === 0 ? output : `${preamble.join('\n')}\n${output}`
  if (Buffer.byteLength(rendered, 'utf8') >= Buffer.byteLength(content, 'utf8')) return { output: content, applied: false }
  return { output: rendered, applied: true }
}
