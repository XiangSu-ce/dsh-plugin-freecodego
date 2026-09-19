/**
 * The breakdown's whole claim is that its rows sum to a number the provider
 * actually reported, and that consecutive snapshots are comparable. Both are
 * invariants, not features, so they are pinned here: the apportionment must be
 * exact, an unmeasured snapshot must say so, a nonsense apportionment must be
 * discarded rather than rendered, and compaction must move one row.
 */

import { describe, expect, it } from 'vitest'
import {
  PROMPT_USAGE_INLINE_MAX_CHARS,
  PROMPT_USAGE_TREE_MAX_NODES,
  apportionToTotal,
  buildPromptComposition,
  buildPromptUsageTree,
  countCategoryChars,
  describePromptComposition,
  estimateTokensFromChars,
  refreshPromptCompositionAfterCompaction,
  type PromptUsageItem,
} from '../src/prompt-composition.ts'

const sources = (overrides: Partial<Record<string, readonly string[]>> = {}): Parameters<typeof buildPromptComposition>[0]['sources'] => ({
  'system-prompt': ['s'.repeat(400)],
  tools: ['t'.repeat(800)],
  conversation: ['c'.repeat(1200)],
  ...overrides,
})

describe('apportionment', () => {
  it('splits a whole without changing it, for any weighting', () => {
    // The property that matters: rows sum to the total, always. Rounding each
    // share independently is exactly the bug this replaces.
    for (const total of [1, 3, 7, 999, 13_454, 1_000_003]) {
      const weights = { 'system-prompt': 137, tools: 941, rules: 0, skills: 1, mcp: 22, subagents: 3, summary: 0, conversation: 4001 }
      const split = apportionToTotal(weights, total)
      const sum = Object.values(split).reduce((a, b) => a + b, 0)
      expect(sum).toBe(total)
    }
  })

  it('is deterministic across equal remainders', () => {
    const weights = { 'system-prompt': 1, tools: 1, rules: 1, skills: 1, mcp: 0, subagents: 0, summary: 0, conversation: 0 }
    expect(apportionToTotal(weights, 2)).toEqual(apportionToTotal(weights, 2))
  })

  it('leaves the whole in the residual when there is nothing to weight by', () => {
    const split = apportionToTotal({ 'system-prompt': 0, tools: 0, rules: 0, skills: 0, mcp: 0, subagents: 0, summary: 0, conversation: 0 }, 500)
    expect(split.conversation).toBe(500)
  })

  it('reports zero for a zero total', () => {
    expect(Object.values(apportionToTotal({ 'system-prompt': 9, tools: 9, rules: 0, skills: 0, mcp: 0, subagents: 0, summary: 0, conversation: 0 }, 0)).every(value => value === 0)).toBe(true)
  })
})

describe('composition snapshot', () => {
  it('counts characters exactly, whether or not tokens can be', () => {
    const chars = countCategoryChars(sources())
    expect(chars['system-prompt']).toBe(400)
    expect(chars.tools).toBe(800)
    expect(chars.conversation).toBe(1200)
    expect(chars.rules).toBe(0)
  })

  it('sums to the measured total and labels itself measured', () => {
    const snapshot = buildPromptComposition({ sources: sources(), measuredPromptTokens: 13_454 })
    expect(snapshot.measured).toBe(true)
    expect(snapshot.consistent).toBe(true)
    expect(snapshot.totalTokens).toBe(13_454)
    expect(snapshot.categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(13_454)
    // The report is about the provider's number, and the provider's number is
    // far larger than the text we could see — the rows are apportioned, not
    // claimed as measured.
    expect(snapshot.categories.find(category => category.id === 'tools')!.tokens).toBeGreaterThan(200)
  })

  it('says it is an estimate when no measurement exists', () => {
    const snapshot = buildPromptComposition({ sources: sources() })
    expect(snapshot.measured).toBe(false)
    expect(snapshot.measuredPromptTokens).toBeUndefined()
    expect(snapshot.consistent).toBe(true)
    expect(snapshot.totalTokens).toBe(
      snapshot.categories.reduce((sum, category) => sum + category.tokens, 0),
    )
    expect(snapshot.totalTokens).toBe(estimateTokensFromChars(2400))
  })

  it('keeps an unchanged category byte-identical between turns', () => {
    const previous = buildPromptComposition({ sources: sources(), measuredPromptTokens: 9_000 })
    const next = buildPromptComposition({
      sources: sources({ conversation: ['c'.repeat(2000)] }),
      measuredPromptTokens: 9_800,
      previous,
    })
    const unchanged = (id: string): number => next.categories.find(category => category.id === id)!.tokens
    expect(unchanged('tools')).toBe(previous.categories.find(category => category.id === 'tools')!.tokens)
    // The growth landed in the residual, which is where it belongs.
    expect(unchanged('conversation')).toBeGreaterThan(previous.categories.find(category => category.id === 'conversation')!.tokens)
    expect(next.consistent).toBe(true)
  })

  it('discards an apportionment whose parts exceed the whole', () => {
    // A previous turn whose cacheable rows were huge, against a measured total
    // that shrank: the ratios resolve past the total, and a table that cannot be
    // true must not be rendered.
    const previous = buildPromptComposition({
      sources: { 'system-prompt': ['s'.repeat(40_000)], tools: ['t'.repeat(40_000)], conversation: [] },
      measuredPromptTokens: 20_000,
    })
    const next = buildPromptComposition({
      sources: { 'system-prompt': ['s'.repeat(40_000)], tools: ['t'.repeat(40_000)], conversation: [] },
      measuredPromptTokens: 100,
      previous,
    })
    expect(next).toBe(previous)
  })

  it('renders the basis and omits empty rows', () => {
    const measured = describePromptComposition(buildPromptComposition({ sources: sources(), measuredPromptTokens: 5_000 }))
    expect(measured).toContain("provider's measured prompt")
    expect(measured).not.toContain('Rules:')
    const estimated = describePromptComposition(buildPromptComposition({ sources: sources() }))
    expect(estimated).toContain('lexical estimate')
  })
})

describe('compaction refresh', () => {
  it('moves only the summary row and re-balances the residual', () => {
    const before = buildPromptComposition({
      sources: { 'system-prompt': ['s'.repeat(400)], tools: ['t'.repeat(800)], conversation: ['c'.repeat(40_000)] },
      measuredPromptTokens: 20_000,
      contextWindow: 100_000,
    })
    const after = refreshPromptCompositionAfterCompaction(before, 2_000, { measuredPromptTokens: 6_000 })
    const row = (snapshot: typeof before, id: string): number => snapshot.categories.find(category => category.id === id)!.tokens
    expect(row(after, 'tools')).toBe(row(before, 'tools'))
    expect(row(after, 'system-prompt')).toBe(row(before, 'system-prompt'))
    expect(row(after, 'summary')).toBeGreaterThan(0)
    expect(row(after, 'conversation')).toBe(6_000 - row(after, 'system-prompt') - row(after, 'tools') - row(after, 'summary'))
    expect(after.consistent).toBe(true)
    expect(after.contextWindow).toBe(100_000)
  })

  it('keeps the previous snapshot when the summary cannot fit', () => {
    const before = buildPromptComposition({ sources: { 'system-prompt': ['s'.repeat(40_000)], conversation: [] }, measuredPromptTokens: 10_000 })
    expect(refreshPromptCompositionAfterCompaction(before, 40_000, { measuredPromptTokens: 200 })).toBe(before)
  })
})

describe('usage tree', () => {
  const snapshot = buildPromptComposition({ sources: sources(), measuredPromptTokens: 5_000 })

  it('roots every category, including the empty ones', () => {
    const tree = buildPromptUsageTree(snapshot, [])
    expect(tree.nodes).toHaveLength(8)
    expect(tree.nodes.every(node => node.kind === 'category')).toBe(true)
    expect(tree.nodes.find(node => node.label === 'Tool definitions')!.tokens).toBeGreaterThan(0)
  })

  it('pairs a tool call with its result under one parent', () => {
    const items: PromptUsageItem[] = [
      { id: 'call-1', label: 'read_file', categoryId: 'conversation', text: '{"path":"a.ts"}', callId: 'c1', role: 'call' },
      { id: 'result-1', label: 'read_file', categoryId: 'conversation', text: 'export {}', callId: 'c1', role: 'result' },
    ]
    const tree = buildPromptUsageTree(snapshot, items)
    const pair = tree.nodes.find(node => node.kind === 'pair')
    expect(pair).toBeDefined()
    const children = tree.nodes.filter(node => node.parentId === pair!.id)
    expect(children).toHaveLength(2)
    // No item node should sit directly under the category for a paired call.
    expect(tree.nodes.filter(node => node.kind === 'item' && node.parentId === 'category:conversation')).toHaveLength(0)
  })

  it('leaves an unanswered call as a pair with one child', () => {
    // The interrupted-turn shape: the call is in the transcript and its result
    // never arrived, which a reader must be able to see.
    const items: PromptUsageItem[] = [
      { id: 'call-9', label: 'bash', categoryId: 'conversation', text: 'pnpm test', callId: 'c9', role: 'call' },
    ]
    const tree = buildPromptUsageTree(snapshot, items)
    const pair = tree.nodes.find(node => node.id === 'pair:c9')
    expect(pair).toBeDefined()
    expect(tree.nodes.filter(node => node.parentId === 'pair:c9')).toHaveLength(1)
  })

  it('references large text instead of embedding it, and embeds small text', () => {
    const items: PromptUsageItem[] = [
      { id: 'small', label: 'Small', categoryId: 'rules', text: 'short' },
      { id: 'big', label: 'Big', categoryId: 'tools', text: 'x'.repeat(PROMPT_USAGE_INLINE_MAX_CHARS + 1) },
    ]
    const tree = buildPromptUsageTree(snapshot, items)
    expect(tree.nodes.find(node => node.id === 'small')!.content).toMatchObject({ kind: 'inline' })
    expect(tree.nodes.find(node => node.id === 'big')!.content).toEqual({ kind: 'blob', ref: 'big' })
  })

  it('counts redacted reasoning as omitted rather than showing it', () => {
    const tree = buildPromptUsageTree(snapshot, [
      { id: 'r', label: 'thinking', categoryId: 'conversation', text: 'secret reasoning', redacted: true },
      { id: 'k', label: 'kept', categoryId: 'conversation', text: 'visible' },
    ])
    expect(tree.omittedRedacted).toBe(1)
    expect(tree.nodes.some(node => node.id === 'r')).toBe(false)
    expect(tree.nodes.some(node => node.id === 'k')).toBe(true)
  })

  it('stays bounded whatever it is handed', () => {
    const items: PromptUsageItem[] = Array.from({ length: PROMPT_USAGE_TREE_MAX_NODES * 3 }, (_, index) => ({
      id: `item-${String(index)}`,
      label: `Item ${String(index)}`,
      categoryId: 'conversation' as const,
      text: 'x',
    }))
    const tree = buildPromptUsageTree(snapshot, items)
    expect(tree.nodes.length).toBeLessThanOrEqual(PROMPT_USAGE_TREE_MAX_NODES)
    // Never silently: the caller is told that items were left out.
    expect(tree.truncated).toBe(true)
    expect(tree.omittedItems).toBeGreaterThan(0)
    // And told *how many*: the count is what makes "the tree is bounded"
    // falsifiable, and stopping the walk at the first refusal reported "1" for
    // a transcript that had hundreds of entries left. Nodes are the category
    // roots plus the items that fit, so the arithmetic closes exactly.
    const categoryNodes = tree.nodes.filter(node => node.kind === 'category').length
    expect(tree.omittedItems).toBe(items.length - (tree.nodes.length - categoryNodes))
    expect(tree.omittedItems).toBeGreaterThan(1)
  })

  it('counts both members of a pair the budget could not place', () => {
    // A call and its result are two entries of the prompt; when the budget is
    // already spent the reader is owed both of them in the omission count, not
    // one pair-shaped unit.
    const calls: PromptUsageItem[] = Array.from({ length: PROMPT_USAGE_TREE_MAX_NODES }, (_, index) => ({
      id: `call-${String(index)}`,
      label: `Call ${String(index)}`,
      categoryId: 'conversation' as const,
      text: 'x',
      callId: `c-${String(index)}`,
      role: 'call' as const,
    }))
    // The callback only needs the index: each result is built from it, not from
    // the call it pairs with. Prefixed so `noUnusedParameters` does not read the
    // pair relationship as an unused binding.
    const results: PromptUsageItem[] = calls.map((_call, index) => ({
      id: `result-${String(index)}`,
      label: `Result ${String(index)}`,
      categoryId: 'conversation' as const,
      text: 'y',
      callId: `c-${String(index)}`,
      role: 'result' as const,
    }))
    const tree = buildPromptUsageTree(snapshot, [...calls, ...results])
    // Every entry is either in the tree or counted as omitted; none vanishes.
    const accounted = tree.nodes.filter(node => node.kind === 'item').length + tree.omittedItems + tree.omittedRedacted
    expect(accounted).toBe(calls.length + results.length)
  })
})
