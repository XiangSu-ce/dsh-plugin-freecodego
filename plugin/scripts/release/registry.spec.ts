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

  it('clears the slowest registry commit two releases measured, with margin', () => {
    // `0.1.7-rc.2.2` and `0.1.7-alpha.2.2` are the two releases a 180s budget
    // failed: their packuments put the version becoming readable 316s and 375s
    // after the publish step invoked npm. A budget has to clear the slower of
    // those — and clear it by enough that a slower afternoon does not put the
    // "re-run jobs" button back in the release procedure.
    expect(SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 375_000)
  })
})

describe('what a wait says while it waits', () => {
  it('says nothing when the registry already carries the version', async () => {
    const script = scriptedRead(['present'])
    const said: string[] = []

    await awaitRegistryState('freecodego', '0.1.7-rc.2.3', {
      intervalMs: 1,
      read: script.read,
      report: message => said.push(message),
    })

    expect(said).toEqual([])
  })

  it('names the version and the budget before waiting, then reports while it waits', async () => {
    // A version that appears only after some real time has passed, so the
    // reporting cadence is exercised rather than the start line alone.
    const started = Date.now()
    const read = (): { kind: 'absent' } | { kind: 'present'; integrity: string } =>
      Date.now() - started < 60 ? { kind: 'absent' } : { kind: 'present', integrity: 'sha512-packed' }
    const said: string[] = []

    const state = await awaitRegistryState('freecodego', '0.1.7-rc.2.3', {
      timeoutMs: 3_000,
      intervalMs: 10,
      reportEveryMs: 25,
      read,
      report: message => said.push(message),
    })

    expect(state.kind).toBe('present')
    expect(said[0]).toContain('freecodego@0.1.7-rc.2.3')
    expect(said[0]).toContain('waiting up to 3s')
    // The start line is not the only one: a wait of minutes has to show that it
    // is still going, or the step it is in reads as hung.
    expect(said.length).toBeGreaterThan(1)
    expect(said[1]).toContain('still not readable')
  })

  it('reports only the wait itself for a version that never appears', async () => {
    const said: string[] = []

    const state = await awaitRegistryState('freecodego', '0.1.7-rc.2.3', {
      timeoutMs: 60,
      intervalMs: 10,
      reportEveryMs: 20,
      read: () => ({ kind: 'absent' }),
      report: message => said.push(message),
    })

    expect(state).toEqual({ kind: 'absent' })
    // Every line is about the wait itself; the failure is the caller's to report.
    for (const message of said) expect(message).toContain('freecodego@0.1.7-rc.2.3')
  })
})
