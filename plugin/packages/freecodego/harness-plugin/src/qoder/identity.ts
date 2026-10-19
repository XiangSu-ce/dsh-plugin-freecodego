/**
 * What each Qoder request surface declares about itself, and the guard that
 * refuses a request which does not carry it.
 *
 * Two surfaces, two protocols
 * ---------------------------
 * The signed `cosy` surface is the account's API (`qoder/cosy.ts`), and its
 * identity is unusually large because every field of it is part of a signature:
 * a machine type, a machine id, a machine token, the cosy key, the client type,
 * the scene and business ids. The campaign surface (`qoder/checkin.ts`) is a
 * plain bearer-token API on the same host, and it carries three fields.
 *
 * Both are written down here rather than at their call sites because they share a
 * field: the campaign surface declares the same `cosy-clienttype` family the
 * signed surface does, under its own client id. The two protocol constants live
 * here for the same reason — this module is what states the identity, and it is
 * the only file both surfaces can import without a cycle.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/identity
 */

import { assertSurfaceIdentity, surfaceIdentityHeaders, type RequestIdentityTable } from '../request-identity.ts'

/** Protocol version advertised in the session payload and in the signed headers. */
export const COSY_VERSION = '1.0.10'

/** The client id the campaign API presents, which is not the signed surface's `5`. */
export const QODER_COSY_CLIENT_TYPE = '10'

/** The request surfaces this plugin sends to Qoder. */
export type QoderRequestSurface = 'cosy' | 'campaign'

/** The fields the signed protocol always carries, whatever the account. */
const COSY_FIXED = {
  'cosy-data-policy': 'agree',
  'content-type': 'application/json',
  'cosy-clienttype': '5',
  'cache-control': 'no-cache',
  'cosy-version': COSY_VERSION,
  'login-version': 'v2',
  'user-agent': 'Go-http-client/2.0',
  'cosy-scene': 'assistant',
  'cosy-business-product': 'ide',
  'cosy-business-type': 'agent',
} as const

/**
 * The fields the signed protocol carries that come from the account or the
 * request: the session material, the signature, and the media type the caller
 * chose. Required, so a caller that stops supplying one is refused here rather
 * than answered with a signature the upstream will reject.
 */
const COSY_REQUIRED = [
  'authorization', 'accept',
  'cosy-machinetype', 'cosy-date', 'cosy-user', 'cosy-key', 'cosy-machineid', 'cosy-machinetoken',
] as const

/** The campaign API's own fields: a bearer token, a media type, and the client type. */
const CAMPAIGN_FIXED = {
  accept: 'application/json',
  'content-type': 'application/json',
  'cosy-clienttype': QODER_COSY_CLIENT_TYPE,
} as const

/** Every Qoder request's declared identity, one entry per surface. */
export const qoderIdentity: RequestIdentityTable<QoderRequestSurface> = {
  code: 'QODER',
  surfaces: {
    cosy: {
      headers: COSY_FIXED,
      required: [...Object.keys(COSY_FIXED), ...COSY_REQUIRED],
    },
    campaign: {
      headers: CAMPAIGN_FIXED,
      required: [...Object.keys(CAMPAIGN_FIXED), 'authorization'],
    },
  },
}

/**
 * The headers of one surface, with the caller's own values merged over the declared ones.
 * @param surface - which request this is.
 * @param additions - the account- and request-derived values.
 * @returns the headers, before the guard runs.
 */
export function qoderSurfaceHeaders(
  surface: QoderRequestSurface,
  additions: Readonly<Record<string, string>>,
): Record<string, string> {
  return surfaceIdentityHeaders(qoderIdentity, surface, additions)
}

/**
 * Refuse a request that does not carry the identity its surface declares.
 * @param surface - which request this is.
 * @param headers - the headers about to be sent.
 * @throws {Error} naming every declared header the request does not carry.
 */
export function assertQoderIdentity(surface: QoderRequestSurface, headers: Readonly<Record<string, string>>): void {
  assertSurfaceIdentity(qoderIdentity, surface, headers)
}
