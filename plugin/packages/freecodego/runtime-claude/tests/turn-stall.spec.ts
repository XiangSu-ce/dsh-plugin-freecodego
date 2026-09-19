/**
 * The Claude turn watchdog.
 *
 * The defect: this runtime drives the SDK in-process, so a turn *is*
 * `await native.prompt(...)`, and `for await (const message of conversation)`
 * blocks until the session yields or throws. An SDK that goes quiet — a wedged
 * request, a half-open socket — does neither, so the Host waits forever on a
 * turn nothing will ever settle. The sibling Codex runtime bounds the same wait;
 * this one had no bound at all.
 *
 * The property this file pins is not "a timer exists". It is that silence
 * *throws*, because that is the only channel the Host is listening on: an event
 * cannot settle a turn the Host is still awaiting, and a rejection it does not
 * read becomes an unhandled rejection. It also pins the two shapes a plausible
 * fix gets wrong — a budget that is absolute rather than idle (a long but
 * healthy turn would be cut off) and a stop that is reported as a user
 * cancellation (which is exactly what this runtime must never claim).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query,
}))

import { openClaudeRootRuntime } from '../src/index.ts'

/** The window the runtime arms, restated so a change to it is a visible diff. */
const WATCHDOG_MS = 15 * 60_000

/** One 14-minute gap: under the window, so a healthy turn keeps its margin. */
const GAP_MS = 14 * 60_000

type Message = { readonly type: string; readonly [key: string]: unknown }
type Conversation = AsyncIterable<Message> & { readonly interrupt: () => Promise<void>; readonly nextCalls: () => number }

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  // Fake timers are per-test; leaving them on would silently disarm the next one.
  vi.useRealTimers()
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
  query.mockReset()
})

/**
 * Only the two timers the deadline itself uses are faked.
 *
 * `setImmediate` stays real on purpose: it is how this file waits for the turn's
 * own file reads, which fake timers cannot drive. Faking it would deadlock the
 * very `await` that reaches the watchdog.
 */
function useWatchdogClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** A real event-loop turn, for the async work a fake clock does not advance. */
function pump(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/**
 * How long a turn may take to reach the SDK session before this helper gives up.
 *
 * A wall-clock budget rather than a count of event-loop turns, because the two
 * are not interchangeable. One `setImmediate` turn is tens of microseconds, so
 * the 200-iteration loop this replaced bought roughly 80ms of real time — while
 * the turn being awaited does real work first: it reads `sdk-session-ids.json`
 * and builds the subprocess environment before it reaches `query()`. On a loaded
 * machine (this repository's normal state: several agents build and run suites at
 * once) that read outlasts 80ms, and this helper threw for a turn that was merely
 * slow — a green spec went red with a message naming the wrong cause. Measured
 * with the full plugin suite running alongside, 2 of 5 runs failed that way; with
 * the budget below, 0 of 5 did.
 *
 * Deliberately under vitest's 5s default test timeout, so a turn that genuinely
 * never arrives still fails on the message that says so rather than on "test
 * timed out". `Date.now()` is safe to use here: {@link useWatchdogClock} fakes
 * only `setTimeout`/`clearTimeout`, and this file depends on that — the same
 * reason its `setImmediate` pump is real.
 */
const PUMP_DEADLINE_MS = 4_000

/** Wait for a condition the turn reaches asynchronously, without ever hanging. */
async function pumpUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + PUMP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (condition()) return
    await pump()
  }
  // Checked once more after the loop: the last `pump()` may have been the one
  // that let the turn arrive, and reporting a failure the condition would now
  // contradict is the one wrong answer worth avoiding here.
  if (condition()) return
  throw new Error('the turn never reached the SDK session')
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await pump()
}

/**
 * The turn's outcome, with a handler attached *now*.
 *
 * The deadline fires while this file is inside `advance`, so an assertion
 * written after it attaches its handler too late: Node has already seen the
 * rejection and reports it as a suite-level unhandled error — which is a red
 * suite for the wrong reason, and hides the failure the test is about.
 */
function outcomeOf(turn: Promise<void>): Promise<unknown> {
  return turn.then(() => undefined, (error: unknown) => error)
}

/**
 * The `session/completed` statuses a turn announced, in order.
 *
 * Read out rather than matched with `expect.objectContaining`, whose `any`
 * return is what makes the matcher form an unsafe assignment.
 */
function completionStatuses(events: readonly { readonly method: string; readonly params: Record<string, unknown> }[]): unknown[] {
  return events.filter(event => event.method === 'session/completed').map(event => event.params.status)
}

/** An abort signal's own reason, narrowed to the Error a rejection must carry. */
function abortFailure(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('the caller aborted the SDK session')
}

interface OpenedSession {
  readonly session: Awaited<ReturnType<typeof openClaudeRootRuntime>>
  readonly events: { readonly method: string; readonly params: Record<string, unknown> }[]
}

async function openSession(harnessSessionId: string): Promise<OpenedSession> {
  const stateDirectory = await mkdtemp(join(tmpdir(), `freecodego-claude-${harnessSessionId}-`))
  cleanups.push(async () => { await rm(stateDirectory, { recursive: true, force: true }) })
  const events: { readonly method: string; readonly params: Record<string, unknown> }[] = []
  const session = await openClaudeRootRuntime({ stateDirectory }, {
    harnessSessionId,
    modelId: 'claude-test',
    provider: 'test',
    workspace: process.cwd(),
    artifactDigest: 'test-artifact',
    protocolAbi: 'freecodego-agent/1',
    onEvent: (event) => { events.push({ method: event.method, params: event.params }) },
  })
  return { session, events }
}

/**
 * An SDK conversation that took the prompt and then went silent forever.
 *
 * Written as a hand-built iterator rather than a generator on purpose: a
 * generator suspended inside its own `await` is the shape the deadline has to
 * survive, and the real SDK's is not a generator this file could drive anyway.
 */
function silentConversation(interrupt: () => Promise<void>): Conversation {
  let calls = 0
  return {
    interrupt,
    nextCalls: () => calls,
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<Message>> => { calls += 1; return new Promise<IteratorResult<Message>>(() => undefined) },
        return: async (): Promise<IteratorResult<Message>> => ({ done: true, value: undefined }),
      }
    },
  }
}

/** A conversation that answers `events` times, one every `gapMs`, then ends. */
function pacedConversation(events: number, gapMs: number): Conversation {
  let calls = 0
  let emitted = 0
  return {
    interrupt: async () => undefined,
    nextCalls: () => calls,
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<Message>> => {
          calls += 1
          return new Promise<IteratorResult<Message>>((resolve) => {
            setTimeout(() => {
              emitted += 1
              resolve(emitted > events
                ? { done: true, value: undefined }
                : { done: false, value: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text_delta: 'tick' } } } })
            }, gapMs)
          })
        },
        return: async (): Promise<IteratorResult<Message>> => ({ done: true, value: undefined }),
      }
    },
  }
}

describe('the Claude turn watchdog', () => {
  it('fails a turn whose SDK session stops producing events', async () => {
    useWatchdogClock()
    const conversation = silentConversation(async () => undefined)
    query.mockImplementation(() => conversation)
    const { session, events } = await openSession('claude-silent')
    const prompt = outcomeOf(session.prompt('a turn that goes silent'))
    await pumpUntil(() => conversation.nextCalls() > 0)
    await advance(WATCHDOG_MS)
    // Without the deadline this never settles at all, and the Host's
    // `await native.prompt(...)` is where the turn — and the user's UI — stays.
    const failure = await prompt
    expect(failure, 'the turn settled instead of being failed by the watchdog').toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/no SDK events/u)
    // The turn failed; it was not cancelled. Reporting `aborted` here would
    // settle the Host on a cause the user never chose, and the Host's recovery
    // path reads that status as "the user stopped this".
    expect(completionStatuses(events)).not.toContain('aborted')
  })

  it('re-arms the window on every event, so a long turn is not cut off', async () => {
    useWatchdogClock()
    // Three events, one every 14 minutes: 42 minutes of turn against a 15-minute
    // window, and no single gap anywhere near it. An absolute budget would have
    // failed this turn at the 15-minute mark; an idle one must not, because a
    // turn that keeps producing is exactly the turn this runtime must not kill.
    const conversation = pacedConversation(3, GAP_MS)
    query.mockImplementation(() => conversation)
    const { session } = await openSession('claude-long-turn')
    const prompt = outcomeOf(session.prompt('a long but healthy turn'))
    await pumpUntil(() => conversation.nextCalls() > 0)
    for (let step = 0; step < 6; step += 1) await advance(GAP_MS)
    expect(await prompt, 'a turn that kept producing was cut off').toBeUndefined()
  })

  it('stops the stalled session instead of leaving it generating', async () => {
    useWatchdogClock()
    const interrupt = vi.fn(async () => undefined)
    const conversation = silentConversation(interrupt)
    query.mockImplementation(() => conversation)
    const { session } = await openSession('claude-stall-interrupt')
    const prompt = outcomeOf(session.prompt('a turn that goes silent'))
    await pumpUntil(() => conversation.nextCalls() > 0)
    await advance(WATCHDOG_MS)
    const failure = await prompt
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/no SDK events/u)
    // A turn the Host has already settled must not keep the SDK working.
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('still reaches the SDK interrupt through the deadline wrapper', async () => {
    // The deadline wrapper is a plain async iterable: it carries no `interrupt`.
    // If the session held the wrapper instead of the conversation, `cancel()`
    // would keep returning without telling the SDK anything — a cancellation
    // that reports success while the model keeps generating.
    const interrupt = vi.fn(async () => undefined)
    query.mockImplementation((request: { options: { abortController: AbortController } }) => {
      const { signal } = request.options.abortController
      return {
        interrupt,
        async *[Symbol.asyncIterator](): AsyncGenerator<never> {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(abortFailure(signal.reason)) }, { once: true })
          })
        },
      }
    })
    const { session, events } = await openSession('claude-cancel-interrupt')
    const prompt = outcomeOf(session.prompt('cancel this request'))
    await pumpUntil(() => query.mock.calls.length > 0)
    await session.cancel()
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(await prompt).toBeUndefined()
    expect(completionStatuses(events)).toContain('aborted')
  })
})
