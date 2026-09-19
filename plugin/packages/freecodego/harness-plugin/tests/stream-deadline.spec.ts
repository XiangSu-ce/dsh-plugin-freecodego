/**
 * The stream's idle deadline.
 *
 * The defect: a provider route stops answering without closing, so the socket
 * stays open, no error is raised, and the client waits forever. The property this
 * file pins is that silence becomes a *typed timeout* — not a cancellation, which
 * takes a different path in the protocol — and that the upstream is released on
 * every exit, so a stalled provider stops being consumed.
 */

import { describe, expect, it } from 'vitest'

import { StreamIdleTimeoutError, withIdleDeadline } from '../src/stream-deadline.ts'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** A stream that yields the given items, waiting before each one, then ends. */
function paced(items: readonly (string | undefined)[], gaps: readonly number[]): { stream: AsyncIterable<string>; released: () => boolean } {
  let released = false
  const stream: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const [index, item] of items.entries()) {
          await delay(gaps[index] ?? 0)
          if (item !== undefined) yield item
        }
      } finally {
        released = true
      }
    },
  }
  return { stream, released: () => released }
}

/**
 * A provider that answered once and then went silent forever.
 *
 * Modelled with a hand-written iterator rather than a generator on purpose: a
 * generator suspended inside its own `await` cannot be interrupted by
 * `return()`, which is the exact shape of a stalled provider — and the reason
 * the deadline releases the upstream instead of awaiting it.
 */
function stalled(
  items: readonly string[],
  options: { readonly returnHangs?: boolean } = {},
): { stream: AsyncIterable<string>; released: () => boolean } {
  let released = false
  return {
    stream: {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next: (): Promise<IteratorResult<string>> => index < items.length
            ? Promise.resolve<IteratorResult<string>>({ done: false, value: items[index++] ?? '' })
            : new Promise<IteratorResult<string>>(() => undefined),
          // A provider that is stalled inside its own `next()` cannot settle
          // `return()` either, which is the shape that makes awaiting the release
          // a hang rather than a cleanup.
          return: (): Promise<IteratorResult<string>> => {
            released = true
            return options.returnHangs === true
              ? new Promise<IteratorResult<string>>(() => undefined)
              : Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    },
    released: () => released,
  }
}

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const seen: string[] = []
  for await (const item of stream) seen.push(item)
  return seen
}

describe('the idle deadline', () => {
  it('passes a stream through untouched when it keeps answering', async () => {
    const { stream } = paced(['a', 'b', 'c'], [1, 1, 1])
    expect(await drain(withIdleDeadline(stream, 200))).toEqual(['a', 'b', 'c'])
  })

  it('turns silence into a typed timeout', async () => {
    const upstream = stalled(['a'])
    const seen: string[] = []
    let failure: unknown
    try {
      for await (const item of withIdleDeadline(upstream.stream, 20)) seen.push(item)
    } catch (error) {
      failure = error
    }
    expect(seen).toEqual(['a'])
    expect(failure).toBeInstanceOf(StreamIdleTimeoutError)
    // The kind a caller reads is what decides between "retry" and "the client
    // stopped listening"; a plain Error would lose that.
    expect((failure as StreamIdleTimeoutError).idleMs).toBe(20)
  })

  it('re-arms on every chunk, so a slow-but-live stream is not cut off', async () => {
    // Five gaps of 50ms against a 200ms deadline: the total is a quarter over the
    // budget, so an absolute deadline would have killed a healthy stream — while
    // each individual gap has a 4x margin, because this uses real timers and a
    // suite running a hundred files in parallel stretches short sleeps. A 5ms
    // margin against a 20ms deadline (the first version) failed under exactly that
    // load, and a test that fails on a busy machine is a test that gets muted.
    const { stream } = paced(['a', 'b', 'c', 'd', 'e'], [50, 50, 50, 50, 50])
    expect(await drain(withIdleDeadline(stream, 200))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('releases the upstream when the deadline fires', async () => {
    const upstream = stalled([])
    await expect(drain(withIdleDeadline(upstream.stream, 20))).rejects.toThrow(/sent nothing/u)
    // A provider still producing for a consumer that gave up is the leak.
    expect(upstream.released()).toBe(true)
  })

  it('does not wait for a stalled upstream to acknowledge the release', async () => {
    // The release is *told*, not awaited. Awaiting it here would block the error
    // path for as long as the stall it is reporting — the client would never
    // learn that the turn was a timeout, which is the failure this whole module
    // exists to remove.
    const upstream = stalled([], { returnHangs: true })
    const started = Date.now()
    await expect(drain(withIdleDeadline(upstream.stream, 20))).rejects.toThrow(/sent nothing/u)
    expect(Date.now() - started).toBeLessThan(500)
    expect(upstream.released()).toBe(true)
  })

  it('releases the upstream when the consumer stops early', async () => {
    const { stream, released } = paced(['a', 'b', 'c'], [1, 1, 1])
    for await (const item of withIdleDeadline(stream, 200)) {
      expect(item).toBe('a')
      break
    }
    await delay(10)
    expect(released()).toBe(true)
  })

  it('is disabled by a non-positive budget, and hands back the same stream', async () => {
    const { stream } = paced(['a'], [1])
    expect(withIdleDeadline(stream, 0)).toBe(stream)
    expect(withIdleDeadline(stream, -1)).toBe(stream)
    expect(withIdleDeadline(stream, Number.NaN)).toBe(stream)
  })

  it('does not hold the process open with its timer', async () => {
    // The same convention the plugin's other timers follow: a stream in flight
    // when the session ends must not keep the Host alive until the deadline.
    let unrefCalled = false
    const realSetTimeout = globalThis.setTimeout
    const stub = ((handler: () => void, timeout?: number) => {
      const handle = realSetTimeout(handler, timeout)
      const originalUnref = handle.unref?.bind(handle)
      handle.unref = () => { unrefCalled = true; originalUnref?.(); return handle }
      return handle
    }) as typeof setTimeout
    globalThis.setTimeout = stub
    try {
      const { stream } = paced(['a'], [1])
      await drain(withIdleDeadline(stream, 50))
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(unrefCalled).toBe(true)
  })
})
