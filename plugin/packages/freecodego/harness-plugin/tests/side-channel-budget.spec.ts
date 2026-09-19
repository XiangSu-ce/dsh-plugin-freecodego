import { describe, expect, it } from 'vitest'
import { SIDE_CHANNEL_WARN_RATIO, SideChannelLedger, approximateChannelTokens, evaluateSideChannelBudget } from '../src/side-channel-budget.ts'

const observation = (overrides: Partial<Parameters<SideChannelLedger['record']>[0]> = {}): Parameters<SideChannelLedger['record']>[0] => ({
  channel: 'advisor',
  sessionId: 's1',
  at: 1,
  mainLoopTokens: 40_000,
  compactionThresholdTokens: 100_000,
  channelTokens: 10_000,
  ...overrides,
})

describe('side-channel budget invariant', () => {
  it('measures against the compaction threshold, not the current conversation size', () => {
    // The yardstick is what decides whether the conversation gets compacted first.
    // A channel measured only against a not-yet-grown main loop reads as safe in
    // exactly the situation that breaks it.
    const verdict = evaluateSideChannelBudget({ mainLoopTokens: 5_000, compactionThresholdTokens: 100_000, channelTokens: 95_000 })
    expect(verdict.state).toBe('narrow')
    expect(verdict.deltaTokens).toBe(90_000)
    expect(verdict.ratio).toBeCloseTo(0.95)
  })

  it('calls a channel that reaches the threshold exceeding, and says why it is confusing', () => {
    const verdict = evaluateSideChannelBudget({ mainLoopTokens: 10_000, compactionThresholdTokens: 100_000, channelTokens: 100_000 })
    expect(verdict.state).toBe('exceeds')
    expect(verdict.detail).toContain('before the conversation does')
    expect(verdict.detail).toContain('look like a broken')
  })

  it('warns before the crossing so it is still fixable', () => {
    const atLine = evaluateSideChannelBudget({ mainLoopTokens: 1_000, compactionThresholdTokens: 100_000, channelTokens: 100_000 * SIDE_CHANNEL_WARN_RATIO })
    expect(atLine.state).toBe('narrow')
    const below = evaluateSideChannelBudget({ mainLoopTokens: 1_000, compactionThresholdTokens: 100_000, channelTokens: 100_000 * SIDE_CHANNEL_WARN_RATIO - 1 })
    expect(below.state).toBe('fits')
    expect(below.detail).toContain('delta vs the conversation')
  })

  it('says unknown rather than safe when the threshold cannot be known', () => {
    // "Cannot check" must not render as "fine", which is the whole reason the
    // state exists.
    for (const input of [
      { mainLoopTokens: 1, compactionThresholdTokens: 0, channelTokens: 1 },
      { mainLoopTokens: 1, compactionThresholdTokens: Number.NaN, channelTokens: 1 },
      { mainLoopTokens: 1, compactionThresholdTokens: 100, channelTokens: Number.NaN },
      { mainLoopTokens: 1, compactionThresholdTokens: 100, channelTokens: -1 },
    ]) {
      expect(evaluateSideChannelBudget(input).state).toBe('unknown')
    }
  })

  it('estimates tokens with the documented convention', () => {
    expect(approximateChannelTokens('')).toBe(0)
    expect(approximateChannelTokens('a'.repeat(4))).toBe(1)
    expect(approximateChannelTokens('a'.repeat(5))).toBe(2)
  })
})

describe('side-channel ledger', () => {
  it('retains the worst footprint per channel, not the latest', () => {
    // The invariant is a worst-case property: a small last call proves nothing
    // about a channel that was over the line earlier.
    const ledger = new SideChannelLedger()
    ledger.record(observation({ at: 1, channelTokens: 90_000 }))
    ledger.record(observation({ at: 2, channelTokens: 1_000 }))
    expect(ledger.worst('advisor')?.channelTokens).toBe(90_000)
    expect(ledger.worst('advisor')?.at).toBe(1)
  })

  it('evicts the least recently recorded channel, not the least recently grown one', () => {
    // Eviction is a recency rule with a bounded map, and the map is also the list
    // the warning surface reads. A channel that is called every turn but whose
    // prompt stopped growing must not be dropped from it: "the prompt is stable"
    // is not "the channel is gone".
    const ledger = new SideChannelLedger(3)
    ledger.record(observation({ channel: 'advisor', channelTokens: 10_000 }))
    ledger.record(observation({ channel: 'architecture', channelTokens: 20_000 }))
    ledger.record(observation({ channel: 'security', channelTokens: 20_000 }))
    // The advisor is used again at the same size, then a fourth channel appears.
    ledger.record(observation({ channel: 'advisor', channelTokens: 10_000 }))
    ledger.record(observation({ channel: 'testing', channelTokens: 30_000 }))
    expect(ledger.channels()).toContain('advisor')
    expect(ledger.channels()).not.toContain('architecture')
    // The standing tax includes every channel still in use, not only the growing.
    expect(ledger.totalTokens()).toBe(60_000)
  })

  it('ranks warnings worst first and leaves unknown channels out', () => {
    const ledger = new SideChannelLedger()
    // Both are past the warn line; only the ranking is under test here.
    ledger.record(observation({ channel: 'advisor', channelTokens: 82_000 }))
    ledger.record(observation({ channel: 'classifier', channelTokens: 95_000 }))
    ledger.record(observation({ channel: 'unmeasurable', compactionThresholdTokens: 0 }))
    const warnings = ledger.warnings(100_000)
    expect(warnings.map(entry => entry.channel)).toEqual(['classifier', 'advisor'])
    // Reporting an unmeasurable channel as a problem would train the reader to
    // ignore the list.
    expect(warnings.some(entry => entry.channel === 'unmeasurable')).toBe(false)
  })

  it('sums the standing side-channel tax across channels', () => {
    const ledger = new SideChannelLedger()
    ledger.record(observation({ channel: 'advisor', channelTokens: 12_000 }))
    ledger.record(observation({ channel: 'classifier', channelTokens: 3_000 }))
    expect(ledger.totalTokens()).toBe(15_000)
    expect([...ledger.channels()].sort()).toEqual(['advisor', 'classifier'])
  })

  it('evicts the oldest channel past the cap', () => {
    const ledger = new SideChannelLedger(2)
    ledger.record(observation({ channel: 'a' }))
    ledger.record(observation({ channel: 'b' }))
    ledger.record(observation({ channel: 'c' }))
    expect(ledger.worst('a')).toBeUndefined()
    expect([...ledger.channels()].sort()).toEqual(['b', 'c'])
    ledger.forget('b')
    expect(ledger.channels()).toEqual(['c'])
    ledger.clear()
    expect(ledger.channels()).toEqual([])
  })
})
