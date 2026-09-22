/**
 * Qoder OAuth (PKCE device flow), identity lookup, plan, and quota reads.
 *
 * The flow is three steps: mint a PKCE verifier plus a nonce and hand the user
 * the login URL; poll `deviceToken/poll` until the browser authorization lands a
 * `dt-` token; then read `userinfo` to build the cosy identity. A 404 from the
 * poll endpoint is the "not authorized yet" answer, not a failure.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { QODER_OAUTH_CLIENT_ID, qoderEndpoints } from './endpoints.ts'
import { firstString } from './cosy.ts'
import type { QoderIdentity, QoderQuota, QoderQuotaBucket, QoderRegion, QoderTokenPair } from './types.ts'

/** One in-flight browser authorization, as the Host holds it. */
export interface QoderLoginAttempt {
  readonly loginId: string
  readonly loginUrl: string
  readonly verifier: string
  readonly nonce: string
  readonly region: QoderRegion
  readonly expiresAt: number
}

/** A round of PKCE parameters. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  return { verifier, challenge }
}

/**
 * Start a browser authorization.
 * @param region - the region the account will belong to.
 * @returns the attempt the card renders and polls.
 */
export function startQoderLogin(region: QoderRegion): QoderLoginAttempt {
  const { verifier, challenge } = pkce()
  const nonce = randomBytes(16).toString('hex')
  const params = new URLSearchParams({
    nonce,
    challenge,
    challenge_method: 'S256',
    client_id: QODER_OAUTH_CLIENT_ID,
  })
  return {
    loginId: randomBytes(16).toString('hex'),
    loginUrl: `${qoderEndpoints(region).deviceLoginBase}?${params.toString()}`,
    verifier,
    nonce,
    region,
    expiresAt: Date.now() + 10 * 60_000,
  }
}

/**
 * Poll once for the device token. Returns `undefined` while the user has not
 * finished authorizing (the endpoint answers 404 until it has).
 * @param attempt - the in-flight attempt.
 * @param signal - cancels the poll.
 * @returns the issued token pair, or `undefined` while pending.
 */
export async function pollQoderDeviceToken(attempt: QoderLoginAttempt, signal?: AbortSignal): Promise<QoderTokenPair | undefined> {
  const params = new URLSearchParams({
    nonce: attempt.nonce,
    verifier: attempt.verifier,
    challenge_method: 'S256',
  })
  const response = await fetch(`${qoderEndpoints(attempt.region).pollEndpoint}?${params.toString()}`, {
    headers: { accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Qoder device-token poll failed: HTTP ${response.status}`)
  const payload = asRecord(await response.json().catch(() => ({})))
  const deviceToken = asString(payload.token)
  if (deviceToken === undefined || deviceToken === '') throw new Error('Qoder device-token poll returned no token')
  const refreshToken = asString(payload.refresh_token)
  return { deviceToken, ...(refreshToken === undefined ? {} : { refreshToken }) }
}

/** Read the authenticated account's userinfo. */
export async function fetchQoderUserInfo(region: QoderRegion, deviceToken: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(qoderEndpoints(region).userinfoBase, {
    headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Qoder userinfo failed: HTTP ${response.status}`)
  return asRecord(await response.json().catch(() => ({})))
}

/** Read the account's plan tier name; an unanswered read yields `undefined`. */
export async function fetchQoderPlan(region: QoderRegion, deviceToken: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(qoderEndpoints(region).planEndpoint, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) return undefined
    const payload = asRecord(await response.json().catch(() => ({})))
    return asString(payload.plan_tier_name)
  } catch {
    return undefined
  }
}

function quotaBucket(value: unknown): QoderQuotaBucket | undefined {
  const row = asRecord(value)
  if (Object.keys(row).length === 0) return undefined
  const used = asNumber(row.used) ?? 0
  const total = asNumber(row.total) ?? 0
  const remaining = asNumber(row.remaining) ?? 0
  if (total === 0 && used === 0 && remaining === 0) return undefined
  const resetTime = asString(row.resetTime) ?? asString(row.reset_time)
  return { used, total, remaining, ...(resetTime === undefined ? {} : { resetTime }) }
}

/**
 * Read one account's quota snapshot. Upstream's own refusal is recorded as the
 * snapshot's `error` rather than thrown, so the card renders the last position
 * with the reason it could not be refreshed.
 * @param region - the account's region.
 * @param deviceToken - the account's device token.
 * @param signal - cancels the read.
 * @returns the quota snapshot.
 */
export async function fetchQoderQuota(region: QoderRegion, deviceToken: string, signal?: AbortSignal): Promise<QoderQuota> {
  const checkedAt = Date.now()
  try {
    const response = await fetch(qoderEndpoints(region).quotaEndpoint, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return { isQuotaExceeded: false, checkedAt, error: `HTTP ${response.status}` }
    }
    const payload = asRecord(await response.json().catch(() => ({})))
    const userQuota = quotaBucket(payload.userQuota)
    const addonQuota = quotaBucket(payload.addOnQuota)
    const expiresAt = asNumber(payload.expiresAt)
    const plan = await fetchQoderPlan(region, deviceToken, signal)
    return {
      ...(plan === undefined ? {} : { plan }),
      ...(userQuota === undefined ? {} : { userQuota }),
      ...(addonQuota === undefined ? {} : { addonQuota }),
      isQuotaExceeded: payload.isQuotaExceeded === true,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      checkedAt,
    }
  } catch (error) {
    return { isQuotaExceeded: false, checkedAt, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Build the cosy identity from a userinfo document.
 * @param userInfo - the authenticated userinfo.
 * @param deviceToken - the issued device token.
 * @param refreshToken - the issued refresh token, when one was issued.
 * @returns the cosy identity.
 */
export function qoderIdentityFromUserInfo(userInfo: Record<string, unknown>, deviceToken: string, refreshToken?: string): QoderIdentity {
  const id = firstString(userInfo, ['id', 'userId', 'uid'])
  const organizationId = asString(userInfo.organization_id)
  const organizationName = asString(userInfo.organization_name)
  return {
    name: asString(userInfo.name) ?? '',
    aid: id,
    uid: id,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(organizationName === undefined ? {} : { organizationName }),
    userType: asString(userInfo.userType) ?? 'personal_standard',
    securityOauthToken: deviceToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  }
}

/**
 * Derive the stable local account id from a userinfo document.
 * @param userInfo - the authenticated userinfo.
 * @param deviceToken - the device token, used as the tail fallback.
 * @returns the account id.
 */
export function qoderAccountIdFromUserInfo(userInfo: Record<string, unknown>, deviceToken: string): string {
  const id = firstString(userInfo, ['id', 'userId', 'uid'])
  const email = asString(userInfo.email) ?? ''
  const composed = `${id}${email}`.replace(/[^a-zA-Z0-9._-]/gu, '').slice(0, 96)
  if (composed !== '') return composed
  return `qoder-${deviceToken.slice(-12)}`
}
