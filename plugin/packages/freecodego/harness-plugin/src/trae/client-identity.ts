/**
 * The marketplace client identity the TRAE credit endpoints are judged by.
 *
 * Two identities, one account
 * ---------------------------
 * TRAE serves two client families from the same access token, and they do not
 * present the same headers. The **IDE protocol** family — `X-Cloudide-Token`,
 * `X-App-Id`, `X-Ide-Version`, `X-Machine-Id` — is what the conversation path
 * signs with (`trae/bridge.ts`), and it is what this connector used for its daily
 * credit claim as well. The **marketplace** family — `X-Market-Client-Id`,
 * `X-Market-User-Id`, `Vscode-Sessionid`, `X-Tt-Trace-Id`, `Package-Type`, the
 * `X-Lscbd-*` pair, plus the browser's own `Sec-Fetch-*` and `Accept-Language`
 * — is what the reference implementation that wins this claim actually presents,
 * and its own notes say so in as many words: the successful sign-in carries "a
 * very complete client header set", not the simplified one.
 *
 * The claim's risk control is the reason this matters. `9074` is a refusal of the
 * *device* (`trae/device.ts` measured that), which means the upstream is deciding
 * on identity rather than on the request, and an identity that is half IDE and
 * half nothing is not the one the campaign was measured to accept.
 *
 * Derived, not random
 * -------------------
 * Every value here that is not a constant is derived from the account's own user
 * id with the reference's algorithm (`trae.ts` `seededStream`, `:353`), so the same
 * account presents the same marketplace identity on every run and two accounts
 * never share one. That is the same bargain `traeAhaDeviceId` makes for the device
 * number: a value the risk control can remember, rather than noise. The values are
 * one-way (SHA-256 with a salt) and are only ever sent to the host the account is
 * already signed in to.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/client-identity
 */

import { createHash, randomUUID } from 'node:crypto'

/** The marketplace client the campaign's own client presents itself as. */
export const TRAE_MARKET_CLIENT_ID = 'VSCode 1.107.1'

/** The package channel of the China marketplace client. */
export const TRAE_MARKET_PACKAGE_TYPE = 'stable_cn'

/** The China marketplace deployment's numeric application id. */
export const TRAE_LSCBD_AID = '787976'

/** The platform the marketplace headers name; this connector is Windows-only. */
export const TRAE_LSCBD_PLATFORM = 'windows'

/** The marketplace gateway's request-SDK generation. */
export const TRAE_LGW_SDK_TYPE = '3'

/** The language the marketplace client asks in, which is not a locale setting. */
export const TRAE_MARKET_LANGUAGE = 'zh-CN'

/**
 * A deterministic byte stream from one seed and salt.
 *
 * The reference's algorithm, ported rather than approximated: SHA-256 over
 * `salt:seed` with a big-endian counter appended, concatenated until `bytes` are
 * produced. The point is that the same `(seed, salt)` always yields the same
 * bytes, so a derived identity is stable across runs and machines.
 * @param seed - the account's user id.
 * @param salt - which derived value this is, so two values from one seed differ.
 * @param bytes - how many bytes to produce.
 * @returns the bytes, in order.
 */
export function traeSeededStream(seed: string, salt: string, bytes: number): number[] {
  const prefix = `${salt}:${seed}`
  const result: number[] = []
  let counter = 0
  while (result.length < bytes) {
    const counterBytes = Buffer.alloc(4)
    counterBytes.writeUInt32BE(counter, 0)
    for (const byte of createHash('sha256').update(prefix, 'utf8').update(counterBytes).digest()) {
      result.push(byte)
      if (result.length >= bytes) break
    }
    counter += 1
  }
  return result.slice(0, bytes)
}

/**
 * The marketplace user id one account presents.
 *
 * A version-4 UUID shaped from the stream, exactly as the reference shapes it: the
 * upstream validates the shape, so a value that is merely 32 hex digits would be
 * rejected where this one is not.
 * @param uid - the account's user id.
 * @returns the deterministic UUID v4 the account signs in as.
 */
export function traeMarketUserId(uid: string): string {
  const bytes = traeSeededStream(uid, 'market', 16)
  const withVersion = bytes.map((byte, index) => {
    if (index === 6) return (byte & 0x0f) | 0x40
    if (index === 8) return (byte & 0x3f) | 0x80
    return byte
  })
  const hex = withVersion.map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * The editor session id one account presents, as the marketplace client's storage
 * would hold it: 64 hex digits, derived so it survives a restart.
 * @param uid - the account's user id.
 * @returns the deterministic session id.
 */
export function traeVscodeSessionId(uid: string): string {
  return traeSeededStream(uid, 'sess', 32).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A W3C trace id in the shape the marketplace client sends: `00-<32 hex>-01`.
 *
 * Minted per request rather than derived: a trace names *this* call, and the
 * upstream's own log trail keys on it.
 * @returns the trace id.
 */
export function traeVscodeTraceId(): string {
  return `00-${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}-01`
}

/**
 * The header set that makes a request this account's marketplace client rather
 * than an anonymous caller.
 *
 * The values this connector already carries on the same request are deliberately
 * absent: the access token arrives as `Authorization`, and the declared IDE build
 * arrives as `X-Ide-Version` — see the check-in parity spec for the three fields
 * where this plugin answers the reference differently on purpose.
 * @param uid - the account's user id, which every derived value comes from.
 * @param ideVersion - the account's declared IDE build, which is the version the
 *   reference states as `App-Version` as well.
 * @returns the headers, ready to merge into a credit request.
 */
export function traeMarketClientHeaders(uid: string, ideVersion: string): Record<string, string> {
  return {
    'accept-encoding': 'gzip, deflate',
    'accept-language': TRAE_MARKET_LANGUAGE,
    'x-market-client-id': TRAE_MARKET_CLIENT_ID,
    'x-market-user-id': traeMarketUserId(uid),
    'x-lgw-req-sdk-type': TRAE_LGW_SDK_TYPE,
    'package-type': TRAE_MARKET_PACKAGE_TYPE,
    'x-lscbd-aid': TRAE_LSCBD_AID,
    'x-lscbd-platform': TRAE_LSCBD_PLATFORM,
    'app-version': ideVersion,
    'x-tt-trace-id': traeVscodeTraceId(),
    'vscode-sessionid': traeVscodeSessionId(uid),
    'x-request-id': randomUUID(),
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'none',
  }
}
