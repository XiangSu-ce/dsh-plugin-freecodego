/**
 * The model-facing UI/UX catalogue tool.
 *
 * The definition rather than a registration: the design page's switch is what
 * registers this tool now (`design/features.ts` lists it, `design/tools.ts`
 * supplies it, and `design-tools.spec` holds that pair together), so what is
 * left to check here is the tool itself — its schema, its routing, and every
 * query it refuses. The fixture replaces the style table because the identity
 * cases below are about the resolver's decisions, which the shipped corpus can
 * only exercise for the styles it happens to contain.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-tool
 */

import { describe, expect, it, vi } from 'vitest'

const catalogFixture = vi.hoisted(() => ({
  styleRows: undefined as readonly Readonly<Record<string, string>>[] | undefined,
}))

vi.mock('../src/uiux/data-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/uiux/data-store.ts')>()
  return {
    ...actual,
    loadDomain: (domain: string, root?: string) => {
      if (domain === 'style' && catalogFixture.styleRows !== undefined) {
        return { kind: 'loaded' as const, file: 'styles.csv', rows: catalogFixture.styleRows, warnings: [] }
      }
      return actual.loadDomain(domain, root)
    },
  }
})

import { DOMAIN_TABLES, STACKS } from '../src/uiux/catalog.ts'
import { clearCatalogCache } from '../src/uiux/data-store.ts'
import { UIUX_SEARCH_TOOL_NAME, uiuxSearchToolDefinition } from '../src/uiux/tool.ts'
import type { SearchRow } from '../src/uiux/search.ts'

interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly required?: readonly string[]
    readonly properties?: Readonly<Record<string, {
      readonly enum?: readonly string[]
      readonly maximum?: number
      readonly maxLength?: number
    }>>
  }
  readonly execute: (args: unknown) => unknown
  readonly presentCall: (args: unknown) => { readonly title: string }
}

/**
 * The shipped definition, with the fixture's style rows in place of the corpus's.
 *
 * Built directly rather than registered: the registration belongs to the design
 * pack now, which is what puts this tool behind the switch on the design page,
 * and `design-tools.spec` is where that is asserted. What this file is about is
 * the tool itself, so it takes the definition and calls it.
 */
function toolHarness(styleRows?: readonly SearchRow[]): { readonly tool: RegisteredTool } {
  catalogFixture.styleRows = styleRows
  clearCatalogCache()
  const definition = uiuxSearchToolDefinition()
  // Read field by field rather than asserting the object whole, and the two
  // assertions that remain are the reason: the registry's contract pins the
  // schema and leaves `execute`/`presentCall` typed as `unknown` through its
  // index signature, so a caller that means to invoke them has to say what it is
  // invoking. A definition that stopped accepting these arguments fails in the
  // case that calls it, which is where a reader would look.
  return {
    tool: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: definition.execute as RegisteredTool['execute'],
      presentCall: definition.presentCall as RegisteredTool['presentCall'],
    },
  }
}

describe('the single UI/UX catalogue tool', () => {
  it('declares the bounded, read-only tool under the name the design page lists', () => {
    const { tool } = toolHarness()
    expect(tool.name).toBe(UIUX_SEARCH_TOOL_NAME)
    expect(tool.name).toBe('freecodego_uiux_search')
    expect(tool.parameters.required).toEqual(['query'])
    expect(tool.parameters.properties?.domain?.enum).toEqual(Object.keys(DOMAIN_TABLES))
    expect(tool.parameters.properties?.stack?.enum).toEqual(STACKS)
    expect(tool.parameters.properties?.query?.maxLength).toBe(1_000)
    // The ceiling the model sees and the ceiling the tool enforces are two
    // statements about one limit, and the refusal case below is the other half.
    expect(tool.parameters.properties?.max_results?.maximum).toBe(20)
    expect(tool.description).toContain('Read-only')
  })

  it('routes a search to an explicitly selected domain and includes score diagnostics', () => {
    const { tool } = toolHarness()
    const answer = tool.execute({ query: 'accessible chart for comparing categories', domain: 'chart' }) as {
      readonly kind: string
      readonly selection: { readonly kind: string; readonly domain: string; readonly strategy: string }
      readonly outcome: {
        readonly kind: string
        readonly results: readonly Record<string, string>[]
        readonly diagnostics: {
          readonly calibrationVersion: string
          readonly scores: { readonly coverage: number }
        }
      }
    }
    expect(answer.kind).toBe('searched')
    expect(answer.selection).toEqual({ kind: 'domain', domain: 'chart', strategy: 'explicit' })
    expect(answer.outcome.kind).toBe('ok')
    expect(answer.outcome.results[0]?.['Data Type']).toBe('Compare Categories')
    expect(answer.outcome.diagnostics.calibrationVersion).toBeTruthy()
    expect(answer.outcome.diagnostics.scores.coverage).toBeGreaterThan(0)
  })

  it('automatically routes palette requests and reports an abstention instead of inventing a match', () => {
    const { tool } = toolHarness()
    const palette = tool.execute({ query: 'color palette for fintech' }) as {
      readonly selection: { readonly domain: string; readonly strategy: string }
      readonly outcome: { readonly kind: string; readonly results: readonly Record<string, string>[] }
    }
    expect(palette.selection).toMatchObject({ domain: 'color', strategy: 'automatic' })
    expect(palette.outcome.kind).toBe('ok')
    expect(palette.outcome.results[0]?.['Product Type']).toBe('Fintech/Crypto')

    const uncertain = tool.execute({ query: 'qzxv blorpting', domain: 'style' }) as {
      readonly outcome: {
        readonly kind: string
        readonly diagnostics: { readonly abstained: boolean; readonly reason: string }
        readonly results: readonly unknown[]
      }
    }
    expect(uncertain.outcome).toMatchObject({ kind: 'ok', diagnostics: { abstained: true, reason: 'low-confidence' }, results: [] })
  })

  it('searches an explicit framework table and keeps the chosen stack in the response', () => {
    const { tool } = toolHarness()
    const answer = tool.execute({ query: 'Use React.memo wisely', stack: 'react' }) as {
      readonly kind: string
      readonly selection: { readonly kind: string; readonly stack: string }
      readonly outcome: { readonly kind: string; readonly results: readonly Record<string, string>[] }
    }
    expect(answer.kind).toBe('searched')
    expect(answer.selection).toEqual({ kind: 'stack', stack: 'react' })
    expect(answer.outcome.kind).toBe('ok')
    expect(answer.outcome.results[0]?.Guideline).toBe('Use React.memo wisely')
  })

  it('refuses malformed, unknown, conflicting, and out-of-range arguments before searching', () => {
    const { tool } = toolHarness()
    for (const [args, reason] of [
      [null, 'invalid-arguments'],
      [{ query: 12 }, 'invalid-query'],
      [{ query: '   ' }, 'empty-query'],
      [{ query: 'x'.repeat(1_001) }, 'query-too-long'],
      [{ query: 'palette', domain: 'unknown' }, 'unknown-domain'],
      [{ query: 'react', stack: 'made-up' }, 'unknown-stack'],
      [{ query: 'react', domain: 'react', stack: 'react' }, 'invalid-selection'],
      [{ query: 'palette', max_results: 0 }, 'invalid-limit'],
      [{ query: 'palette', max_results: '3' }, 'invalid-limit'],
    ] as const) {
      expect(tool.execute(args), JSON.stringify(args)).toMatchObject({ kind: 'refused', reason })
    }
  })

  it('refuses ambiguous exact and contained style identities rather than picking a row', () => {
    const exact = toolHarness([
      { 'Style ID': 'first', 'Style Category': 'First', Aliases: 'shared name', Status: 'active' },
      { 'Style ID': 'second', 'Style Category': 'Second', Aliases: 'shared name', Status: 'active' },
    ])
    expect(exact.tool.execute({ query: 'shared name', domain: 'style' })).toMatchObject({
      kind: 'refused', reason: 'ambiguous-identity', domain: 'style',
    })

    const contained = toolHarness([
      { 'Style ID': 'alpha', 'Style Category': 'Alpha Frame', Status: 'active' },
      { 'Style ID': 'bravo', 'Style Category': 'Bravo Frame', Status: 'active' },
    ])
    expect(contained.tool.execute({ query: 'use Alpha Frame and Bravo Frame', domain: 'style' })).toMatchObject({
      kind: 'refused', reason: 'ambiguous-identity', domain: 'style',
    })
  })

  it('resolves exact identities and follows deprecated style redirects before ranking', () => {
    const { tool } = toolHarness()
    const style = tool.execute({ query: 'glassmorphism' }) as {
      readonly kind: string
      readonly identity: { readonly id: string; readonly reason: string }
      readonly results: readonly Record<string, string>[]
    }
    expect(style).toMatchObject({ kind: 'identity', identity: { id: 'glassmorphism', reason: 'exact-identity' } })
    expect(style.results[0]?.Status).toBe('active')

    const landing = tool.execute({ query: 'Hero-Centric + Feature-Rich', domain: 'landing' }) as {
      readonly kind: string
      readonly identity: { readonly id: string; readonly matchedBy: string }
    }
    expect(landing).toMatchObject({ kind: 'identity', identity: { id: 'hero-centric-design', matchedBy: 'Aliases' } })

    const successor = tool.execute({ query: 'bento-grids', domain: 'style' }) as {
      readonly kind: string
      readonly resultDomain: string
      readonly identity: { readonly id: string; readonly reason: string; readonly trail: readonly string[] }
    }
    expect(successor).toMatchObject({
      kind: 'identity', resultDomain: 'style',
      identity: { id: 'bento-box-grid', reason: 'style-replacement', trail: ['bento-grids'] },
    })

    const redirect = tool.execute({ query: 'hero-centric-design', domain: 'style' }) as {
      readonly kind: string
      readonly resultDomain: string
      readonly identity: { readonly reason: string; readonly id: string }
      readonly results: readonly Record<string, string>[]
    }
    expect(redirect).toMatchObject({
      kind: 'identity', resultDomain: 'landing',
      identity: { reason: 'cross-domain-redirect', id: 'hero-centric-design' },
    })
    expect(redirect.results[0]?.['Pattern ID']).toBe('hero-centric-design')
  })

  it('presents a bounded call title without trusting malformed query fields', () => {
    const { tool } = toolHarness()
    expect(tool.presentCall({ query: 'palette' }).title).toBe('UI/UX search: palette')
    expect(tool.presentCall({ query: null }).title).toBe('UI/UX search: ')
  })
})
