/**
 * The drain's contract is a deadline, not a guarantee: it settles what it can,
 * times out whatever it cannot, and never turns the failure of an abandoned
 * write into an unhandled rejection at teardown. All four are pinned here.
 */

import { describe, expect, it } from 'vitest'
import { PendingWriteDrain } from '../src/abort-drain.ts'

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('pending write drain', () => {
  it('settles tracked writes and reports them drained', async () => {
    const drain = new PendingWriteDrain(500)
    const latch = Promise.resolve('done')
    void drain.track(latch)
    expect(drain.inflight).toBe(1)
    const outcome = await drain.drain()
    expect(outcome).toMatchObject({ drained: 1, remaining: 0, timedOut: false })
    expect(drain.inflight).toBe(0)
  })

  it('times out bounded and reports what is still in flight', async () => {
    const drain = new PendingWriteDrain(30)
    void drain.track(new Promise(() => undefined))
    const started = Date.now()
    const outcome = await drain.drain()
    expect(outcome.timedOut).toBe(true)
    expect(outcome.remaining).toBe(1)
    // Bounded: the drain must not hang on a promise that never settles.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('never rejects, even when a tracked write rejects while it drains', async () => {
    const drain = new PendingWriteDrain(200)
    const promise = drain.track(tick(10).then(() => { throw new Error('disk full') }))
    // The drain runs while the write is still in flight — the teardown case —
    // and settles without throwing even though the write rejects.
    const outcome = await drain.drain()
    await expect(promise).rejects.toThrow('disk full')
    expect(outcome.drained).toBe(1)
    expect(outcome.remaining).toBe(0)
    expect(outcome.failed).toBeGreaterThan(0)
  })

  it('tracks a synchronous throw from the run wrapper as a failed write', async () => {
    const drain = new PendingWriteDrain(200)
    const promise = drain.run(() => { throw new Error('sync failure') })
    await expect(promise).rejects.toThrow('sync failure')
    // Already settled, so the drain waited on nothing — but the failure is still
    // named, because a rejection nobody counts is the one that goes unnoticed.
    const outcome = await drain.drain()
    expect(outcome).toMatchObject({ drained: 0, remaining: 0, timedOut: false })
    expect(outcome.failed).toBe(1)
  })

  it('counts only this drain\'s batch when a write is added mid-drain', async () => {
    // The batch is snapshotted when the drain starts, while the tracked set can
    // still grow behind it (another turn finishing its own write). Counting the
    // set instead of the batch made `drained` describe writes this drain never
    // waited for.
    const drain = new PendingWriteDrain(500)
    const first = drain.track(tick(10).then(() => 'first'))
    const draining = drain.drain()
    void drain.track(new Promise(() => undefined))
    void drain.track(new Promise(() => undefined))
    await first
    const outcome = await draining
    // Before the fix this read `1 - 2` — a *negative* number of writes that had
    // already settled, because the live set grew behind the snapshot.
    expect(outcome.drained).toBe(1)
    expect(outcome.remaining).toBe(0)
    expect(outcome.timedOut).toBe(false)
    // Writes that arrived after the snapshot are still tracked; `inflight` is
    // where a caller sees them.
    expect(drain.inflight).toBe(2)
  })

  it('waits for writes added before the drain started, and reports an empty drain', async () => {
    const drain = new PendingWriteDrain(500)
    void drain.track(tick(20).then(() => 'ok'))
    expect((await drain.drain()).remaining).toBe(0)
    // An empty drain is a settled no-op, not an error.
    expect(await drain.drain()).toMatchObject({ drained: 0, remaining: 0, timedOut: false })
  })

  it('supports an explicit shorter deadline per drain', async () => {
    const drain = new PendingWriteDrain(5_000)
    void drain.track(new Promise(() => undefined))
    const outcome = await drain.drain({ timeoutMs: 20 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.timeoutMs).toBe(20)
  })
})
