/**
 * What a failed model request was.
 *
 * Two properties carry this table. The first is that a *timeout* and a
 * *cancellation* — which arrive as the same aborted iterator and must take
 * different paths — are never confused. The second is that whatever the shape,
 * something bounded and readable reaches the error frame: `[object Object]` in a
 * protocol error is worse than the provider's own words.
 */

import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../src/provider-error-classify.ts'
import { StreamIdleTimeoutError } from '../src/stream-deadline.ts'

/** The shape the API client throws for a non-2xx response. */
function http(status: number, message = `HTTP ${String(status)}`): Error {
  return Object.assign(new Error(message), { status })
}

describe('timeout versus cancellation', () => {
  it('reads the stream deadline as a timeout the client can be told about', () => {
    const verdict = classifyProviderError(new StreamIdleTimeoutError(30_000))
    expect(verdict.kind).toBe('timeout')
    expect(verdict.retryable).toBe(true)
    expect(verdict.cancellation).toBe(false)
    // No timeout type exists in the protocol, so the wire form is the generic
    // one; the distinct kind is this plugin's own answer.
    expect(verdict.wireType).toBe('api_error')
  })

  it('reads an aborted signal as a cancellation, whatever carried it', () => {
    for (const error of [
      new Error('This operation was aborted'),
      Object.assign(new Error('bridge client disconnected'), { name: 'AbortError' }),
      new Error('the request was canceled by the caller'),
    ]) {
      const verdict = classifyProviderError(error)
      expect(verdict.cancellation, error.message).toBe(true)
      expect(verdict.retryable, error.message).toBe(false)
    }
  })

  it('tells a timeout DOMException from an abort DOMException', () => {
    // Both are DOMExceptions with an empty message; only the name separates them,
    // and this is exactly the pair a wording-only classifier gets wrong.
    const timeout = Object.assign(new Error(''), { name: 'TimeoutError' })
    const abort = Object.assign(new Error(''), { name: 'AbortError' })
    expect(classifyProviderError(timeout).kind).toBe('timeout')
    expect(classifyProviderError(abort).kind).toBe('cancelled')
  })

  it('does not read a provider timeout as a cancellation', () => {
    const verdict = classifyProviderError(new Error('fetch failed: ETIMEDOUT'))
    expect(verdict.kind).toBe('timeout')
    expect(verdict.cancellation).toBe(false)
  })
})

describe('what is worth retrying', () => {
  it('retries a rate limit and an overload, and names them for the client', () => {
    expect(classifyProviderError(http(429, 'rate limited'))).toMatchObject({ kind: 'rate-limit', retryable: true, wireType: 'rate_limit_error' })
    expect(classifyProviderError(http(529, 'overloaded'))).toMatchObject({ kind: 'overloaded', retryable: true, wireType: 'overloaded_error' })
  })

  it('does not retry a rejected key, a content refusal, or a bad request', () => {
    expect(classifyProviderError(http(401, 'invalid api key'))).toMatchObject({ kind: 'auth', retryable: false })
    expect(classifyProviderError(new Error('the content policy blocked this request'))).toMatchObject({ kind: 'content', retryable: false })
    expect(classifyProviderError(http(422, 'malformed tool schema'))).toMatchObject({ kind: 'invalid-request', retryable: false })
  })

  it('gives a context overflow its own kind, because the fix is the input', () => {
    // Retrying the identical request is the same too-long request. Folding this
    // into `invalid-request` would hide the one action that works.
    const verdict = classifyProviderError(http(400, 'maximum context length exceeded'))
    expect(verdict.kind).toBe('context-overflow')
    expect(verdict.retryable).toBe(false)
    expect(verdict.wireType).toBe('request_too_large')
    expect(classifyProviderError(new Error('This model\'s maximum context length is 128000 tokens')).kind).toBe('context-overflow')
  })

  it('retries a server failure without pretending to know what it was', () => {
    expect(classifyProviderError(http(503, 'service unavailable'))).toMatchObject({ kind: 'unknown', retryable: true, wireType: 'api_error' })
    expect(classifyProviderError(new TypeError('fetch failed')).retryable).toBe(true)
  })

  it('prefers a status over the wording that came with it', () => {
    // The transport's number is what it observed; the message is prose, and a
    // proxy that appends "timeout" to a 429 must not turn it into a timeout.
    expect(classifyProviderError(http(429, 'timeout while waiting')).kind).toBe('rate-limit')
  })

  it('prefers a status over cancellation wording too, so a rate limit is not silenced', () => {
    // The same rule as above, for the one wording that changes the *outcome* rather
    // than only the label. `cancelled` makes the stream end quietly because the
    // client that asked for it has stopped listening — so reading "aborted" as a
    // cancellation turns a retryable rate limit into a client waiting forever for
    // an error frame that never comes.
    expect(classifyProviderError(http(429, 'request aborted')).kind).toBe('rate-limit')
    expect(classifyProviderError(http(503, 'connection aborted')).retryable).toBe(true)
    expect(classifyProviderError(http(401, 'aborted')).kind).toBe('auth')
  })
})

describe('the machine code, which is the one signal written to be routed on', () => {
  /**
   * The shape an adapter's failure reaches this module in: `LlmFailure` is
   * `{ message, code, status? }`, and the plugin's own wire readers build plain
   * objects of the same shape (`{ message: 'provider refused the request', code:
   * 'PROVIDER_REFUSAL' }`). `HarnessError` — which every adapter throws — documents
   * its `code` as the thing to route on, "never by parsing `message`".
   */
  function failure(message: string, code: string, status?: number): Error {
    return Object.assign(new Error(message), status === undefined ? { code } : { code, status })
  }

  it('does not retry a code the harness retry policy calls terminal', () => {
    // `DEFAULT_RETRYABLE_CODES` is `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT,
    // TRANSPORT]`, so every one of these is terminal by the harness's own
    // decision. Each message is provider wording that the wording table below
    // does not recognise, which is what made them retryable until the code was
    // read — each retry spending the user's budget to be told the same thing.
    const terminal: readonly (readonly [string, string])[] = [
      ['Insufficient Balance', 'QUOTA'],
      ['Your credit balance is too low to access the API', 'QUOTA'],
      ['The request is too large for this model', 'CONTEXT_WINDOW_EXCEEDED'],
      ['The model "gpt-5.9" does not exist', 'UNKNOWN_MODEL'],
      ['No adapter is registered for provider "x"', 'NO_ADAPTER'],
      ['Dynamic discovery failed for this route', 'DISCOVERY_FAILED'],
      ['The tool schema at tools[3] was rejected', 'INVALID_REQUEST'],
      ['The stored credential cannot be used', 'INVALID_CREDENTIAL'],
      ['Provider rejected the credential', 'AUTH'],
    ]
    for (const [message, code] of terminal) {
      const verdict = classifyProviderError(failure(message, code))
      expect(verdict.retryable, `${code}: ${message}`).toBe(false)
      expect(verdict.cancellation, `${code}: ${message}`).toBe(false)
    }
  })

  it('keeps the harness retryable codes retryable, and names the ones it can', () => {
    expect(classifyProviderError(failure('The provider is rate limiting this key', 'RATE_LIMIT')))
      .toMatchObject({ kind: 'rate-limit', retryable: true, wireType: 'rate_limit_error' })
    expect(classifyProviderError(failure('Provider returned an unexpected error', 'SERVER')).retryable).toBe(true)
    expect(classifyProviderError(failure('The connection was reset', 'TRANSPORT')).retryable).toBe(true)
    // No timeout type exists in the protocol; the kind is this plugin's answer.
    expect(classifyProviderError(failure('The request deadline elapsed', 'TIMEOUT')))
      .toMatchObject({ kind: 'timeout', retryable: true })
    expect(classifyProviderError(failure('The completion came back empty', 'EMPTY_RESPONSE')).retryable).toBe(true)
  })

  it('gives an exhausted balance its own kind, because the fix is not a retry', () => {
    // Anthropic reports this as `invalid_request_error`, so that is the wire form;
    // the distinct kind is what says "add credit" rather than "your request was
    // malformed" to whoever reads the log.
    expect(classifyProviderError(failure('Insufficient Balance', 'QUOTA', 402)))
      .toMatchObject({ kind: 'quota', retryable: false, wireType: 'invalid_request_error' })
  })

  it('reads a route that stopped before the first token as the cancellation it is', () => {
    // This plugin's own abort code. The wording table only knows the spellings
    // `aborted`/`cancelled`, so a route that ended for another reason arrived as
    // `unknown` — retryable — and the retry path then re-sent a request the client
    // had already stopped waiting for.
    expect(classifyProviderError(failure('The bridge stopped before the first token', 'ABORTED')))
      .toMatchObject({ kind: 'cancelled', cancellation: true, retryable: false })
  })

  it('reads the plugin\'s own refusal code as a content refusal, not an unknown one', () => {
    // Measured: `provider refused the request` matches nothing in the wording
    // table, so this plugin classified its own refusal as `unknown` — retryable —
    // and spent another attempt on a request the provider had already declined on
    // safety grounds.
    expect(classifyProviderError({ message: 'provider refused the request', code: 'PROVIDER_REFUSAL' }))
      .toMatchObject({ kind: 'content', retryable: false, wireType: 'invalid_request_error' })
  })

  it('falls back to status and wording for a code it does not know', () => {
    // An errno, a proxy's code, or a provider code added after this table was
    // written must not become terminal by omission: an unrecognised code leaves
    // the tiers below exactly as they were.
    expect(classifyProviderError(failure('service unavailable', 'ECONNRESET', 503)).retryable).toBe(true)
    expect(classifyProviderError(failure('invalid api key', 'ENOENT')).kind).toBe('auth')
    expect(classifyProviderError(failure('rate limited', 'SOMETHING_NEW', 429)).kind).toBe('rate-limit')
  })

  it('still lets an abort signal name outrank the code on the same value', () => {
    // Tier 1 stays tier 1: the name is the abort signal's own spelling, and a
    // cancellation must never be retried. A value carrying both is contradictory,
    // and the safe reading of a contradiction is the one that stops quietly.
    const both = Object.assign(new Error('the caller gave up'), { name: 'AbortError', code: 'RATE_LIMIT' })
    expect(classifyProviderError(both)).toMatchObject({ cancellation: true, retryable: false })
  })
})

describe('what reaches the error frame', () => {
  it('never renders a bare object', () => {
    for (const error of [{}, { detail: 'something' }, []]) {
      const verdict = classifyProviderError(error)
      expect(verdict.message).not.toContain('[object')
      expect(verdict.message.length).toBeGreaterThan(0)
    }
  })

  it('bounds a message, so a provider cannot write a novel into the frame', () => {
    const verdict = classifyProviderError(new Error('x'.repeat(5_000)))
    expect(verdict.message.length).toBeLessThanOrEqual(600)
  })

  it('answers for a value that is not an error at all', () => {
    expect(classifyProviderError(undefined).kind).toBe('unknown')
    expect(classifyProviderError(undefined).message).toBe('the model request failed')
    expect(classifyProviderError(503).kind).toBe('unknown')
  })
})
