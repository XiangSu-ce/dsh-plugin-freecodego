/**
 * G8 — the sleep gate.
 *
 * Two halves, and each has one assertion worth reading first. In the detection
 * half it is `a monotonic clock that goes backwards is not evidence` — a guard
 * that fires on bookkeeping mistakes gets switched off. In the refresh half it is
 * `never aborts the in-flight refresh`, because a cancelled rotation can discard
 * a token the server has already consumed.
 */

import { describe, expect, test } from 'vitest'

import {
  DEFAULT_SUSPEND_THRESHOLD_MS,
  classifyRefreshFailure,
  detectSuspend,
  runGuardedRefresh,
  startSuspendWatch,
} from '../src/system-power.ts'

describe('suspend detection', () => {
  test('no drift is not evidence of anything', () => {
    expect(detectSuspend({ wallMs: 1_000, monoMs: 500 }, { wallMs: 2_000, monoMs: 1_500 })).toBeUndefined()
  })

  test('a small drift stays below the threshold', () => {
    expect(detectSuspend({ wallMs: 0, monoMs: 0 }, { wallMs: 10_000, monoMs: 5_000 })).toBeUndefined()
  })

  test('a drift at the threshold is reported', () => {
    const evidence = detectSuspend(
      { wallMs: 0, monoMs: 0 },
      { wallMs: 100_000 + DEFAULT_SUSPEND_THRESHOLD_MS, monoMs: 100_000 },
    )
    expect(evidence).toBeDefined()
    expect(evidence!.driftMs).toBe(DEFAULT_SUSPEND_THRESHOLD_MS)
    expect(evidence!.kind).toBe('suspect-sleep')
  })

  test('a drift one millisecond under the threshold is not reported', () => {
    expect(detectSuspend({ wallMs: 0, monoMs: 0 }, { wallMs: DEFAULT_SUSPEND_THRESHOLD_MS - 1, monoMs: 0 })).toBeUndefined()
  })

  test('a whole night of sleep is reported with both intervals', () => {
    const evidence = detectSuspend({ wallMs: 0, monoMs: 0 }, { wallMs: 8 * 3_600_000, monoMs: 1_000 })
    expect(evidence!.wallMs).toBe(8 * 3_600_000)
    expect(evidence!.monoMs).toBe(1_000)
    expect(evidence!.driftMs).toBe(8 * 3_600_000 - 1_000)
  })

  test('a monotonic clock that goes backwards is not evidence', () => {
    // Two samples from different processes, or a pair assembled out of order.
    // Firing a revalidation on a bookkeeping mistake is how a guard gets
    // switched off.
    expect(detectSuspend({ wallMs: 5_000, monoMs: 5_000 }, { wallMs: 6_000, monoMs: 4_000 })).toBeUndefined()
  })

  test('a wall clock that goes backwards is not evidence either', () => {
    expect(detectSuspend({ wallMs: 5_000, monoMs: 5_000 }, { wallMs: 4_000, monoMs: 5_100 })).toBeUndefined()
  })
})

describe('the watch timer', () => {
  test('reports a suspend after the clocks move', () => {
    let wall = 0
    const mono = 0
    const fired: number[] = []
    const stop = startSuspendWatch({
      onSuspectSleep: evidence => void fired.push(evidence.driftMs),
      readClock: () => ({ wallMs: wall, monoMs: mono }),
      intervalMs: 5,
    })
    wall += 1_000_000
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        stop()
        expect(fired.length).toBeGreaterThan(0)
        resolve()
      }, 40)
    })
  })

  test('the interval is unref-able, so it cannot hold the process open', () => {
    // The same convention the plugin's other intervals follow: a timer that
    // outlives the last session is a hang, not a feature.
    let unrefCalled = false
    const realSetInterval = globalThis.setInterval
    const fake = ((handler: () => void, timeout?: number) => {
      const handle = realSetInterval(handler, timeout)
      const originalUnref = handle.unref?.bind(handle)
      handle.unref = () => {
        unrefCalled = true
        originalUnref?.()
        return handle
      }
      return handle
    }) as typeof setInterval
    globalThis.setInterval = fake
    try {
      const stop = startSuspendWatch({ onSuspectSleep: () => undefined, readClock: () => ({ wallMs: 0, monoMs: 0 }), intervalMs: 1_000_000 })
      stop()
    } finally {
      globalThis.setInterval = realSetInterval
    }
    expect(unrefCalled).toBe(true)
  })
})

describe('failure classification', () => {
  test('a 401 or 403 is an explicit invalidation', () => {
    for (const status of [401, 403]) {
      expect(classifyRefreshFailure(Object.assign(new Error('nope'), { status })).kind).toBe('invalid')
    }
  })

  test('the gateway wording for a consumed rotation is an invalidation', () => {
    for (const message of [
      'refresh token is invalid',
      'refresh_token reused',
      'refresh token already used',
      'the refresh token has expired',
      'invalid refresh credential',
    ]) {
      expect(classifyRefreshFailure(new Error(message)).kind).toBe('invalid')
    }
  })

  test('a plain 400 is a request problem, not a dead credential', () => {
    // A malformed device id must not wipe the vault.
    expect(classifyRefreshFailure(Object.assign(new Error('bad device id'), { status: 400 })).kind).toBe('transient')
  })

  test('a 5xx is treated as a network failure and is retried', () => {
    expect(classifyRefreshFailure(Object.assign(new Error('bad gateway'), { status: 502 })).kind).toBe('network')
  })

  test('transport errors read as network failures', () => {
    for (const message of ['fetch failed', 'ECONNREFUSED', 'socket hang up', 'The operation was aborted due to timeout']) {
      expect(classifyRefreshFailure(new Error(message)).kind).toBe('network')
    }
  })

  test('an unrecognised error is never treated as an invalidation', () => {
    // The asymmetry that matters: guessing "invalid" erases a user's session.
    const classified = classifyRefreshFailure(new Error('something nobody anticipated'))
    expect(classified.kind).toBe('unknown')
    expect(classified.kind).not.toBe('invalid')
  })

  test('a thrown non-Error still yields a kind rather than crashing', () => {
    expect(classifyRefreshFailure('a bare string').kind).toBe('unknown')
    expect(classifyRefreshFailure(undefined).kind).toBe('network')
  })
})

describe('the guarded refresh', () => {
  test('never aborts the in-flight refresh, whatever the failure', async () => {
    // The bug this prevents: a timer fires during a suspend, decides the refresh
    // "took too long", cancels it, and discards the rotated token the server had
    // already issued — logging the user out with the guard meant to keep them in.
    const signals: AbortSignal[] = []
    for (const failure of [
      Object.assign(new Error('fetch failed'), { status: undefined }),
      Object.assign(new Error('forbidden'), { status: 403 }),
      Object.assign(new Error('bad request'), { status: 400 }),
      new Error('unsurprising'),
    ]) {
      await runGuardedRefresh({
        attempt: async (options) => {
          signals.push(options.signal)
          throw failure
        },
        wait: async () => undefined,
      })
    }
    // One attempt each for the invalid/transient/unknown cases, two for the
    // network one: only a network failure is retried.
    expect(signals).toHaveLength(5)
    expect(signals.every(signal => signal.aborted)).toBe(false)
  })

  test('succeeds on the first attempt without retrying', async () => {
    let calls = 0
    const outcome = await runGuardedRefresh({
      attempt: async () => {
        calls += 1
        return 'token'
      },
    })
    expect(outcome).toEqual({ ok: true, value: 'token', attempts: 1, clearVault: false })
    expect(calls).toBe(1)
  })

  test('retries a network failure exactly once and succeeds', async () => {
    let calls = 0
    const outcome = await runGuardedRefresh({
      attempt: async () => {
        calls += 1
        if (calls === 1) throw new Error('fetch failed')
        return 'token'
      },
      wait: async () => undefined,
    })
    expect(outcome).toMatchObject({ ok: true, attempts: 2, clearVault: false, recovered: true })
  })

  test('does not retry a network failure twice', async () => {
    let calls = 0
    const outcome = await runGuardedRefresh({
      attempt: async () => {
        calls += 1
        throw new Error('fetch failed')
      },
      wait: async () => undefined,
    })
    expect(calls).toBe(2)
    expect(outcome.ok).toBe(false)
    expect(outcome.clearVault).toBe(false)
  })

  test('a network failure never clears the vault', async () => {
    // A laptop that woke without a network yet is the ordinary case.
    const outcome = await runGuardedRefresh({
      attempt: async (): Promise<string> => { throw new Error('fetch failed') },
      wait: async () => undefined,
    })
    expect(outcome.clearVault).toBe(false)
  })

  test('an explicit invalidation clears the vault', async () => {
    const outcome = await runGuardedRefresh({
      attempt: async (): Promise<string> => { throw Object.assign(new Error('forbidden'), { status: 403 }) },
    })
    expect(outcome.clearVault).toBe(true)
    expect(outcome.failureKind).toBe('invalid')
  })

  test('an invalidation is not retried, because retrying does not un-invalidate', async () => {
    let calls = 0
    await runGuardedRefresh({
      attempt: async (): Promise<string> => {
        calls += 1
        throw Object.assign(new Error('forbidden'), { status: 403 })
      },
    })
    expect(calls).toBe(1)
  })

  test('a transient failure is not retried and does not clear the vault', async () => {
    let calls = 0
    const outcome = await runGuardedRefresh({
      attempt: async (): Promise<string> => {
        calls += 1
        throw Object.assign(new Error('bad device id'), { status: 400 })
      },
    })
    expect(calls).toBe(1)
    expect(outcome.clearVault).toBe(false)
  })

  test('a retry that comes back invalid still clears the vault', async () => {
    // The rule is applied to the last word, so having retried neither widens nor
    // narrows the erasure path.
    let calls = 0
    const outcome = await runGuardedRefresh({
      attempt: async (): Promise<string> => {
        calls += 1
        if (calls === 1) throw new Error('fetch failed')
        throw Object.assign(new Error('forbidden'), { status: 403 })
      },
      wait: async () => undefined,
    })
    expect(outcome.clearVault).toBe(true)
    expect(outcome.attempts).toBe(2)
  })

  test('the retry waits before trying again', async () => {
    const waits: number[] = []
    await runGuardedRefresh({
      attempt: async (): Promise<string> => { throw new Error('fetch failed') },
      wait: async ms => void waits.push(ms),
      retryDelayMs: 250,
    })
    expect(waits).toEqual([250])
  })

  test('the first attempt is marked as not-a-retry so a caller can tell them apart', async () => {
    const retries: boolean[] = []
    await runGuardedRefresh({
      attempt: async (options) => {
        retries.push(options.retry)
        throw new Error('fetch failed')
      },
      wait: async () => undefined,
    })
    expect(retries).toEqual([false, true])
  })

  test('a caller-supplied classifier replaces the default', async () => {
    // The seam that lets a caller whose transport reports failures differently
    // keep the policy without editing the guard.
    const outcome = await runGuardedRefresh({
      attempt: async (): Promise<string> => { throw new Error('anything at all') },
      classify: () => ({ kind: 'invalid' as const, message: 'classified' }),
    })
    expect(outcome).toMatchObject({ clearVault: true, failureKind: 'invalid', message: 'classified' })
  })

  test('the guard is the api package implementation, not a local copy', async () => {
    // Asserted so the re-export cannot silently become a fork: two
    // implementations of "when may I erase a user's credentials" would drift
    // apart silently until one of them logged someone out.
    const api = await import('@deepseek-ai/dsh-freecodego-api')
    const local = await import('../src/system-power.ts')
    expect(local.runGuardedRefresh).toBe(api.runGuardedRefresh)
    expect(local.classifyRefreshFailure).toBe(api.classifyRefreshFailure)
  })
})
