import { describe, expect, it } from 'vitest'
import {
  SURFACE_TOKEN_ESTIMATE_NOTE,
  buildSurfaceLock,
  collectPluginSurfaces,
  describeSurfaceLockDiff,
  diffSurfaceLock,
  groupDigest,
  measureSurfaces,
} from '../src/surface-lock.ts'
import { tokensFromChars } from '../src/token-estimate.ts'

const groups = [
  { group: 'tool-schemas', entries: [{ name: 'tool_search', text: '{"name":"tool_search"}' }, { name: 'advisor_review', text: '{"name":"advisor_review"}' }] },
  { group: 'injected-guidance', entries: [{ name: 'plan-mode', text: 'You are in PLAN MODE.' }] },
]

describe('surface measurement', () => {
  it('measures bytes and labels the token figure as an estimate', () => {
    const report = measureSurfaces(groups)
    expect(report.groups[0]?.entries).toBe(2)
    expect(report.totals.entries).toBe(3)
    expect(report.totals.bytes).toBeGreaterThan(0)
    // Each group is priced by the shared estimator, and the total is the sum of
    // the figures on display — not the estimate of the summed bytes. Rounding up
    // per group can put the total one token above the whole, and a table whose
    // rows do not add up is worse than one that is a token off.
    for (const group of report.groups) {
      expect(group.approximateTokens).toBe(tokensFromChars(group.bytes))
    }
    expect(report.totals.approximateTokens).toBe(
      report.groups.reduce((total, group) => total + group.approximateTokens, 0),
    )
    expect(report.disclaimer).toBe(SURFACE_TOKEN_ESTIMATE_NOTE)
    expect(report.disclaimer).toContain('not a tokenizer count')
  })

  it('reports an empty surface without inventing a size', () => {
    const report = measureSurfaces([{ group: 'empty', entries: [] }])
    expect(report.groups[0]).toEqual({ group: 'empty', entries: 0, bytes: 0, approximateTokens: 0 })
  })
})

describe('surface digest lock', () => {
  it('is stable across entry order, because injected order must be deterministic', () => {
    const reversed = [{ group: 'tool-schemas', entries: [...(groups[0]!.entries)].reverse() }]
    expect(groupDigest(reversed[0]!)).toBe(groupDigest(groups[0]!))
  })

  it('changes when one entry body changes', () => {
    const edited = [{ group: 'tool-schemas', entries: [{ name: 'tool_search', text: '{"name":"tool_search","description":"different"}' }, groups[0]!.entries[1]!] }]
    expect(groupDigest(edited[0]!)).not.toBe(groupDigest(groups[0]!))
  })

  it('changes when an entry is renamed but keeps its body', () => {
    const renamed = [{ group: 'tool-schemas', entries: [{ name: 'tool_lookup', text: groups[0]!.entries[0]!.text }, groups[0]!.entries[1]!] }]
    expect(groupDigest(renamed[0]!)).not.toBe(groupDigest(groups[0]!))
  })

  it('matches itself on a rebuild', () => {
    const lock = buildSurfaceLock(groups)
    expect(diffSurfaceLock(lock, groups)).toMatchObject({ matches: true, added: [], removed: [], changed: [] })
    expect(describeSurfaceLockDiff(diffSurfaceLock(lock, groups))).toContain('match the reviewed lock')
  })

  it('separates added, removed, and changed surfaces', () => {
    const lock = buildSurfaceLock(groups)
    const drifted = [
      { group: 'tool-schemas', entries: [{ name: 'tool_search', text: 'changed' }] },
      { group: 'new-guidance', entries: [{ name: 'a', text: 'b' }] },
    ]
    const diff = diffSurfaceLock(lock, drifted)
    expect(diff.added).toEqual(['new-guidance'])
    expect(diff.changed).toEqual(['tool-schemas'])
    expect(diff.removed).toEqual(['injected-guidance'])
    expect(diff.matches).toBe(false)
    expect(describeSurfaceLockDiff(diff)).toContain('added: new-guidance')
  })

  it('treats a missing lock as everything being new rather than as a match', () => {
    const diff = diffSurfaceLock(undefined, groups)
    expect(diff.matches).toBe(false)
    expect(diff.added).toEqual(['injected-guidance', 'tool-schemas'])
  })
})

describe('surface collection', () => {
  it('collects the tool schema block and the guidance block', () => {
    const surfaces = collectPluginSurfaces({
      toolSchemas: [{ name: 'tool_search', description: 'Fetch schemas', parameters: { type: 'object' } }],
      guidance: [{ name: 'plan-mode', text: 'PLAN MODE' }],
    })
    expect(surfaces.map(group => group.group)).toEqual(['tool-schemas', 'injected-guidance'])
    expect(surfaces[0]?.entries[0]?.text).toContain('Fetch schemas')
    expect(measureSurfaces(surfaces).groups[1]?.bytes).toBe(Buffer.byteLength('PLAN MODE', 'utf8'))
  })

  it('handles a plugin surface set with nothing in it', () => {
    expect(measureSurfaces(collectPluginSurfaces({})).totals).toEqual({ entries: 0, bytes: 0, approximateTokens: 0 })
  })
})
