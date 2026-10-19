/**
 * What each TRAE request surface declares about itself, and the guard that refuses
 * a request which does not carry it.
 *
 * One account, two client families
 * --------------------------------
 * The conversation path speaks the IDE protocol; the daily credit claim speaks it
 * *and* the marketplace one, because that is the request the campaign was measured
 * to accept (`trae/client-identity.ts` states both families and why the claim
 * carries the second). Those two surfaces therefore declare different identities,
 * and the fields are listed here once rather than at the two call sites: the last
 * time this connector's headers lived at their call sites, the claim was missing
 * the whole marketplace half and nothing said so.
 *
 * The account-derived half — the token in three spellings, the uid, the machine
 * and device ids — is deliberately not in the table. A value that arrives per
 * account is the caller's to supply, and each one is *required* below, so a caller
 * that stops supplying one is refused here instead of at the upstream.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/identity
 */

import { assertSurfaceIdentity, surfaceIdentityHeaders, type RequestIdentityTable } from '../request-identity.ts'
import {
  TRAE_LGW_SDK_TYPE,
  TRAE_LSCBD_AID,
  TRAE_LSCBD_PLATFORM,
  TRAE_MARKET_CLIENT_ID,
  TRAE_MARKET_LANGUAGE,
  TRAE_MARKET_PACKAGE_TYPE,
} from './client-identity.ts'
import {
  TRAE_APP_ID,
  TRAE_APP_VERSION,
  TRAE_DEVICE_BRAND,
  TRAE_DEVICE_TYPE,
  TRAE_OS_VERSION,
  TRAE_USER_REGION,
} from './endpoints.ts'

/** The two request surfaces the TRAE connector sends. */
export type TraeRequestSurface = 'solo' | 'checkin'

/**
 * The fields every TRAE request carries because it is the IDE client.
 *
 * `x-uid`, `x-machine-id` and the conversation `x-device-id` are not among them:
 * each is absent when the account never stated one, and an empty header is an
 * identity claim the account cannot make — so the builder omits them and the
 * declarations below leave them out rather than requiring a value that is
 * sometimes not there.
 */
const IDE_PROTOCOL_REQUIRED = [
  'content-type', 'accept', 'user-agent', 'authorization',
  'x-cloudide-token', 'x-ide-token',
  'x-app-id', 'x-app-version', 'x-app-version-code',
  'x-ide-version', 'x-ide-version-code', 'x-ide-version-type',
  'x-device-type', 'x-os-version', 'x-device-brand', 'request-traffic-type',
  'x-custom-trace-id', 'x-flow-traceparent',
] as const

/** The fields the campaign's own client presents, which this connector had not been sending. */
const MARKET_REQUIRED = [
  'x-market-client-id', 'x-market-user-id', 'vscode-sessionid',
  'x-lgw-req-sdk-type', 'package-type', 'x-lscbd-aid', 'x-lscbd-platform',
  'app-version', 'x-tt-trace-id', 'x-request-id',
  'accept-encoding', 'accept-language',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
] as const

/** Every TRAE request's declared identity, one entry per surface. */
export const traeIdentity: RequestIdentityTable<TraeRequestSurface> = {
  code: 'TRAE',
  surfaces: {
    solo: {
      // The fixed half of the IDE identity: values that are the client's own, not
      // the account's and not the request's.
      headers: {
        'content-type': 'application/json',
        'request-traffic-type': 'prod',
        'x-ide-version-type': 'stable',
        'x-device-type': TRAE_DEVICE_TYPE,
        'x-os-version': TRAE_OS_VERSION,
        'x-device-brand': TRAE_DEVICE_BRAND,
        'x-app-id': TRAE_APP_ID,
        'x-app-version': TRAE_APP_VERSION,
      },
      required: IDE_PROTOCOL_REQUIRED,
    },
    checkin: {
      // The marketplace half, plus the region and device the credit endpoints
      // additionally require.
      headers: {
        ...traeMarketIdentity(),
        // Without this header the claim answers `9074` rather than claiming.
        'x-user-region': TRAE_USER_REGION,
      },
      required: [
        ...IDE_PROTOCOL_REQUIRED,
        'x-user-region', 'x-device-id',
        ...MARKET_REQUIRED,
      ],
    },
  },
}

/**
 * The marketplace client's fixed headers.
 *
 * Built from the same constants `trae/client-identity.ts` uses for the values it
 * derives per account, so the declared set and the sent set cannot name different
 * clients.
 * @returns the constant half of the marketplace identity.
 */
function traeMarketIdentity(): Record<string, string> {
  return {
    'accept-encoding': 'gzip, deflate',
    'accept-language': TRAE_MARKET_LANGUAGE,
    'x-market-client-id': TRAE_MARKET_CLIENT_ID,
    'x-lgw-req-sdk-type': TRAE_LGW_SDK_TYPE,
    'package-type': TRAE_MARKET_PACKAGE_TYPE,
    'x-lscbd-aid': TRAE_LSCBD_AID,
    'x-lscbd-platform': TRAE_LSCBD_PLATFORM,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'none',
  }
}

/**
 * The headers of one surface, with the caller's own values merged over the declared ones.
 * @param surface - which request this is.
 * @param additions - the account- and request-derived values.
 * @returns the headers, before the guard runs.
 */
export function traeSurfaceHeaders(
  surface: TraeRequestSurface,
  additions: Readonly<Record<string, string>>,
): Record<string, string> {
  return surfaceIdentityHeaders(traeIdentity, surface, additions)
}

/**
 * Refuse a request that does not carry the identity its surface declares.
 * @param surface - which request this is.
 * @param headers - the headers about to be sent.
 * @throws {Error} naming every declared header the request does not carry.
 */
export function assertTraeIdentity(surface: TraeRequestSurface, headers: Readonly<Record<string, string>>): void {
  assertSurfaceIdentity(traeIdentity, surface, headers)
}
