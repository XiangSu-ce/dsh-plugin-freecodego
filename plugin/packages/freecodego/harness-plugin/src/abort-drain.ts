/**
 * Bounded drain for work that was already computed when a turn was cut short.
 *
 * Why
 * ---
 * A cancelled turn is the one moment where the plugin's own write paths are
 * racing its own teardown. The engine cancels the caller's signal, the session
 * starts unwinding, and any promise the plugin started and did not await — a
 * memory observation, a checkpoint pre-image, a Skill-catalog injection — is
 * still in flight with nobody left to wait for it. The work is not *unstarted*
 * and it is not *wrong*; it is simply about to be abandoned, and abandoning it
 * loses results the user already paid tokens to produce. A crash-recovery repair
 * pass cannot help here either: the session is not reopening, it is going away,
 * and the log it would repair is the one being written.
 *
 * So the drain is deliberately narrow. It waits — with a ceiling — for the
 * promises a caller explicitly handed it, and it does nothing else. It cannot
 * start work, retry, or resurrect a cancelled operation, because at this point
 * the one thing that must not happen is the cleanup outliving the turn it is
 * cleaning up after.
 *
 * Three properties the rest of the plugin depends on
 * ------------------------------------------------
 * 1. **It never rejects.** A drain failure must not convert a handled turn into
 *    an unhandled rejection during teardown, which is the worst place to learn
 *    about it.
 * 2. **It never hangs.** The deadline is the whole point: an abandoned write
 *    that never settles must not hold the session open, so what remains after
 *    the deadline is *reported*, not waited on further.
 * 3. **It never keeps the process alive.** The deadline timer is unref'd, since
 *    a drain at teardown is usually the last thing running.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/abort-drain
 */

/** What one drain managed to settle, and what it did not. */
export interface AbortDrainOutcome {
  /** Promises from this drain's batch that settled before the deadline. */
  readonly drained: number
  /**
   * Batch promises still in flight when the deadline passed; not waited on
   * further. Writes handed to the drain *after* it started are not part of the
   * batch and are reported by {@link PendingWriteDrain.inflight} instead, so
   * `drained + remaining` is always the size of the set this drain waited on.
   */
  readonly remaining: number
  /**
   * Writes that have rejected since this drain was constructed.
   *
   * Cumulative rather than per-drain, and reported on every path including an
   * empty one: a write that rejected and settled *before* the drain began is
   * settled, not drained, so counting only inside a non-empty batch would report
   * the one failure the log most needs to name as though it never happened.
   */
  readonly failed: number
  /** Whether the deadline expired before the tracked set emptied. */
  readonly timedOut: boolean
  /** The deadline this drain ran under. */
  readonly timeoutMs: number
}

/**
 * Default ceiling for one drain.
 *
 * Five seconds is longer than any single plugin write should take and far
 * shorter than a user will wait after pressing cancel. A drain that outlives the
 * user's patience has become a worse bug than the abandoned write it was
 * protecting.
 */
export const ABORT_DRAIN_TIMEOUT_MS = 5_000

/**
 * A set of in-flight promises a caller can wait on once, under a deadline.
 *
 * Tracking is explicit rather than global: a drain that swept up every promise in
 * the process would wait on the LLM request itself, which is exactly the promise
 * the cancellation just rejected.
 */
/** Coerce an unknown thrown value into an Error without the lint-noisy ternary. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class PendingWriteDrain {
  private readonly pending = new Set<Promise<unknown>>()
  private failures = 0

  /**
   * @param timeoutMs - the default deadline for {@link drain}.
   */
  constructor(private readonly timeoutMs: number = ABORT_DRAIN_TIMEOUT_MS) {}

  /** Promises currently in flight. */
  get inflight(): number {
    return this.pending.size
  }

  /** Whether any tracked write has rejected since construction. */
  get failureCount(): number {
    return this.failures
  }

  /**
   * Track one write, returning the same promise so the caller keeps its own
   * error handling.
   *
   * The internal `.then` attaches a rejection handler that only counts, so a
   * tracked write's rejection is never reported as unhandled during teardown
   * while still surfacing to whoever awaited the returned promise.
   *
   * @param work - the write to track.
   * @returns `work`, unchanged.
   */
  track<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<unknown> = work.then(
      () => { this.pending.delete(tracked); return undefined },
      () => { this.pending.delete(tracked); this.failures += 1; return undefined },
    )
    this.pending.add(tracked)
    return work
  }

  /** Run a write and track it in one step. */
  run<T>(work: () => Promise<T>): Promise<T> {
    let started: Promise<T>
    try {
      started = work()
    } catch (error) {
      // A synchronous throw is a rejected write, not a reason to skip tracking
      // the caller's contract: hand back an equivalent rejected promise.
      started = Promise.reject(asError(error))
    }
    return this.track(started)
  }

  /**
   * Wait for the tracked writes, bounded by a deadline.
   *
   * Never rejects. The returned outcome distinguishes "everything settled" from
   * "the deadline passed", because those lead to different log lines and only
   * one of them is a problem worth reporting.
   *
   * @param options - override the deadline for this drain.
   * @returns what settled and what did not.
   */
  async drain(options: { readonly timeoutMs?: number } = {}): Promise<AbortDrainOutcome> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? this.timeoutMs)
    const batch = [...this.pending]
    if (batch.length === 0) return { drained: 0, remaining: 0, failed: this.failures, timedOut: false, timeoutMs }
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { resolve('timeout') }, timeoutMs)
      // A drain at teardown is often the last thing running; its own deadline
      // must not be the reason the process stays up.
      timer.unref?.()
    })
    const settled = Promise.all(batch).then(() => 'settled' as const)
    let outcome: 'settled' | 'timeout'
    try {
      outcome = await Promise.race([settled, deadline])
    } catch {
      // `Promise.all` rejects only if a tracked promise rejected, and the
      // tracking wrapper already handled those; treat it as settled regardless
      // so one bad write cannot skip the rest of the batch.
      outcome = 'settled'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // Counted against the batch, not the live set: a write tracked while this
    // drain was waiting is neither drained nor left over here, and subtracting
    // the live set from the batch size reported a number that could go negative
    // — `drained: -1` for one write that had in fact settled.
    const remaining = batch.filter(entry => this.pending.has(entry)).length
    return {
      drained: batch.length - remaining,
      remaining,
      failed: this.failures,
      timedOut: outcome === 'timeout',
      timeoutMs,
    }
  }

  /** Drop all tracking without waiting. For a discarded host, not a drained one. */
  clear(): void {
    this.pending.clear()
  }
}
