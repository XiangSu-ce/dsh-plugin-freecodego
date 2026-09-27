/**
 * Regression coverage for pre-ranking catalog identities and generation successors.
 *
 * Why these tests use the real tables as well as small edge-case fixtures
 * ---------------------------------------------------------------------
 * The redirects and aliases are data declarations, so a resolver can be perfectly
 * self-consistent against a tiny hand-written fixture while pointing at no real row.
 * The committed styles and landing tables exercise those pointers end to end; small
 * rows then isolate ambiguity, cycles and missing-successor behavior without relying
 * on upstream currently happening to contain malformed data.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-generations
 */

import { describe, expect, it } from 'vitest'

import { loadDomain } from '../src/uiux/data-store.ts'
import {
  containedStyleIdentity,
  exactIdentity,
  resolveLandingIdentity,
  resolveStyleDestination,
  resolveStyleIdentity,
  STYLE_IDENTITY_FIELDS,
} from '../src/uiux/generations.ts'
import type { SearchRow } from '../src/uiux/search.ts'

/** Read one loaded domain for the real-corpus checks below. */
function domainRows(domain: 'style' | 'landing'): readonly SearchRow[] {
  const outcome = loadDomain(domain)
  if (outcome.kind !== 'loaded') throw new Error(`Expected ${domain} catalog to load: ${outcome.message}`)
  return outcome.rows
}

const styles = domainRows('style')
const landings = domainRows('landing')

describe('exact catalog identities', () => {
  it('resolves stable IDs, categories, and aliases without opening ranked search', () => {
    const byId = resolveStyleIdentity(styles, 'glassmorphism')
    expect(byId.kind).toBe('matched')
    if (byId.kind === 'matched') {
      expect(byId.reason).toBe('exact-identity')
      expect(byId.row['Style ID']).toBe('glassmorphism')
    }

    const byCategory = resolveStyleIdentity(styles, 'Glassmorphism')
    expect(byCategory.kind).toBe('matched')
    if (byCategory.kind === 'matched') expect(byCategory.row['Style ID']).toBe('glassmorphism')

    const byAlias = resolveLandingIdentity(landings, 'Hero-Centric + Feature-Rich')
    expect(byAlias?.id).toBe('hero-centric-design')
    expect(byAlias?.field).toBe('Aliases')
    expect(resolveLandingIdentity(landings, 'hero-centric-design')?.field).toBe('Pattern ID')
    expect(resolveLandingIdentity(landings, 'hero-centric design')?.id).toBe('hero-centric-design')
    expect(resolveLandingIdentity(landings, 'hero-centric')).toBeUndefined()
  })

  it('does not choose a contained match when the exact identity declaration is ambiguous', () => {
    const ambiguous: readonly SearchRow[] = [
      { 'Style ID': 'first', 'Style Category': 'First', Aliases: 'shared name', Status: 'active' },
      { 'Style ID': 'second', 'Style Category': 'Second', Aliases: 'shared name', Status: 'active' },
    ]
    expect(exactIdentity(ambiguous, 'shared name', STYLE_IDENTITY_FIELDS)).toBeUndefined()
    expect(resolveStyleIdentity(ambiguous, 'shared name')).toStrictEqual({
      kind: 'ambiguous', identity: 'shared name', match: 'exact',
    })
    expect(exactIdentity([
      { 'Style ID': 'stable-id', 'Style Category': 'Stable', Aliases: '' },
      { 'Style ID': 'other', 'Style Category': 'Other', Aliases: 'stable-id' },
    ], 'stable-id', STYLE_IDENTITY_FIELDS)?.id).toBe('stable-id')

    const containedTie: readonly SearchRow[] = [
      { 'Style ID': 'alpha', 'Style Category': 'Alpha Frame', Status: 'active' },
      { 'Style ID': 'bravo', 'Style Category': 'Bravo Frame', Status: 'active' },
    ]
    expect(containedStyleIdentity(containedTie, 'use Alpha Frame and Bravo Frame')).toBeUndefined()
    expect(resolveStyleIdentity(containedTie, 'use Alpha Frame and Bravo Frame')).toMatchObject({
      kind: 'ambiguous', match: 'contained',
    })
  })

  it('resolves only a complete, distinctive style identity contained in a longer request', () => {
    const contained = resolveStyleIdentity(styles, 'Please use the Bento Box Grid style for this product')
    expect(contained.kind).toBe('matched')
    if (contained.kind === 'matched') {
      expect(contained.reason).toBe('contained-identity')
      expect(contained.row['Style ID']).toBe('bento-box-grid')
    }
    expect(resolveStyleIdentity(styles, 'use a general design system')).toStrictEqual({ kind: 'miss' })
  })
})

describe('generation transitions', () => {
  it('follows a style replacement to its live successor and records the trail', () => {
    const legacy = styles.find(row => row['Style ID'] === 'bento-grids')
    expect(legacy).toBeDefined()
    if (legacy === undefined) return
    const result = resolveStyleDestination(styles, legacy, landings)
    expect(result.kind).toBe('matched')
    if (result.kind === 'matched') {
      expect(result.reason).toBe('style-replacement')
      expect(result.row['Style ID']).toBe('bento-box-grid')
      expect(result.trail).toStrictEqual(['bento-grids'])
    }
  })

  it('validates a deprecated style redirect against the shipped landing-pattern ID', () => {
    const legacy = styles.find(row => row['Style ID'] === 'hero-centric-design')
    expect(legacy).toBeDefined()
    if (legacy === undefined) return
    expect(resolveStyleDestination(styles, legacy, landings)).toMatchObject({
      kind: 'redirect', domain: 'landing', id: 'hero-centric-design', sourceId: 'hero-centric-design',
      trail: ['hero-centric-design'],
    })

    const absentTarget = resolveStyleDestination(
      styles,
      legacy,
      landings.filter(row => row['Pattern ID'] !== 'hero-centric-design'),
    )
    expect(absentTarget.kind).toBe('unresolved')
    if (absentTarget.kind === 'unresolved') expect(absentTarget.reason).toBe('missing-successor')
  })

  it('verifies every deprecated identity in the current corpus reaches a declared target', () => {
    const deprecated = styles.filter(row => row.Status === 'deprecated')
    expect(deprecated).toHaveLength(9)
    for (const row of deprecated) {
      const result = resolveStyleDestination(styles, row, landings)
      expect(['matched', 'redirect'], row['Style ID']).toContain(result.kind)
    }
  })

  it('refuses missing, duplicate, and cyclic local successors rather than selecting the first', () => {
    const source: SearchRow = {
      'Style ID': 'old', Status: 'deprecated', 'Parent Style ID': 'missing',
    }
    expect(resolveStyleDestination([source], source)).toMatchObject({ kind: 'unresolved', reason: 'missing-successor' })

    const duplicate: readonly SearchRow[] = [
      source,
      { 'Style ID': 'target', Status: 'active' },
      { 'Style ID': 'target', Status: 'active' },
    ]
    expect(resolveStyleDestination(duplicate, source)).toMatchObject({ kind: 'unresolved', reason: 'missing-successor' })

    const cycle: readonly SearchRow[] = [
      { 'Style ID': 'a', Status: 'deprecated', 'Replacement Domain': 'style', 'Replacement ID': 'b' },
      { 'Style ID': 'b', Status: 'deprecated', 'Parent Style ID': 'a' },
    ]
    expect(resolveStyleDestination(cycle, cycle[0] ?? {})).toMatchObject({ kind: 'unresolved', reason: 'successor-cycle' })
  })
})
