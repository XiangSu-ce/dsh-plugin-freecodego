/**
 * Prose text crusher — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/text_crusher/`, © Headroom
 * Maintainers, Apache-2.0.
 *
 * Extractive sentence selection for long prose tool output (READMEs, error
 * reports, generated documentation): sentences are scored on recency,
 * salience (digits, failure vocabulary, ALL-CAPS, dotted identifiers), and
 * short-sentence preference, then selected in descending score order until
 * the character budget is spent and re-ordered to the original sequence.
 * Every sentence is emitted verbatim — zero rewriting, zero merging.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/text-crusher
 */

import type { CcrStore } from './ccr.ts'
import { computeKey } from './ccr.ts'
import { scoreBatch } from './relevance.ts'

export interface TextCrusherConfig {
  /** Minimum characters before compression is attempted. */
  minBytes: number
  /** Target output as a fraction of the input. */
  targetRatio: number
  /** Weight of a sentence's recency (position) in its score. */
  wRecency: number
  /** Weight of salience features. */
  wSalience: number
  /** Weight of short-sentence preference. */
  wShort: number
  /** Weight of query relevance (BM25 term overlap). */
  wRelevance: number
  /** Accept only when the rendering is below this ratio of the original. */
  maxRatio: number
}

export const TEXT_CRUSHER_DEFAULTS: TextCrusherConfig = {
  minBytes: 4_096,
  targetRatio: 0.5,
  wRecency: 1.0,
  wSalience: 1.0,
  wShort: 0.25,
  wRelevance: 1.5,
  maxRatio: 0.8,
}

/** ASCII+CJK sentence splitting: newline, terminal punctuation, then whitespace. */
function splitSentences(text: string): readonly string[] {
  const sentences: string[] = []
  let current = ''
  for (const ch of text) {
    current += ch
    if (ch === '\n' || ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？') {
      sentences.push(current)
      current = ''
    }
  }
  if (current !== '') sentences.push(current)
  return sentences
}

/** Salience: failure vocabulary outweighs digits, ALL-CAPS, dotted identifiers. */
function salienceScore(sentence: string): number {
  const trimmed = sentence.trim()
  if (trimmed === '') return 0
  const words = trimmed.split(/\s+/u).filter(Boolean)
  if (words.length === 0) return 0
  let salient = 0
  for (const word of words) {
    if (/\b(?:error|fail(?:ed|ure)?|fatal|crash|critical|deprecated|todo|fixme|note|important|warning|must|never|always)\b/i.test(word)) salient += 3
    else if (/\d/u.test(word)) salient += 1
    else if (word.length > 2 && word === word.toUpperCase() && /[A-Z]/u.test(word)) salient += 1
    else if (/^[a-z][\w.]*\.[\w.]+$/iu.test(word)) salient += 1
  }
  return salient / words.length
}

export interface TextCrushResult {
  readonly compressed: string
  readonly applied: boolean
  readonly cacheKey: string | undefined
}

/**
 * Extractively compress long prose: score sentences (recency + salience +
 * query relevance + brevity), take the top ones within the character budget,
 * and emit them in original order with a CCR marker for the full text.
 */
export function crushText(text: string, cfg: TextCrusherConfig, store: CcrStore | undefined, query = ''): TextCrushResult {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes < cfg.minBytes) return { compressed: text, applied: false, cacheKey: undefined }

  const sentences = splitSentences(text)
  if (sentences.length < 3) return { compressed: text, applied: false, cacheKey: undefined }

  // Query-relevance per sentence (original w_relevance; term-overlap proxy
  // for the shared BM25 scorer).
  const queryTerms = query.toLowerCase().match(/[a-z0-9_]{3,}/gu) ?? []
  const relevanceScores = queryTerms.length > 0
    ? scoreBatch(sentences, query)
    : undefined

  const budget = Math.floor(originalBytes * cfg.targetRatio)
  const scored = sentences.map((sentence, index) => {
    const recency = (index + 1) / sentences.length
    const salience = salienceScore(sentence)
    const chars = Array.from(sentence).length
    const short = chars <= 120 ? 1 : 0
    const relevance = relevanceScores?.[index]?.score ?? 0
    const score = cfg.wRecency * recency + cfg.wSalience * salience + cfg.wShort * short + cfg.wRelevance * relevance
    return { sentence, index, score, bytes: Buffer.byteLength(sentence, 'utf8') }
  })

  // Near-duplicate suppression: skip a candidate that shares its 3-gram
  // signature with an already-selected sentence.
  const shingle = (sentence: string): string => {
    const words = sentence.toLowerCase().split(/\s+/u).filter(Boolean)
    return words.slice(0, 8).join('\u0000')
  }
  const selected = new Set<number>()
  const seenShingles = new Set<string>()
  let used = 0
  for (const candidate of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (used + candidate.bytes > budget) continue
    const signature = shingle(candidate.sentence)
    if (seenShingles.has(signature)) continue
    selected.add(candidate.index)
    seenShingles.add(signature)
    used += candidate.bytes
  }
  if (selected.size === 0) return { compressed: text, applied: false, cacheKey: undefined }

  const compressedBody = scored.filter(item => selected.has(item.index)).map(item => item.sentence).join('')
  let cacheKey: string | undefined
  let compressed = compressedBody
  if (Buffer.byteLength(compressedBody, 'utf8') / originalBytes < cfg.maxRatio && store !== undefined) {
    cacheKey = computeKey(text)
    store.put(cacheKey, text)
    compressed = `${compressedBody}\n[Prose compressed from ${originalBytes} bytes. Retrieve full text: hash=${cacheKey}]`
  }
  const applied = Buffer.byteLength(compressed, 'utf8') / originalBytes < cfg.maxRatio
  return { compressed: applied ? compressed : text, applied, cacheKey }
}
