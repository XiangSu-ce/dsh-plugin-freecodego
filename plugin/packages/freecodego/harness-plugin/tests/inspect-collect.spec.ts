/**
 * G9 — the unified inspect surface.
 *
 * Three properties are asserted here rather than merely exercised: a failing
 * section does not take the report down, the token count in `rules` is the same
 * number the context breakdown reports, and every payload is boundary-safe.
 */

import { describe, expect, test } from 'vitest'

import { estimateTokensFromChars } from '../src/prompt-composition.ts'
import {
  collectHooksSection,
  collectInspectReport,
  collectRulesSection,
  collectScanSection,
  collectSkillsSection,
  INSPECT_SECTIONS,
  inspectReportToJson,
  renderInspectReport,
  type InspectCollector,
  type JsonValue,
} from '../src/inspect/collect.ts'
import { selectScanFiles } from '../src/scan-selection.ts'
import { tokensFromChars } from '../src/token-estimate.ts'

/** A collector set that answers every section with a small payload. */
function fullCollectorSet(overrides: Partial<Record<string, () => JsonValue | Promise<JsonValue>>> = {}): InspectCollector[] {
  return INSPECT_SECTIONS.map(section => ({
    id: section.id,
    collect: overrides[section.id] ?? (() => ({ ok: true })),
  }))
}

describe('the report', () => {
  test('covers every declared section, in the declared order', async () => {
    const report = await collectInspectReport(fullCollectorSet(), 1_000)
    expect(report.sections.map(section => section.id)).toEqual(INSPECT_SECTIONS.map(section => section.id))
    expect(report.unavailable).toEqual([])
    expect(report.generatedAt).toBe(1_000)
  })

  test('a missing collector is reported rather than omitted', async () => {
    const report = await collectInspectReport(fullCollectorSet().filter(collector => collector.id !== 'mcp'), 1_000)
    const mcp = report.sections.find(section => section.id === 'mcp')!
    expect(mcp.status).toBe('unavailable')
    expect(mcp.reason).toContain('no collector was registered')
    // Absent from the report entirely would be the worse failure: a reader could
    // not tell "no MCP servers" from "I forgot to look".
    expect(report.sections).toHaveLength(INSPECT_SECTIONS.length)
  })

  test('a throwing collector does not take the report down', async () => {
    const report = await collectInspectReport(
      fullCollectorSet({ mcp: () => { throw new Error('config is unreadable') } }),
      1_000,
    )
    const mcp = report.sections.find(section => section.id === 'mcp')!
    expect(mcp).toMatchObject({ status: 'unavailable', reason: 'config is unreadable', data: null })
    expect(report.unavailable).toEqual(['mcp'])
    expect(report.sections.filter(section => section.status === 'ok')).toHaveLength(INSPECT_SECTIONS.length - 1)
  })

  test('a rejecting collector is isolated the same way', async () => {
    const report = await collectInspectReport(
      fullCollectorSet({ engines: () => Promise.reject(new Error('probe timed out')) }),
      1_000,
    )
    expect(report.unavailable).toEqual(['engines'])
    expect(report.sections.find(section => section.id === 'engines')!.reason).toBe('probe timed out')
  })

  test('an async collector is awaited', async () => {
    const report = await collectInspectReport(
      fullCollectorSet({ trust: async () => ({ trusted: true }) }),
      1_000,
    )
    expect(report.sections.find(section => section.id === 'trust')!.data).toEqual({ trusted: true })
  })
})

describe('the boundary shape', () => {
  test('the serialized report survives a JSON round trip unchanged', async () => {
    const report = await collectInspectReport(fullCollectorSet({ skills: () => collectSkillsSection([]) }), 1_000)
    const json = inspectReportToJson(report)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })

  test('every value in a serialized report is a JSON primitive, array or plain object', async () => {
    const report = await collectInspectReport(
      fullCollectorSet({
        rules: () => collectRulesSection([{ path: '/a/rules.md', source: 'project', text: 'hello world' }]),
        hooks: () => collectHooksSection([{ event: 'Stop', sources: ['project'] }]),
        scan: () => collectScanSection({
          workspace: '/repo',
          selection: selectScanFiles([
            { path: 'src/a.ts', bytes: 400 },
            { path: 'packages/app/dist/b.js', bytes: 10 },
            { path: 'src/.env', bytes: 10 },
            { path: 'src/gone.ts', deleted: true },
            { path: 'src/unmeasured.ts' },
          ]),
        }),
      }),
      1_000,
    )
    const walk = (value: JsonValue, path: string): void => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return
      if (Array.isArray(value)) {
        value.forEach((entry, index) =>{  walk(entry, `${path}[${index}]`) })
        return
      }
      expect(Object.getPrototypeOf(value), `${path} must be a plain object`).toBe(Object.prototype)
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`)
    }
    walk(inspectReportToJson(report), 'report')
  })

  test('an unavailable section carries its reason through serialization', async () => {
    const report = await collectInspectReport(
      fullCollectorSet({ sandbox: () => { throw new Error('no policy service') } }),
      1_000,
    )
    const json = inspectReportToJson(report) as { sections: { id: string; reason?: string }[] }
    expect(json.sections.find(section => section.id === 'sandbox')!.reason).toBe('no policy service')
  })
})

describe('the scan section payload', () => {
  test('names the denominator and the reason for every exclusion', () => {
    const payload = collectScanSection({
      workspace: '/repo',
      selection: selectScanFiles([
        { path: 'src/a.ts', bytes: 400 },
        { path: 'packages/app/dist/b.js', bytes: 10 },
        { path: 'src/gone.ts', deleted: true },
      ]),
    })
    expect(payload).toMatchObject({
      available: true,
      workspace: '/repo',
      denominator: 1,
      selected: ['src/a.ts'],
      excludedCount: 2,
      selectedBytes: 400,
      selectedTokens: 100,
      sizeUnchecked: [],
    })
    // Every exclusion a reader can act on carries its own explanation, so "why is
    // my file not scanned" is answered by the report rather than by a re-run.
    expect((payload as { readonly excluded: readonly Record<string, unknown>[] }).excluded).toEqual([
      { path: 'packages/app/dist/b.js', exclusion: 'excluded-by-pattern', pattern: '**/dist/**', reason: 'build output' },
      { path: 'src/gone.ts', exclusion: 'deleted' },
    ])
  })

  test('names an unmeasured file instead of letting it hide in a zero total', () => {
    const payload = collectScanSection({
      workspace: '/repo',
      selection: selectScanFiles([{ path: 'src/unmeasured.ts' }, { path: 'src/a.ts', bytes: 400 }]),
    })
    expect(payload).toMatchObject({ denominator: 2, sizeUnchecked: ['src/unmeasured.ts'], selectedBytes: 400 })
  })

  test('no change set is reported as unavailable with a reason, not as an empty scan', () => {
    const payload = collectScanSection({ workspace: '/repo' })
    expect(payload).toMatchObject({ available: false, workspace: '/repo' })
    expect(String((payload as Record<string, unknown>).reason)).toContain('not a git repository')
  })

  test('a caller-supplied reason is carried through', () => {
    const payload = collectScanSection({ workspace: '/repo', unavailable: 'git is missing from PATH' })
    expect((payload as Record<string, unknown>).reason).toBe('git is missing from PATH')
  })

  test('a report with no active workspace says so rather than naming the process directory', () => {
    expect(collectScanSection({ workspace: undefined })).toMatchObject({ available: false, workspace: null })
  })
})

describe('rendering', () => {
  test('names every section and counts the unavailable ones', async () => {
    const report = await collectInspectReport(
      fullCollectorSet({ mcp: () => { throw new Error('unreadable') } }),
      1_000,
    )
    const text = renderInspectReport(report)
    for (const section of INSPECT_SECTIONS) expect(text).toContain(section.title)
    expect(text).toContain('unreadable')
    expect(text).toContain('1 section(s) could not be collected.')
  })

  test('summarizes counts rather than dumping the payload', () => {
    const report = {
      generatedAt: 0,
      sections: [{
        id: 'rules' as const,
        title: 'Rules',
        status: 'ok' as const,
        data: { count: 3, totalTokens: 12 },
      }],
      unavailable: [],
    }
    const text = renderInspectReport(report)
    expect(text).toContain('count=3')
    expect(text).toContain('totalTokens=12')
  })
})

describe('the rules section shares one token source', () => {
  const sources = [
    { path: '/repo/AGENTS.md', source: 'project' as const, text: 'x'.repeat(500) },
    { path: '/home/.dsh/rules.md', source: 'user' as const, text: 'y'.repeat(77) },
  ]

  test('its per-file counts equal the shared estimator exactly', () => {
    const section = collectRulesSection(sources) as {
      entries: { path: string; tokens: number; chars: number }[]
      totalTokens: number
    }
    for (const source of sources) {
      const entry = section.entries.find(item => item.path === source.path)!
      expect(entry.tokens).toBe(tokensFromChars(source.text.length))
    }
  })

  test('its totals equal what the context breakdown would report', () => {
    // The cross-check with A4: `inspect` and `prompt-composition` must not be
    // able to report different sizes for the same text.
    const section = collectRulesSection(sources) as { totalTokens: number }
    const viaComposition = sources.reduce((total, source) => total + estimateTokensFromChars(source.text.length), 0)
    expect(section.totalTokens).toBe(viaComposition)
  })

  test('a budget turns into an explicit over/under answer', () => {
    const under = collectRulesSection(sources, { budgetTokens: 10_000 }) as { overBudget: boolean }
    expect(under.overBudget).toBe(false)
    const over = collectRulesSection(sources, { budgetTokens: 1 }) as { overBudget: boolean }
    expect(over.overBudget).toBe(true)
  })
})

describe('the skills and hooks sections', () => {
  test('skills are ordered by name so the report is not a diff', () => {
    const section = collectSkillsSection([
      { name: 'zeta', description: 'z', source: 'user', invocation: 'auto' },
      { name: 'alpha', description: 'a', source: 'project', invocation: 'manual' },
    ]) as { entries: { name: string }[]; count: number }
    expect(section.count).toBe(2)
    expect(section.entries.map(entry => entry.name)).toEqual(['alpha', 'zeta'])
  })

  test('skills report their collisions when there are any', () => {
    const section = collectSkillsSection([
      { name: 'shared', description: 's', source: 'project', invocation: 'auto', collidesWith: ['user:shared'] },
    ]) as { entries: { collidesWith?: readonly string[] }[] }
    expect(section.entries[0]!.collidesWith).toEqual(['user:shared'])
  })

  test('hooks are grouped by event with their sources', () => {
    const section = collectHooksSection([
      { event: 'Stop', sources: ['global'] },
      { event: 'Stop', sources: ['project'] },
      { event: 'PreToolUse', sources: ['project'] },
    ]) as { total: number; events: { event: string; handlers: number; sources: string[] }[] }
    expect(section.total).toBe(3)
    expect(section.events).toEqual([
      { event: 'PreToolUse', handlers: 1, sources: ['project'] },
      { event: 'Stop', handlers: 2, sources: ['global', 'project'] },
    ])
  })

  test('hook warnings reach the report', () => {
    const section = collectHooksSection([], ['a matcher on Stop cannot discriminate anything and was ignored']) as { warnings: string[] }
    expect(section.warnings).toHaveLength(1)
  })
})
