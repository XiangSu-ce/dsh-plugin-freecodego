/**
 * Search-output compressor — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/search_compressor.rs`, © Headroom
 * Maintainers, Apache-2.0.
 *
 * Compresses grep/rg/findstr output: `path:line:content` lines grouped by
 * file, scored (error/warn keywords, query-context terms), capped per file
 * and globally, and rendered back in original order with per-file omission
 * summaries. The full output is stored in CCR when the savings are real.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/search-compressor
 */

import type { CcrStore } from './ccr.ts'
import { computeKey } from './ccr.ts'
// "What the terminal renders" has one definition in this subsystem, and the
// search test needs it for the same reason the detector does.
import { stripAnsi } from './lossless-compaction.ts'
// The detection rule is the detector's, not this module's: `looksLikeSearchOutput`
// used to re-derive "is this a `path:line:` line?" from `parseMatchLine`, which
// lacks the detector's exclusions (clock/date prefixes, `=`/`<`/`>` fragments).
// The two answers disagreed on the most common log shape there is — a timestamped
// line parses as `file:line` under the permissive matcher — so the runtime's
// search branch claimed payloads the detector had already called logs.
import { isSearchResultLine } from './content-detector.ts'

/**
 * Tunables for search-output compaction: when to engage, how many matches and
 * files survive, and the ratio the rendering must beat to be accepted.
 */
export interface SearchCompressorConfig {
  /** Minimum match lines before compression is attempted. */
  minMatches: number
  /** Maximum matches kept per file (first/last always survive). */
  perFileCap: number
  /** Maximum files rendered. */
  maxFiles: number
  /** Global match budget ceiling. */
  globalCap: number
  /** Accept only when the rendering is below this ratio of the original. */
  maxRatio: number
}

/** Default search-compressor tunables. */
export const SEARCH_COMPRESSOR_DEFAULTS: SearchCompressorConfig = {
  minMatches: 10,
  perFileCap: 5,
  maxFiles: 15,
  globalCap: 30,
  maxRatio: 0.8,
}

interface MatchLine {
  readonly file: string
  readonly line: number
  readonly content: string
  readonly order: number
  score: number
}

const CONTEXT_WORD_SCORE = 0.3
const ERROR_SCORE = 0.5
const WARN_SCORE = 0.4
const KEYWORD_SCORE = 0.4

// Search-context terms from the original's scorer: identifiers, symbols, and
// failure vocabulary a follow-up query actually needs to see.
const SEARCH_KEYWORDS = ['todo', 'fixme', 'hack', 'deprecated', 'unsafe', 'removed', 'refactor', 'temporary', 'workaround', 'legacy', 'bug', 'issue'] as const

function scoreMatch(content: string, contextWords: readonly string[]): number {
  let score = 0
  const lower = content.toLowerCase()
  for (const word of contextWords) {
    if (lower.includes(word)) score += CONTEXT_WORD_SCORE
  }
  if (/\b(?:error|exception|fatal|panic|assert)\b/i.test(content)) score += ERROR_SCORE
  if (/\b(?:warn|warning)\b/i.test(content)) score += WARN_SCORE
  for (const keyword of SEARCH_KEYWORDS) {
    if (lower.includes(keyword)) score += KEYWORD_SCORE
  }
  return Math.min(score, 1.0)
}

/**
 * Parse one `path:line[:col]:content` line. The file part is matched
 * non-greedily after an optional Windows drive prefix so `C:\a\b.ts:12:msg`
 * resolves with the whole path as the file.
 */
function parseMatchLine(line: string): { file: string; line: number; content: string } | undefined {
  const match = /^(?:[A-Za-z]:)?(.+?):(\d+)(?::\d+)?:?(.*)$/u.exec(line)
  if (match === null) return undefined
  const file = match[1]!
  if (file.includes('://')) return undefined // URL, not a filesystem path
  return { file, line: Number(match[2]!), content: match[3] ?? '' }
}

/**
 * Outcome of one search compaction: the rendering, whether it was adopted,
 * how many matches were seen and kept, and the CCR key when one was stashed.
 */
export interface SearchCompressionResult {
  readonly compressed: string
  readonly applied: boolean
  readonly matchCount: number
  readonly keptCount: number
  readonly cacheKey: string | undefined
}

/**
 * Compress grep/rg output: group matches by file, keep the strongest per
 * file (anchors first/last), respect a global information budget, and render
 * with per-file omission notes. Returns `applied: false` for short or
 * non-search text. `contextWords` boosts query-relevant matches; `bias` > 1
 * keeps more (conservative), < 1 fewer (aggressive).
 * @param text - the text to process.
 * @param cfg - the search-compressor settings to apply.
 * @param store - the store to read, when one is mounted.
 * @param contextWords - query words that boost a match's score.
 * @param bias - multiplier on the keep budget (>1 keeps more).
 * @returns the search compaction result.
 */
export function compressSearch(text: string, cfg: SearchCompressorConfig, store: CcrStore | undefined, contextWords: readonly string[] = [], bias = 1.0): SearchCompressionResult {
  const lines = text.split('\n')
  const matches: MatchLine[] = []
  for (const [i, raw] of lines.entries()) {
    if (raw.trim() === '') continue
    const parsed = parseMatchLine(raw)
    if (parsed === undefined) continue
    matches.push({ ...parsed, order: i, score: 0 })
  }
  if (matches.length < cfg.minMatches) {
    return { compressed: text, applied: false, matchCount: matches.length, keptCount: matches.length, cacheKey: undefined }
  }

  for (const match of matches) match.score = scoreMatch(`${match.file}:${match.content}`, contextWords)

  // Group by file preserving first-seen order.
  const byFile = new Map<string, MatchLine[]>()
  for (const match of matches) {
    const group = byFile.get(match.file) ?? []
    group.push(match)
    byFile.set(match.file, group)
  }

  // File cap: keep the files with the most matches (ties keep first-seen
  // order). First-seen indexes are precomputed — findIndex inside the sort
  // comparator degenerates to O(files × n × log files) on large outputs.
  const firstSeen = new Map<string, number>()
  for (const match of matches) {
    if (!firstSeen.has(match.file)) firstSeen.set(match.file, match.order)
  }
  let files = [...byFile.entries()]
  files = files.sort((a, b) => b[1].length - a[1].length || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
  const effectiveMaxFiles = Math.max(1, Math.round(cfg.maxFiles * bias))
  const effectivePerFileCap = Math.max(1, Math.round(cfg.perFileCap * bias))
  const effectiveGlobalCap = Math.max(1, Math.round(cfg.globalCap * bias))
  const omittedFiles = Math.max(0, files.length - effectiveMaxFiles)
  files = files.slice(0, effectiveMaxFiles)

  // Per-file selection with anchors, then a global score cap.
  const kept = new Set<number>()
  for (const [, group] of files) {
    const keepCount = Math.min(group.length, effectivePerFileCap)
    const selected = new Set<number>()
    // Anchors: first and last always survive.
    selected.add(0)
    if (group.length > 1) selected.add(group.length - 1)
    // Fill by score.
    const byScore = [...group.entries()].sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
    for (const [index] of byScore) {
      if (selected.size >= keepCount) break
      selected.add(index)
    }
    for (const [index, match] of group.entries()) {
      if (selected.has(index)) kept.add(match.order)
    }
  }
  // Apply the global cap by score across all kept matches.
  if (kept.size > effectiveGlobalCap) {
    const keptMatches = matches.filter(match => kept.has(match.order))
    keptMatches.sort((a, b) => b.score - a.score || a.order - b.order)
    const survivors = new Set(keptMatches.slice(0, effectiveGlobalCap).map(match => match.order))
    survivors.forEach(order => kept.add(order))
    kept.clear()
    survivors.forEach(order => kept.add(order))
  }

  // Render: original order, grouped rendering with per-file omission notes.
  const outputLines: string[] = []
  let lastFile: string | undefined
  const omittedPerFile = new Map<string, number>()
  for (const [file, group] of files) {
    const keptInFile = group.filter(match => kept.has(match.order)).length
    if (keptInFile < group.length) omittedPerFile.set(file, group.length - keptInFile)
  }
  // One linear pass: last kept order per file. Re-checking with a full scan
  // per kept match (`groupLastKept`-style) is O(kept × n) on large outputs.
  const lastKeptPerFile = new Map<string, number>()
  for (const match of matches) {
    if (kept.has(match.order)) lastKeptPerFile.set(match.file, match.order)
  }
  for (const match of matches) {
    if (!kept.has(match.order)) continue
    if (match.file !== lastFile) {
      lastFile = match.file
      outputLines.push(match.file)
    }
    outputLines.push(`  ${match.line}: ${match.content}`)
    const omitted = omittedPerFile.get(match.file) ?? 0
    if (omitted > 0 && lastKeptPerFile.get(match.file) === match.order) {
      outputLines.push(`  [... and ${omitted} more matches in this file]`)
    }
  }
  if (omittedFiles > 0) outputLines.push(`[... and ${omittedFiles} more files]`)

  const rendered = outputLines.join('\n')
  const ratio = Buffer.byteLength(rendered, 'utf8') / Math.max(1, Buffer.byteLength(text, 'utf8'))
  if (ratio >= cfg.maxRatio) {
    return { compressed: text, applied: false, matchCount: matches.length, keptCount: kept.size, cacheKey: undefined }
  }
  // Reaching this point *is* the decision to deliver a rendering instead of the
  // input, so the only question the store gate still asks is whether a store
  // exists. It used to ask a second question — `matches.length >= minMatchesForCcr`
  // — whose answer was already yes, because the entry gate above required
  // `matches.length >= minMatches` and both defaults were 10. Two thresholds that
  // have to stay equal to keep the output retrievable are not a contract, they are
  // a coincidence: raising one alone delivers a rendering whose lost lines have no
  // marker and cannot be fetched back, which is exactly the defect F-25 found in
  // the log compressor. The field is gone rather than asserted-equal so the drift
  // has nowhere to reappear.
  let cacheKey: string | undefined
  let compressed = rendered
  if (store !== undefined) {
    const key = computeKey(text)
    // Dropped matches may ship only with their original stored; a refused write
    // means the marker would name nothing, so the rendering is declined.
    if (store.put(key, text) !== true) return { compressed: text, applied: false, matchCount: matches.length, keptCount: kept.size, cacheKey: undefined }
    cacheKey = key
    compressed += `\n[${matches.length} matches compressed to ${kept.size}. Retrieve more: hash=${cacheKey}]`
  }
  return { compressed, applied: true, matchCount: matches.length, keptCount: kept.size, cacheKey }
}

/**
 * Whether the text looks like multi-line search output (`path:line:` lines dominate).
 *
 * Uses the detector's line test, not this module's permissive extractor: the
 * extractor answers "can I pull a file and a line number out of this line?"
 * (which a `2026-09-19T09:01:01Z INFO ...` log line can), while detection has to
 * answer "is this a search result?" — and a timestamp is a log line, which the
 * log compressor reads far better.
 *
 * SGR colour is removed before the test, and the reason is the same guard: the
 * line test rejects a line that *starts* with a clock or a date, and a coloured
 * line starts with `\x1b[32m`, so a coloured application log passed this predicate
 * at ≥0.8 of its lines and the runtime's search branch claimed it before the log
 * branch was asked — the misrouting `headroom-log-routing.spec.ts` pins, reaching
 * it through a spelling those fixtures do not carry. `detectContentType` strips
 * the same escapes at its own entry point; these are the two predicates the
 * runtime asks, so each normalises its own input rather than relying on the other
 * to have done it first.
 * @param raw - the text to test.
 * @returns true when the text reads as grep/rg output.
 */
export function looksLikeSearchOutput(raw: string): boolean {
  const lines = stripAnsi(raw).split('\n')
  let matchLines = 0
  let nonEmpty = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    nonEmpty += 1
    if (isSearchResultLine(line)) matchLines += 1
  }
  return nonEmpty >= 8 && matchLines / nonEmpty >= 0.8
}
