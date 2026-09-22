/**
 * The TRAE SOLO sign-in closure: the URL's callback is parsed here, the
 * refresh token it carries is exchanged for a session, and the account row the
 * vault stores is built from both.
 *
 * Why the redirect is the interesting half
 * ----------------------------------------
 * SOLO authorizes in the browser and hands the result to a loopback URL rather
 * than answering a poll. Everything the account *is* arrives in that one
 * redirect: the refresh token, the uid, the display name, and — on the degraded
 * path where the page issues no refresh token — a short-lived access token.
 * Parsing is therefore the whole login, and every branch below exists because
 * the page has been observed to take it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/login
 */

import { randomBytes } from 'node:crypto'
import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { TRAE_EXCHANGE_PATH, traeExchangeHosts, type TraeMachineIdentity } from './endpoints.ts'
import { TraeUpstreamError } from './errors.ts'
import { traeRealmConfig, type TraeRealm } from './realms.ts'
import type { TraeAccount, TraeCallbackInfo, TraeToken } from './types.ts'

/** A fresh machine identity for one sign-in attempt. */
export function traeMachineIdentity(): TraeMachineIdentity {
  return {
    machineId: randomBytes(16).toString('hex'),
    deviceId: randomBytes(16).toString('hex'),
  }
}

/**
 * Parse one URL-encoded JSON query parameter.
 *
 * The sign-in page has been seen to encode these twice, so a parameter that
 * does not parse is unescaped once more before it is given up on. Both attempts
 * are made because the extra decode is harmless when it was not needed: an
 * already-plain document has no escapes left to remove.
 * @param raw - the parameter value, or `undefined` when absent.
 * @returns the parsed object, or `undefined` when it is not an object at all.
 */
function parseJsonParam(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw === '') return undefined
  const candidates = [raw]
  try {
    const unescaped = decodeURIComponent(raw)
    if (unescaped !== raw) candidates.push(unescaped)
  } catch {
    // A malformed escape leaves the raw value as the only candidate.
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const record = asRecord(parsed)
      if (Object.keys(record).length > 0) return record
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Repair a display name the redirect double-encoded.
 *
 * A UTF-8 name that was percent-encoded twice comes back as the *bytes* of that
 * name read as latin1 — `张三` arrives as `Óû§`. Reading the string back as bytes
 * and decoding it as UTF-8 recovers the name; when the result is not valid
 * UTF-8 (so the input was a name that did not need repairing) the original is
 * kept, and the caller falls back to the uid rather than printing mojibake.
 * @param value - the name as the redirect spelled it.
 * @returns the repaired name, or `undefined` when it cannot be trusted.
 */
export function decodeTraeNickname(value: string | undefined): string | undefined {
  const raw = value?.trim() ?? ''
  if (raw === '') return undefined
  if (/^[\u0020-\u007e]*$/u.test(raw)) return raw
  const repaired = Buffer.from(raw, 'latin1').toString('utf8')
  const usable = !repaired.includes('\uFFFD') && repaired.trim() !== ''
  if (usable && /[\u4e00-\u9fff]/u.test(repaired)) return repaired.trim()
  // Already valid text (`张三` read as latin1 is not), or a repair that produced
  // replacement characters: only the original can be shown, and a name that is
  // not readable text is worse than the uid.
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(raw) ? raw : undefined
}

/**
 * Normalize an upstream expiry into Unix seconds.
 *
 * The token host states expiry as milliseconds while the vault stores seconds;
 * the two are told apart by magnitude, because a value that large in seconds
 * would be a date in the year 56000.
 * @param expireAt - `TokenExpireAt` as it arrived, in ms or s.
 * @param durationSeconds - `TokenExpireDuration`, used when `expireAt` is stale.
 * @param now - current epoch ms.
 * @returns the expiry in Unix seconds, or `0` when the upstream stated none.
 */
export function traeExpiresAt(expireAt: number, durationSeconds: number, now = Date.now()): number {
  if (expireAt > 0) {
    const seconds = expireAt > 1e12 ? Math.floor(expireAt / 1000) : expireAt
    if (seconds > Math.floor(now / 1000)) return seconds
  }
  return durationSeconds > 0 ? Math.floor(now / 1000) + durationSeconds : 0
}

/**
 * Parse the sign-in redirect.
 *
 * @param rawUrl - the full callback URL, or the path plus query as the browser
 *   shows it.
 * @returns the credential fields the redirect carried.
 * @throws TraeUpstreamError when the redirect carries no credential at all.
 */
export function parseTraeCallback(rawUrl: string): TraeCallbackInfo {
  const trimmed = rawUrl.trim()
  if (trimmed === '') throw new TraeUpstreamError(400, 'TRAE_LOGIN_CALLBACK_EMPTY')
  let params: URLSearchParams
  try {
    params = new URL(trimmed.startsWith('http') ? trimmed : `http://127.0.0.1${trimmed}`).searchParams
  } catch {
    throw new TraeUpstreamError(400, 'TRAE_LOGIN_CALLBACK_UNPARSEABLE')
  }
  const userInfo = parseJsonParam(params.get('userInfo') ?? undefined)
  const userJwt = parseJsonParam(params.get('userJwt') ?? undefined)
  const refreshFromQuery = asString(params.get('refreshToken'))
  const refreshFromJwt = userJwt === undefined ? undefined : asString(userJwt.RefreshToken)
  const refreshToken = refreshFromQuery ?? refreshFromJwt
  const accessToken = userJwt === undefined ? undefined : asString(userJwt.Token)
  if ((refreshToken === undefined || refreshToken === '') && (accessToken === undefined || accessToken === '')) {
    throw new TraeUpstreamError(400, 'TRAE_LOGIN_CALLBACK_WITHOUT_CREDENTIAL')
  }
  const uid = userInfo === undefined ? '' : asString(userInfo.UserID) ?? asString(userInfo.user_id) ?? ''
  const nickname = userInfo === undefined ? undefined : asString(userInfo.ScreenName)
  const enterpriseId = userInfo === undefined ? undefined : asString(userInfo.TenantID)
  const userRegion = userInfo === undefined ? '' : regionCode(userInfo)
  const jwtExpiry = userJwt === undefined ? 0 : asNumber(userJwt.TokenExpireAt) ?? 0
  return {
    ...(refreshToken === undefined || refreshToken === '' ? {} : { refreshToken }),
    ...(accessToken === undefined || accessToken === '' ? {} : { accessToken }),
    uid,
    ...(nickname === undefined ? {} : { nickname }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(userRegion === '' ? {} : { userRegion }),
    // The degraded path has no exchange to date the token from, so the redirect's
    // own expiry is the only thing that says when this session ends.
    expiresAt: refreshToken === undefined || refreshToken === '' ? traeExpiresAt(jwtExpiry, 0) : 0,
  }
}

/**
 * The account's own region code, when the redirect states one.
 *
 * The international deployment splits its chat traffic on this value, and the
 * redirect is the only place an account describes itself during a sign-in. Every
 * spelling upstream has been seen to use is accepted; an unstated region is the
 * normal answer for a China account and is left absent rather than guessed.
 * @param userInfo - the redirect's `userInfo` document.
 * @returns the upper-cased region code, or an empty string.
 */
function regionCode(userInfo: Record<string, unknown>): string {
  const raw = userInfo.UserRegion ?? userInfo.userRegion ?? userInfo.Region ?? userInfo.region
  const value = asString(raw) ?? asString(asRecord(raw).region)
  return value === undefined ? '' : value.trim().toUpperCase()
}

/**
 * Exchange a refresh token for a session.
 *
 * A failed exchange leaves the stored refresh token in place and unsaid: the
 * upstream rotates refresh tokens, so a request that is retried with the token
 * it already had is either the rotation that landed or the retry of one that
 * did not — never a token that was silently spent by a failure.
 * @param refreshToken - the token to spend.
 * @param realm - the deployment the token belongs to, which decides the host and
 *   the client id it is matched against.
 * @param signal - cancels the exchange.
 * @returns the rotated session.
 */
export async function exchangeTraeToken(refreshToken: string, realm: TraeRealm, signal?: AbortSignal): Promise<TraeToken> {
  // The realm's own auth host first, then any host the same service has been
  // observed on. Only a wrong-host refusal moves to the next candidate — a
  // credential refusal repeats identically, and retrying it would report one
  // problem twice.
  const hosts = traeExchangeHosts(realm)
  const clientId = traeRealmConfig(realm).oauthClientId
  let lastError: TraeUpstreamError | undefined
  for (const host of hosts) {
    const response = await fetch(`${host}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `Trae/${traeRealmConfig(realm).ideVersion}`,
      },
      // `ClientSecret` is spelled `-` by the IDE itself: the field exists in the
      // contract and the desktop client sends a literal dash for a public client.
      body: JSON.stringify({ ClientID: clientId, RefreshToken: refreshToken, ClientSecret: '-', UserID: '' }),
      ...(signal === undefined ? { signal: AbortSignal.timeout(20_000) } : { signal }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const failure = new TraeUpstreamError(response.status, detail.slice(0, 300))
      // 404 is the wrong host's answer; anything else names the credential or the
      // client id, and another host will answer it the same way.
      if (response.status !== 404) throw failure
      lastError = failure
      continue
    }
    const document = await response.json().catch(() => undefined)
    // A 200 that is not JSON is the other wrong-host answer: a gateway or load
    // balancer page from a name that does not serve this API, which is why
    // `traeExchangeHosts` lists more than one host for a realm. Only this shape
    // moves on. A JSON refusal is the credential's own answer or the client id's,
    // and the next host would answer it identically — retried there it would just
    // read as the same problem reported twice.
    if (document === undefined) {
      lastError = new TraeUpstreamError(502, 'TRAE_TOKEN_HOST_ANSWERED_A_GATEWAY_PAGE')
      continue
    }
    const result = exchangedSession(asRecord(asRecord(document).Result), refreshToken)
    return result
  }
  throw lastError ?? new TraeUpstreamError(502, 'no token host answered the exchange')
}

/**
 * Read a rotated session out of an `ExchangeToken` result.
 * @param result - the document's `Result` object.
 * @param refreshToken - the token that was spent, kept when the upstream did not rotate it.
 * @returns the session to store.
 */
function exchangedSession(result: Record<string, unknown>, refreshToken: string): TraeToken {
  const accessToken = asString(result.Token)
  if (accessToken === undefined || accessToken === '') throw new TraeUpstreamError(502, 'TRAE_TOKEN_EXCHANGE_RETURNED_NO_TOKEN')
  const rotated = asString(result.RefreshToken)
  const expiresAt = traeExpiresAt(asNumber(result.TokenExpireAt) ?? 0, asNumber(result.TokenExpireDuration) ?? 0)
  return {
    accessToken,
    refreshToken: rotated === undefined || rotated === '' ? refreshToken : rotated,
    expiresAt,
  }
}

/**
 * The stable local id of an account.
 *
 * Derived from the uid rather than from a token, so re-authorizing the same
 * account replaces its row instead of adding a second one — which is what a
 * token-derived id did, and what left a pool of rows that were one account.
 * @param uid - the account's upstream uid.
 * @param fallback - a non-empty seed used when the redirect carried no uid.
 * @returns the account id.
 */
export function traeAccountId(uid: string, fallback: string): string {
  const cleaned = uid.trim().replace(/[^a-zA-Z0-9._-]/gu, '')
  if (cleaned !== '') return cleaned
  return `trae-${fallback.replace(/[^a-zA-Z0-9._-]/gu, '').slice(-12)}`
}

/**
 * Build the account row one completed sign-in stores.
 * @param callback - the parsed redirect.
 * @param identity - the machine identity the attempt claimed.
 * @param token - the exchanged session.
 * @param realm - the deployment this sign-in authorized against.
 * @param now - current epoch ms.
 * @returns the account to vault.
 */
export function traeAccountFromLogin(
  callback: TraeCallbackInfo,
  identity: TraeMachineIdentity,
  token: TraeToken,
  realm: TraeRealm = 'cn',
  now = Date.now(),
): TraeAccount {
  const nickname = decodeTraeNickname(callback.nickname)
  const fallback = token.accessToken === '' ? identity.deviceId : token.accessToken
  return {
    id: traeAccountId(callback.uid, fallback),
    realm,
    ...(callback.userRegion === undefined ? {} : { userRegion: callback.userRegion }),
    uid: callback.uid,
    nickname: nickname ?? '',
    ...(callback.enterpriseId === undefined || callback.enterpriseId === '' ? {} : { enterpriseId: callback.enterpriseId }),
    machineId: identity.machineId,
    deviceId: identity.deviceId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    createdAt: Math.floor(now / 1000),
    lastChecked: Math.floor(now / 1000),
  }
}
