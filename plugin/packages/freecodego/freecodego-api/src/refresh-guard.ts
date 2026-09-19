/**
 * The refresh guard: two rules that protect a token rotation.
 *
 * Why this is here and not in the plugin
 * -------------------------------------
 * Every refresh path lives in this package, and the plugin depends on this
 * package rather than the other way round. A guard implemented above the
 * refreshes it guards would have to be re-implemented by each caller, and two
 * implementations of \"when may I erase a user's credentials\" would eventually
 * disagree. So there is one implementation, and `harness-plugin`'s
 * `system-power.ts` re-exports it rather than owning a second copy.
 *
 * Rule 1: an in-flight refresh is never aborted.
 * ---------------------------------------------
 * A rotated-token exchange is not idempotent. The server consumes the old
 * refresh token the moment the exchange succeeds, so cancelling a request that
 * would have succeeded can discard a response the server has already acted on —
 * stranding the credential the guard exists to protect. The signal this guard
 * hands each attempt is therefore one it creates and never aborts. A caller may
 * still bound its own *wait*; it may not cancel the exchange.
 *
 * That does not cover a wall-clock timeout inside the transport: a `setTimeout`
 * that fires after a laptop wakes is indistinguishable from one that fired on
 * time, and pretending otherwise here would mean writing a branch that cannot be
 * tested. What this guard does about that case is retry.
 *
 * Rule 2: a network failure is retried exactly once.
 * ------------------------------------------------
 * A machine that resumed without a network yet is the ordinary case, not an
 * authentication failure, and reporting it as one is how a resume becomes a
 * forced sign-in. The bound is one because a persistent outage is not fixed by
 * trying harder.
 *
 * Only an explicit invalidation erases credentials. That rule predates this
 * module and this module does not relax it; the classification below is what
 * makes it checkable in one place instead of at each catch site.
 *
 * An attempt may throw or report its own result
 * --------------------------------------------
 * Both styles are accepted, and the distinction is load-bearing rather than
 * convenient: an attempt that *resolves* `{ ok: false }` is reporting a failure,
 * and a guard that reads it as a success value would answer `ok: true` while
 * holding a credential the server just rejected — nothing retries, and nothing is
 * erased, which is worse than having no rules at all.
 *
 * The discriminator is `ok` **being a boolean**. A payload that happens to carry
 * a string field called `ok` is data, not a verdict, and is passed through.
 *
 * @module @deepseek-ai/dsh-freecodego-api/refresh-guard
 */

/** How a refresh attempt failed, in the only four ways that change the answer. */
export type RefreshFailureKind =
  /** No usable network: retry once, never erase. */
  | 'network'
  /** Server-side or transport failure the server did not explain: never erase. */
  | 'transient'
  /** The refresh credential itself was rejected: erase. */
  | 'invalid'
  /** An error this build cannot classify: never erase. */
  | 'unknown'

/** The result of one attempt. */
export type RefreshAttemptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: RefreshFailureKind; readonly message?: string }

/** What the guard concluded. */
export interface RefreshOutcome<T> {
  readonly ok: boolean
  readonly value?: T
  /** Attempts made, including the first. */
  readonly attempts: number
  /** True only for an explicit invalidation: the caller erases its vault entry. */
  readonly clearVault: boolean
  readonly failureKind?: RefreshFailureKind
  readonly message?: string
  /** True when the second attempt was the one that answered. */
  readonly recovered?: boolean
}

/** What each attempt is told. */
export interface RefreshAttemptOptions {
  /** Never aborted by the guard; see rule 1. */
  readonly signal: AbortSignal
  /** True on the retry rather than the first attempt. */
  readonly retry: boolean
}

/** What an attempt may return: a value, or its own verdict about the attempt. */
export type RefreshAttemptOutcome<T> = T | RefreshAttemptResult<T>

/** Gap between the first attempt and the retry. */
export const DEFAULT_REFRESH_RETRY_DELAY_MS = 1_000

/** The kinds a reported failure may name. */
const FAILURE_KINDS: readonly RefreshFailureKind[] = ['network', 'transient', 'invalid', 'unknown']

/**
 * Read the message a thrown value carries, without inventing one.
 *
 * `String({})` is `[object Object]`, and filing that as a message would put text
 * that looks like evidence into a classification that has none. A value with no
 * readable message stays unreadable, and the readable-by-default answer for an
 * unreadable failure is `network` — which never erases anything.
 * @param error - the thrown value.
 * @returns the message, when one can actually be read.
 */
function readableMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message === '' ? undefined : error.message
  if (typeof error === 'string') return error === '' ? undefined : error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/** The status a thrown value carries, when it carries a usable one. */
function readableStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * The gateway's wording for a refresh credential that is gone for good.
 *
 * Built from two parts because the single-line form is longer than this
 * repository's line limit, and a regex a reader cannot see the whole of is the
 * one place a silent change is most expensive: this pattern is what turns a
 * server message into "erase the user's session".
 */
const CREDENTIAL_REJECTED = new RegExp(
  'refresh(?:_| )?token.*(?:invalid|expired|revoked|reused|already\\s+used)'
  + '|invalid.*refresh|token.*invalidated',
  'iu',
)

/**
 * The transport failures a `fetch` rejects with, and the wording a proxy uses
 * for them.
 *
 * Built from two parts for the same reason as {@link CREDENTIAL_REJECTED}: a
 * rule a reader cannot see in full is one that can change without anyone
 * noticing what it decides, and this one decides whether a refresh is retried or
 * filed as unclassifiable.
 */
const NETWORKISH = new RegExp(
  'fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT'
  + '|EAI_AGAIN|socket hang up|aborted|timeout|timed out',
  'iu',
)

/**
 * Classify an error thrown by, or reported from, a refresh exchange.
 *
 * The `status` field is the authority when it is present, because it is what the
 * transport actually observed. The message is consulted for two things: the
 * wording the gateway uses for a consumed rotation, which arrives without a
 * usable status behind some proxies, and the transport errors a `fetch` rejects
 * with.
 *
 * A 400 is deliberately `transient` rather than `invalid`: it is a
 * request-validation failure — a malformed device id, most often — and is not
 * evidence that the stored credential is dead. Erasing on one would cost the user
 * a manual sign-in for a bug this code caused.
 * @param error - the thrown value, or a reported failure's message.
 * @returns the kind, and the message when one can be read.
 */
export function classifyRefreshFailure(error: unknown): { readonly kind: RefreshFailureKind; readonly message?: string } {
  const message = readableMessage(error)
  const withMessage = message === undefined ? {} : { message }
  const status = readableStatus(error)
  const credentialRejected = message !== undefined && CREDENTIAL_REJECTED.test(message)
  if (status === 401 || status === 403 || credentialRejected) return { kind: 'invalid', ...withMessage }
  if (status !== undefined && status >= 400 && status < 500) return { kind: 'transient', ...withMessage }
  if (status !== undefined && status >= 500) return { kind: 'network', ...withMessage }
  // Nothing readable is not evidence that the credential is dead, so the
  // readable-by-default answer is the one that retries and never erases.
  if (message === undefined) return { kind: 'network' }
  const networkish = NETWORKISH.test(message)
  return { kind: networkish ? 'network' : 'unknown', ...withMessage }
}

/**
 * Recognize an attempt's own verdict, if it produced one.
 *
 * Deliberately not generic in the resolved value: the verdict is read from an
 * `unknown`, so the caller — the only one that knows the value's type — is the
 * one that asserts it, rather than this function inventing a type parameter it
 * cannot use.
 * @param value - whatever the attempt resolved.
 * @returns the verdict, or undefined when the value is data rather than a verdict.
 */
function asAttemptResult(value: unknown): RefreshAttemptResult<unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { readonly ok?: unknown; readonly kind?: unknown; readonly value?: unknown; readonly message?: unknown }
  // `ok` must be a boolean: a payload carrying a string field named `ok` is data.
  if (typeof candidate.ok !== 'boolean') return undefined
  // `unknown` rather than a type parameter: the caller is the one that knows
  // what it asked for, and this function cannot.
  if (candidate.ok) return { ok: true, value: candidate.value }
  const kind = typeof candidate.kind === 'string' && (FAILURE_KINDS as readonly string[]).includes(candidate.kind)
    ? candidate.kind as RefreshFailureKind
    : 'unknown'
  return {
    ok: false,
    kind,
    ...(typeof candidate.message === 'string' && candidate.message !== '' ? { message: candidate.message } : {}),
  }
}

/**
 * Run a refresh under both rules.
 * @param input - the attempt function, an optional classifier, and an optional sleeper.
 * @returns the outcome, including whether the caller should erase its vault entry.
 */
export async function runGuardedRefresh<T>(input: {
  readonly attempt: (options: RefreshAttemptOptions) => Promise<RefreshAttemptOutcome<T>>
  /** Turns a thrown error into a kind. Defaults to {@link classifyRefreshFailure}. */
  readonly classify?: (error: unknown) => { readonly kind: RefreshFailureKind; readonly message?: string }
  readonly wait?: (ms: number) => Promise<void>
  readonly retryDelayMs?: number
}): Promise<RefreshOutcome<T>> {
  const classify = input.classify ?? classifyRefreshFailure
  // Created once and never aborted: rule 1.
  const controller = new AbortController()
  const first = await attemptOnce(input.attempt, controller.signal, false, classify)
  if (first.ok) return { ok: true, value: first.value, attempts: 1, clearVault: false }

  if (first.kind === 'invalid') {
    return { ok: false, attempts: 1, clearVault: true, failureKind: 'invalid', ...passthrough(first) }
  }
  if (first.kind !== 'network') {
    return { ok: false, attempts: 1, clearVault: false, failureKind: first.kind, ...passthrough(first) }
  }

  await (input.wait ?? defaultWait)(input.retryDelayMs ?? DEFAULT_REFRESH_RETRY_DELAY_MS)
  const second = await attemptOnce(input.attempt, controller.signal, true, classify)
  if (second.ok) return { ok: true, value: second.value, attempts: 2, clearVault: false, recovered: true }
  return {
    ok: false,
    attempts: 2,
    // The rule is applied to the last word, so having retried neither widens nor
    // narrows the erasure path.
    clearVault: second.kind === 'invalid',
    failureKind: second.kind,
    ...passthrough(second),
  }
}

/** Carry an attempt's message onto the outcome without inventing one. */
function passthrough<T>(result: RefreshAttemptResult<T>): { readonly message?: string } {
  return result.ok || result.message === undefined ? {} : { message: result.message }
}

/** One attempt, normalized to a verdict rather than a throw. */
async function attemptOnce<T>(
  attempt: (options: RefreshAttemptOptions) => Promise<RefreshAttemptOutcome<T>>,
  signal: AbortSignal,
  retry: boolean,
  classify: (error: unknown) => { readonly kind: RefreshFailureKind; readonly message?: string },
): Promise<RefreshAttemptResult<T>> {
  try {
    const outcome = await attempt({ signal, retry })
    const reported = asAttemptResult(outcome)
    // A resolved verdict is used as one; anything else is the value itself.
    if (reported === undefined) return { ok: true, value: outcome as T }
    return reported as RefreshAttemptResult<T>
  } catch (error) {
    const classified = classify(error)
    return { ok: false, kind: classified.kind, ...(classified.message === undefined ? {} : { message: classified.message }) }
  }
}

/** Sleep between attempts. */
function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
