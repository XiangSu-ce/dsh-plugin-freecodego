/**
 * Content-type detection — TypeScript port of Headroom's
 * `headroom/transforms/content_detector.py`, © Headroom Maintainers,
 * Apache-2.0.
 *
 * Priority chain (first confident claim wins): parse-confirmed JSON → diff →
 * HTML → search results → build/log output → tabular → structured config →
 * source code → plain text. Detection drives the runtime's lossless fold kind
 * and its lossy-compressor routing, mirroring the original ContentRouter.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/content-detector
 */

import type { JsonValue } from '../types.ts'
// The span scanner and the concatenated-object decoder live beside the crusher
// that consumes the same reading; two copies of them had already been kept in
// step by hand.
import { decodeConcatenatedObjects, findBulkJsonSpan } from './json-span.ts'
// The table-shape rules are shared with the tabular ingest: the verdict this
// detector renders is the shape that module then parses.
import { detectDelimited, detectMarkdownTable } from './table-shape.ts'

export type HeadroomContentType =
  | 'json'
  | 'diff'
  | 'html'
  | 'search'
  | 'log'
  | 'tabular'
  | 'config'
  | 'code'
  | 'text'

export interface DetectionResult {
  readonly contentType: HeadroomContentType
  readonly confidence: number
  readonly metadata: Readonly<Record<string, string | number | boolean>>
}

// ─── JSON ────────────────────────────────────────────────────────────────────

function tryDetectJson(content: string): DetectionResult | undefined {
  const stripped = content.trim()
  if (stripped === '') return undefined
  let value: JsonValue | undefined
  try {
    value = JSON.parse(stripped) as JsonValue
  } catch {
    // Whitespace-separated top-level objects (web-search backends, #1741).
    if (stripped.startsWith('{')) {
      const items = decodeConcatenatedObjects(stripped)
      if (items !== undefined) {
        return { contentType: 'json', confidence: 1.0, metadata: { item_count: items.length, concatenated: true } }
      }
    }
    // One JSON value decoded out of a wrapped payload. Not "the first bracket in
    // the payload": a bracketed word in the wrapper line (`[WARN]`, `{1}`) is a
    // balanced span that is not JSON, and letting it decide the shape made one
    // status word mask a body that was 90% of the bytes. `findBulkJsonSpan`
    // scans for the span that both parses and carries the bulk — the same
    // reading the crusher uses, so the two cannot answer differently.
    const found = findBulkJsonSpan(stripped)
    if (found === undefined) return undefined
    value = found.value
  }
  if (typeof value !== 'object' || value === null) return undefined
  if (Array.isArray(value)) {
    const isDictArray = value.length > 0 && value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))
    return { contentType: 'json', confidence: isDictArray ? 1.0 : 0.8, metadata: { item_count: value.length, is_dict_array: isDictArray } }
  }
  return { contentType: 'json', confidence: 0.9, metadata: { is_object: true } }
}

// ─── Diff ────────────────────────────────────────────────────────────────────

const DIFF_HEADER_RE = /^(?:diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/u
const DIFF_CHANGE_RE = /^[+-][^+-]/u

function tryDetectDiff(content: string): DetectionResult | undefined {
  const lines = content.split('\n').slice(0, 500)
  let headerMatches = 0
  let changeMatches = 0
  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) headerMatches += 1
    if (DIFF_CHANGE_RE.test(line)) changeMatches += 1
  }
  if (headerMatches === 0) return undefined
  const confidence = Math.min(1.0, 0.5 + headerMatches * 0.2 + changeMatches * 0.05)
  return { contentType: 'diff', confidence, metadata: { header_matches: headerMatches, change_lines: changeMatches } }
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function tryDetectHtml(content: string): DetectionResult | undefined {
  const sample = content.slice(0, 3000)
  const hasDoctype = /^\s*<!doctype\s+html/i.test(sample)
  const hasHtmlTag = /<html[\s>]/i.test(sample)
  const hasHead = /<head[\s>]/i.test(sample)
  const hasBody = /<body[\s>]/i.test(sample)
  const structural = (sample.match(/<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi) ?? []).length
  if (!hasDoctype && !hasHtmlTag && structural < 3) return undefined
  let confidence = 0
  if (hasDoctype) confidence += 0.5
  if (hasHtmlTag) confidence += 0.3
  if (hasHead) confidence += 0.1
  if (hasBody) confidence += 0.1
  confidence += Math.min(0.3, structural * 0.03)
  confidence = Math.min(1.0, confidence)
  return { contentType: 'html', confidence, metadata: { structural: structural } }
}

// ─── Search results (grep/rg) ────────────────────────────────────────────────

const SEARCH_RESULT_RE = /^[^\s:]+:\d+:/u

/** Leading clock or date-time token: `09:57:59`, `09:57:59.123`, `2026-09-09T09:57`, `2026-09-09 09:57`. */
const TIMESTAMP_PREFIX_RE = /^(?:\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/u

/** `path:line:content` shape. A bare `word:digits:` prefix also matches clock
 * times and `key=value:12:` fragments, so those are rejected explicitly: a
 * timestamp is a log line, and the log compressor extracts far more from it. */
function isSearchResultLine(line: string): boolean {
  if (!SEARCH_RESULT_RE.test(line)) return false
  if (TIMESTAMP_PREFIX_RE.test(line)) return false
  const prefix = line.split(':', 1)[0] ?? ''
  return !prefix.includes('<') && !prefix.includes('>') && !prefix.includes('=')
}

function tryDetectSearch(content: string): DetectionResult | undefined {
  const lines = content.split('\n').slice(0, 100)
  let matching = 0
  for (const line of lines) {
    if (line.trim() !== '' && isSearchResultLine(line)) matching += 1
  }
  // Absolute floor: one coincidental `word:digits:` line must not claim the payload.
  if (matching < 2) return undefined
  const nonEmpty = lines.filter(line => line.trim() !== '').length
  if (nonEmpty === 0) return undefined
  const ratio = matching / nonEmpty
  if (ratio < 0.3) return undefined
  const confidence = Math.min(1.0, 0.4 + ratio * 0.6)
  return { contentType: 'search', confidence, metadata: { matching_lines: matching, total_lines: nonEmpty } }
}

// ─── Build/log output ────────────────────────────────────────────────────────

const LOG_PATTERNS: readonly RegExp[] = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^={3,}|^-{3,}/,
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/,
  /^npm ERR!|^yarn error|^cargo error/,
  /Traceback \(most recent call last\)/,
  /^\w*(Error|Exception):/,
  /^\s*at\s+[\w.$/]+\(/,
  /^\s*at async \S/,
  /^(panic|fatal error): /,
  /^goroutine \d+ \[/,
  /^\t\S+\.go:\d+ \+0x/,
  /^thread '[^']*' panicked at/,
  /^stack backtrace:/,
  /^\s+\d+: \S/,
  /^\s+at \S+:\d+:\d+$/,
  /^Unhandled exception\./,
  /^\s*at .+\) in .+:line \d+/,
  /^Caused by: /,
  /^\s*\.\.\. \d+ more$/,
]

function tryDetectLog(content: string): DetectionResult | undefined {
  const lines = content.split('\n').slice(0, 200)
  if (lines.length === 0) return undefined
  let patternMatches = 0
  let errorMatches = 0
  for (const line of lines) {
    for (const [i, pattern] of LOG_PATTERNS.entries()) {
      if (pattern.test(line)) {
        patternMatches += 1
        if (i < 2) errorMatches += 1
        break
      }
    }
  }
  if (patternMatches === 0) return undefined
  const nonEmpty = lines.filter(line => line.trim() !== '').length
  if (nonEmpty === 0) return undefined
  const ratio = patternMatches / nonEmpty
  if (ratio < 0.1) return undefined
  const confidence = Math.min(1.0, 0.3 + ratio * 0.5 + errorMatches * 0.05)
  return { contentType: 'log', confidence, metadata: { pattern_matches: patternMatches, error_matches: errorMatches, total_lines: nonEmpty } }
}

// ─── Tabular (CSV/TSV/markdown tables) ──────────────────────────────────────

function tryDetectTabular(content: string): DetectionResult | undefined {
  // The first 50 non-empty lines are the detector's budget; the ingest that
  // acts on this verdict re-runs the same shared rules over the whole payload.
  const lines = content.split('\n').filter(line => line.trim() !== '').slice(0, 50)
  if (lines.length < 3) return undefined
  const shape = detectMarkdownTable(lines) ?? detectDelimited(lines)
  if (shape === undefined) return undefined
  return {
    contentType: 'tabular',
    confidence: shape.confidence,
    metadata: shape.format === 'markdown'
      ? { format: 'markdown', columns: shape.columns }
      : { format: 'csv', delimiter: shape.delimiter, columns: shape.columns },
  }
}

// ─── Structured config (YAML/TOML/INI) ──────────────────────────────────────

const CONFIG_COMMENT_RE = /^\s*#/
const CONFIG_SECTION_RE = /^\s*\[[^\]\n=]+\]\s*$/
const TOML_ASSIGN_RE = /^\s*[\w."'-]+\s*=[^=]/
const INI_ASSIGN_RE = /^\s*[\w."'-]+\s*=[^=]/
const YAML_KEY_RE = /^\s*[\w.-]+:\s?/
const YAML_LIST_RE = /^\s*-\s+\S/
const YAML_DOC_RE = /^(---|\.\.\.)$/

function tryDetectConfig(content: string): DetectionResult | undefined {
  const head = content.trimStart().slice(0, 1)
  if (head === '' || head === '{' || head === '<') return undefined
  const lines = content.split('\n').slice(0, 200)
  const nonEmpty = lines.filter(line => line.trim() !== '')
  if (nonEmpty.length < 3) return undefined
  const body = nonEmpty.filter(line => !CONFIG_COMMENT_RE.test(line))
  if (body.length < 3) return undefined

  // TOML/INI: section header + assignment-dominant body.
  const sections = body.filter(line => CONFIG_SECTION_RE.test(line)).length
  if (sections >= 1) {
    const assigns = body.filter(line => TOML_ASSIGN_RE.test(line) || INI_ASSIGN_RE.test(line)).length
    if (assigns >= 2 && (sections + assigns) / body.length >= 0.6) {
      const share = (sections + assigns) / body.length
      return { contentType: 'config', confidence: Math.min(0.95, 0.7 + share * 0.25), metadata: { sections, assigns } }
    }
  }

  // Markdown front-matter guard: closed `---` fence followed by non-YAML is markdown.
  if (lines[0]?.trim() === '---') {
    for (let idx = 1; idx < Math.min(lines.length, 60); idx += 1) {
      const line = lines[idx]?.trim()
      if (line === '---' || line === '...') {
        const tail = lines.slice(idx + 1).filter(l => l.trim() !== '')
        const tailYaml = tail.filter(l => YAML_KEY_RE.test(l) || YAML_LIST_RE.test(l)).length
        if (tail.length > 0 && tailYaml / tail.length < 0.3) return undefined
        break
      }
    }
  }

  // YAML heuristic.
  const yamlKeys = body.filter(line => YAML_KEY_RE.test(line)).length
  const yamlLists = body.filter(line => YAML_LIST_RE.test(line) && !YAML_KEY_RE.test(line)).length
  const docMarks = body.filter(line => YAML_DOC_RE.test(line.trim())).length
  if (yamlKeys < 3) return undefined
  const share = (yamlKeys + yamlLists + docMarks) / body.length
  if (share < 0.6) return undefined
  // Prose guards: config lines are short field-ish tuples.
  const enders = body.filter(line => /[.!?]$/.test(line.trimEnd())).length
  if (enders / body.length >= 0.5) return undefined
  const avgWords = body.reduce((sum, line) => sum + line.split(/\s+/).length, 0) / body.length
  if (avgWords > 8) return undefined
  // Structure signal: nested indentation, a document marker, or a real list.
  const indents = new Set(body.filter(line => YAML_KEY_RE.test(line) || YAML_LIST_RE.test(line)).map(line => line.length - line.trimStart().length))
  if (indents.size < 2 && docMarks === 0 && yamlLists < 3) return undefined
  return { contentType: 'config', confidence: Math.min(0.9, 0.55 + share * 0.35), metadata: { keys: yamlKeys, list_items: yamlLists } }
}

// ─── Source code ─────────────────────────────────────────────────────────────

const CODE_PATTERNS: readonly (readonly [string, readonly RegExp[]])[] = [
  ['python', [/^\s*def \w+\(/, /^\s*import \w+/, /^\s*from \S+ import /, /^\s*class \w+[(:]/, /^\s*if __name__ == ['"]__main__/]],
  ['javascript', [/^\s*(?:export\s+)?(?:async\s+)?function \w+\(/, /^\s*(?:const|let|var) \w+ = (?:async )?\(?/, /^\s*import .+ from ['"]/, /^\s*export (?:default|const|function|class)/, /=>\s*\{/]],
  ['typescript', [/^\s*(?:export\s+)?(?:interface|type) \w+/, /^\s*(?:export\s+)?(?:async\s+)?function \w+\(/, /:\s*(?:string|number|boolean|void)\b/, /^\s*import .+ from ['"]/, /<\w+>\(/]],
  ['go', [/^func \w+\(/, /^import \(/, /^package \w+/, /^\t\w+ := /, /^var \w+ \w+/]],
  ['rust', [/^fn \w+\(/, /^use \w+::/, /^pub fn \w+\(/, /^\s*let mut \w+/, /impl \w+ \{/]],
  ['java', [/^\s*(?:public|private|protected)\s+\w+.*\{$/, /^\s*import [\w.]+;/, /^\s*package [\w.]+;/, /@\w+$/]],
  ['c', [/^#include\s*[<"]/, /^\w[\w\s*]*\([^;]*\)\s*\{$/, /^\s*printf\(/, /struct \w+ \{/]],
  ['shell', [/^#!\s*\/bin\/(ba)?sh/, /^\s*echo \$\{?\w/, /^\s*if \[ /, /^\s*for \w+ in /]],
]

function tryDetectCode(content: string): DetectionResult | undefined {
  const lines = content.split('\n').slice(0, 100)
  if (lines.length === 0) return undefined
  const languageScores = new Map<string, number>()
  for (const line of lines) {
    for (const [lang, patterns] of CODE_PATTERNS) {
      if (patterns.some(pattern => pattern.test(line))) {
        languageScores.set(lang, (languageScores.get(lang) ?? 0) + 1)
        break
      }
    }
  }
  if (languageScores.size === 0) return undefined
  let bestLang: string | undefined
  let bestScore = 0
  for (const [lang, score] of languageScores) {
    if (score > bestScore) {
      bestLang = lang
      bestScore = score
    }
  }
  if (bestLang === undefined || bestScore < 3) return undefined
  const nonEmpty = lines.filter(line => line.trim() !== '').length
  const ratio = bestScore / Math.max(nonEmpty, 1)
  const confidence = Math.min(1.0, 0.4 + ratio * 0.4 + bestScore * 0.02)
  return { contentType: 'code', confidence, metadata: { language: bestLang, pattern_matches: bestScore } }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Detect the content type with the original's priority chain: parse-confirmed
 * JSON first, then the distinctive shapes (diff/HTML), then the ambiguous
 * line-grammars (search/log), then tabular/config, then code, then plain text.
 */
export function detectContentType(content: string): DetectionResult {
  if (content.trim() === '') return { contentType: 'text', confidence: 0.0, metadata: {} }

  const json = tryDetectJson(content)
  if (json !== undefined) return json

  const diff = tryDetectDiff(content)
  if (diff !== undefined && diff.confidence >= 0.7) return diff

  const html = tryDetectHtml(content)
  if (html !== undefined && html.confidence >= 0.7) return html

  const search = tryDetectSearch(content)
  if (search !== undefined && search.confidence >= 0.6) return search

  const log = tryDetectLog(content)
  if (log !== undefined && log.confidence >= 0.5) return log

  const tabular = tryDetectTabular(content)
  if (tabular !== undefined && tabular.confidence >= 0.6) return tabular

  const config = tryDetectConfig(content)
  if (config !== undefined && config.confidence >= 0.6) return config

  const code = tryDetectCode(content)
  if (code !== undefined && code.confidence >= 0.5) return code

  return { contentType: 'text', confidence: 0.5, metadata: {} }
}

/** Re-export for callers that need the raw search-line test (bash search fold). */
export { isSearchResultLine }
