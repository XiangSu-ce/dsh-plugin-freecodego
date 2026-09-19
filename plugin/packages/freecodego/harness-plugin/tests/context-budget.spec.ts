import { describe, expect, it } from 'vitest'
import {
  CONTEXT_BAND_AT,
  ContextBudgetStore,
  classifyContextPressure,
  contextBudgetFragment,
  contextBudgetReport,
  describeContextBudget,
} from '../src/context-budget.ts'

describe('context pressure bands', () => {
  it('classifies at each boundary rather than between them', () => {
    const window = 100_000
    expect(classifyContextPressure(0, window)).toBe('ample')
    expect(classifyContextPressure(0.35 * window - 1, window)).toBe('ample')
    expect(classifyContextPressure(0.35 * window, window)).toBe('comfortable')
    expect(classifyContextPressure(0.6 * window, window)).toBe('tight')
    expect(classifyContextPressure(0.8 * window, window)).toBe('critical')
    expect(classifyContextPressure(window, window)).toBe('over')
    expect(classifyContextPressure(2 * window, window)).toBe('over')
    // Boundaries are exclusive at the lower edge, so a fraction sitting exactly
    // on a threshold belongs to the more constrained band.
    expect(CONTEXT_BAND_AT.tight).toBeGreaterThan(CONTEXT_BAND_AT.comfortable)
  })

  it('charges the response reserve against the usable window', () => {
    // 80k of 100k is only "tight" until a 20k reply is reserved for, at which
    // point it is at the window edge — the reserve is what makes that visible.
    expect(classifyContextPressure(80_000, 100_000)).toBe('critical')
    expect(classifyContextPressure(80_000, 100_000, 20_000)).toBe('over')
  })

  it('reports an unadvertised window as unknown instead of inventing a denominator', () => {
    const report = contextBudgetReport({ usedTokens: 40_000, measured: false })
    expect(report.band).toBe('unknown')
    expect(report.contextWindow).toBeUndefined()
    expect(report.remainingTokens).toBeUndefined()
    expect(report.usedFraction).toBeUndefined()
    const text = contextBudgetFragment(report)
    expect(text).toContain('40,000 tokens in use')
    expect(text).toContain('not advertised')
    // No fabricated percentage may appear for a window we do not know.
    expect(text).not.toMatch(/%/)
  })

  it('refuses to present a heuristic price as provider usage', () => {
    const estimated = contextBudgetFragment(contextBudgetReport({ usedTokens: 10_000, contextWindow: 100_000, measured: false }))
    expect(estimated).toContain('heuristic estimate, not provider usage')
    const measured = contextBudgetFragment(contextBudgetReport({ usedTokens: 10_000, contextWindow: 100_000, measured: true }))
    expect(measured).not.toContain('heuristic estimate')
  })

  it('never leaves a negative remaining figure', () => {
    const report = contextBudgetReport({ usedTokens: 150_000, contextWindow: 100_000, measured: true, responseReserve: 20_000 })
    // The reserve is clamped to the window, so remaining bottoms out at the
    // overrun rather than the sum of the overrun and the reserve.
    expect(report.remainingTokens).toBe(-50_000)
    // The reported reserve is the *effective* one: there was no room left to
    // reserve from, so claiming 20,000 was held back would be false.
    expect(report.responseReserve).toBe(0)
    expect(report.band).toBe('over')
    expect(contextBudgetFragment(report)).not.toContain('-70,000')
  })

  it('states the bound rather than a threshold to obey', () => {
    const text = contextBudgetFragment(contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true }))
    expect(text).toContain('tight')
    expect(text).toContain('Compacting or snipping now costs less than compacting later')
    // No band may order a specific action at a specific count, because the model
    // can see the real numbers and we can only see an estimate.
    expect(text).not.toMatch(/you must/i)
  })

  it('describes the same numbers in one line for a reader', () => {
    const report = contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true, responseReserve: 8_000 })
    const line = describeContextBudget(report)
    expect(line).toContain('70,000 tokens used of 100,000 (70%)')
    expect(line).toContain('22,000 remaining')
    expect(line).toContain('tight')
    expect(describeContextBudget(contextBudgetReport({ usedTokens: 5, measured: true }))).toContain('no remaining figure is available')
  })
})

describe('budget injection stays cache-stable', () => {
  it('does not ask for a new fragment while the band is unchanged', () => {
    const store = new ContextBudgetStore()
    const first = store.plan('s1', contextBudgetReport({ usedTokens: 36_000, contextWindow: 100_000, measured: true }))
    // The first plan for an unseen session must inject, or the model never learns.
    expect(first.changed).toBe(true)
    expect(first.band).toBe('comfortable')
    store.commit('s1', first.band)

    // Movement inside the band is exactly the case that must not rewrite the
    // prefix: it is why the text is quantized instead of printed per turn.
    for (const used of [37_000, 40_000, 50_000, 59_999]) {
      expect(store.plan('s1', contextBudgetReport({ usedTokens: used, contextWindow: 100_000, measured: true })).changed).toBe(false)
    }
    const crossed = store.plan('s1', contextBudgetReport({ usedTokens: 60_000, contextWindow: 100_000, measured: true }))
    expect(crossed.changed).toBe(true)
    expect(crossed.band).toBe('tight')
  })

  it('keeps sessions independent and re-announces after a forget', () => {
    const store = new ContextBudgetStore()
    const report = contextBudgetReport({ usedTokens: 10_000, contextWindow: 100_000, measured: true })
    store.commit('s1', store.plan('s1', report).band)
    expect(store.bandFor('s1')).toBe('ample')
    expect(store.bandFor('s2')).toBeUndefined()
    // A second session must be told even though the first one already was.
    expect(store.plan('s2', report).changed).toBe(true)
    store.forget('s1')
    expect(store.plan('s1', report).changed).toBe(true)
    store.clear()
    expect(store.bandFor('s1')).toBeUndefined()
  })

  it('does not record a plan the caller never sent', () => {
    const store = new ContextBudgetStore()
    const report = contextBudgetReport({ usedTokens: 90_000, contextWindow: 100_000, measured: true })
    const plan = store.plan('s1', report)
    expect(plan.band).toBe('critical')
    // Measured but unsent: nothing committed, so the store still reports the
    // model as uninformed and the next turn will inject.
    expect(store.bandFor('s1')).toBeUndefined()
    expect(store.plan('s1', report).changed).toBe(true)
  })

  it('says a new figure replaces the earlier one when a band was already announced', () => {
    // The fragment is *appended*, so crossing a band leaves two figures in the
    // conversation. Without a line saying which one is current, the model is
    // holding a stale number and a fresh one with nothing to choose between them
    // — worst when a compaction drops the band back down.
    const store = new ContextBudgetStore()
    const first = store.plan('s1', contextBudgetReport({ usedTokens: 10_000, contextWindow: 100_000, measured: true }))
    expect(first.text).not.toContain('replaces')
    store.commit('s1', first.band)
    const crossed = store.plan('s1', contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true }))
    expect(crossed.changed).toBe(true)
    expect(crossed.text).toContain('replaces')
    expect(crossed.text).toContain('Context budget (tight)')
    // A session nothing is known about introduces itself instead of replacing.
    store.forget('s1')
    expect(store.plan('s1', contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true })).text).not.toContain('replaces')
  })

  it('treats a changing window as a band change', () => {
    // A model switch mid-session changes both the prefix and the denominator, so
    // the fragment has to reappear even at a constant used count.
    const store = new ContextBudgetStore()
    store.commit('s1', store.plan('s1', contextBudgetReport({ usedTokens: 40_000, contextWindow: 200_000, measured: true })).band)
    expect(store.bandFor('s1')).toBe('ample')
    const afterSwitch = store.plan('s1', contextBudgetReport({ usedTokens: 40_000, contextWindow: 50_000, measured: true }))
    expect(afterSwitch.changed).toBe(true)
    expect(afterSwitch.band).toBe('critical')
  })
})
