import { afterEach, describe, expect, it, vi } from 'vitest'
import { deadline, remainingTimeoutMs, resumeTimeout, suspendTimeout, timeoutOf } from '../src/index.ts'

afterEach(() => { vi.useRealTimers() })

describe('deadline suspension seam', () => {
  it('pauses the clock: no abort while suspended, remaining frozen', async () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'T')
    expect(suspendTimeout(d.signal)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(d.signal.aborted).toBe(false)
    expect(remainingTimeoutMs(d.signal)).toBe(100)
  })

  it('re-arms with the frozen remainder and fires after it elapses', async () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'T')
    suspendTimeout(d.signal)
    await vi.advanceTimersByTimeAsync(500)
    resumeTimeout(d.signal)
    expect(remainingTimeoutMs(d.signal)).toBe(100)
    await vi.advanceTimersByTimeAsync(50)
    expect(d.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal, 'T')).toBeDefined()
  })

  it('charges the elapsed time before the pause', () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'T')
    vi.advanceTimersByTime(40)
    suspendTimeout(d.signal)
    expect(remainingTimeoutMs(d.signal)).toBe(60)
  })

  it('freezes and charges across repeated pause cycles', () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'T')
    vi.advanceTimersByTime(10)
    suspendTimeout(d.signal)
    vi.advanceTimersByTime(1_000)
    expect(remainingTimeoutMs(d.signal)).toBe(90)
    resumeTimeout(d.signal)
    vi.advanceTimersByTime(30)
    suspendTimeout(d.signal)
    expect(remainingTimeoutMs(d.signal)).toBe(60)
  })

  it('nests pauses and resumes only at the outermost resume', async () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'T')
    suspendTimeout(d.signal)
    suspendTimeout(d.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    resumeTimeout(d.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(d.signal.aborted).toBe(false)
    resumeTimeout(d.signal)
    await vi.advanceTimersByTimeAsync(100)
    expect(d.signal.aborted).toBe(true)
  })

  it('upstream cancellation still aborts a paused deadline', () => {
    vi.useFakeTimers()
    const upstream = new AbortController()
    using d = deadline(upstream.signal, 100, 'T')
    suspendTimeout(d.signal)
    upstream.abort(new Error('cancel'))
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal, 'T')).toBeUndefined()
  })

  it('is a no-op on signals without a deadline', () => {
    const foreign = new AbortController().signal
    expect(suspendTimeout(foreign)).toBe(false)
    expect(resumeTimeout(foreign)).toBe(false)
    expect(remainingTimeoutMs(foreign)).toBeUndefined()
    expect(suspendTimeout(undefined)).toBe(false)
    expect(resumeTimeout(undefined)).toBe(false)
    expect(remainingTimeoutMs(undefined)).toBeUndefined()
  })

  it('has nothing to suspend on a timeout-less deadline', () => {
    using d = deadline(undefined, 0, 'T')
    expect(suspendTimeout(d.signal)).toBe(false)
    expect(remainingTimeoutMs(d.signal)).toBeUndefined()
  })

  it('resume without a pause leaves the deadline running', () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'T')
    expect(resumeTimeout(d.signal)).toBe(true)
    expect(remainingTimeoutMs(d.signal)).toBe(100)
  })

  it('dispose drops the deadline from the registry', () => {
    vi.useFakeTimers()
    const d = deadline(undefined, 100, 'T')
    expect(remainingTimeoutMs(d.signal)).toBe(100)
    d[Symbol.dispose]()
    expect(remainingTimeoutMs(d.signal)).toBeUndefined()
    expect(suspendTimeout(d.signal)).toBe(false)
  })
})
