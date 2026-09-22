/**
 * Table-shape detection — the CSV/TSV/markdown rules from Headroom's
 * `headroom/transforms/content_detector.py`, © Headroom Maintainers,
 * Apache-2.0.
 *
 * Two call sites need the same answer: the content detector asks "is this
 * tabular?" to route the payload, and the tabular ingest then asks "with which
 * delimiter?" to parse it. Each used to carry its own copy of these rules, and
 * the copies had drifted: the delimiter preference order was reversed (so on a
 * row with equal counts for `,` and `;` the detector reported a shape the
 * ingest did not parse) and the prose guard counted empty cells as a word (so a
 * payload the detector called a table failed the ingest's guard, or the other
 * way round). One reader of the text, one set of rules.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/table-shape
 */

/** Markdown alignment separator cell: `---`, `:--`, `--:`, `:-:`. */
export const MD_SEP_CELL_RE = /^:?-{2,}:?$/

/**
 * Delimiter preference, weakest-signal first is NOT the order: entries are
 * tried in order and the highest confidence wins, so this list is the tie
 * breaker. A tie means both delimiters fit the payload equally well and the
 * first entry gets parsed — keep `,` first for CSV-shaped text.
 */
export const DELIMITERS: readonly (readonly [string, number])[] = [[',', 0.85], ['\t', 0.7], [';', 0.85], ['|', 0.85]]

/**
 * Shape of a detected table: which format the payload uses, the delimiter that
 * best fits it, the column count and how confident the detector is.
 */
export interface TableShape {
  readonly format: 'markdown' | 'csv'
  readonly delimiter: string
  readonly columns: number
  readonly confidence: number
}

/**
 * Cells in a `| a | b |` row, counting the outer pipes' contents only.
 * @param row - the candidate markdown row to count cells in.
 * @returns the cell count.
 */
export function mdCellCount(row: string): number {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
}

/**
 * Markdown separator row: at least two `---`-style cells.
 * @param row - the candidate markdown row to test.
 * @returns true when the row is a markdown alignment separator.
 */
export function isMdSeparator(row: string): boolean {
  const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).filter(c => c !== '')
  return cells.length >= 2 && cells.every(c => MD_SEP_CELL_RE.test(c))
}

/**
 * First piped header row followed by a separator row, anywhere in `lines`.
 * @param lines - the candidate lines to scan, in order.
 * @returns the detected Table Shape, or undefined when no markdown table is present.
 */
export function detectMarkdownTable(lines: readonly string[]): TableShape | undefined {
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const line = lines[i]
    const next = lines[i + 1]
    if (line === undefined || next === undefined) continue
    const columns = mdCellCount(line)
    if (line.includes('|') && isMdSeparator(next) && columns >= 2) {
      return { format: 'markdown', delimiter: '|', columns, confidence: 0.95 }
    }
  }
  return undefined
}

/**
 * Prose guard: sentences (ender ratio ≥0.5) or wordy cells (avg >3 words)
 * reject. Empty cells are not words — counting them as one let a sparse table
 * with many blank fields read as prose.
 * @param sample - the sample rows to inspect.
 * @param delim - the delimiter whose cells are counted.
 * @returns true when the sample reads as prose rather than tabular data.
 */
export function looksLikeProse(sample: readonly string[], delim: string): boolean {
  const enders = sample.filter(row => /[.!?]$/.test(row.trimEnd())).length
  if (enders / sample.length >= 0.5) return true
  const cells = sample.flatMap(row => row.split(delim)).map(c => c.trim())
  const avgWords = cells.reduce((sum, c) => sum + c.split(/\s+/).filter(Boolean).length, 0) / Math.max(1, cells.length)
  return avgWords > 3
}

/**
 * Best delimiter whose per-row count is consistent enough, prose rejected.
 * @param lines - the candidate lines to scan, in order.
 * @returns the detected Table Shape, or undefined when no delimiter fits.
 */
export function detectDelimited(lines: readonly string[]): TableShape | undefined {
  const sample = lines.slice(0, 20)
  if (sample.length < 3) return undefined
  let best: TableShape | undefined
  for (const [delim, minConsistency] of DELIMITERS) {
    const counts = sample.map(row => row.split(delim).length - 1)
    if (counts[0] === 0) continue
    const tally = new Map<number, number>()
    for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1)
    let commonCount = 0
    let freq = 0
    for (const [count, n] of tally) {
      if (n > freq) {
        commonCount = count
        freq = n
      }
    }
    if (commonCount === 0) continue
    const consistency = freq / sample.length
    const columns = commonCount + 1
    if (columns < 2 || consistency < minConsistency) continue
    if (looksLikeProse(sample, delim)) continue
    const confidence = Math.min(0.95, 0.5 + consistency * 0.3 + Math.min(columns, 5) * 0.03)
    if (best === undefined || confidence > best.confidence) {
      best = { format: 'csv', delimiter: delim, columns, confidence }
    }
  }
  return best
}
