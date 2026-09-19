/**
 * An idle deadline for a stream, normalized to a timeout.
 *
 * Why
 * ---
 * A provider can stop answering without closing: the socket stays open, no
 * chunk arrives, and no error is ever raised. The caller then waits forever, and
 * in this plugin's bridge that means a client CLI waiting forever on a request
 * that will never produce another byte. Nothing above can tell the difference
 * between "slow" and "gone", so the decision has to be made here, on evidence
 * the stream itself provides: how long it has been since the last chunk.
 *
 * Idle rather than absolute
 * -------------------------
 * A total budget would cut off a legitimate long answer — a large file being
 * written token by token can take minutes without that being a failure. Silence
 * is the signal that something is wrong, so the deadline re-arms on every chunk.
 *
 * A timeout is not a cancellation
 * -------------------------------
 * The distinction is the reason {@link StreamIdleTimeoutError} exists rather than
 * a plain `Error`: a cancellation comes from the *client* and must stay quiet —
 * whoever asked for it has stopped listening — while a timeout is the provider
 * failing to answer, and the protocol has to be told so the client can retry.
 * Two shapes that look alike (`AbortError` and this) therefore take two different
 * paths, and the plugin's `provider-error-classify.ts` is where that is decided.
 *
 * Why it lives here rather than beside one of its callers
 * -------------------------------------------------------
 * Three transports need the same decision, and two of them cannot reach the
 * third: the plugin's provider bridge and the in-process Claude SDK session both
 * have to fail a silent stream, and the Claude runtime is a dependency *of* the
 * plugin, so it cannot import from it. A second copy of "silence is the only
 * evidence of a stall" would drift from this one — the deadline is subtle in
 * exactly the places a re-implementation gets wrong (see the release below), and
 * this package is already where the boundary's timeout helpers live.
 *
 * @module @deepseek-ai/dsh-freecodego-native-runtime-protocol/deadline
 */

/** Raised when a stream produced nothing for longer than its idle budget. */
export class StreamIdleTimeoutError extends Error {
  override readonly name = 'StreamIdleTimeoutError'
  constructor(readonly idleMs: number) {
    super(`the provider sent nothing for ${String(idleMs)}ms`)
  }
}

/**
 * Wrap a stream so silence becomes an error.
 *
 * The upstream iterator is released (`return()`) on every exit path, including
 * the timeout and a consumer that stops early: a provider left iterating after
 * its consumer is gone is the leak this whole path is about.
 * @param source - the upstream chunk stream.
 * @param idleMs - how long a gap is treated as a failure; non-positive disables it.
 * @returns the same chunks, with the deadline applied.
 */
export function withIdleDeadline<T>(
  source: AsyncIterable<T>,
  idleMs: number,
): AsyncIterable<T> {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return source
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = source[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await nextWithin(iterator, idleMs)
          if (next.done === true) return
          yield next.value
        }
      } finally {
        // The upstream is *told* to stop and not waited for, which is the whole
        // difference between this working and hanging: a stalled provider is
        // stalled inside its own pending `next()`, so its `return()` cannot
        // settle until that resolves — awaiting it here would block the error
        // path for exactly as long as the failure it is reporting. Awaiting the
        // release is the upstream's business (its transport has its own timeout,
        // and the caller's abort signal reaches it independently).
        const released = iterator.return?.()
        if (released !== undefined) void Promise.resolve(released).catch(() => undefined)
      }
    },
  }
}

/**
 * Take a timer off the event loop, where the runtime's timers can be.
 *
 * The parameter is deliberately *not* `ReturnType<typeof setTimeout>`: that type
 * is the Node one, where `unref` is always present, and the call would read as
 * dead code. The DOM's `setTimeout` returns a bare number, which carries no
 * `unref` at all; asking for just the method is what makes the check below a
 * real one — and it is not decoration. A stream that ends while the deadline is
 * still armed would otherwise hold the Host open until the timer fires.
 */
function detach(timer: { unref?: () => void }): void {
  timer.unref?.()
}

/** One `next()`, or the deadline error. */
async function nextWithin<T>(iterator: AsyncIterator<T>, idleMs: number): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      timer = setTimeout(() => { reject(new StreamIdleTimeoutError(idleMs)) }, idleMs)
      // A pending timer must not hold the process open: a session that ends with
      // a stream in flight would otherwise keep the Host alive until it fires.
      detach(timer)
      iterator.next().then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
