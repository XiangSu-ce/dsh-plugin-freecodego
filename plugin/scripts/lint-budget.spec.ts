/**
 * The ratchet is only worth having if it reports growth and stays quiet
 * otherwise, so the comparison is unit-tested against hand-made counts rather
 * than against a live Oxlint run: the suite must not pay two minutes to learn
 * that `3 > 2`.
 *
 * @module scripts/lint-budget
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregate, diagnosticsFrom, increases, type LintBudget, type LintDiagnostic } from './lint-budget.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')

const diagnostic = (code: string, file: string): LintDiagnostic => ({ code, labels: [{ file }] })

type FileCounts = Readonly<Record<string, Readonly<Record<string, number>>>>

const budget = (rules: Readonly<Record<string, number>>, files: FileCounts = {}): LintBudget =>
  ({ version: 1, generatedBy: 'test', total: Object.values(rules).reduce((sum, count) => sum + count, 0), rules, files })

describe('aggregate', () => {
  it('counts per rule and per file, with a total that matches the input', () => {
    const result = aggregate([diagnostic('a/one', 'src/x.ts'), diagnostic('a/one', 'src/x.ts'), diagnostic('b/two', 'src/y.ts')], 'test')
    expect(result.total).toBe(3)
    expect(result.rules).toEqual({ 'a/one': 2, 'b/two': 1 })
    expect(result.files).toEqual({ 'src/x.ts': { 'a/one': 2 }, 'src/y.ts': { 'b/two': 1 } })
  })

  it('normalizes Windows separators so a path counts once', () => {
    const result = aggregate([diagnostic('a/one', 'src\\x.ts'), diagnostic('a/one', 'src/x.ts')], 'test')
    expect(result.files).toEqual({ 'src/x.ts': { 'a/one': 2 } })
  })

  it('falls back to the message filename and to a placeholder code', () => {
    const result = aggregate([{ filename: 'src/z.ts' }, { code: 'a/one' }], 'test')
    expect(result.rules).toEqual({ '(unknown)': 1, 'a/one': 1 })
    expect(result.files['src/z.ts']).toEqual({ '(unknown)': 1 })
  })

  it('is stable: the same input aggregates to the same bytes', () => {
    const input = [diagnostic('b/two', 'src/b.ts'), diagnostic('a/one', 'src/a.ts')]
    expect(JSON.stringify(aggregate(input, 'test'))).toBe(JSON.stringify(aggregate([...input].reverse(), 'test')))
  })
})

describe('increases', () => {
  it('reports nothing when every rule is at or below its budget', () => {
    expect(increases(budget({ 'a/one': 2 }), budget({ 'a/one': 1 }))).toEqual([])
    expect(increases(budget({ 'a/one': 2 }), budget({ 'a/one': 2 }))).toEqual([])
  })

  it('reports the rule and the files that account for the growth', () => {
    const baseline = budget({ 'a/one': 2 }, { 'src/a.ts': { 'a/one': 2 } })
    const current = budget({ 'a/one': 4 }, { 'src/a.ts': { 'a/one': 2 }, 'src/new.ts': { 'a/one': 2 } })
    expect(increases(baseline, current)).toEqual([{ rule: 'a/one', baseline: 2, current: 4, files: ['src/new.ts (+2)'] }])
  })

  it('treats a rule missing from the baseline as growth from zero', () => {
    const grown = increases(budget({}), budget({ 'a/new': 1 }))
    expect(grown).toEqual([{ rule: 'a/new', baseline: 0, current: 1, files: [] }])
  })

  it('orders the largest overshoot first', () => {
    const baseline = budget({ 'a/one': 1, 'b/two': 5 })
    const current = budget({ 'a/one': 2, 'b/two': 9 })
    expect(increases(baseline, current).map(entry => entry.rule)).toEqual(['b/two', 'a/one'])
  })
})

describe('diagnosticsFrom', () => {
  it('reads the diagnostics array', () => {
    expect(diagnosticsFrom({ diagnostics: [diagnostic('a/one', 'src/x.ts')] })).toHaveLength(1)
  })

  it('rejects a report that is not an Oxlint JSON report', () => {
    expect(() => diagnosticsFrom({ warnings: [] })).toThrow(/diagnostics array/)
    expect(() => diagnosticsFrom('Failed to parse')).toThrow(/diagnostics array/)
  })
})

describe('the committed baseline', () => {
  const baseline = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'scripts', 'lint-budget.baseline.json'), 'utf8')) as LintBudget

  it('is a versioned budget whose total is the sum of its rules', () => {
    expect(baseline.version).toBe(1)
    expect(baseline.total).toBe(Object.values(baseline.rules).reduce((sum, count) => sum + count, 0))
    expect(baseline.total).toBeGreaterThan(0)
  })

  it('records every count as a positive number and every rule sorted', () => {
    const rules = Object.entries(baseline.rules)
    expect(rules.length).toBeGreaterThan(10)
    for (const [, count] of rules) expect(count).toBeGreaterThan(0)
    expect(rules.map(([rule]) => rule)).toEqual([...rules.map(([rule]) => rule)].sort())
  })

  it('attributes each rule to at least one file, so growth can be located', () => {
    const perRule = new Map<string, number>()
    for (const counts of Object.values(baseline.files)) {
      for (const [rule, count] of Object.entries(counts)) perRule.set(rule, (perRule.get(rule) ?? 0) + count)
    }
    for (const [rule, count] of Object.entries(baseline.rules)) expect(perRule.get(rule)).toBe(count)
  })
})
