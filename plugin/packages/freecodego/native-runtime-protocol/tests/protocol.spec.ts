/**
 * The JSONL framing and deadline helpers every native runtime call passes
 * through had no test of their own — only `sandbox-mode.spec.ts` covered this
 * package, while the decoder and the two race helpers carried the boundary rules
 * a worker's output and a turn's cancellation actually depend on:
 *
 * - Framing is newline-delimited, so a chunk boundary can split both a frame and
 *   a multi-byte character, and a bounded tail must never be mistaken for a
 *   frame that arrived.
 * - A frame over the byte limit is refused rather than buffered, and the refusal
 *   must not discard the complete valid frames sitting in front of it.
 * - A deadline has to be a deadline: `setTimeout` silently turns a negative delay
 *   into an immediate timer and an infinite one into a 1 ms timer, so a bad
 *   `timeoutMs` used to surface as an unexplained instant failure.
 * - Cancellation rejects with the signal's reason and leaves no listener behind.
 *
 * @module @deepseek-ai/dsh-freecodego-native-runtime-protocol/tests/protocol
 */

import { describe, expect, it } from 'vitest'
import {
  NativeRuntimeJsonlDecoder,
  encodeNativeRuntimeMessage,
  withNativeRuntimeAbort,
  withNativeRuntimeTimeout,
} from '../src/index.ts'

/** A promise that settles only when the test says so. */
function deferred<Value>(): { readonly promise: Promise<Value>; readonly resolve: (value: Value) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

describe('native runtime JSONL framing', () => {
  it('encodes exactly one frame per message', () => {
    expect(encodeNativeRuntimeMessage({ id: '1', method: 'initialize', params: {} })).toBe('{"id":"1","method":"initialize","params":{}}\n')
    // A value carrying a newline is escaped by `JSON.stringify`, so one message
    // can never become two frames.
    const framed = encodeNativeRuntimeMessage({ id: '2', method: 'session/prompt', params: { text: 'a\nb' } })
    expect(framed.indexOf('\n')).toBe(framed.length - 1)
  })

  it('reassembles frames split across chunks', () => {
    const decoder = new NativeRuntimeJsonlDecoder()
    expect(decoder.push('{"id":"a","method":"init')).toEqual([])
    expect(decoder.push('ialize","params":{}}\n')).toEqual([{ id: 'a', method: 'initialize', params: {} }])
  })

  it('returns every complete frame from one chunk and keeps the unterminated tail', () => {
    const decoder = new NativeRuntimeJsonlDecoder()
    const frames = decoder.push('{"method":"one"}\n{"method":"two"}\n{"method":"thr')
    expect(frames.map(frame => frame.method)).toEqual(['one', 'two'])
    expect(decoder.push('ee"}\n').map(frame => frame.method)).toEqual(['three'])
  })

  it('skips blank lines without treating them as frames', () => {
    const decoder = new NativeRuntimeJsonlDecoder()
    expect(decoder.push('\n\n   \n{"method":"one"}\n')).toEqual([{ method: 'one' }])
  })

  it('refuses a frame that is not JSON, or not an object', () => {
    expect(() => new NativeRuntimeJsonlDecoder().push('{oops}\n')).toThrow('invalid JSONL')
    expect(() => new NativeRuntimeJsonlDecoder().push('[1,2]\n')).toThrow('must be an object')
    expect(() => new NativeRuntimeJsonlDecoder().push('"text"\n')).toThrow('must be an object')
    expect(() => new NativeRuntimeJsonlDecoder().push('null\n')).toThrow('must be an object')
  })

  it('refuses a frame over the byte limit rather than buffering it', () => {
    const decoder = new NativeRuntimeJsonlDecoder(64)
    expect(() => decoder.push(`{"method":"${'x'.repeat(128)}"}\n`)).toThrow('exceeds the configured byte limit')
  })

  it('refuses an unterminated tail once it passes the limit', () => {
    const decoder = new NativeRuntimeJsonlDecoder(32)
    // Nothing terminated, so only the byte accounting can refuse it: the buffer
    // never reaches a newline for the per-frame check to see.
    expect(() => decoder.push('x'.repeat(64))).toThrow('exceeds the configured byte limit')
  })

  it('accepts a burst whose frames together exceed the limit', () => {
    // The tail check runs after the loop on purpose, so the limit bounds one
    // frame rather than one chunk: five small frames in one push total more than
    // `maxFrameBytes` and must all come back.
    const decoder = new NativeRuntimeJsonlDecoder(32)
    const burst = Array.from({ length: 5 }, (_unused, index) => `{"method":"m${index}"}\n`).join('')
    expect(burst.length).toBeGreaterThan(32)
    expect(decoder.push(burst).map(frame => frame.method)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('refuses a byte limit that is not a positive safe integer', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new NativeRuntimeJsonlDecoder(limit), String(limit)).toThrow('maxFrameBytes must be a positive safe integer')
    }
  })
})

describe('native runtime deadlines', () => {
  it('returns the value when the operation beats its deadline', async () => {
    await expect(withNativeRuntimeTimeout(Promise.resolve('done'), 5_000, 'timed out')).resolves.toBe('done')
  })

  it('rejects with the deadline message and runs the timeout hook once', async () => {
    const never = deferred<string>()
    let cleanups = 0
    await expect(withNativeRuntimeTimeout(never.promise, 5, 'request timed out', () => { cleanups += 1 })).rejects.toThrow('request timed out')
    await Promise.resolve()
    expect(cleanups).toBe(1)
  })

  it('propagates the operation failure instead of the deadline', async () => {
    const never = deferred<string>()
    const bounded = withNativeRuntimeTimeout(never.promise, 5_000, 'timed out')
    never.reject(new Error('worker died'))
    await expect(bounded).rejects.toThrow('worker died')
  })

  it('refuses a deadline that is not a positive finite number', async () => {
    // The defect this pins: `setTimeout` turns a negative delay into an immediate
    // timer and an infinite one into a `TimeoutOverflowWarning` plus a 1 ms timer,
    // so each of these used to reject instantly with the deadline message — an
    // unexplained failure instead of a named misconfiguration.
    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(withNativeRuntimeTimeout(Promise.resolve('value'), timeoutMs, 'timed out'), String(timeoutMs))
        .rejects.toThrow('native runtime timeout must be a positive finite number')
    }
  })
})

describe('native runtime cancellation', () => {
  it('rejects immediately for an already-aborted turn', async () => {
    const controller = new AbortController()
    controller.abort(new Error('turn interrupted before the call'))
    await expect(withNativeRuntimeAbort(Promise.resolve('value'), controller.signal)).rejects.toThrow('turn interrupted before the call')
  })

  it('rejects with the signal reason when the turn aborts mid-flight', async () => {
    const controller = new AbortController()
    const never = deferred<string>()
    const interrupted = withNativeRuntimeAbort(never.promise, controller.signal)
    controller.abort(new Error('user cancelled'))
    await expect(interrupted).rejects.toThrow('user cancelled')
  })

  it('rejects with the signal default when it carries no explicit reason', async () => {
    const controller = new AbortController()
    const never = deferred<string>()
    const interrupted = withNativeRuntimeAbort(never.promise, controller.signal)
    // `abort()` with no argument leaves `reason` an `AbortError`, which is a real
    // error and not the string fallback; the fallback only covers a signal whose
    // `reason` is absent altogether.
    controller.abort()
    await expect(interrupted).rejects.toBeInstanceOf(Error)
    await expect(interrupted).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns the value when the turn completes, and leaves no listener behind', async () => {
    const controller = new AbortController()
    const listeners = new Set<unknown>()
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, listener: unknown) => { listeners.add(listener) },
      removeEventListener: (_type: string, listener: unknown) => { listeners.delete(listener) },
    } as unknown as AbortSignal
    await expect(withNativeRuntimeAbort(Promise.resolve('done'), signal)).resolves.toBe('done')
    expect(listeners.size).toBe(0)
    expect(controller.signal.aborted).toBe(false)
  })
})
