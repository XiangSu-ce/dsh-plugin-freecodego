/**
 * What an upstream HTTP status says about the account that sent it.
 *
 * Why one table
 * -------------
 * Every provider in this plugin walks a pool of accounts and reports a failed route
 * in the shared `LlmError` vocabulary, whose code is read by the UI *and*
 * aggregated into the token-usage ledger's "top provider failure codes". So this
 * mapping decides both what a user is told and what the ledger remembers:
 *
 * - **401** is the only status that says the sign-in itself is dead. It is the one
 *   code that sends a user to Settings to re-authorize an account.
 * - **402 / 403 / 429** are the free tier's budget, plan and rate gates. The
 *   credential is fine, one route is out of money or out of turn, and a user should
 *   change model or wait rather than sign in again.
 * - **≥ 500** is the upstream's failure, not the account's.
 * - anything else keeps its status in the code, `HTTP_404`, because the caller that
 *   acts on it needs to know which one.
 *
 * It was written out four times, and one copy had already drifted in the direction
 * the first bullet warns about: the generic OpenAI-compatible adapter — the route
 * most turns take — mapped **403 to `AUTH`**, telling a user their key was invalid
 * when the account had merely run out of plan. That ladder had **no test at all**,
 * which is how the drift survived: the two providers that were tested were the two
 * that agreed, and the copy that disagreed was the one nobody probed. A fourth copy
 * (`agnes.ts`) collapsed every unrecognised status into `SERVER`, reporting a 400
 * request error to the user as an upstream outage.
 *
 * The category is the fact, the code is one reading of it
 * ------------------------------------------------------
 * The same status answers more than one question, and every caller asks this module
 * rather than comparing against `status` again:
 *
 * - **Which `LlmError` code** — {@link llmCodeForUpstreamStatus}.
 * - **How long an account is parked** — `workbuddy-intl.ts` indexes its cooldown
 *   table by category, so a `403` takes the credit park (a plan does not refill in
 *   the five minutes a sign-in park lasts) and a `5xx` takes the short one. An
 *   upstream-stated delay still overrides both, because a measurement beats a
 *   policy.
 * - **Whether the credential is refreshed** — the same file refreshes only on
 *   `'auth'`. Answering yes for a `403` burned a token rotation on every plan gate
 *   and replayed a request the upstream had refused on other grounds; the file's own
 *   rule for code `10085` (*"refreshing cannot fix it and would burn a rotation"*)
 *   says why that was wrong.
 * - **Whether another account is tried at all** — the pool walk treats a gate as
 *   route-local and an auth refusal as account-wide.
 *
 * A question that is *not* this table: `classifyRefreshFailure` (upstream, in
 * `@deepseek-ai/dsh-freecodego-api`) reads 401/403 off a **token refresh**
 * response, where a refusal really does mean the refresh token is dead and the
 * vault should be cleared. Same numbers, different call, different answer.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/upstream-status-code
 */

/**
 * What a failed route's status means for the account behind it.
 *
 * `'quota'` and `'rate-limit'` are separate categories because the cooldown a
 * caller parks an account for is minutes against an hour, and only the caller that
 * budgets time needs the difference. Both read as one code: a user is shown
 * "rate limited" either way, because both mean "this route is out of turn", and the
 * distinction that matters to them is that neither is their key.
 */
export type UpstreamStatusCategory = 'auth' | 'quota' | 'rate-limit' | 'server' | 'other'

/**
 * The category of an upstream status.
 *
 * @param status - an HTTP status from a route that failed.
 * @returns what the status says about the account, not about the request.
 */
export function upstreamStatusCategory(status: number): UpstreamStatusCategory {
  // 401 alone: the sign-in was refused. 403 is the plan gate on every free tier
  // here — it means the account may not use *this* route, which is a fact about
  // the route.
  if (status === 401) return 'auth'
  if (status === 402 || status === 403) return 'quota'
  if (status === 429) return 'rate-limit'
  // 5xx is the upstream's own failure: retrying the same account is the right
  // answer, and calling it `AUTH` would send the user to fix a working credential.
  if (status >= 500) return 'server'
  return 'other'
}

/**
 * The `LlmError` code for an upstream status.
 *
 * @param status - an HTTP status from a route that failed.
 * @returns `AUTH`, `RATE_LIMIT`, `SERVER`, or `HTTP_<status>` for anything else.
 */
export function llmCodeForUpstreamStatus(status: number): 'AUTH' | 'RATE_LIMIT' | 'SERVER' | `HTTP_${number}` {
  const category = upstreamStatusCategory(status)
  if (category === 'auth') return 'AUTH'
  if (category === 'quota' || category === 'rate-limit') return 'RATE_LIMIT'
  if (category === 'server') return 'SERVER'
  return `HTTP_${status}`
}
