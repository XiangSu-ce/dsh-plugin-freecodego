/**
 * Suspend detection, and the two rules that protect a token rotation.
 *
 * What Node can and cannot tell us
 * -------------------------------
 * There is no cross-platform suspend/resume event in Node, and `powerMonitor`
 * belongs to Electron rather than to a Host process. So this module does not
 * pretend to have one. An earlier design (grok's) includes a `WillSleep` hook;
 * faking that here would mean writing a branch that never runs and cannot be
 * tested, which is worse than not having it. That omission is deliberate and is
 * the scheme's one *intentional* divergence from the design it copies.
 *
 * What is real instead is a **clock jump**: `process.hrtime.bigint()` is
 * monotonic and stops during a suspend, while `Date.now()` keeps a wall clock.
 * A large positive drift between the two is evidence that time passed without
 * this process running.
 *
 * Detection is only ever allowed to do something *idempotent and harmless*.
 * Wall-clock jumps also happen when a user changes their system clock or an NTP
 * correction lands, and the response — revalidate the session once — is
 * something a correctly-behaving session does for free. Nothing destructive is
 * ever triggered by a suspicion.
 *
 * The two rules
 * -------------
 * **1. An in-flight refresh is never aborted.** A timer that fires during a
 * suspend will conclude that a refresh "took too long" and cancel it, and
 * cancelling it can discard a rotated-token response the server has already
 * issued — the user is then logged out by the very guard meant to keep them
 * logged in. So the guard below passes a signal it never aborts.
 *
 * **2. A refresh that fails on the network is retried once.** A laptop that
 * woke without a network yet is the ordinary case, and treating it as an
 * invalid session is how a resume turns into a re-login.
 *
 * Only an explicit invalidation clears the vault. That rule is pre-existing and
 * this module does not relax it; the test asserts it, because the whole point of
 * the retry above is that it must not have widened the logout path.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/system-power
 */

/** A monotonic and a wall clock reading, taken together. */
export interface ClockSample {
  /** `Date.now()`. */
  readonly wallMs: number
  /** `Number(process.hrtime.bigint() / 1_000_000n)`. */
  readonly monoMs: number
}

/** Evidence that the process was not running for a while. */
export interface SuspendEvidence {
  readonly kind: 'suspect-sleep'
  /** Wall-clock time that passed. */
  readonly wallMs: number
  /** Monotonic time that passed over the same interval. */
  readonly monoMs: number
  /** `wallMs - monoMs`, which is what made this suspicious. */
  readonly driftMs: number
}

/** Default drift at or above which a suspend is suspected. */
export const DEFAULT_SUSPEND_THRESHOLD_MS = 90_000

/**
 * Decide whether the interval between two samples contained a suspend.
 *
 * A *negative* drift is not evidence of anything and is deliberately not
 * reported: the monotonic clock running backwards means the samples were taken
 * by different processes or the pair was assembled out of order, and firing a
 * session revalidation on a bookkeeping mistake is exactly the kind of false
 * positive that trains people to turn a guard off.
 * @param previous - the earlier sample.
 * @param current - the later sample.
 * @param thresholdMs - drift at or above which a suspend is suspected.
 * @returns the evidence, or undefined when nothing was detected.
 */
export function detectSuspend(
  previous: ClockSample,
  current: ClockSample,
  thresholdMs = DEFAULT_SUSPEND_THRESHOLD_MS,
): SuspendEvidence | undefined {
  const wallMs = current.wallMs - previous.wallMs
  const monoMs = current.monoMs - previous.monoMs
  if (wallMs < 0 || monoMs < 0) return undefined
  const driftMs = wallMs - monoMs
  if (driftMs < thresholdMs) return undefined
  return { kind: 'suspect-sleep', wallMs, monoMs, driftMs }
}

/**
 * The refresh guard, re-exported rather than reimplemented.
 *
 * It lives in `@deepseek-ai/dsh-freecodego-api` because that is where every
 * refresh path is, and the plugin depends on that package rather than the other
 * way round. A second copy here would mean two implementations of "when may I
 * erase a user's credentials", and the drift between them would be silent until
 * it logged someone out.
 *
 * The plugin imports it because a plugin-side caller wants the same answer, and
 * this module is the plugin's public surface for it.
 */
export {
  classifyRefreshFailure,
  runGuardedRefresh,
  DEFAULT_REFRESH_RETRY_DELAY_MS as DEFAULT_RETRY_DELAY_MS,
  type RefreshAttemptOptions,
  type RefreshAttemptResult,
  type RefreshFailureKind,
  type RefreshOutcome,
} from '@deepseek-ai/dsh-freecodego-api'

/**
 * Create the detect-and-revalidate timer.
 *
 * The interval is `unref`'d, which is this repository's existing convention for
 * background timers: a plugin that keeps the process alive after the last
 * session closes is a hang rather than a feature.
 * @param input - the sampling interval, the clock readers, and the revalidation.
 * @returns a stop function.
 */
export function startSuspendWatch(input: {
  readonly onSuspectSleep: (evidence: SuspendEvidence) => void
  readonly readClock: () => ClockSample
  readonly intervalMs?: number
  readonly thresholdMs?: number
}): () => void {
  let previous = input.readClock()
  const interval = setInterval(() => {
    const current = input.readClock()
    const evidence = detectSuspend(previous, current, input.thresholdMs)
    previous = current
    if (evidence !== undefined) input.onSuspectSleep(evidence)
  }, input.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS)
  // See the doc comment: an un-unref'd interval outlives the session.
  interval.unref?.()
  return () =>{  clearInterval(interval) }
}

/** How often the clocks are sampled. */
export const DEFAULT_WATCH_INTERVAL_MS = 30_000
