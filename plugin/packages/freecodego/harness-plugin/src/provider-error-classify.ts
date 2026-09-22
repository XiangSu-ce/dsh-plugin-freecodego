/**
 * What a failed model request was, in terms a caller can act on.
 *
 * Why
 * ---
 * The same failure arrives in a different shape from every route: a `fetch`
 * rejection, a status code on a custom error, a DOMException from an abort
 * signal, the machine code an adapter attached, a provider's own wording in a
 * message. Reacting to the *message* at each call site is how a rate limit gets
 * retried forever while a context overflow gets retried until the budget is
 * gone, so everything funnels through one table here and each kind maps to one
 * decision.
 *
 * The three decisions that matter
 * -------------------------------
 * - **Retryable or not.** A rate limit and a 5xx are worth another attempt; a
 *   rejected key and a content refusal are not, and retrying them spends the
 *   user's budget to be told the same thing again.
 * - **Timeout or cancellation.** These look identical on the wire — an aborted
 *   iterator, an `AbortError` — and must not be treated alike. A cancellation
 *   came from the client, which has stopped listening, so the answer is to stop
 *   quietly. A timeout is the provider's failure and the protocol has to carry it
 *   so the client can tell a stall from a finished turn.
 * - **Which error the client is told.** Anthropic's clients key their own retry
 *   and backoff on the SSE error type, so sending everything as `api_error`
 *   throws away a distinction the caller already knows how to use. It is also why a
 *   `403` must never reach the client as `authentication_error`: that type is how an
 *   Anthropic client decides to send the user back to sign in, and a plan gate is not
 *   a credential problem. The numbers that say something about the account are read
 *   from `upstream-status-code.ts`, so the type in the frame and the `LlmError` code
 *   a user is shown cannot disagree.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/provider-error-classify
 */

import { StreamIdleTimeoutError } from './stream-deadline.ts'
import { upstreamStatusCategory } from './upstream-status-code.ts'

/** The kinds this plugin distinguishes. Each maps to one caller decision. */
export type ProviderErrorKind =
  | 'rate-limit'
  | 'overloaded'
  | 'auth'
  /** The account is out of credit: nothing about another attempt changes that. */
  | 'quota'
  | 'context-overflow'
  | 'timeout'
  | 'cancelled'
  | 'content'
  | 'invalid-request'
  | 'unknown'

/** The Anthropic SSE error types a client's own retry logic keys on. */
export type ProviderWireErrorType =
  | 'rate_limit_error'
  | 'overloaded_error'
  | 'authentication_error'
  | 'invalid_request_error'
  | 'request_too_large'
  | 'api_error'

/** How one provider error should be classified and answered. */
export interface ProviderErrorVerdict {
  readonly kind: ProviderErrorKind
  /** The type to put in the protocol's error frame. */
  readonly wireType: ProviderWireErrorType
  /** Whether another attempt is worth the spend. */
  readonly retryable: boolean
  /**
   * True when the caller stopped it. The stream must end *silently*: a client
   * that cancelled is not waiting for an error it caused.
   */
  readonly cancellation: boolean
  /** A bounded description, safe to put in the error frame. */
  readonly message: string
}

/** Longest message carried into an error frame. */
const MESSAGE_LIMIT = 600

/**
 * Classify a failed model request.
 * @param error - the thrown value, a stream failure, or a timeout.
 * @returns the kind, whether to retry, and how the client should be told.
 */
export function classifyProviderError(error: unknown): ProviderErrorVerdict {
  const message = describe(error)
  const status = statusOf(error)
  const name = nameOf(error)

  // Order matters and is deliberate. Four tiers, strongest evidence first:
  //
  //   1. An explicit signal — a timeout or abort *name*. Nothing a message says
  //      may override one.
  //   2. The machine code the adapter attached, which was written to be routed on.
  //      One exception, and it is deliberate: a *bucket* code (`RATE_LIMIT`) yields to
  //      a status that says the account cannot pay. That code is what this plugin's
  //      providers report for 402, 403 and 429 alike — the `LlmError` vocabulary has
  //      no code for a balance — so only the status keeps those three apart.
  //   3. The transport's status number, which is what it observed rather than prose
  //      it, or a proxy, wrapped around it.
  //   4. Wording, and only then. Inside this tier the specific conditions come
  //      before the transport catch-all, because that catch-all is `unknown` under
  //      another name.
  //
  // A `StreamIdleTimeoutError` checked after a generic "aborted" match would be
  // reported as a cancellation, which is the one confusion this module exists to
  // prevent — hence tier 1.
  if (error instanceof StreamIdleTimeoutError || name === 'TimeoutError') return verdict('timeout', message)
  // Only the name here, never the wording: `name` is the abort signal's own
  // spelling, while a message containing "aborted" is prose, and prose belongs in
  // tier 3 where a status can outrank it. Keeping both here made a 429 that mentioned
  // "aborted" report as a cancellation — the stream then ends quietly because a
  // cancellation must not raise an error, so a retryable rate limit became a client
  // waiting forever for a frame that never comes.
  if (name === 'AbortError') return verdict('cancelled', message)
  // The code is read before the status and the wording because it is the only one
  // of the three that was written to be acted on: `HarnessError.code` is documented
  // as "stable, programmatic … route on this, never by parsing `message`", and
  // `LlmFailure` carries it alongside both. A code this table does not name leaves
  // the tiers below untouched, so it can never turn a retryable failure terminal by
  // omission.
  const code = codeOf(error)
  const byCode = KIND_BY_CODE[code ?? '']
  if (byCode !== undefined && !statusRefinesCode(code, status)) return verdict(byCode, message)
  // Before the status table, and deliberately: an overflow arrives as a 400,
  // which the transport rule below would file as the caller's bad request. It is
  // the one 4xx whose message says the request was fine and the *input* is too
  // long, and that is the distinction the caller has to act on.
  if (/context (?:length|window)|too many tokens|maximum context|prompt is too long|context_length_exceeded/i.test(message)) {
    return verdict('context-overflow', message)
  }
  if (status !== undefined) return fromStatus(status, message)

  if (/rate[ _-]?limit|too many requests|429\b/i.test(message)) return verdict('rate-limit', message)
  if (/overloaded|at capacity|server is busy|529\b/i.test(message)) return verdict('overloaded', message)
  if (/api[ _-]?key|unauthori[sz]ed|authentication|invalid token|permission denied|401\b/i.test(message)) return verdict('auth', message)
  // A `402`/`403` in prose, with no number for the transport tier to read, is the
  // gate `fromStatus` reads those two as. It used to be folded into the credential
  // pattern above — which put `authentication_error` in the client's frame for an
  // account whose credential was fine — and it must not fall through to `unknown`
  // either, which is retryable and spends the budget re-sending a request the plan
  // already refused. The credential patterns stay first on purpose: a `403` whose
  // prose also names a key is that proxy's way of saying the key was refused, and
  // that is the more specific statement of the two.
  if (/\b402\b|\b403\b/i.test(message)) return verdict('quota', message)
  if (/content (?:policy|filter)|safety|moderat|flagged|blocked by/i.test(message)) return verdict('content', message)
  if (/timed? ?out|timeout|etimedout|deadline exceeded/i.test(message)) return verdict('timeout', message)
  if (/invalid[_ ]request|bad request|malformed|400\b|422\b/i.test(message)) return verdict('invalid-request', message)
  // Last of the wordings that carry a distinct meaning, and ahead of the transport
  // catch-all only because "aborted" names something and `unknown` deliberately
  // does not. It is reached only when no status and no more specific wording was
  // found, which is what makes a client-side abort recognisable without letting the
  // word outrank evidence.
  if (isCancellationWording(message)) return verdict('cancelled', message)
  if (/fetch failed|econn|enotfound|eai_again|socket hang up|network|503\b|502\b|500\b/i.test(message)) return verdict('unknown', message)
  return verdict('unknown', message)
}

/**
 * What each machine code means to this plugin, for the codes whose meaning the
 * name itself fixes.
 *
 * Before this table the code was never read at all: a failure whose wording the
 * bottom tier did not happen to recognise was answered `unknown` — which is
 * *retryable* — so a terminal failure was retried until the budget was gone, and
 * this plugin's own `PROVIDER_REFUSAL` ("provider refused the request", a
 * sentence that matches none of the wording patterns) was re-sent on safety
 * grounds. The retryable half is exactly the harness's `DEFAULT_RETRYABLE_CODES`;
 * the terminal half is deliberately not an enumeration of everything the harness
 * can produce — only the codes whose name settles the question. An errno, a
 * proxy's own spelling, or a code added to the harness after this file was
 * written falls through to status and wording exactly as before.
 */
const KIND_BY_CODE: Readonly<Record<string, ProviderErrorKind>> = {
  // The harness retry policy's default retryable set.
  EMPTY_RESPONSE: 'unknown',
  RATE_LIMIT: 'rate-limit',
  // The same condition under the other spelling the adapters use.
  RATE_LIMITED: 'rate-limit',
  SERVER: 'unknown',
  TIMEOUT: 'timeout',
  TRANSPORT: 'unknown',
  // Terminal, and named more precisely than a sentence can be: which one it was is
  // what decides what the caller has to change.
  AUTH: 'auth',
  INVALID_CREDENTIAL: 'auth',
  // `QUOTA_EXCEEDED_CODE`: an exhausted balance, canonical in `dsh-llm/error`.
  QUOTA: 'quota',
  // `CONTEXT_WINDOW_EXCEEDED_CODE`, likewise.
  CONTEXT_WINDOW_EXCEEDED: 'context-overflow',
  ABORTED: 'cancelled',
  UNSUPPORTED_CONTENT: 'content',
  // This plugin's own wire readers, for a provider that declined the request.
  PROVIDER_REFUSAL: 'content',
  PROVIDER_CONTENT_FILTER: 'content',
  INVALID_REQUEST: 'invalid-request',
  UNKNOWN_MODEL: 'invalid-request',
  INVALID_ADAPTER: 'invalid-request',
  NO_ADAPTER: 'invalid-request',
  DISCOVERY_FAILED: 'invalid-request',
  MALFORMED_RESPONSE: 'invalid-request',
  INVALID_REPLAY_STATE: 'invalid-request',
  // `IMAGE_OFFLOAD_REQUIRED_CODE`: the *same* request cannot be re-sent until the
  // caller offloads images, which is a different request and not a retry.
  IMAGE_OFFLOAD_REQUIRED: 'invalid-request',
}

/**
 * Whether a status outranks the code it arrived with.
 *
 * `RATE_LIMIT` is the code this plugin's providers report for `402`, `403` and `429`
 * alike, because the `LlmError` vocabulary has no code for a spent balance. The status
 * is therefore the finer of the two facts, and it decides: read by code alone, a plan
 * gate reached the client as `rate_limit_error` — the frame that sends the client's own
 * backoff straight back at the account that cannot pay, which is the argument the
 * `quota` row already makes against that wire type.
 *
 * Deliberately one status family. A provider that answers `400` with "rate limit
 * exceeded" in the body *is* reporting a rate limit and the code is right about it; a
 * `403` recorded as `AUTH` was chosen by an adapter that read the refusal, and that
 * reading is more specific than the number.
 */
function statusRefinesCode(code: string | undefined, status: number | undefined): boolean {
  if (status === undefined) return false
  if (code !== 'RATE_LIMIT' && code !== 'RATE_LIMITED') return false
  return upstreamStatusCategory(status) === 'quota'
}

/**
 * A status code answers the question by itself when the transport reports one.
 *
 * The numbers that say something about the *account* are read from the shared table
 * (`upstream-status-code.ts`), so a `403` classifies here exactly as it is coded in
 * the `LlmError` a user is shown. It used to be filed with `401` as `auth`, which put
 * `authentication_error` in the protocol frame — and that frame is what a client keys
 * its re-sign-in guidance on — for a plan that had merely declined the route. `402`
 * fell all the way to `invalid-request`, telling whoever read the log that the
 * request was malformed when it was the balance that was empty.
 *
 * Two statuses are decided before the table because they are protocol facts rather
 * than statements about the account: `529` is Anthropic's overload, with its own
 * retryable wire type, and `413` is a body too large for the route.
 */
function fromStatus(status: number, message: string): ProviderErrorVerdict {
  if (status === 529) return verdict('overloaded', message)
  if (status === 413) return verdict('context-overflow', message)
  switch (upstreamStatusCategory(status)) {
    case 'auth':
      return verdict('auth', message)
    // 402 and 403: the account cannot pay for this route, which is what the `quota`
    // row already argues about a wire type — `invalid_request_error` because that is
    // what Anthropic sends for a balance, and not `rate_limit_error`, which would send
    // the client's own backoff straight back at the account that cannot pay.
    case 'quota':
      return verdict('quota', message)
    case 'rate-limit':
      return verdict('rate-limit', message)
    case 'server':
      return verdict('unknown', message)
    default:
      return status >= 400 ? verdict('invalid-request', message) : verdict('unknown', message)
  }
}

/** One row of the table: kind, wire type, and whether another attempt is worth it. */
function verdict(kind: ProviderErrorKind, message: string): ProviderErrorVerdict {
  const text = message.slice(0, MESSAGE_LIMIT)
  switch (kind) {
    case 'rate-limit':
      return { kind, wireType: 'rate_limit_error', retryable: true, cancellation: false, message: text }
    case 'overloaded':
      return { kind, wireType: 'overloaded_error', retryable: true, cancellation: false, message: text }
    case 'auth':
      return { kind, wireType: 'authentication_error', retryable: false, cancellation: false, message: text }
    case 'quota':
      // Not retryable whatever the wire type: the account is empty, so another
      // attempt spends nothing but the user's time on the same refusal. The wire
      // type is `invalid_request_error` because that is what Anthropic sends for an
      // exhausted balance and because `rate_limit_error` would send the client's own
      // backoff straight back to the empty account; the distinct kind is what tells
      // the log to say "add credit" instead of "the request was malformed".
      return { kind, wireType: 'invalid_request_error', retryable: false, cancellation: false, message: text }
    case 'context-overflow':
      // Not retryable as-is: another identical request is the same too-long
      // request. The caller has to change the input, which is why the kind is its
      // own rather than folded into invalid-request.
      return { kind, wireType: 'request_too_large', retryable: false, cancellation: false, message: text }
    case 'timeout':
      // No timeout type exists in the protocol, and a client's retry logic keys
      // on `api_error`; the distinct kind is what this plugin reports locally.
      return { kind, wireType: 'api_error', retryable: true, cancellation: false, message: text }
    case 'cancelled':
      return { kind, wireType: 'api_error', retryable: false, cancellation: true, message: text }
    case 'content':
      return { kind, wireType: 'invalid_request_error', retryable: false, cancellation: false, message: text }
    case 'invalid-request':
      return { kind, wireType: 'invalid_request_error', retryable: false, cancellation: false, message: text }
    case 'unknown':
      return { kind, wireType: 'api_error', retryable: true, cancellation: false, message: text }
  }
}

/** A thrown value's message, without the `[object Object]` trap. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error)
  if (error === undefined || error === null) return 'the model request failed'
  const message = (error as { readonly message?: unknown }).message
  if (typeof message === 'string' && message !== '') return message
  // A plain object with nothing readable in it: rendering it would put
  // `[object Object]` into an error frame, which reads like evidence and is not.
  return 'the model request failed'
}

/** The stable machine code an error or failure object carries, when it has one. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  // A string only: `DOMException`'s `code` is a number, and neither spelling of an
  // errno is in the table above.
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** The abort or timeout signal name, when the value carries one. */
function nameOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const name = (error as { readonly name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

/**
 * A numeric HTTP status, when the value carries a usable one.
 *
 * Two shapes carry one, and both are read. A provider's own exception — a library's
 * error, or one of this plugin's `…UpstreamError`s — puts the number at `status`.
 * `LlmError`, which is what every adapter in this plugin throws, keeps it on the frozen
 * `failure` record instead (`LlmFailure` is `{ message, code, status? }`, documented in
 * `@deepseek-ai/dsh-llm`). Reading only the first shape left the whole status tier dead
 * for this plugin's own failures: the code tier answered every one of them, which is
 * how a `403` recorded as `RATE_LIMIT` became a retryable rate gate in the frame.
 */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const bare = (error as { readonly status?: unknown }).status
  const nested = (error as { readonly failure?: { readonly status?: unknown } }).failure?.status
  return usableStatus(bare) ?? usableStatus(nested)
}

/** An HTTP status this table can route on, or `undefined` for anything else. */
function usableStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

/**
 * The wording an abort carries when it is not a `DOMException`.
 *
 * Node's own `AbortSignal.timeout()` produces a `TimeoutError` DOMException, but
 * a controller aborted with a reason — which is how this plugin aborts on a
 * client disconnect — carries whatever the caller passed, so both spellings are
 * recognised here.
 */
function isCancellationWording(message: string): boolean {
  return /\bcancel?led\b|\baborted\b|client disconnected/i.test(message)
}
