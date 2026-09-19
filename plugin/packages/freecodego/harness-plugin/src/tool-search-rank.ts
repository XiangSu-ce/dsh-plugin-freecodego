/**
 * Ranking for `tool_search`.
 *
 * Why not substring counting
 * --------------------------
 * The first implementation scored a candidate by where a term appeared: a name
 * hit was worth 10, a description hit 1. That is cheap and it has three failures
 * a catalog of a few hundred tools makes visible:
 *
 * - **No rarity.** "use" appears in most descriptions and "checkpoint" in one, and
 *   both counted the same. A query of mostly stopword-ish terms therefore ranked
 *   by how many words a tool's description happened to contain.
 * - **No length normalization.** A one-line description and a 40-line one got the
 *   same credit per hit, so the longer a tool's prose, the more likely it was to
 *   out-rank the tool that is actually named after the thing.
 * - **No saturation.** Ten mentions scored ten times one, so a description that
 *   repeated a word could outbid a name match.
 *
 * What replaces it
 * ----------------
 * BM25F over two fields — name and description — with the standard saturation
 * (`k1 = 1.2`) and length normalization (`b = 0.75`), inverse document frequency
 * computed over the catalog being searched, and a name weight of 3. IDF is the
 * part that matters most here and it is only computable because the corpus is
 * small and in hand: the catalog *is* the document set, so "how rare is this term
 * among the tools I could actually load" is a real, current answer rather than a
 * guess from a static model.
 *
 * A prefix is a partial hit, either way round
 * ------------------------------------------
 * Tokens are whole words, so `checkpoint` does not match `checkpoints` on its
 * own. A query term of three or more characters counts at
 * {@link PREFIX_DISCOUNT} of a whole one when it prefixes a token — which keeps
 * `check` finding `engineering_checkpoint_restore` — and the same discount
 * applies when a token prefixes the term, which is what makes the plural
 * `checkpoints` find the same tool. Both are partial hits, neither outranks the
 * word it matches, and only one of the two directions is ever counted for a
 * given field and term.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tool-search-rank
 */

/** The part of a tool a ranker sees. */
export interface RankableTool {
  readonly name: string
  readonly description?: string
}

/** One tool and the score that placed it, for tests and diagnostics. */
export interface RankedTool<T extends RankableTool> {
  readonly tool: T
  readonly score: number
}

/**
 * How much a name hit is worth against a description hit.
 *
 * Higher than the old 10:1 because the fields are now separate for scoring, and
 * because a tool that is *named* after a query term is the answer far more often
 * than a tool that mentions it.
 */
const NAME_WEIGHT = 3

/** Term-frequency saturation. The textbook value, and it behaves here. */
const K1 = 1.2

/** Length normalization. Also the textbook value. */
const B = 0.75

/** What a term that only prefixes a token counts as. */
const PREFIX_DISCOUNT = 0.5

/** Below this length a prefix match is dropped: `ro` would match everything. */
const MIN_PREFIX_LENGTH = 3

const TOKEN_RUN = /[a-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]+/gu
const ASCII_RUN = /^[a-z0-9]+$/u

/**
 * Split text into the tokens this ranker indexes.
 *
 * Underscores, dashes, dots and punctuation all separate, so
 * `engineering_memory_search` becomes three tokens and a query for `memory`
 * matches it without a substring rule.
 *
 * CJK runs are indexed **both** as single characters and as bigrams. Bigrams are
 * where a language written without spaces carries meaning, and they are what
 * discriminates; the unigrams are kept so that a one-character query — which is a
 * legitimate way to ask `tool_search` for a character's tools — is an exact hit
 * rather than a prefix too short to be allowed.
 *
 * The same function tokenizes the *query*, which is the part that is easy to
 * forget: a ranker whose documents are bigrammed and whose query is not can only
 * ever be asked in English.
 * @param text - the field or query text.
 * @returns the tokens, lowercased.
 */
export function tokenize(text: string): readonly string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(TOKEN_RUN)) {
    const run = match[0]
    if (ASCII_RUN.test(run) || run.length === 1) {
      tokens.push(run)
      continue
    }
    for (const character of run) tokens.push(character)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/** One field of one document, ready to score. */
interface Field {
  readonly counts: ReadonlyMap<string, number>
  readonly length: number
}

/** Count tokens and remember the length. */
function fieldOf(tokens: readonly string[]): Field {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return { counts, length: tokens.length }
}

/**
 * How often a term occurs in a field, allowing for a discounted prefix.
 *
 * A whole-token hit is never added to a prefix hit: `memory` in `memory_get` is
 * one occurrence, not two because a sibling token also starts with it.
 * @param field - the field to search.
 * @param term - the query term, lowercased.
 * @returns the saturated-worthy frequency.
 */
function frequencyOf(field: Field, term: string): number {
  const exact = field.counts.get(term)
  if (exact !== undefined) return exact
  if (term.length < MIN_PREFIX_LENGTH) return 0
  let prefix = 0
  for (const [token, count] of field.counts) if (token.startsWith(term)) prefix += count
  if (prefix > 0) return prefix * PREFIX_DISCOUNT
  // The same partial hit read the other way. A model writes the plural as often
  // as the singular, and the forward-only rule answered `checkpoints` with "no
  // match" while `checkpoint` found the tool — a miss for a query that names the
  // thing. Taken only when the forward reading found nothing, so the two
  // directions can never add up into a score that beats a whole-token hit, and at
  // the same discount, so a partial hit still never outranks the word it matches.
  let reversed = 0
  for (const [token, count] of field.counts) if (token.length >= MIN_PREFIX_LENGTH && term.startsWith(token)) reversed += count
  return reversed * PREFIX_DISCOUNT
}

/** The BM25 term contribution for one field. */
function fieldScore(field: Field, term: string, idf: number, averageLength: number): number {
  const frequency = frequencyOf(field, term)
  if (frequency === 0) return 0
  const normalization = 1 - B + B * (field.length / averageLength)
  return idf * (frequency * (K1 + 1)) / (frequency + K1 * normalization)
}

/**
 * Rank candidates against the query's free terms.
 *
 * Ties break on the name, so the same query answers in the same order twice —
 * a discovery result that reshuffles between identical calls is a result the
 * model cannot read out of its own history.
 * @param terms - the query's ranking terms, case-insensitive; repeats are ignored.
 * @param tools - the candidates, already filtered by any `+required` terms.
 * @param limit - most results to return; at least one.
 * @returns the scoring tools, best first.
 */
export function rankTools<T extends RankableTool>(
  terms: readonly string[],
  tools: readonly T[],
  limit: number,
): readonly RankedTool<T>[] {
  // The query goes through the same tokenizer as the documents, so a CJK query
  // becomes the bigrams the index actually holds.
  const wanted = [...new Set(terms.flatMap(term => tokenize(term)).filter(term => term !== ''))]
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  if (wanted.length === 0 || tools.length === 0) return []

  const documents = tools.map((tool) => {
    const name = fieldOf(tokenize(tool.name))
    const description = fieldOf(tokenize(tool.description ?? ''))
    return { tool, name, description }
  })
  const averageName = averageLength(documents.map(document => document.name.length))
  const averageDescription = averageLength(documents.map(document => document.description.length))

  // Document frequency over both fields, so a term is "common" only when the
  // catalog genuinely cannot use it to tell one tool from another.
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    const seen = new Set([...document.name.counts.keys(), ...document.description.counts.keys()])
    for (const term of wanted) {
      if ([...seen].some(token => token === term || (term.length >= MIN_PREFIX_LENGTH && token.startsWith(term)))) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
    }
  }

  const scored: RankedTool<T>[] = []
  for (const document of documents) {
    let score = 0
    for (const term of wanted) {
      const idf = inverseDocumentFrequency(documentFrequency.get(term) ?? 0, documents.length)
      score += NAME_WEIGHT * fieldScore(document.name, term, idf, averageName)
      score += fieldScore(document.description, term, idf, averageDescription)
    }
    if (score > 0) scored.push({ tool: document.tool, score })
  }
  scored.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
  return scored.slice(0, cap)
}

/** Mean field length, floored at 1 so an all-empty field cannot divide by zero. */
function averageLength(lengths: readonly number[]): number {
  if (lengths.length === 0) return 1
  return Math.max(1, lengths.reduce((total, length) => total + length, 0) / lengths.length)
}

/**
 * The BM25 inverse document frequency.
 *
 * The `+ 0.5` terms are what keep a term that appears in *every* document from
 * having a negative or zero weight: it is uninformative, not disqualifying.
 * @param documentFrequency - how many documents contain the term.
 * @param total - how many documents were searched.
 * @returns the term's weight.
 */
function inverseDocumentFrequency(documentFrequency: number, total: number): number {
  return Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))
}
