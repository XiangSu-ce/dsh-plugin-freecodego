/**
 * Mixed-content splitting — TypeScript port of Headroom's
 * `headroom/transforms/mixed_content.py` (`is_mixed_content`,
 * `mixed_content_indicators`, `split_into_sections`), © Headroom
 * Maintainers, Apache-2.0.
 *
 * Tool output that interleaves code fences, JSON blocks, grep rows, and
 * prose gets split into typed sections so each one is routed to its own
 * compressor — a JSON array inside a log no longer has to share one fate
 * with the prose around it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/mixed-content
 */

import { detectContentType } from './content-detector.ts'
// "What the terminal renders" is one definition for the whole subsystem, and
// every test in this module is a `^`-anchored line test — see the note on
// `isMixedContent`.
import { stripAnsi } from './lossless-compaction.ts'

/** Content family of one section of a mixed payload. */
export type SectionType = 'code' | 'json' | 'search' | 'text'

/**
 * One section of a split payload: its bytes, its content type, an optional
 * language hint, and whether it must survive as an indivisible unit.
 */
export interface ContentSection {
  readonly content: string
  readonly contentType: SectionType
  readonly language?: string
  readonly atomic: boolean
}

const CODE_FENCE_RE = /^```(\w*)\s*$/
const JSON_BLOCK_START_RE = /^\s*[[{]/
const SEARCH_RESULT_RE = /^\S+:\d+:/
const PROSE_RE = /[A-Z][a-z]+\s+\w+\s+\w+/g

/**
 * The colour-blind reading of a payload, line by line.
 *
 * Every test in this module is a `^`-anchored line test — a fence opens with
 * ```, a JSON block starts with `{`/`[`, a search row is `path:line:` — and a
 * coloured line starts with `\x1b[32m`, so SGR escapes silently defeated all of
 * them at once. Measured on a fixture of prose + a fenced command + a JSON block +
 * prose: `isMixedContent` is `true` and `splitIntoSections` yields
 * `text code json text` on the plain bytes, and `false` with a single `text`
 * section once every line is painted — the payload loses the whole section chain,
 * so the JSON block and the fenced command are handed to the prose crusher as one
 * run of lines instead of to their own compressors. Colour is decoration, and no
 * decision here is allowed to depend on it.
 * @param content - the content to read.
 * @returns the visible lines, one per input line.
 */
function visibleLines(content: string): readonly string[] {
  return content.split('\n').map(line => stripAnsi(line))
}

/**
 * The content signals, read from the rendered text rather than the raw bytes.
 * @param raw - the content to inspect.
 * @returns which signals are present.
 */
export function mixedContentIndicators(raw: string): Readonly<Record<string, boolean>> {
  const visible = stripAnsi(raw)
  const hasCodeFences = /^```(\w*)\s*$/m.test(visible)
  const hasJsonBlocks = /^\s*[[{]/m.test(visible)
  const hasSearchResults = /^\S+:\d+:/m.test(visible)
  const hasProse = (visible.match(PROSE_RE) ?? []).length > 5
  return { hasCodeFences, hasJsonBlocks, hasSearchResults, hasProse }
}

/**
 * Two or more distinct content signals → split before compressing.
 * @param raw - the content to send.
 * @returns true when the payload mixes content families.
 */
export function isMixedContent(raw: string): boolean {
  const indicators = mixedContentIndicators(raw)
  return Object.values(indicators).filter(value => value).length >= 2
}

/** Find the balanced JSON block starting at line `start`; returns [content, endLineIndex]. */
function extractJsonBlock(lines: readonly string[], start: number): readonly [string, number] | undefined {
  const first = lines[start]
  if (first === undefined) return undefined
  const openChar = first.trim().startsWith('{') ? '{' : '['
  const closeChar = openChar === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === openChar) depth += 1
      else if (ch === closeChar) {
        depth -= 1
        if (depth === 0) return [lines.slice(start, i + 1).join('\n'), i]
      }
    }
    // Multi-line strings (JSON cannot span raw newlines in strings) are
    // impossible in valid JSON, so the line loop is safe.
    if (i > start + 5_000) return undefined
  }
  return undefined
}

/**
 * Parse mixed content into typed sections: code fences, validated JSON
 * blocks, search rows, and plain-text runs. Bracket-balanced-but-invalid
 * JSON (a prose banner like "[harness: ...]") keeps its own atomic section
 * so it meets the text compressors' size floors on its own.
 * @param content - the content to send.
 * @param isolate - substrings that must stay in their own section.
 * @returns the content sections, in payload order.
 */
export function splitIntoSections(content: string, isolate: readonly string[] = []): readonly ContentSection[] {
  const sections: ContentSection[] = []
  const lines = content.split('\n')
  // Every branch below is a decision, so every branch reads the rendered line:
  // the section it produces still carries the payload's own bytes, which keeps the
  // stronger contract this module has — the sections are the partition a splice
  // rebuilds from, and no line (or escape) is dropped by the act of splitting.
  const visible = visibleLines(content)
  const shown = (index: number): string => visible[index] ?? ''
  const carriesIsolate = (text: string): boolean => isolate.some(marker => text.includes(marker))
  const isIsolated = (index: number): boolean => isolate.length > 0 && carriesIsolate(shown(index))
  const isFence = (index: number): boolean => CODE_FENCE_RE.test(shown(index))
  const isFenceLine = (index: number): boolean => shown(index).startsWith('```')
  const isSearchRow = (index: number): boolean => SEARCH_RESULT_RE.test(shown(index))
  const isJsonStart = (index: number): boolean => JSON_BLOCK_START_RE.test(shown(index))

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    if (isIsolated(i)) {
      sections.push({ content: line, contentType: 'text', atomic: true })
      i += 1
      continue
    }

    const fence = isFence(i) ? CODE_FENCE_RE.exec(shown(i)) : null
    if (fence !== null) {
      const language = fence[1] ?? 'unknown'
      // The delimiters belong to the section, because the sections are the
      // partition a splice rebuilds from. Dropping them meant the adopted
      // rendering replaced fenced code with bare lines and never said so --
      // a rewrite of the model's context that nothing announced. An
      // unterminated fence has no closing line; the loop already stopped at
      // EOF for it.
      const codeLines: string[] = [line]
      i += 1
      while (i < lines.length && !isFenceLine(i)) {
        codeLines.push(lines[i]!)
        i += 1
      }
      if (i < lines.length) {
        codeLines.push(lines[i]!)
        i += 1
      }
      sections.push({ content: codeLines.join('\n'), contentType: 'code', language, atomic: false })
      continue
    }

    if (isJsonStart(i)) {
      // Balanced over the *rendered* lines, which is what the fence and the JSON
      // start were read from, and validated there too: a coloured JSON block whose
      // visible text parses is JSON. Its content stays the raw slice — a parse
      // proves the visible text is a document, it does not license dropping the
      // payload's bytes into the model's context without a marker, and the section
      // is a slice of the partition. The consequence is measured and asserted in
      // `headroom-detection-rendering.spec.ts`: such a section is typed `json` and
      // its crusher then refuses the escaped text, so it ships unchanged, which is
      // a missed saving rather than a wrong rendering.
      const extracted = extractJsonBlock(visible, i)
      if (extracted !== undefined) {
        const [renderedJson, endLine] = extracted
        let validJson = false
        try {
          JSON.parse(renderedJson)
          validJson = true
        } catch {
          validJson = false
        }
        sections.push({ content: lines.slice(i, endLine + 1).join('\n'), contentType: validJson ? 'json' : 'text', atomic: !validJson })
        i = endLine + 1
        continue
      }
    }

    if (isSearchRow(i)) {
      const searchLines: string[] = []
      while (i < lines.length && isSearchRow(i)) {
        searchLines.push(lines[i]!)
        i += 1
      }
      sections.push({ content: searchLines.join('\n'), contentType: 'search', atomic: false })
      continue
    }

    const textLines = [line]
    i += 1
    while (i < lines.length) {
      if (isFence(i) || isJsonStart(i) || isSearchRow(i) || isIsolated(i)) break
      textLines.push(lines[i]!)
      i += 1
    }
    const textContent = textLines.join('\n')
    // Kept even when it is only blank lines: the partition has to account for
    // every line, or the splice loses the ones no section claims.
    sections.push({ content: textContent, contentType: 'text', atomic: textContent.trim() === '' })
  }
  return sections
}

/**
 * Source-code false-positive guard (original `_determine_strategy`): the
 * cheap regex heuristics misclassify pure source with dict/list literals as
 * mixed. When the detectors confidently say code, trust that over MIXED.
 * @param content - the content to send.
 * @returns true when the payload is confidently source code.
 */
export function mixedIsActuallyCode(content: string): boolean {
  const detection = detectContentType(content)
  return detection.contentType === 'code' && detection.confidence >= 0.8
}
