/**
 * Regression coverage for the UI/UX catalog's retrieval core.
 *
 * Why the numbers in this file are exact
 * -------------------------------------
 * The catalog's abstention floors are measured scores, and every one of them is a
 * number *about this scorer*. A port is therefore only correct when it produces the
 * same number for the same input, not merely a plausible ranking — which is why the
 * similarity cases below assert the exact ratio Python's `difflib` produced for the
 * same pair (as a rational expression, so the assertion states the arithmetic rather
 * than a rounded decimal someone copied out of a terminal).
 *
 * The three properties a ranking function can have without being this one
 * ---------------------------------------------------------------------
 * 1. It can rank correctly and score differently — every floor moves, and the
 *    abstention decisions with them. The IDF and length cases below pin the scoring,
 *    not the order.
 * 2. It can rank and score correctly and break ties differently. `style` and
 *    `landing` rank near-identical rows on purpose (a style family and its variants),
 *    so the tie order is part of the answer; the case below pins corpus order.
 * 3. It can keep every earlier property and still report coverage as if "we looked"
 *    meant "we found" — the coverage cases pin the two apart.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-bm25
 */

import { describe, expect, it } from 'vitest'

import { fitBm25, normalizeQuery, queryCoverage, similarityRatio, suggestTerms, tokenize } from '../src/uiux/bm25.ts'

describe('tokenizing', () => {
  it('folds a known variant without rewriting the variant inside a longer word', () => {
    // `nav` is a synonym of `navigation`, and `navigation` contains it. A rewrite that
    // was not boundary-anchored would produce `navigationigation`, which no corpus
    // term matches — the sort of failure that shows up as a search returning nothing
    // rather than as an error.
    expect(normalizeQuery('nav navigation a11y')).toBe('navigation navigation accessibility')
    expect(tokenize('nav navigation')).toStrictEqual(['navigation', 'navigation'])
  })

  it('drops stopwords and one-character tokens while keeping short domain tokens', () => {
    // The floor is two characters, and the stopword list exists for the words above
    // it. `ui`, `ux` and `3d` are all two characters and all carry signal, so a length
    // rule alone would have to be wrong about them.
    expect(tokenize('a ui for the ux 3d and to')).toStrictEqual(['ui', 'ux', '3d'])
  })

  it('folds variants before it splits on punctuation, and treats the rest as separators', () => {
    // The order of those two steps is the assertion. `dark-mode` is a synonym key, so
    // the fold consumes the whole word and produces *one* token; a split that ran
    // first would produce `dark` and `mode`, and a corpus that stores `dark` would
    // then be matching the query on half of what it said. A hyphen that is not a key
    // is only a separator, which is the same input shape reaching the other branch.
    expect(tokenize('dark-mode / glassmorphism, (neumorphism)')).toStrictEqual([
      'dark', 'glassmorphism', 'neumorphism',
    ])
    expect(tokenize('data-heavy report')).toStrictEqual(['data', 'heavy', 'report'])
    expect(tokenize('q&a')).toStrictEqual(['question', 'answer'])
  })
})

describe('scoring', () => {
  /** Eight rows where one rare term and one ubiquitous term carry the same weight. */
  const DOCUMENTS = [
    'design glassmorphism gradients',
    'design system tokens',
    'design system spacing',
    'design system color',
    'design system typography',
    'design system motion',
    'design system grid',
    'design system elevation',
  ]

  it('lets a rare term outrank a term every row carries', () => {
    // A term present in every document carries no information — its IDF is at its
    // floor — so a query naming both must be decided by the rare one. A port that
    // dropped IDF would rank by term frequency and return whichever row is longest.
    const index = fitBm25(DOCUMENTS)
    expect(index.documentCount).toBe(8)
    expect(index.documentFrequency('design')).toBe(8)
    expect(index.documentFrequency('glassmorphism')).toBe(1)
    const ranking = index.score('design glassmorphism')
    expect(ranking).toHaveLength(8)
    // Indexed reads are nullable under `noUncheckedIndexedAccess`, so the two entries
    // are read with a default: the assertion then compares a value rather than a
    // possibly-absent one, and the length check above is what proves the rows are real.
    const top = ranking[0] ?? { document: -1, score: 0 }
    const next = ranking[1] ?? { document: -1, score: 0 }
    expect(top.document).toBe(0)
    expect(top.score).toBeGreaterThan(next.score)
  })

  it('keeps corpus order when two rows score the same', () => {
    // Variant rows are near-identical on purpose, so ties are the normal case rather
    // than an edge. The tie rule is the one the floors were calibrated against: the
    // earlier row wins, because both languages sort stably and neither reorders by
    // hash.
    const index = fitBm25(['glassmorphism card', 'glassmorphism card', 'glassmorphism card'])
    const ranking = index.score('glassmorphism')
    expect(ranking.map(entry => entry.document)).toStrictEqual([0, 1, 2])
    expect(new Set(ranking.map(entry => entry.score)).size).toBe(1)
  })

  it('scores an unknown term at zero rather than at an unmeasured value', () => {
    // A token no document carries contributes nothing. The alternative — treating an
    // unknown token as a very small IDF — would give every query a small positive
    // score, and a positive score is what the floors are compared against.
    const index = fitBm25(DOCUMENTS)
    const unknown = index.score('zzzz')
    expect(unknown.every(entry => entry.score === 0)).toBe(true)
    expect(unknown).toHaveLength(8)
  })

  it('fits an empty corpus without inventing a length', () => {
    // `averageLength` is a divisor, so zero documents must not produce a zero there.
    // The empty fit is what the caller's floor turns into a refusal; a NaN score
    // would instead travel into the diagnostics and compare false against every floor.
    const index = fitBm25([])
    expect(index.documentCount).toBe(0)
    expect(index.averageLength).toBe(1)
    expect(index.vocabulary).toStrictEqual([])
    expect(index.score('anything').every(entry => entry.score === 0)).toBe(true)
  })
})

describe('coverage', () => {
  const index = fitBm25(['glassmorphism card statistics'])

  it('reports the share of distinct query tokens the corpus has seen', () => {
    // Distinct, not total: a query that repeats one known word is not more covered
    // than one that says it once.
    expect(queryCoverage(index, 'glassmorphism')).toBe(1)
    expect(queryCoverage(index, 'glassmorphism unknown')).toBe(0.5)
    expect(queryCoverage(index, 'unknown unknown glassmorphism')).toBe(0.5)
  })

  it('reports a query with no tokens as uncovered, not as complete', () => {
    // The empty-query case is the one where "nothing was missing" and "nothing was
    // looked for" are easy to confuse, and the safe reading is the one that abstains.
    expect(queryCoverage(index, '')).toBe(0)
    expect(queryCoverage(index, 'a to the')).toBe(0)
  })
})

describe('similarity', () => {
  it('reproduces the ratio the source threshold was measured against', () => {
    // Every value on the right is what Python's `difflib.SequenceMatcher.ratio()`
    // returned for the same pair, written as the fraction it computed (2M/T). These
    // pairs are misspellings a user actually types, which is the input the 0.72
    // suggestion floor was tuned on.
    expect(similarityRatio('palete', 'palette')).toBe(12 / 13)
    expect(similarityRatio('glassmorfism', 'glassmorphism')).toBe(22 / 25)
    expect(similarityRatio('acessibility', 'accessibility')).toBe(24 / 25)
    expect(similarityRatio('mobil', 'mobile')).toBe(10 / 11)
    expect(similarityRatio('typografy', 'typography')).toBe(16 / 19)
    expect(similarityRatio('ux', 'ux')).toBe(1)
  })

  it('places a pair below the floor when it belongs there', () => {
    // `darkmode` against `dark` scores 2/3, under the 0.72 floor: related words that
    // share a stem are not misspellings, and offering one as a correction for the
    // other would rewrite a good query.
    expect(similarityRatio('darkmode', 'dark')).toBe(8 / 12)
    expect(similarityRatio('zzz', 'qqq')).toBe(0)
  })

  it('treats two empty strings as identical, as the source does', () => {
    // Not a curiosity: the ratio is a division by total length, and the branch that
    // avoids it is the difference between 1 and NaN for a pair of empty fields.
    expect(similarityRatio('', '')).toBe(1)
  })
})

describe('suggestions', () => {
  const index = fitBm25(['glassmorphism card', 'minimalism layout', 'neumorphism button'])

  it('offers only terms the corpus actually contains, and only close enough ones', () => {
    // A suggestion is an invitation to retry. A name that is not in the catalog would
    // make that retry fail for a second reason, and a name that is merely related
    // would rewrite a query that was already right — `neumorphism` scores 0.52 against
    // `glassmorfism` and stays out, while the 0.88 neighbour is offered.
    const suggestions = suggestTerms(index, 'glassmorfism')
    expect(suggestions).toStrictEqual(['glassmorphism'])
    for (const term of suggestions) expect(index.vocabulary).toContain(term)
  })

  it('never offers a term the caller would refuse anyway', () => {
    // The predicate is the abstention floor spelled as a filter. Without it an offer
    // reads as "try this" when the catalog would refuse it too — a suggestion that
    // costs a round trip to learn nothing.
    expect(suggestTerms(index, 'minimalizm', { accepts: () => false })).toStrictEqual([])
    expect(suggestTerms(index, 'minimalizm', { accepts: term => term === 'minimalism' })).toStrictEqual(['minimalism'])
    // Two candidates clear the floor for this query, so the narrowing above is doing
    // the work rather than the similarity being unambiguous.
    expect(suggestTerms(index, 'zmorphism')).toStrictEqual(['neumorphism', 'glassmorphism'])
  })

  it('offers nothing for a query with no tokens to compare', () => {
    expect(suggestTerms(index, '')).toStrictEqual([])
    expect(suggestTerms(index, 'a to')).toStrictEqual([])
  })

  it('caps the offer at the requested count, most similar first', () => {
    // The offer is read by a model and priced like any other output, so the cap is a
    // budget rather than a tidy-up, and the order is what makes the first suggestion
    // the one worth trying.
    expect(suggestTerms(index, 'zmorphism', { limit: 1 })).toStrictEqual(['neumorphism'])
    expect(suggestTerms(index, 'zmorphism').length).toBeLessThanOrEqual(6)
  })
})
