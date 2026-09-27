/**
 * The retrieval half of the vendored UI/UX catalog: BM25 over its own tables.
 *
 * Why this is a port rather than a reuse of `tool-search-rank.ts`
 * --------------------------------------------------------------
 * That module ranks a *tool catalog* and is tuned for that job: BM25F across a
 * name and a description, saturated term frequency, a description-length
 * normaliser. Every one of those exists to make short names and long prose
 * comparable inside one corpus of a few hundred rows. The catalog behind this file
 * is 79–192 rows per table scored by a published, unchanged formula
 * (k1 = 1.5, b = 0.75) whose *abstention floors were measured against that exact
 * scorer* — `catalog.ts` carries them. Dropping a different ranking function in
 * would leave every one of those numbers in place and would make all of them
 * meaningless, which is the same defect class as a ported constant whose meaning
 * did not travel with it.
 *
 * What is deliberately identical to upstream
 * ------------------------------------------
 * The token boundary (`\w`-equivalent letters/digits/underscore, whitespace split,
 * two-character minimum), the stopword list, the synonym normalisation applied
 * longest-first at word boundaries, the IDF formula, the score formula, the
 * stable tie order, and the coordinate-descent-free, index-ordered vocabulary
 * that the suggestion pass walks.
 *
 * What is deliberately different, and why
 * ---------------------------------------
 * - **Suggestions use a real Ratcliff–Obershelp ratio.** Upstream calls Python's
 *   `difflib.SequenceMatcher.ratio()`, and its 0.72 floor is a number about *that*
 *   function. A cheaper similarity (Dice over bigrams, Levenshtein distance under
 *   a renamed constant) would be a different number against the same threshold, so
 *   this file reimplements the same recursion — longest matching block, then the
 *   same recursion on each side — and documents the tie rule it inherited.
 * - **Length is counted in code points.** Python's `len()` counts characters where
 *   `.length` counts UTF-16 units, so a surrogate pair would be one character
 *   upstream and two here, and a one-character query token would slip past the
 *   minimum. The count is taken with `Array.from`.
 * - **A missing domain table is a refusal, not an empty answer.** Upstream returns
 *   an empty result set when its data file is absent, which reads to a caller
 *   exactly like "the catalog has nothing for you". Nothing that reaches the model
 *   may make those two states the same one.
 *
 * @module uiux/bm25
 */

/** Words that add no search signal. Domain-relevant short tokens (`ui`, `ux`, `3d`) stay searchable. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'to', 'in', 'on', 'at', 'is', 'of', 'by', 'or', 'an', 'if', 'no', 'so',
  'do', 'be', 'we', 'it', 'as', 'the', 'and', 'for', 'are', 'was',
])

/**
 * Spelling variants folded onto one canonical form before tokenizing.
 *
 * Upstream keeps this a plain map with no fuzzy matching, and the port keeps that:
 * a synonym table is a decision someone made, while a stemmer is a decision nobody
 * can enumerate. `q&a` is present because the boundary split would otherwise turn
 * it into the two tokens `q` and `a`, which are below the length floor.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  'q&a': 'question answer',
  'e-commerce': 'ecommerce',
  'dark-mode': 'dark',
  'darkmode': 'dark',
  'light-mode': 'light',
  'lightmode': 'light',
  a11y: 'accessibility',
  nav: 'navigation',
  'sign-up': 'signup',
  'log-in': 'login',
  colour: 'color',
  colours: 'colors',
  customisation: 'customization',
  organisation: 'organization',
  behaviour: 'behavior',
  'ux/ui': 'ux ui',
}

/** Similarity at or above which a known term may be offered as a replacement. */
export const SUGGESTION_SIMILARITY_FLOOR = 0.72

/** Characters that end a token: anything that is not a letter, a digit, an underscore, or whitespace. */
const NON_TOKEN = /[^\p{L}\p{N}_\s]/gu

/**
 * The synonym patterns, longest variant first.
 *
 * Order is the substance rather than tidiness: `dark-mode` has to be rewritten
 * before `darkmode` is tried against text that already became `dark mode`, and
 * Python's `sorted(..., key=len, reverse=True)` is what upstream relies on for the
 * same reason.
 */
const SYNONYM_PATTERNS: readonly { readonly pattern: RegExp; readonly canonical: string }[] =
  Object.entries(SYNONYMS)
    .sort((left, right) => right[0].length - left[0].length)
    .map(([variant, canonical]) => ({
      pattern: new RegExp(`(?<!\\w)${escapeForPattern(variant)}(?!\\w)`, 'giu'),
      canonical,
    }))

/** A fitted BM25 index over one domain table's searchable text. */
export interface Bm25Index {
  /** Number of documents in the corpus. */
  readonly documentCount: number
  /** Mean document length in tokens, or 1 when the corpus is empty. */
  readonly averageLength: number
  /** Every indexed term, in first-seen order — the order the suggestion pass walks. */
  readonly vocabulary: readonly string[]
  /** Number of documents containing a term, for the suggestion pass's tie-break. */
  readonly documentFrequency: (term: string) => number
  /** Documents ranked by score, highest first, with corpus order kept for ties. */
  readonly score: (query: string) => readonly RankedDocument[]
}

/** One document's place in a ranked result. */
export interface RankedDocument {
  /** Index into the document array the index was fitted over. */
  readonly document: number
  /** BM25 score, comparable only against the floors measured for this scorer. */
  readonly score: number
}

/** BM25's term-frequency saturation and length-normalisation weights. */
export interface Bm25Weights {
  /** Term-frequency saturation. 1.5 is upstream's published value. */
  readonly k1?: number
  /** Length normalisation. 0.75 is upstream's published value. */
  readonly b?: number
}

/** Escape a literal so it can be embedded in a pattern. @param text - the literal. @returns the escaped literal. */
function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Fold known spelling variants onto their canonical spelling.
 *
 * Substitution is boundary-anchored and case-insensitive, so `nav` inside
 * `navigation` is left alone while `nav` standing on its own is rewritten.
 *
 * @param text - the text to normalise.
 * @returns the text with every known variant replaced.
 */
export function normalizeQuery(text: string): string {
  let normalized = text
  for (const { pattern, canonical } of SYNONYM_PATTERNS) normalized = normalized.replace(pattern, canonical)
  return normalized
}

/**
 * Split text into indexed tokens.
 *
 * The two-character floor is what makes the stopword list's size matter rather than
 * its contents: a word shorter than two characters is dropped whatever it says, so
 * only domain-bearing short tokens need naming.
 *
 * @param text - the text to tokenize.
 * @returns the tokens, lowercased, with synonyms folded and stopwords removed.
 */
export function tokenize(text: string): readonly string[] {
  const normalized = normalizeQuery(text.toLowerCase()).replace(NON_TOKEN, ' ')
  return normalized
    .split(/\s+/u)
    .filter(word => word !== '')
    .filter(word => Array.from(word).length >= 2 && !STOPWORDS.has(word))
}

/**
 * Fit an index over documents.
 *
 * An empty corpus is a fit, not an error: `documentCount` is 0, `averageLength` is
 * 1, and every score is 0. The caller's abstention floor is what turns that into a
 * refusal, and it is the only place that decision belongs.
 *
 * @param documents - the searchable text of each row, in table order.
 * @param weights - term-frequency and length weights; upstream's defaults apply.
 * @returns the fitted index.
 */
export function fitBm25(documents: readonly string[], weights: Bm25Weights = {}): Bm25Index {
  const k1 = weights.k1 ?? 1.5
  const b = weights.b ?? 0.75
  const corpus = documents.map(document => tokenize(document))
  const documentCount = corpus.length
  const lengths = corpus.map(tokens => tokens.length)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const averageLength = documentCount === 0 ? 1 : total / documentCount || 1

  const termFrequencies = corpus.map((tokens) => {
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return frequencies
  })
  // Insertion order is the vocabulary order, and it is load-bearing: upstream walks
  // `idf.keys()` when it offers replacement terms, and Python's dict keeps the
  // order keys were first seen in. A Set built the same way reproduces it.
  const documentFrequencies = new Map<string, number>()
  for (const frequencies of termFrequencies) {
    for (const term of frequencies.keys()) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1)
  }
  const idf = new Map<string, number>()
  for (const [term, frequency] of documentFrequencies) {
    idf.set(term, Math.log((documentCount - frequency + 0.5) / (frequency + 0.5) + 1))
  }

  return {
    documentCount,
    averageLength,
    vocabulary: [...idf.keys()],
    documentFrequency: term => documentFrequencies.get(term) ?? 0,
    score: (query) => {
      const queryTokens = tokenize(query)
      const ranked: RankedDocument[] = []
      for (const [document, frequencies] of termFrequencies.entries()) {
        let score = 0
        const length = lengths[document] ?? 0
        for (const token of queryTokens) {
          const termIdf = idf.get(token)
          // A token no document carries contributes nothing, which is what makes a
          // query of entirely unknown words score zero rather than score *unusually*.
          if (termIdf === undefined) continue
          const frequency = frequencies.get(token) ?? 0
          const numerator = frequency * (k1 + 1)
          const denominator = frequency + k1 * (1 - b + (b * length) / averageLength)
          score += (termIdf * numerator) / denominator
        }
        ranked.push({ document, score })
      }
      // Sorting is stable in both languages, so equal scores keep corpus order.
      // That is the tie rule the upstream floors were calibrated against; a port
      // that broke it would change which row wins on the exact queries the floors
      // were tuned on.
      return ranked.sort((left, right) => right.score - left.score)
    },
  }
}

/**
 * The share of a query's tokens the corpus has ever seen.
 *
 * This is the half of abstention that scores cannot express: a query made of words
 * nobody wrote produces scores near zero and would be caught by a floor, while a
 * query whose words nearly all exist can still land on a bad row, and upstream
 * requires a *minimum* share before it will answer at all.
 *
 * @param index - the fitted index.
 * @param query - the query text.
 * @returns the fraction of distinct query tokens present in the vocabulary, or 0 when the query has none.
 */
export function queryCoverage(index: Bm25Index, query: string): number {
  const tokens = new Set(tokenize(query))
  if (tokens.size === 0) return 0
  const vocabulary = new Set(index.vocabulary)
  let present = 0
  for (const token of tokens) if (vocabulary.has(token)) present += 1
  return present / tokens.size
}

/**
 * The longest matching block of two strings within a range, with Python's tie rule.
 *
 * Ties go to the earliest position in the first string and then the earliest in the
 * second, which is what `difflib` does: it walks the first string ascending and
 * replaces the best match only on a strictly longer block.
 *
 * @param first - the first string.
 * @param second - the second string.
 * @param firstLow - range start in the first string.
 * @param firstHigh - range end in the first string.
 * @param secondLow - range start in the second string.
 * @param secondHigh - range end in the second string.
 * @returns the block's position in each string and its length.
 */
function longestMatch(
  first: string,
  second: string,
  firstLow: number,
  firstHigh: number,
  secondLow: number,
  secondHigh: number,
): { readonly inFirst: number; readonly inSecond: number; readonly size: number } {
  let bestFirst = firstLow
  let bestSecond = secondLow
  let bestSize = 0
  let previous = new Map<number, number>()
  for (let i = firstLow; i < firstHigh; i += 1) {
    const current = new Map<number, number>()
    for (let j = secondLow; j < secondHigh; j += 1) {
      if (first[i] !== second[j]) continue
      const run = (previous.get(j - 1) ?? 0) + 1
      current.set(j, run)
      if (run > bestSize) {
        bestFirst = i - run + 1
        bestSecond = j - run + 1
        bestSize = run
      }
    }
    previous = current
  }
  return { inFirst: bestFirst, inSecond: bestSecond, size: bestSize }
}

/**
 * How similar two strings are, on the same scale as Python's `SequenceMatcher.ratio()`.
 *
 * The ratio is `2M / T` over the recursion's matched characters, and the recursion
 * is the Ratcliff–Obershelp one: take the longest matching block, then recurse on
 * what is left to either side of it. Matching blocks are disjoint by construction,
 * so the sum does not depend on the order the ranges are visited in.
 *
 * @param first - the first string.
 * @param second - the second string.
 * @returns a ratio from 0 to 1; two empty strings are identical, as upstream decides.
 */
export function similarityRatio(first: string, second: string): number {
  let matched = 0
  const pending: { readonly firstLow: number; readonly firstHigh: number; readonly secondLow: number; readonly secondHigh: number }[] = [
    { firstLow: 0, firstHigh: first.length, secondLow: 0, secondHigh: second.length },
  ]
  while (pending.length > 0) {
    const range = pending.pop()
    if (range === undefined) break
    const block = longestMatch(first, second, range.firstLow, range.firstHigh, range.secondLow, range.secondHigh)
    if (block.size === 0) continue
    matched += block.size
    if (range.firstLow < block.inFirst && range.secondLow < block.inSecond) {
      pending.push({ firstLow: range.firstLow, firstHigh: block.inFirst, secondLow: range.secondLow, secondHigh: block.inSecond })
    }
    const firstAfter = block.inFirst + block.size
    const secondAfter = block.inSecond + block.size
    if (firstAfter < range.firstHigh && secondAfter < range.secondHigh) {
      pending.push({ firstLow: firstAfter, firstHigh: range.firstHigh, secondLow: secondAfter, secondHigh: range.secondHigh })
    }
  }
  const total = first.length + second.length
  return total === 0 ? 1 : (2 * matched) / total
}

/**
 * Known terms close enough to the query to be worth retrying with.
 *
 * A zero-result search that says only "nothing matched" costs the caller another
 * full round trip to guess; naming the nearest terms turns the refusal into the
 * next attempt. Only terms already in the vocabulary can come back — a suggestion
 * that does not exist would be worse than none — and a suggestion has to clear the
 * same abstention floor the search does, so the offered retry can actually answer.
 *
 * @param index - the fitted index.
 * @param query - the query that found nothing.
 * @param options - how many terms to offer, and the floor a candidate's own search must clear.
 * @returns the replacement terms, most similar first.
 */
export function suggestTerms(
  index: Bm25Index,
  query: string,
  options: {
    readonly limit?: number
    /** A term is only offered when searching for it would clear this predicate. */
    readonly accepts?: (term: string) => boolean
  } = {},
): readonly string[] {
  const limit = options.limit ?? 6
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return []
  const candidates: { readonly similarity: number; readonly frequency: number; readonly term: string }[] = []
  for (const term of index.vocabulary) {
    if (queryTokens.includes(term)) continue
    const similarity = Math.max(...queryTokens.map(token => similarityRatio(token, term)))
    if (similarity < SUGGESTION_SIMILARITY_FLOOR) continue
    if (options.accepts !== undefined && !options.accepts(term)) continue
    candidates.push({ similarity, frequency: index.documentFrequency(term), term })
  }
  // Similarity first, then the more-used term, then the earlier code-point order —
  // the last one because Python compares strings by code point and a locale-aware
  // comparison here would reorder the same three candidates differently.
  candidates.sort((left, right) =>
    right.similarity - left.similarity
    || right.frequency - left.frequency
    || (left.term < right.term ? -1 : left.term > right.term ? 1 : 0))
  return candidates.slice(0, limit).map(candidate => candidate.term)
}
