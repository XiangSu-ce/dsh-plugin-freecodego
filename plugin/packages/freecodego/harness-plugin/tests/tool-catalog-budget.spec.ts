/**
 * The `tool_search` index budget.
 *
 * The property that carries the feature is not any single rendering: it is that
 * the listing stays inside its budget **and** leaves no name unreachable. A
 * truncating index would satisfy the first half by hiding tools, and a listing
 * that cannot be asked for the hidden names would hide them permanently.
 */

import { describe, expect, it } from 'vitest'

import {
  catalogPrefixOf,
  DEFAULT_CATALOG_TOKEN_BUDGET,
  renderDeferredNameList,
  renderToolCatalog,
  type CatalogEntry,
} from '../src/tool-catalog-budget.ts'

/** `n` tools named `engineering_tool_<i>`, each with a realistic summary. */
function catalog(n: number, prefix = 'engineering_tool_'): readonly CatalogEntry[] {
  return Array.from({ length: n }, (_unused, index) => ({
    name: `${prefix}${String(index)}`,
    summary: `Does the ${String(index)}th thing this plugin needs, described in one sentence of the length a real tool description has.`,
  }))
}

describe('the index budget', () => {
  it('stays at full detail for a catalog that fits, in the original shape', () => {
    const listing = renderToolCatalog(catalog(4))
    expect(listing.detail).toBe('full')
    expect(listing.text).toContain('- engineering_tool_0 — Does the 0th thing')
    expect(listing.text).toContain('Fetch any of these by name, e.g. tool_search("select:engineering_tool_0")')
    expect(listing.omitted).toBe(0)
    expect(listing.listed).toBe(4)
  })

  it('drops the summaries rather than the names when the summaries do not fit', () => {
    const listing = renderToolCatalog(catalog(60))
    expect(listing.detail).toBe('names')
    // The whole point: degradation is not truncation.
    expect(listing.omitted).toBe(0)
    expect(listing.listed).toBe(60)
    for (const entry of catalog(60)) expect(listing.text).toContain(entry.name)
    expect(listing.text).not.toContain('Does the 0th thing')
  })

  it('says what it dropped and how to get it back, instead of only dropping it', () => {
    const listing = renderToolCatalog(catalog(60))
    expect(listing.text).toContain('Summaries are omitted')
    expect(listing.text).toContain('search by keyword to get a summary and the schema together')
  })

  it('groups by prefix once even the bare names do not fit', () => {
    const listing = renderToolCatalog(catalog(1_500))
    expect(listing.detail).toBe('grouped')
    expect(listing.groups.length).toBeGreaterThan(0)
    for (const group of listing.groups) {
      // The key is the leading identifier, not the whole name: `tool_` is part
      // of the name, and grouping on it would produce one group per tool.
      expect(group.prefix).toBe('engineering_')
      expect(group.count).toBe(1_500)
      expect(group.samples).toHaveLength(3)
    }
    expect(listing.text).toContain('(1500 tools)')
  })

  it('accounts for every name it did not spell out at the grouped level', () => {
    const listing = renderToolCatalog(catalog(1_500))
    // `omitted` is the count a caller would have to ask `list:` for; the two
    // halves always add up to the catalog, which is what makes it checkable.
    expect(listing.listed + listing.omitted).toBe(1_500)
    expect(listing.omitted).toBeGreaterThan(0)
    expect(listing.text).toContain('tool_search("list:all")')
  })

  it('renders one group line per distinct prefix, largest first', () => {
    const entries: CatalogEntry[] = [
      { name: 'advisor_a', summary: 'x' },
      ...catalog(60, 'engineering_'),
      ...catalog(5, 'freecodego_'),
    ]
    // 200 tokens holds neither the 66 summaries nor the 66 bare names, and holds
    // the three group lines with room to spare.
    const listing = renderToolCatalog(entries, 200)
    expect(listing.detail).toBe('grouped')
    expect(listing.groups.map(group => group.prefix)).toEqual(['engineering_', 'freecodego_', 'advisor_'])
    expect(listing.groups.map(group => group.count)).toEqual([60, 5, 1])
  })

  it('never exceeds the budget at any level, however large the catalog', () => {
    for (const size of [1, 10, 40, 100, 400, 2_000, 10_000]) {
      for (const budget of [1_000, 400, 120]) {
        const listing = renderToolCatalog(catalog(size), budget)
        expect(listing.tokens, `size=${String(size)} budget=${String(budget)}`).toBeLessThanOrEqual(budget)
      }
    }
  })

  it('still renders something when nothing fits, rather than an empty listing', () => {
    // A budget that cannot hold one group line would otherwise answer with
    // nothing at all, and a model told "no deferred tools" would stop asking.
    const listing = renderToolCatalog(catalog(500), 1)
    expect(listing.detail).toBe('grouped')
    expect(listing.groups).toHaveLength(1)
    expect(listing.text).toContain('engineering_tool_')
    expect(listing.omitted).toBeGreaterThan(0)
  })

  it('says which guarantee yields when the budget is smaller than one group line', () => {
    // Reachability wins, and it is the only case where the budget does: a budget that
    // cannot hold a single group line leaves no listing that both fits and names
    // anything. Stated here because the two tests above this one read as though the
    // budget always wins, and the precedence should be pinned rather than inferred
    // from whichever assertion a reader meets first.
    const listing = renderToolCatalog(catalog(500), 1)
    expect(listing.tokens).toBeGreaterThan(listing.budgetTokens)
    expect(listing.groups).toHaveLength(1)
    // Still bounded by the one line it had to keep, not by the catalog.
    expect(listing.tokens).toBeLessThan(100)
  })

  it('falls back to the default budget when handed a nonsensical one', () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderToolCatalog(catalog(60), budget).detail).toBe('names')
    }
  })

  it('leaves the empty-catalog sentence to the caller, which knows why it is empty', () => {
    const listing = renderToolCatalog([])
    expect(listing.text).toBe('')
    expect(listing.listed).toBe(0)
    expect(listing.budgetTokens).toBe(DEFAULT_CATALOG_TOKEN_BUDGET)
  })

  it('keeps a summary-less tool readable at full detail', () => {
    const listing = renderToolCatalog([{ name: 'advisor_notes' }])
    expect(listing.text.startsWith('- advisor_notes\n')).toBe(true)
  })
})

describe('the grouping key', () => {
  it('is the leading identifier and its underscores', () => {
    expect(catalogPrefixOf('engineering_memory_search')).toBe('engineering_')
    expect(catalogPrefixOf('read')).toBe('read')
    expect(catalogPrefixOf('mcp__slack__send')).toBe('mcp__')
  })
})

describe('the names-only listing', () => {
  const entries = [...catalog(30, 'engineering_'), ...catalog(4, 'advisor_')]

  it('lists one prefix and nothing else', () => {
    const text = renderDeferredNameList(entries, 'advisor_')
    expect(text).toContain('advisor_0')
    expect(text).not.toContain('engineering_0')
  })

  it('is case-insensitive, so a prefix typed by a model still matches', () => {
    expect(renderDeferredNameList(entries, 'ADVISOR_')).toContain('advisor_3')
  })

  it('lists everything for an empty prefix and for `all`', () => {
    for (const prefix of ['', 'all', 'ALL']) {
      const text = renderDeferredNameList(entries, prefix)
      expect(text).toContain('engineering_29')
      expect(text).toContain('advisor_3')
    }
  })

  it('bounds itself and says how many names it left', () => {
    const text = renderDeferredNameList(entries, 'all', 5)
    expect(text).toContain('… and 29 more')
    expect(text.split('\n').filter(line => line.startsWith('engineering_'))).toHaveLength(5)
  })

  it('never pretends a name is callable, because a name is not a schema', () => {
    const text = renderDeferredNameList(entries, 'all')
    expect(text).not.toContain('<function>')
    expect(text).toContain('is not callable until its schema is fetched')
  })

  it('answers an unknown prefix with the groups that exist', () => {
    const text = renderDeferredNameList(entries, 'nope_')
    expect(text).toContain('No deferred tool name starts with "nope_"')
    expect(text).toContain('advisor_')
    expect(text).toContain('engineering_')
  })
})
