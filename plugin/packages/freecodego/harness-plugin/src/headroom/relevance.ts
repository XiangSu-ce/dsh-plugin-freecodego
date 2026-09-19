/**
 * BM25 relevance scoring — TypeScript port of Headroom's
 * `headroom/relevance/bm25.py` (BM25Scorer) plus the no-embedding boost
 * rules of `headroom/relevance/hybrid.py`, © Headroom Maintainers,
 * Apache-2.0.
 *
 * Scores records of a tool output against the request's information need
 * (the triggering tool call's name + arguments) so the compression pipeline
 * can keep the high-relevance records verbatim and compress only the
 * low-value tail. UUID/4+-digit numeric tokens are preserved as single
 * terms (they are the tokens a follow-up query actually targets).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/relevance
 */

// UUIDs, 4+-digit numeric IDs, then alphanumeric words (original _TOKEN_PATTERN).
const TOKEN_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b\d{4,}\b|[a-zA-Z0-9_]+/gu

const K1 = 1.5
const B = 0.75
/** Raw-score normalization ceiling (original max_score). */
const MAX_SCORE = 10.0
/** Long exact matches (UUIDs, long IDs) earn this bonus (original). */
const LONG_MATCH_BONUS = 0.3
/** BM25-only fallback floor for any matched item (original hybrid boost). */
const MATCH_FLOOR = 0.3
/** Additional boost when ≥2 distinct query terms match (original hybrid boost). */
const MULTI_MATCH_BONUS = 0.2

export interface RelevanceScore {
  readonly score: number
  readonly matchedTerms: readonly string[]
}

function tokenize(text: string): readonly string[] {
  if (text === '') return []
  return text.toLowerCase().match(TOKEN_RE) ?? []
}

/** Floored Lucene-style IDF: log((N - n + 0.5) / (n + 0.5) + 1). */
function computeIdf(docCount: number, docFreq: number): number {
  if (docFreq <= 0) return 0
  return Math.log((docCount - docFreq + 0.5) / (docFreq + 0.5) + 1.0)
}

function bm25Score(
  docTokens: readonly string[],
  queryTokens: readonly string[],
  avgDocLen: number | undefined,
  idfMap: ReadonlyMap<string, number> | undefined,
): { raw: number; matched: string[] } {
  if (docTokens.length === 0) return { raw: 0, matched: [] }
  const termFreqs = new Map<string, number>()
  for (const token of docTokens) termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1)

  const avgdl = avgDocLen ?? docTokens.length
  let raw = 0
  const matched: string[] = []
  const seen = new Set<string>()
  for (const queryToken of queryTokens) {
    if (seen.has(queryToken)) continue
    seen.add(queryToken)
    const freq = termFreqs.get(queryToken)
    if (freq === undefined) continue
    matched.push(queryToken)
    const idf = idfMap?.get(queryToken) ?? Math.log(2.0)
    const numerator = freq * (K1 + 1)
    const denominator = freq + K1 * (1 - B + B * docTokens.length / avgdl)
    raw += idf * (numerator / denominator)
  }
  return { raw, matched }
}

/**
 * Batch-score records against a query. The batch is treated as a corpus:
 * per-query-term IDF is computed from document frequencies across the batch
 * (rare discriminative tokens — IDs, UUIDs — outrank common ones), exactly
 * like the original `score_batch`.
 */
export function scoreBatch(items: readonly string[], context: string): readonly RelevanceScore[] {
  const queryTokens = tokenize(context)
  if (queryTokens.length === 0) {
    return items.map(() => ({ score: 0, matchedTerms: [] }))
  }
  const allTokens = items.map(item => tokenize(item))
  const avgLen = allTokens.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(items.length, 1)

  const nDocs = allTokens.length
  const docFreq = new Map<string, number>()
  for (const tokens of allTokens) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }
  const idfMap = new Map<string, number>()
  for (const term of new Set(queryTokens)) {
    const freq = docFreq.get(term)
    if (freq !== undefined) idfMap.set(term, computeIdf(nDocs, freq))
  }

  return allTokens.map((tokens) => {
    const { raw, matched } = bm25Score(tokens, queryTokens, avgLen, idfMap)
    let score = Math.min(1.0, raw / MAX_SCORE)
    // Long exact matches (UUIDs, long IDs) are high-value hits.
    if (matched.some(term => term.length >= 8)) score = Math.min(1.0, score + LONG_MATCH_BONUS)
    // Original hybrid fallback boost (no embedding tier in the port).
    if (matched.length > 0) score = Math.max(score, MATCH_FLOOR)
    if (matched.length >= 2) score = Math.min(1.0, score + MULTI_MATCH_BONUS)
    return { score, matchedTerms: matched.slice(0, 10) }
  })
}

/** Words from the query used for the search compressor's context scoring. */
export function contextWords(query: string): readonly string[] {
  const seen = new Set<string>()
  const words: string[] = []
  for (const token of tokenize(query)) {
    if (token.length < 3 || seen.has(token)) continue
    seen.add(token)
    words.push(token)
  }
  return words.slice(0, 24)
}
