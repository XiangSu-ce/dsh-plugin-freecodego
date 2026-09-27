/**
 * One domain's calibrated search: rows if the match holds up, an explicit refusal if
 * it does not.
 *
 * Why a refusal is a branch and not an empty list
 * ----------------------------------------------
 * Upstream returns a dictionary in which "three rows" and "no rows because the table
 * is missing" differ only by a key, and in which a refusal and a genuinely empty
 * result look the same to anything that reads `results`. A recommendation that
 * cannot be told from a refusal is how a fabricated answer arrives: something
 * downstream reads the empty list, treats it as a weak match, and fills the blanks
 * with defaults. The outcome here is a discriminated union, so the caller has to say
 * what it does about a refusal and cannot do it by accident.
 *
 * What the diagnostics are for
 * ----------------------------
 * Every number the decision used travels with the decision: the rewritten query, the
 * rewrite that fired, the top score, the runner-up, the margin, the token coverage,
 * and the calibration version the floors came from. That is what makes a false
 * abstention answerable — "why did it refuse a query that looks right" is not a
 * question an audit trail can be reconstructed from later, because the corpus may
 * have moved. The two numbers that decide most refusals (score and coverage) move
 * independently: a query of entirely unknown words scores near zero, and a query of
 * known words can still score below a floor measured on a different corpus size.
 *
 * One boundary, stated once
 * -------------------------
 * Upstream writes its abstention boundary twice — `top_score <= min_score` refuses,
 * and, in the suggestion pass, `top_score > min_score` accepts — which is the same
 * rule spelled two ways in two files. Here `abstains` is the only spelling, and the
 * suggestion pass goes through it, so the two can no longer drift apart.
 *
 * What this file does not do
 * --------------------------
 * It performs no IO and holds no cache. Upstream keys a process-level index cache on
 * the file's path, its columns, an index version and a row variant; that machinery
 * exists to avoid re-reading and re-fitting the same CSV inside one process, and a
 * caller that hands in parsed rows has already made that decision. An identity
 * resolution step (aliases, deprecated rows, cross-domain redirects) sits above this
 * layer and is deliberately not here: it changes *which* rows are searched, and this
 * module's contract is what happens once they are known.
 *
 * @module uiux/search
 */

import { fitBm25, normalizeQuery, queryCoverage, suggestTerms, type Bm25Index } from './bm25.ts'
import { CALIBRATION_VERSION, isValidMaxResults, type CalibratedThreshold } from './catalog.ts'

/** One catalog row, as parsed from its table: column name to cell text. */
export type SearchRow = Readonly<Record<string, string>>

/** The numbers an abstention decision is made from. */
export interface SearchScores {
  /** Highest score in the ranking, or 0 when the corpus is empty. */
  readonly topScore: number
  /** Second-highest score, or 0. */
  readonly runnerUpScore: number
  /** Top score minus runner-up; how far the winner is from its nearest rival. */
  readonly margin: number
  /** Share of the query's distinct tokens the corpus has seen. */
  readonly coverage: number
}

/** Why a search answered, or why it did not. */
export type SearchReason = 'matched' | 'low-confidence'

/** Everything the decision used, so a refusal can be argued with. */
export interface SearchDiagnostics {
  /** The query after synonym folding, before routing rewrites. */
  readonly normalizedQuery: string
  /** The query the corpus was actually scored against. */
  readonly searchQuery: string
  /** The domain rewrites that fired, as `term->replacement`. */
  readonly queryRewrites: readonly string[]
  /** The scores the decision was made from. */
  readonly scores: SearchScores
  /** Whether the search refused to answer. */
  readonly abstained: boolean
  /** The floors the decision was compared against. */
  readonly threshold: CalibratedThreshold
  /** Identifies the floors' provenance, so a result is attributable to numbers rather than to a date. */
  readonly calibrationVersion: string
  /** The outcome in one word. */
  readonly reason: SearchReason
}

/** A refusal this layer can state: a caller's argument, or a domain with nothing to read. */
export type SearchRefusal = 'max-results' | 'empty-data'

/** The result of searching one domain. */
export type DomainSearchOutcome =
  | {
    readonly kind: 'ok'
    readonly domain: string
    readonly query: string
    /** Number of returned rows; `results.length` by construction. */
    readonly count: number
    readonly results: readonly SearchRow[]
    readonly diagnostics: SearchDiagnostics
    /** Replacement terms offered when nothing was returned. Empty when something was. */
    readonly suggestions: readonly string[]
  }
  | {
    readonly kind: 'refused'
    readonly domain: string
    readonly query: string
    readonly reason: SearchRefusal
    /** A sentence naming what was wrong, for a reader rather than a branch. */
    readonly message: string
  }

/**
 * Whether these scores fail to clear a threshold.
 *
 * All three checks are here together because they are one decision: a search that
 * clears the score floor and misses on coverage has still refused, and reporting
 * only the first failure found would hide which one it was.
 *
 * @param scores - the top and runner-up scores and the query's token coverage.
 * @param threshold - the floors the domain was calibrated with.
 * @returns true when the search must refuse rather than answer.
 */
export function abstains(scores: SearchScores, threshold: CalibratedThreshold): boolean {
  return scores.topScore <= threshold.minScore
    || scores.coverage < threshold.minCoverage
    || (threshold.minMargin > 0 && scores.margin < threshold.minMargin)
}

/**
 * Rank the corpus against a query and read the decision numbers off the ranking.
 *
 * @param index - the fitted index.
 * @param searchQuery - the query to score, already rewritten.
 * @returns the ranking and the scores derived from it.
 */
function rank(index: Bm25Index, searchQuery: string): { readonly ranking: ReturnType<Bm25Index['score']>; readonly scores: SearchScores } {
  const ranking = index.score(searchQuery)
  // A missing score reads as 0, which is what the floor comparison needs: an absent
  // number would compare false against every floor and abstain for the wrong reason.
  const topScore = ranking[0]?.score ?? 0
  const runnerUpScore = ranking[1]?.score ?? 0
  return {
    ranking,
    scores: { topScore, runnerUpScore, margin: topScore - runnerUpScore, coverage: queryCoverage(index, searchQuery) },
  }
}

/**
 * Project a row onto the columns its table returns.
 *
 * A column the row does not carry is left out rather than set to an empty string.
 * The difference matters to the reader above: an absent column has no answer while an
 * empty one answers "nothing", and filling every missing field with `''` is how a
 * recommendation ends up stating a value it never read.
 *
 * @param row - the full row.
 * @param columns - the columns to keep.
 * @returns the projected row.
 */
export function projectRow(row: SearchRow, columns: readonly string[]): SearchRow {
  const entries: [string, string][] = []
  for (const column of columns) {
    const value = row[column]
    if (value !== undefined) entries.push([column, value])
  }
  return Object.fromEntries(entries)
}

/**
 * Search one domain's rows.
 *
 * @param rows - the table's rows, in table order; order is the tie-break the calibrated floors were measured with.
 * @param options - the domain, the query, the table's columns, and the floors to apply.
 * @returns the rows, or the refusal that says why there are none.
 */
export function searchDomain(
  rows: readonly SearchRow[],
  options: {
    readonly domain: string
    readonly query: string
    /** Table columns whose text is indexed. */
    readonly searchColumns: readonly string[]
    /** Table columns returned with each hit. */
    readonly outputColumns: readonly string[]
    /** The floors measured for this domain. */
    readonly threshold: CalibratedThreshold
    /** Results to return; upstream's default when omitted. */
    readonly maxResults?: number
    /** Query to actually score, when routing has already rewritten it. */
    readonly searchQuery?: string
    /** Rewrites to report, when the caller applied them. */
    readonly queryRewrites?: readonly string[]
    /** Narrows the corpus before indexing — the style domain uses it to hold deprecated rows out of ranking. */
    readonly rowFilter?: (row: SearchRow) => boolean
  },
): DomainSearchOutcome {
  const maxResults = options.maxResults ?? 3
  if (!isValidMaxResults(maxResults)) {
    return {
      kind: 'refused',
      domain: options.domain,
      query: options.query,
      reason: 'max-results',
      message: `max_results must be an integer from 1 to 20, got ${String(maxResults)}`,
    }
  }
  const filtered = options.rowFilter === undefined ? rows : rows.filter(options.rowFilter)
  if (filtered.length === 0) {
    return {
      kind: 'refused',
      domain: options.domain,
      query: options.query,
      reason: 'empty-data',
      message: `No rows to search for domain ${options.domain}.`,
    }
  }

  const index = fitBm25(filtered.map(row => options.searchColumns.map(column => row[column] ?? '').join(' ')))
  const searchQuery = options.searchQuery ?? options.query
  const { ranking, scores } = rank(index, searchQuery)
  const abstained = abstains(scores, options.threshold)
  const results = abstained
    ? []
    : ranking
      .slice(0, maxResults)
      // A non-positive score is not a weak match, it is no match at all; returning it
      // would spend a result slot on a row that shares nothing with the query.
      .filter(entry => entry.score > 0)
      .flatMap((entry) => {
        const row = filtered[entry.document]
        // A ranking entry indexes the corpus the index was fitted over, so this is
        // defined whenever the filter is pure. Reading it defensively keeps a caller's
        // impure filter from turning a missing row into a crash inside a search.
        return row === undefined ? [] : [projectRow(row, options.outputColumns)]
      })
  return {
    kind: 'ok',
    domain: options.domain,
    query: options.query,
    count: results.length,
    results,
    diagnostics: {
      normalizedQuery: normalizeQuery(options.query.toLowerCase()),
      searchQuery,
      queryRewrites: options.queryRewrites ?? [],
      scores,
      abstained,
      threshold: options.threshold,
      calibrationVersion: CALIBRATION_VERSION,
      reason: abstained ? 'low-confidence' : 'matched',
    },
    suggestions: results.length > 0
      ? []
      : suggestTerms(index, searchQuery, {
        // A suggestion has to be a query that would itself be answered, or the retry
        // it invites fails the same way the original did.
        accepts: term => !abstains(rank(index, term).scores, options.threshold),
      }),
  }
}
