import { describe, expect, it } from 'vitest'
import {
  CONTEXT_BAND_AT,
  CONTEXT_BUFFER_BOUNDS,
  CONTEXT_BUFFER_TOKENS,
  ContextBudgetStore,
  REFERENCE_WINDOW_TOKENS,
  classifyContextPressure,
  contextBudgetFragment,
  contextBudgetReport,
  contextBufferForWindow,
  describeContextBudget,
  scaleThresholdToWindow,
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

describe('a fixed threshold scales to the window in use', () => {
  const bounds = { min: 256, max: 1_000_000 }

  it('returns the figure unchanged at the reference window and for an unknown one', () => {
    expect(scaleThresholdToWindow(1_200, REFERENCE_WINDOW_TOKENS, bounds)).toBe(1_200)
    // No window is the case the fixed number was always for, so the behaviour
    // before this existed is what remains rather than a guessed denominator.
    expect(scaleThresholdToWindow(1_200, undefined, bounds)).toBe(1_200)
    expect(scaleThresholdToWindow(1_200, 0, bounds)).toBe(1_200)
  })

  it('holds the share of the window constant across models', () => {
    expect(scaleThresholdToWindow(1_200, 8_000, bounds)).toBe(256)
    expect(scaleThresholdToWindow(1_200, 32_000, bounds)).toBe(300)
    expect(scaleThresholdToWindow(1_200, 1_000_000, bounds)).toBe(9_375)
  })

  it('clamps into the bounds the caller owns', () => {
    // A threshold below the smallest payload worth a rewrite, or above the largest
    // useful one, is a policy decision the caller made — this function only knows
    // how to scale.
    expect(scaleThresholdToWindow(2_000, 32_000, { min: 500, max: 100_000 })).toBe(500)
    expect(scaleThresholdToWindow(2_000, 10_000_000, { min: 500, max: 100_000 })).toBe(100_000)
  })
})

describe('the fixed slack held back for what no compressor can shrink', () => {
  it('scales with the window and clamps into the buffer bounds', () => {
    expect(contextBufferForWindow(REFERENCE_WINDOW_TOKENS)).toBe(CONTEXT_BUFFER_TOKENS)
    // A 32k window holds a quarter of it back — 5,000 — because the share of the
    // window is what has to stay constant, not the token count.
    expect(contextBufferForWindow(32_000)).toBe(5_000)
    // The floor: below it the slack is smaller than the window's own granularity.
    expect(contextBufferForWindow(8_000)).toBe(CONTEXT_BUFFER_BOUNDS.min)
    // The ceiling: past it the buffer would hold back more than a session can keep.
    expect(contextBufferForWindow(1_000_000)).toBe(CONTEXT_BUFFER_BOUNDS.max)
    // An unnoticed window still answers the reference figure; the caller is what
    // decides not to hold anything back without a denominator.
    expect(contextBufferForWindow(undefined)).toBe(CONTEXT_BUFFER_TOKENS)
  })

  it('is charged against the same room as the reply reserve, and moves the band', () => {
    // 80k of 100k with no reserve is "critical"; holding 20k of slack in addition
    // to the 5k reply makes it "over" — the window never had the room the plain
    // fraction claimed, because the tool schemas in it cannot be compacted away.
    expect(contextBudgetReport({ usedTokens: 80_000, contextWindow: 100_000, measured: true }).band).toBe('critical')
    const withBuffer = contextBudgetReport({ usedTokens: 80_000, contextWindow: 100_000, measured: true, responseReserve: 5_000, buffer: 20_000 })
    expect(withBuffer.band).toBe('over')
    // The 20k of room that is left is all either claim may take, and the piece it
    // gives up is the buffer: 5k reserved for the reply, 15k of the 20k held back.
    expect(withBuffer.responseReserve).toBe(5_000)
    expect(withBuffer.buffer).toBe(15_000)
    expect(withBuffer.remainingTokens).toBe(0)
  })

  it('gives the buffer way first when there is not room for both claims', () => {
    // 10k of room cannot hold a 20k buffer and an 8k reserve. The reply reserve is
    // the part the next turn needs, so it is preserved and the slack shrinks to
    // what is left rather than the shortfall counting both.
    const report = contextBudgetReport({ usedTokens: 90_000, contextWindow: 100_000, measured: true, responseReserve: 8_000, buffer: 20_000 })
    expect(report.responseReserve).toBe(8_000)
    expect(report.buffer).toBe(2_000)
    expect(report.remainingTokens).toBe(0)
    // Over the window: neither claim can be held, and the shortfall stays the
    // overrun rather than the overrun plus figures that were never reserved.
    const past = contextBudgetReport({ usedTokens: 150_000, contextWindow: 100_000, measured: true, responseReserve: 8_000, buffer: 20_000 })
    expect(past.responseReserve).toBe(0)
    expect(past.buffer).toBe(0)
    expect(past.remainingTokens).toBe(-50_000)
  })

  it('names the two held-back figures separately, because they are spent differently', () => {
    const text = contextBudgetFragment(contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true, responseReserve: 5_000, buffer: 10_000 }))
    expect(text).toContain('reserving 5,000 for the reply')
    expect(text).toContain('holding 10,000 as fixed headroom for tool schemas and instructions')
    expect(text).toContain('15,000 left')
    expect(describeContextBudget(contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true, responseReserve: 5_000, buffer: 10_000 })))
      .toContain('a 5,000-token reply reserve and 10,000 of fixed headroom')
    // With no buffer — every caller that passes none — the text is the one from
    // before the figure existed, byte for byte.
    const plain = contextBudgetFragment(contextBudgetReport({ usedTokens: 70_000, contextWindow: 100_000, measured: true, responseReserve: 5_000 }))
    expect(plain).toContain('left after reserving 5,000 for the reply.')
    expect(plain).not.toContain('headroom')
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
