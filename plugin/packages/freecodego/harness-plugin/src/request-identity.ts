/**
 * What a provider's request surfaces declare about themselves, and the guard that
 * refuses a request which does not carry it.
 *
 * Why a table, and why the guard is not a comment
 * ----------------------------------------------
 * A request to a third-party host carries two kinds of fact: what this process
 * wants (a completion, a credit balance) and who it says it is. The second kind
 * is invisible in the code that needs it. A provider's gateway matches on the
 * identity header family, and the failure when one goes missing is not a
 * rejection with a reason — it is an answer shaped like a different problem, or
 * an account quietly counted as a stranger. So the identity is written down once
 * per surface, in a table a reader can compare against the reference client, and
 * every request is checked against it before it leaves.
 *
 * The check has to be a *table read at send time* rather than a builder used by
 * convention: the identity was three literals spread across three methods on the
 * provider this was first extracted from, and the drift between them was
 * invisible until a turn stopped being answered. A copy of a header set that
 * happens to agree cannot be told from a correct one by any assertion on output,
 * and it disagrees the day someone edits one of the copies.
 *
 * What this module deliberately does not decide: which values are right. Each
 * provider's table holds its own, the account- and request-derived values arrive
 * as additions, and this file only refuses a request that is missing what its own
 * surface declared.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/request-identity
 */

/**
 * One header a request must carry: a name, or the spellings of one field of which
 * one must be present.
 *
 * The list form exists because upstream is not consistent about a field's name
 * across its own routes, and the client answers with the spelling that means "the
 * account does not have this" when it has nothing to send — `x-no-user-id` rather
 * than an omitted `x-user-id`. A surface that requires `['x-user-id',
 * 'x-no-user-id']` states that the *field* must be accounted for, not that one
 * particular spelling must appear.
 */
export type RequiredHeader = string | readonly string[]

/** What one request surface declares: the values it always sends, and what it must carry. */
export interface SurfaceDeclaration {
  /** The values every request on this surface sends, whatever the account. */
  readonly headers: Readonly<Record<string, string>>
  /**
   * Every name a request on this surface has to carry, in the order a failure
   * should list them — so the message reads as the identity's shape rather than
   * as the order the headers happened to be built in.
   *
   * This list is longer than {@link SurfaceDeclaration.headers} on purpose: the
   * account-derived values (a token, a user id, a per-turn id) are the caller's
   * to supply, and a caller who forgets one is exactly the failure this exists
   * to turn into a sentence.
   */
  readonly required: readonly RequiredHeader[]
}

/** One provider's request surfaces, keyed by the names the provider's own code uses. */
export interface RequestIdentityTable<Surface extends string> {
  /** The prefix of a missing-header failure: `<CODE>_IDENTITY_INCOMPLETE`. */
  readonly code: string
  /** One declaration per surface the provider sends. */
  readonly surfaces: Readonly<Record<Surface, SurfaceDeclaration>>
}

/** The spellings a missing entry is reported under. */
function entryNames(entry: RequiredHeader): readonly string[] {
  return typeof entry === 'string' ? [entry] : entry
}

/**
 * The declared headers of one surface, with the caller's own values merged over them.
 *
 * Additions come last so a value derived from the account or the request can
 * replace a declared default; a *missing* one is not caught here, because that is
 * the guard's job rather than the builder's.
 * @param table - the provider's surfaces.
 * @param surface - which surface this request is.
 * @param additions - the account- and request-derived values.
 * @returns the headers for the request, before the guard runs.
 */
export function surfaceIdentityHeaders<Surface extends string>(
  table: RequestIdentityTable<Surface>,
  surface: Surface,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...table.surfaces[surface].headers, ...additions }
}

/**
 * The entries a request does not account for, in declaration order.
 *
 * Presence is matched case-insensitively, because that is how a header name
 * reaches the wire: a surface declaring `accept` is satisfied by `Accept`, and a
 * guard that said otherwise would be a guard against a spelling rather than
 * against a missing field.
 * @param table - the provider's surfaces.
 * @param surface - which surface this request is.
 * @param headers - the request's headers, as it is about to send them.
 * @returns one entry per unmet requirement, empty when the identity is complete.
 */
export function missingIdentityHeaders<Surface extends string>(
  table: RequestIdentityTable<Surface>,
  surface: Surface,
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  const present = new Set(Object.keys(headers).map(name => name.toLowerCase()))
  return table.surfaces[surface].required
    .filter(entry => !entryNames(entry).some(name => present.has(name.toLowerCase())))
    .map(entry => entryNames(entry).join(' | '))
}

/**
 * Refuse a request that does not carry the identity its surface declares.
 *
 * The message names the surface and the missing entries rather than the call site,
 * because the operator reading a failed request has the surface in front of them
 * and not this file — and because the alternative (an upstream answer shaped like
 * a different problem) is the failure this replaced.
 * @param table - the provider's surfaces.
 * @param surface - which surface this request is.
 * @param headers - the request's headers, as it is about to send them.
 * @throws {Error} with a `<CODE>_IDENTITY_INCOMPLETE` message naming what is missing.
 */
export function assertSurfaceIdentity<Surface extends string>(
  table: RequestIdentityTable<Surface>,
  surface: Surface,
  headers: Readonly<Record<string, string>>,
): void {
  const missing = missingIdentityHeaders(table, surface, headers)
  if (missing.length > 0) {
    throw new Error(`${table.code}_IDENTITY_INCOMPLETE: the ${surface} request is missing ${missing.join(', ')}`)
  }
}
