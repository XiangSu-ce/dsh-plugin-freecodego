/** Cover the wait for a publish the registry acknowledged asynchronously. */

import { describe, expect, it } from 'vitest'
import { awaitRegistryState, FAILED_UPLOAD_PROBE_MS, SETTLE_TIMEOUT_MS } from './registry.ts'

/** A read that answers from a script, counting how often it was asked. */
function scriptedRead(states: readonly ('absent' | 'present')[]): { reads: () => number; read: () => { kind: 'absent' } | { kind: 'present'; integrity: string } } {
  let reads = 0
  return {
    reads: () => reads,
    read: () => {
      const state = states[Math.min(reads, states.length - 1)] ?? 'absent'
      reads += 1
      return state === 'absent' ? { kind: 'absent' } : { kind: 'present', integrity: 'sha512-packed' }
    },
  }
}

describe('awaitRegistryState', () => {
  it('answers a version the registry already carries without waiting', async () => {
    const script = scriptedRead(['present'])

    const state = await awaitRegistryState('freecodego', '0.1.6-alpha.2.3', {
      intervalMs: 1,
      read: script.read,
    })

    expect(state).toEqual({ kind: 'present', integrity: 'sha512-packed' })
    expect(script.reads()).toBe(1)
  })

  it('keeps asking while the registry answers 404, and reports the version that arrives', async () => {
    const script = scriptedRead(['absent', 'absent', 'present'])

    const state = await awaitRegistryState('freecodego', '0.1.6-alpha.2.3', {
      intervalMs: 1,
      read: script.read,
    })

    expect(state.kind).toBe('present')
    expect(script.reads()).toBe(3)
  })

  it('reports a version that never appears as absent rather than waiting forever', async () => {
    const script = scriptedRead(['absent'])

    const state = await awaitRegistryState('freecodego', '0.1.6-alpha.2.3', {
      timeoutMs: 15,
      intervalMs: 5,
      read: script.read,
    })

    expect(state).toEqual({ kind: 'absent' })
    expect(script.reads()).toBeGreaterThan(1)
  })
})

describe('the budgets', () => {
  it('probes a failed upload for less than it waits on an accepted one', () => {
    // Every publish attempt pays the probe before deciding whether to retry, so
    // it cannot be as long as the wait a single accepted upload is given.
    expect(FAILED_UPLOAD_PROBE_MS).toBeLessThan(SETTLE_TIMEOUT_MS)
  })

  it('gives a settled publish at least the few minutes npm promises', () => {
    expect(SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
  })
})
