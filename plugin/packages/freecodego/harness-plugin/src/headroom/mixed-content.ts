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

export type SectionType = 'code' | 'json' | 'search' | 'text'

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

export function mixedContentIndicators(content: string): Readonly<Record<string, boolean>> {
  const hasCodeFences = /^```(\w*)\s*$/m.test(content)
  const hasJsonBlocks = /^\s*[[{]/m.test(content)
  const hasSearchResults = /^\S+:\d+:/m.test(content)
  const hasProse = (content.match(PROSE_RE) ?? []).length > 5
  return { hasCodeFences, hasJsonBlocks, hasSearchResults, hasProse }
}

/** Two or more distinct content signals → split before compressing. */
export function isMixedContent(content: string): boolean {
  const indicators = mixedContentIndicators(content)
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
 */
export function splitIntoSections(content: string, isolate: readonly string[] = []): readonly ContentSection[] {
  const sections: ContentSection[] = []
  const lines = content.split('\n')
  const carriesIsolate = (text: string): boolean => isolate.some(marker => text.includes(marker))

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    if (isolate.length > 0 && carriesIsolate(line)) {
      sections.push({ content: line, contentType: 'text', atomic: true })
      i += 1
      continue
    }

    const fence = CODE_FENCE_RE.exec(line)
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
      while (i < lines.length && !lines[i]!.startsWith('```')) {
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

    if (JSON_BLOCK_START_RE.test(line)) {
      const extracted = extractJsonBlock(lines, i)
      if (extracted !== undefined) {
        const [jsonContent, endLine] = extracted
        let validJson = false
        try {
          JSON.parse(jsonContent)
          validJson = true
        } catch {
          validJson = false
        }
        sections.push({ content: jsonContent, contentType: validJson ? 'json' : 'text', atomic: !validJson })
        i = endLine + 1
        continue
      }
    }

    if (SEARCH_RESULT_RE.test(line)) {
      const searchLines: string[] = []
      while (i < lines.length && SEARCH_RESULT_RE.test(lines[i]!)) {
        searchLines.push(lines[i]!)
        i += 1
      }
      sections.push({ content: searchLines.join('\n'), contentType: 'search', atomic: false })
      continue
    }

    const textLines = [line]
    i += 1
    while (i < lines.length) {
      const nextLine = lines[i]!
      if (CODE_FENCE_RE.test(nextLine) || JSON_BLOCK_START_RE.test(nextLine) || SEARCH_RESULT_RE.test(nextLine) || (isolate.length > 0 && carriesIsolate(nextLine))) break
      textLines.push(nextLine)
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
 */
export function mixedIsActuallyCode(content: string): boolean {
  const detection = detectContentType(content)
  return detection.contentType === 'code' && detection.confidence >= 0.8
}
