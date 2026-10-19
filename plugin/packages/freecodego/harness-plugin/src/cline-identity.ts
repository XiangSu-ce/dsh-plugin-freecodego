/**
 * What each Cline request surface declares about itself, and the guard that
 * refuses a request which does not carry it.
 *
 * The one surface the upstream vets
 * ---------------------------------
 * Cline's chat gateway checks the caller against a known-product allowlist, so
 * every identity field it carries is load-bearing: a plausible-looking substitute
 * is refused exactly like no header at all (see the note where the values are
 * declared). The token endpoints are the other surface, and they are declared for
 * the opposite reason — they carry a media type and nothing else, and stating that
 * is what keeps the identity set from being sprayed onto a WorkOS host that has no
 * business receiving it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/cline-identity
 */

import { assertSurfaceIdentity, surfaceIdentityHeaders, type RequestIdentityTable } from './request-identity.ts'

/** The request surfaces this plugin sends to Cline. */
export type ClineRequestSurface = 'client' | 'token'

/**
 * The identity every Cline request that reaches the gateway authenticates with.
 *
 * These are the values of the product the gateway's allowlist names, and they are
 * matched as a set rather than individually.
 */
const CLINE_CLIENT_IDENTITY: Readonly<Record<string, string>> = {
  'user-agent': 'Cline/3.0.50',
  'http-referer': 'https://cline.bot',
  'x-title': 'Cline',
  'x-is-multiroot': 'false',
  'x-client-type': 'cline-cli',
  'x-client-version': '3.0.50',
  'x-platform': 'terminal',
  'x-platform-version': '3.0.50',
  'x-core-version': '0.0.70',
}

/**
 * The fields a gateway request carries from the caller: the account's token and the
 * task id the body also names, plus the media type and the acceptance the route
 * needs. Every one is required, so a caller that stops supplying one is refused
 * here rather than by the allowlist, which answers a missing field the same way it
 * answers a wrong one.
 */
const CLIENT_REQUIRED = [...Object.keys(CLINE_CLIENT_IDENTITY), 'authorization', 'x-task-id'] as const

/** Every Cline request's declared identity, one entry per surface. */
export const clineIdentity: RequestIdentityTable<ClineRequestSurface> = {
  code: 'CLINE',
  surfaces: {
    client: {
      headers: CLINE_CLIENT_IDENTITY,
      required: CLIENT_REQUIRED,
    },
    token: {
      headers: { 'content-type': 'application/json' },
      required: ['content-type'],
    },
  },
}

/**
 * The identity headers for one gateway request, with its session id attached.
 *
 * `taskId` is the same value the request body carries as `session_id`: the upstream
 * treats a task id that disagrees with the body as a mismatched surface, and two
 * ids built in two places is how they come to disagree.
 * @param taskId - the task/session id to attach as `x-task-id`.
 * @param additions - the account- and route-derived values: the token, the media
 *   type, the acceptance.
 * @returns the identity headers for the request.
 * @throws {Error} when the request is missing a declared header.
 */
export function clineClientHeaders(
  taskId: string,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers = surfaceIdentityHeaders(clineIdentity, 'client', { 'x-task-id': taskId, ...additions })
  assertSurfaceIdentity(clineIdentity, 'client', headers)
  return headers
}

/**
 * The headers of one token-endpoint call, which carries a media type and no identity.
 * @param additions - any further fields the endpoint needs.
 * @returns the headers for the call.
 * @throws {Error} when the request is missing a declared header.
 */
export function clineTokenHeaders(additions: Readonly<Record<string, string>> = {}): Record<string, string> {
  const headers = surfaceIdentityHeaders(clineIdentity, 'token', additions)
  assertSurfaceIdentity(clineIdentity, 'token', headers)
  return headers
}
