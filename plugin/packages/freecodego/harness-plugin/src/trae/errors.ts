/**
 * The classified upstream failure every TRAE call surfaces.
 *
 * It carries both layers the upstream reports separately: the HTTP status the
 * transport saw, and the business code a 200-OK stream can still carry inside
 * an `event: error` frame. The adapter needs both — the status classifies the
 * transport, the business code says whether the account is out of quota
 * (`4008`), rate limited (`4011`), or holding an entitlement the plan no longer
 * includes (`1005`), and those are three different things to tell a user.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/errors
 */

/** A TRAE request that the upstream refused, at either layer. */
export class TraeUpstreamError extends Error {
  /**
   * @param status - the HTTP status, or the status this failure is equivalent
   *   to when it arrived inside a stream (`502` for a refusal that came over an
   *   accepted connection).
   * @param detail - the upstream's own words, already truncated.
   * @param code - the business code, when the failure came out of the stream.
   */
  constructor(readonly status: number, readonly detail: string, readonly code?: number) {
    super(`TRAE upstream HTTP ${status}: ${detail}`)
    this.name = 'TraeUpstreamError'
  }
}
