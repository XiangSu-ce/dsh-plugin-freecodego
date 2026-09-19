/**
 * The shared clock is the one piece of the companion that talks to the platform,
 * so its whole job is the edges: a realm without `requestAnimationFrame`, a hidden
 * tab, and the last subscriber leaving.
 *
 * These run without a document on purpose — a Node lane is exactly the realm
 * whose fallbacks the browser lane can never reach — and each test re-imports the
 * module so it gets a clock of its own rather than the process-wide one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanionClock } from '../src/client/companion/driver.ts'

/** Fresh module instance, so `companionClock()`'s singleton starts empty. */
async function freshClock(): Promise<CompanionClock> {
  vi.resetModules()
  const module = await import('../src/client/companion/driver.ts')
  return module.companionClock()
}

interface FakeDocument {
  readonly listeners: Set<() => void>
  readonly stub: { visibilityState: string; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void }
}

/** A document just real enough to drive the visibility contract. */
function fakeDocument(visibilityState: string): FakeDocument {
  const listeners = new Set<() => void>()
  return {
    listeners,
    stub: {
      visibilityState,
      addEventListener: (_type, listener) => { listeners.add(listener) },
      removeEventListener: (_type, listener) => { listeners.delete(listener) },
    },
  }
}

/** One fallback frame, in milliseconds; the clock's own 60Hz interval. */
const FALLBACK_TICK_MS = 1000 / 60

/** Arm the fake clock's frame queue. @returns the queue, fed by hand. */
function stubFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return frames
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('companion clock: without requestAnimationFrame', () => {
  it('falls back to a fixed interval and still advances', async () => {
    vi.useFakeTimers()
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    expect(clock.nowSeconds()).toBe(0)
    vi.advanceTimersByTime(200)
    expect(listener.mock.calls.length).toBeGreaterThan(0)
    expect(clock.nowSeconds()).toBeGreaterThan(0)
    stop()
    const settled = clock.nowSeconds()
    vi.advanceTimersByTime(200)
    expect(clock.nowSeconds()).toBe(settled)
  })

  it('reads the wall clock when the fine clock is absent', async () => {
    vi.stubGlobal('performance', undefined)
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    // `setInterval` is real here, so the tick has to be waited for.
    await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })
    expect(clock.nowSeconds()).toBeGreaterThan(0)
    stop()
  })
})

describe('companion clock: with requestAnimationFrame', () => {
  it('runs one frame at a time and re-arms itself', async () => {
    const frames = stubFrames()
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(1)
    stop()
  })

  it('shares one clock and disarms it only with the last subscriber', async () => {
    const frames = stubFrames()
    const clock = await freshClock()
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = clock.subscribe(first)
    const stopSecond = clock.subscribe(second)
    // The second subscriber joins the running loop instead of arming another.
    expect(frames).toHaveLength(1)
    stopFirst()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
    stopSecond()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(frames).toHaveLength(1)
  })

  it('gives every subscriber the same process-wide clock', async () => {
    stubFrames()
    vi.resetModules()
    const module = await import('../src/client/companion/driver.ts')
    expect(module.companionClock()).toBe(module.companionClock())
  })
})

describe('companion clock: visibility', () => {
  it('does not arm while the document is hidden, and starts on return', async () => {
    const frames = stubFrames()
    const doc = fakeDocument('hidden')
    vi.stubGlobal('document', doc.stub)
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    expect(frames).toHaveLength(0)

    doc.stub.visibilityState = 'visible'
    for (const notify of doc.listeners) notify()
    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops on hiding and resumes without skipping the paused time', async () => {
    const frames = stubFrames()
    const doc = fakeDocument('visible')
    vi.stubGlobal('document', doc.stub)
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    expect(frames).toHaveLength(1)

    doc.stub.visibilityState = 'hidden'
    for (const notify of doc.listeners) notify()
    expect(cancelAnimationFrame).toHaveBeenCalled()
    const paused = clock.nowSeconds()

    doc.stub.visibilityState = 'visible'
    for (const notify of doc.listeners) notify()
    frames.pop()!(0)
    // The hidden interval is sealed, not added back: one frame after resuming
    // advances the counter by that frame, not by however long the tab was away.
    expect(clock.nowSeconds() - paused).toBeLessThan(1)
    stop()
  })

  it('stops following the document when the last subscriber leaves', async () => {
    const frames = stubFrames()
    const doc = fakeDocument('visible')
    vi.stubGlobal('document', doc.stub)
    const clock = await freshClock()
    const stop = clock.subscribe(vi.fn())
    expect(doc.listeners.size).toBe(1)
    stop()
    expect(frames).toHaveLength(1)
    expect(doc.listeners.size).toBe(0)
  })

  it('does not arm a second frame queue on a repeated visible notification', async () => {
    const frames = stubFrames()
    const doc = fakeDocument('visible')
    vi.stubGlobal('document', doc.stub)
    const clock = await freshClock()
    const stop = clock.subscribe(vi.fn())
    expect(frames).toHaveLength(1)
    for (const notify of doc.listeners) notify()
    // A page may report visibility without the state changing; that must not
    // stack a second rAF loop on the first.
    expect(frames).toHaveLength(1)
    stop()
  })

  it('does not arm a second interval on a repeated visible notification', async () => {
    vi.useFakeTimers()
    const doc = fakeDocument('visible')
    vi.stubGlobal('document', doc.stub)
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    for (const notify of doc.listeners) notify()
    vi.advanceTimersByTime(FALLBACK_TICK_MS)
    // One interval, not two: the tick count stays single-rate.
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('leaves the document alone entirely where there is none', async () => {
    const frames = stubFrames()
    const clock = await freshClock()
    const stop = clock.subscribe(vi.fn())
    // No document: nothing to observe, and the clock still runs.
    expect(frames).toHaveLength(1)
    stop()
  })

  it('tears down without a canceller to call', async () => {
    const frames = stubFrames()
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const clock = await freshClock()
    const listener = vi.fn()
    const stop = clock.subscribe(listener)
    stop()
    // Nothing to cancel with, so the queued frame simply never runs again.
    expect(frames).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
  })
})
