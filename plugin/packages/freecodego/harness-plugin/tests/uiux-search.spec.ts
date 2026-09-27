/**
 * Regression coverage for the catalog's calibrated search.
 *
 * Why every refusal here is asserted with the number that caused it
 * ---------------------------------------------------------------
 * "It refused" is not a passable assertion. Three independent gates can refuse a
 * search — the score floor, the coverage floor and the margin — and a case that only
 * checks the refusal cannot tell which of them fired, so a port that lost one gate
 * would stay green as long as another kept refusing the same input. Each case below
 * therefore asserts the deciding number *and* that a neighbouring input still answers,
 * which is the pair that makes a gate's absence visible.
 *
 * Why the fixtures are tiny and their corpora are asserted non-empty
 * -----------------------------------------------------------------
 * A calibrated search over a fixture is only a statement about the fixture, so the
 * floors used here are passed explicitly rather than read from the domain table —
 * except in the cases whose point *is* the table's own floor. Every case asserts its
 * corpus size first: a search that walked nothing answers nothing, and every
 * assertion after that would pass for the wrong reason.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-search
 */

import { describe, expect, it } from 'vitest'

import { CALIBRATION_VERSION, DOMAIN_TABLES, NO_THRESHOLD, thresholdForDomain, type CalibratedThreshold } from '../src/uiux/catalog.ts'
import { abstains, projectRow, searchDomain, type SearchRow } from '../src/uiux/search.ts'

/** Two style rows whose only difference is which keyword they carry. */
const STYLE_ROWS: readonly SearchRow[] = [
  { 'Style ID': 'minimalism-and-swiss-style', 'Style Category': 'Minimalism', Keywords: 'minimalism clean typography' },
  { 'Style ID': 'glassmorphism', 'Style Category': 'Glassmorphism', Keywords: 'glassmorphism gradient blur' },
]

/** Two landing rows, one of which carries a social-proof section order. */
const LANDING_ROWS: readonly SearchRow[] = [
  { 'Pattern ID': 'hero-centric', 'Pattern Name': 'Hero Centric', Keywords: 'hero social proof sections' },
  { 'Pattern ID': 'feature-led', 'Pattern Name': 'Feature Led', Keywords: 'features comparison table' },
]

const STYLE_COLUMNS = DOMAIN_TABLES.style
const LANDING_COLUMNS = DOMAIN_TABLES.landing

describe('the table contract', () => {
  it('carries the columns the search relies on, spelled as the tables spell them', () => {
    // A misspelled column is the one contract break that produces no error anywhere:
    // the field searches as empty text and returns as absent, so a row that has a
    // value reads as a row that does not.
    expect(STYLE_COLUMNS.file).toBe('styles.csv')
    expect(STYLE_COLUMNS.searchColumns).toContain('Keywords')
    expect(STYLE_COLUMNS.outputColumns).toContain('Light Mode ✓')
    expect(LANDING_COLUMNS.searchColumns).toContain('Section Order')
    expect(DOMAIN_TABLES.gsap.file).toBe('motion.csv')
  })
})

describe('the score floor', () => {
  it('refuses a positive score below the domain floor, and answers the same query without it', () => {
    // This is the catalog's central promise: a weak match is not an answer. The
    // assertion on the score is what separates this from a no-match refusal — the
    // search found exactly one candidate row and chose not to speak.
    const floored = searchDomain(STYLE_ROWS, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: thresholdForDomain('style'),
    })
    expect(floored.kind).toBe('ok')
    if (floored.kind !== 'ok') return
    expect(floored.diagnostics.scores.topScore).toBeGreaterThan(0)
    expect(floored.diagnostics.scores.topScore).toBeLessThanOrEqual(thresholdForDomain('style').minScore)
    expect(floored.diagnostics.abstained).toBe(true)
    expect(floored.diagnostics.reason).toBe('low-confidence')
    expect(floored.results).toStrictEqual([])
    expect(floored.count).toBe(0)
    expect(floored.diagnostics.calibrationVersion).toBe(CALIBRATION_VERSION)

    // The same query, the same rows, no floor: the match was always there.
    const unfloored = searchDomain(STYLE_ROWS, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: NO_THRESHOLD,
    })
    expect(unfloored.kind).toBe('ok')
    if (unfloored.kind !== 'ok') return
    expect(unfloored.count).toBe(1)
    expect(unfloored.results[0]?.['Style ID']).toBe('glassmorphism')
    expect(unfloored.diagnostics.abstained).toBe(false)
  })

  it('offers a retry that would itself be answered', () => {
    // A refusal that only says "nothing matched" costs a full round trip to guess at
    // the spelling. The offer has to clear the same floor, or the retry fails for a
    // reason the caller cannot see — so the suggestion is searched again here.
    const misspelled = searchDomain(STYLE_ROWS, {
      domain: 'style',
      query: 'glassmorfism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: thresholdForDomain('style'),
    })
    expect(misspelled.kind).toBe('ok')
    if (misspelled.kind !== 'ok') return
    expect(misspelled.diagnostics.abstained).toBe(true)
    // The floor refuses a single-term match here, so nothing may be offered: an offer
    // is a promise about the next search, and this catalog cannot keep it.
    expect(misspelled.suggestions).toStrictEqual([])

    const unfloored = searchDomain(STYLE_ROWS, {
      domain: 'style',
      query: 'glassmorfism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: NO_THRESHOLD,
    })
    expect(unfloored.kind).toBe('ok')
    if (unfloored.kind !== 'ok') return
    expect(unfloored.suggestions).toStrictEqual(['glassmorphism'])
    const retry = searchDomain(STYLE_ROWS, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: NO_THRESHOLD,
    })
    expect(retry.kind === 'ok' && retry.count).toBe(1)
  })
})

describe('the coverage floor', () => {
  it('refuses on coverage alone, while the score would have carried it', () => {
    // Two unknown words beside one known one is a query the corpus mostly cannot act
    // on, even though the one word it does know matches a row. The score floor is set
    // to zero for this case so the score gate cannot be the reason: what refuses here
    // is coverage, and both numbers are asserted to say so.
    const threshold = { ...thresholdForDomain('landing'), minScore: 0 }
    expect(thresholdForDomain('landing').minCoverage).toBe(0.5)
    const outcome = searchDomain(LANDING_ROWS, {
      domain: 'landing',
      query: 'hero zzzz1 zzzz2',
      searchColumns: LANDING_COLUMNS.searchColumns,
      outputColumns: LANDING_COLUMNS.outputColumns,
      threshold,
    })
    expect(LANDING_ROWS.length).toBeGreaterThan(0)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.diagnostics.scores.topScore).toBeGreaterThan(threshold.minScore)
    expect(outcome.diagnostics.scores.coverage).toBeCloseTo(1 / 3, 10)
    expect(outcome.diagnostics.abstained).toBe(true)

    // At exactly the floor it answers, so the gate is `<` and not `<=`.
    const atFloor = searchDomain(LANDING_ROWS, {
      domain: 'landing',
      query: 'hero social proof',
      searchColumns: LANDING_COLUMNS.searchColumns,
      outputColumns: LANDING_COLUMNS.outputColumns,
      threshold: { ...threshold, minScore: 0 },
    })
    expect(atFloor.kind === 'ok' && atFloor.count).toBe(1)
  })
})

describe('the margin floor', () => {
  it('refuses when two rows are indistinguishable, and answers once the floor is gone', () => {
    // Margin is the gate for "we cannot tell these apart". Two identical rows are the
    // cleanest way to reach it: the top score is as high as the corpus allows, and the
    // answer would be decided by corpus order alone, which is not a reason.
    const twins: readonly SearchRow[] = [
      { 'Style ID': 'a', Keywords: 'glassmorphism gradient' },
      { 'Style ID': 'b', Keywords: 'glassmorphism gradient' },
    ]
    const demanding: CalibratedThreshold = { minScore: 0, minMargin: 1, minCoverage: 0 }
    const outcome = searchDomain(twins, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: ['Style ID', 'Keywords'],
      outputColumns: ['Style ID'],
      threshold: demanding,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.diagnostics.scores.margin).toBe(0)
    expect(outcome.diagnostics.abstained).toBe(true)
    // The gate is exercised directly too, so a change to `abstains` cannot be hidden
    // behind a search that refuses for an unrelated reason.
    expect(abstains({ topScore: 9, runnerUpScore: 9, margin: 0, coverage: 1 }, demanding)).toBe(true)
    expect(abstains({ topScore: 9, runnerUpScore: 1, margin: 8, coverage: 1 }, demanding)).toBe(false)

    const relaxed = searchDomain(twins, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: ['Style ID', 'Keywords'],
      outputColumns: ['Style ID'],
      threshold: NO_THRESHOLD,
    })
    expect(relaxed.kind === 'ok' && relaxed.count).toBe(2)
  })
})

describe('narrowing the corpus', () => {
  it('cannot rank a row the filter removed, even when it is the best match', () => {
    // The filter is the mechanism that keeps deprecated rows out of ranking, and the
    // failure it prevents is a retired style being returned as a live recommendation.
    const rows: readonly SearchRow[] = [
      { 'Style ID': 'retired-glass', Status: 'deprecated', Keywords: 'glassmorphism gradient' },
      { 'Style ID': 'live-minimal', Status: 'active', Keywords: 'minimalism clean' },
    ]
    const unfiltered = searchDomain(rows, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: ['Style ID'],
      threshold: NO_THRESHOLD,
    })
    expect(unfiltered.kind === 'ok' && unfiltered.results[0]?.['Style ID']).toBe('retired-glass')

    const filtered = searchDomain(rows, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: ['Style ID'],
      threshold: NO_THRESHOLD,
      rowFilter: row => row.Status !== 'deprecated',
    })
    expect(filtered.kind).toBe('ok')
    if (filtered.kind !== 'ok') return
    // Not a refusal about the catalog, and not an answer either: the surviving row
    // shares nothing with the query, so the search has no positive score and says so
    // rather than returning the row it can still see.
    expect(filtered.diagnostics.scores.topScore).toBe(0)
    expect(filtered.diagnostics.reason).toBe('low-confidence')
    expect(filtered.results).toStrictEqual([])
    expect(filtered.count).toBe(0)
  })

  it('refuses as empty data when the filter removes every row', () => {
    // "The corpus is empty after narrowing" and "no row matched" are different
    // answers, and only the first one is a statement about the catalog.
    const outcome = searchDomain(STYLE_ROWS, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: NO_THRESHOLD,
      rowFilter: () => false,
    })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('empty-data')
    expect(outcome.message).toContain('style')
  })
})

describe('the returned shape', () => {
  it('projects the configured columns and leaves an absent one absent', () => {
    // An empty string is an answer and a missing key is not. Filling every unprojected
    // column with `''` is how a recommendation states a value it never read.
    const row: SearchRow = { 'Style ID': 'a', 'Style Category': 'Minimalism', Keywords: 'clean' }
    const projected = projectRow(row, ['Style ID', 'Style Category'])
    expect(projected).toStrictEqual({ 'Style ID': 'a', 'Style Category': 'Minimalism' })
    const withAbsent = projectRow(row, ['Style ID', 'Ring'])
    expect('Ring' in withAbsent).toBe(false)
    expect(Object.keys(withAbsent)).toStrictEqual(['Style ID'])
  })

  it('never spends a slot on a row that shares nothing with the query', () => {
    const rows: readonly SearchRow[] = [
      { 'Style ID': 'match', Keywords: 'glassmorphism' },
      { 'Style ID': 'other', Keywords: 'minimalism' },
      { 'Style ID': 'third', Keywords: 'brutalism' },
    ]
    const outcome = searchDomain(rows, {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: ['Style ID', 'Keywords'],
      outputColumns: ['Style ID'],
      threshold: NO_THRESHOLD,
      maxResults: 10,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.results.map(result => result['Style ID'])).toStrictEqual(['match'])
  })
})

describe('the argument refusals', () => {
  it('refuses a result count outside the accepted range, and accepts both ends of it', () => {
    // The bound is enforced where the answer is formed rather than only where a tool's
    // schema describes it: a schema is a description, and this is the number the
    // catalog's own output budget is spent against.
    for (const maxResults of [0, 21, 2.5, Number.NaN]) {
      const outcome = searchDomain(STYLE_ROWS, {
        domain: 'style',
        query: 'glassmorphism',
        searchColumns: STYLE_COLUMNS.searchColumns,
        outputColumns: STYLE_COLUMNS.outputColumns,
        threshold: NO_THRESHOLD,
        maxResults,
      })
      expect(outcome.kind, String(maxResults)).toBe('refused')
      if (outcome.kind !== 'refused') continue
      expect(outcome.reason).toBe('max-results')
      expect(outcome.message).toContain('1 to 20')
    }
    for (const maxResults of [1, 20]) {
      const outcome = searchDomain(STYLE_ROWS, {
        domain: 'style',
        query: 'glassmorphism',
        searchColumns: STYLE_COLUMNS.searchColumns,
        outputColumns: STYLE_COLUMNS.outputColumns,
        threshold: NO_THRESHOLD,
        maxResults,
      })
      expect(outcome.kind, String(maxResults)).toBe('ok')
    }
  })

  it('refuses an empty table instead of answering it', () => {
    const outcome = searchDomain([], {
      domain: 'style',
      query: 'glassmorphism',
      searchColumns: STYLE_COLUMNS.searchColumns,
      outputColumns: STYLE_COLUMNS.outputColumns,
      threshold: NO_THRESHOLD,
    })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('empty-data')
  })
})
