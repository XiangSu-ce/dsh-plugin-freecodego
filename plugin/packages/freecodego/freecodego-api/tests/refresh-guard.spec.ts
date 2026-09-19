/**
 * The two rules that protect a token rotation, and the table they rest on.
 *
 * Why this file exists
 * --------------------
 * `refresh-guard.ts` is the single implementation of "when may I erase a user's
 * credentials", and it had no test in the package that owns it: the only spec
 * reaching it did so through the plugin's re-export, which left two things
 * unpinned. The first is the classification table — a 400 that wipes a vault
 * costs the user a manual login, and a 500 that wipes it turns an outage into
 * one. The second is that **an attempt may either throw or report its own
 * result**, and a guard that reads a *reported failure* as a success value is
 * worse than one with no rules at all: it answers `ok: true` while holding a
 * credential the server has already rejected, so nothing retries and nothing is
 * erased.
 *
 * @module tests/refresh-guard
 */

import { describe, expect, it } from 'vitest'

import {
  classifyRefreshFailure,
  DEFAULT_REFRESH_RETRY_DELAY_MS,
  runGuardedRefresh,
  type RefreshAttemptOptions,
  type RefreshAttemptResult,
} from '../src/refresh-guard.ts'

/** An HTTP failure shaped the way the transport throws it. */
function httpError(status: number, message = `HTTP ${String(status)}`): Error {
  return Object.assign(new Error(message), { status })
}

describe('refresh failure classification', () => {
  it('reads a rejected refresh credential as invalid, because only that erases it', () => {
    expect(classifyRefreshFailure(httpError(401)).kind).toBe('invalid')
    expect(classifyRefreshFailure(httpError(403)).kind).toBe('invalid')
  })

  it('reads a consumed rotation as invalid even when the status is unusable', () => {
    // Some proxy configurations drop the status but keep the gateway's wording.
    expect(classifyRefreshFailure(new Error('refresh token already used')).kind).toBe('invalid')
    expect(classifyRefreshFailure(new Error('invalid refresh token')).kind).toBe('invalid')
  })

  it('reads a validation failure as transient, not as a dead credential', () => {
    // A malformed device id arrives as a 400 and must not log anyone out.
    expect(classifyRefreshFailure(httpError(400, 'device id is required')).kind).toBe('transient')
  })

  it('reads a server failure as a network failure, so it is retried', () => {
    expect(classifyRefreshFailure(httpError(503)).kind).toBe('network')
  })

  it('reads a transport failure as a network failure', () => {
    expect(classifyRefreshFailure(new TypeError('fetch failed')).kind).toBe('network')
    expect(classifyRefreshFailure(new Error('socket hang up')).kind).toBe('network')
    expect(classifyRefreshFailure(new Error('ETIMEDOUT')).kind).toBe('network')
  })

  it('treats a throw with nothing readable in it as a network failure', () => {
    // `undefined` carries no evidence that the credential is dead, so the
    // readable-by-default answer is "try once more", never "erase".
    expect(classifyRefreshFailure(undefined).kind).toBe('network')
  })

  it('refuses to guess when the failure says nothing it recognises', () => {
    expect(classifyRefreshFailure(new Error('the server exploded')).kind).toBe('unknown')
  })

  it('classifies a thrown object from the message it carries', () => {
    // A cross-realm or library error is not always an `Error` instance, and its
    // wording is the same evidence an instance would be classified on.
    expect(classifyRefreshFailure({ message: 'refresh token already used' }).kind).toBe('invalid')
    expect(classifyRefreshFailure({ status: 503 }).kind).toBe('network')
  })

  it('does not invent a message for a thrown object that has none', () => {
    // `String({})` is `[object Object]`, which would put text that looks like
    // evidence into the failure it is filed under. Nothing readable means the
    // readable-by-default answer, which never erases.
    const classified = classifyRefreshFailure({})
    expect(classified.kind).toBe('network')
    expect(classified.message).toBeUndefined()
  })
})

describe('the guarded refresh', () => {
  it('reports a failure an attempt returned, rather than filing it as a value', async () => {
    // The bug this pins: a resolved `{ ok: false }` read as a success value.
    // The caller would be told the refresh succeeded, holding the dead
    // credential the server just rejected.
    let calls = 0
    const outcome = await runGuardedRefresh<string>({
      attempt: async (): Promise<RefreshAttemptResult<string>> => {
        calls += 1
        return { ok: false, kind: 'network' }
      },
      wait: async () => undefined,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.failureKind).toBe('network')
    expect(outcome.clearVault).toBe(false)
    expect(calls).toBe(2)
  })

  it('unwraps the value of an attempt that reports its own success', async () => {
    const outcome = await runGuardedRefresh<string>({
      attempt: async (): Promise<RefreshAttemptResult<string>> => ({ ok: true, value: 'token' }),
    })
    expect(outcome).toEqual({ ok: true, value: 'token', attempts: 1, clearVault: false })
  })

  it('erases the vault when an attempt reports an invalidation, and does not retry it', async () => {
    let calls = 0
    const outcome = await runGuardedRefresh<string>({
      attempt: async (): Promise<RefreshAttemptResult<string>> => {
        calls += 1
        return { ok: false, kind: 'invalid' }
      },
    })
    expect(calls).toBe(1)
    expect(outcome.clearVault).toBe(true)
    expect(outcome.failureKind).toBe('invalid')
  })

  it('reads a reported failure with an unrecognised kind as unknown, and erases nothing', async () => {
    const outcome = await runGuardedRefresh<string>({
      attempt: async () => ({ ok: false, kind: 'meltdown' }) as unknown as RefreshAttemptResult<string>,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.failureKind).toBe('unknown')
    expect(outcome.clearVault).toBe(false)
    expect(outcome.attempts).toBe(1)
  })

  it('keeps a resolved value that only resembles a result', async () => {
    // `ok` is the discriminator, and it has to be a boolean: a payload that
    // happens to carry a string field called `ok` is data, not a verdict.
    const outcome = await runGuardedRefresh<{ readonly ok: string }>({
      attempt: async () => ({ ok: 'yes' }),
    })
    expect(outcome).toEqual({ ok: true, value: { ok: 'yes' }, attempts: 1, clearVault: false })
  })

  it('retries a network failure an attempt threw, once', async () => {
    // The style every real caller uses: the exchange rejects.
    let calls = 0
    const outcome = await runGuardedRefresh<string>({
      attempt: async () => {
        calls += 1
        throw new TypeError('fetch failed')
      },
      wait: async () => undefined,
    })
    expect(calls).toBe(2)
    expect(outcome.ok).toBe(false)
    expect(outcome).toEqual(expect.objectContaining({ attempts: 2, failureKind: 'network', clearVault: false }))
  })

  it('does not retry a thrown invalidation, and erases the vault', async () => {
    let calls = 0
    const outcome = await runGuardedRefresh<string>({
      attempt: async () => {
        calls += 1
        throw httpError(401, 'refresh token rejected')
      },
    })
    expect(calls).toBe(1)
    expect(outcome.clearVault).toBe(true)
    expect(outcome.failureKind).toBe('invalid')
  })

  it('applies the erasure rule to the last attempt, not the first', async () => {
    // Retrying must neither widen nor narrow the logout path.
    let calls = 0
    const outcome = await runGuardedRefresh<string>({
      attempt: async (): Promise<RefreshAttemptResult<string>> => {
        calls += 1
        return calls === 1 ? { ok: false, kind: 'network' } : { ok: false, kind: 'invalid' }
      },
      wait: async () => undefined,
    })
    expect(outcome.attempts).toBe(2)
    expect(outcome.clearVault).toBe(true)
  })

  it('marks the recovery when the retry is the attempt that answered', async () => {
    const outcome = await runGuardedRefresh<string>({
      attempt: async (options: RefreshAttemptOptions): Promise<RefreshAttemptResult<string>> =>
        options.retry ? { ok: true, value: 'rotated' } : { ok: false, kind: 'network' },
      wait: async () => undefined,
    })
    expect(outcome).toEqual({ ok: true, value: 'rotated', attempts: 2, clearVault: false, recovered: true })
  })

  it('hands every attempt a signal it never aborts', async () => {
    // Cancelling a rotated-token exchange can discard a response the server has
    // already acted on, which strands the credential this guard protects.
    const signals: AbortSignal[] = []
    await runGuardedRefresh<string>({
      attempt: async (options: RefreshAttemptOptions) => {
        signals.push(options.signal)
        throw new TypeError('fetch failed')
      },
      wait: async () => undefined,
    })
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
  })

  it('waits the configured delay before retrying, and the default one otherwise', async () => {
    const waits: number[] = []
    await runGuardedRefresh<string>({
      attempt: async () => ({ ok: false, kind: 'network' }),
      wait: async ms => void waits.push(ms),
      retryDelayMs: 250,
    })
    await runGuardedRefresh<string>({
      attempt: async () => ({ ok: false, kind: 'network' }),
      wait: async ms => void waits.push(ms),
    })
    expect(waits).toEqual([250, DEFAULT_REFRESH_RETRY_DELAY_MS])
    expect(DEFAULT_REFRESH_RETRY_DELAY_MS).toBe(1_000)
  })
})
