/**
 * The TRAE daily credit check-in.
 *
 * SOLO grants credits once a day and the claim is a separate call from the
 * status read, which is what makes this a small state machine rather than one
 * POST: the status is the authority on whether today is already collected, and
 * the claim is the only thing that can collect it. Reading first is therefore
 * not an optimization — claiming blind would answer `1001` on every account that
 * already signed in, and a run over a pool of accounts would look like a wall of
 * failures on a day that had in fact gone perfectly.
 *
 * `9074` is a refusal of the **device**, not of the request and not the capacity
 * message it prints: measured on a real account, every request shape presents the
 * same `9074` except the one carrying the number the official client registered on
 * this machine, which claims with `code: 0` (see `trae/device.ts` for the full
 * measurement and for the order the numbers are tried in). The earlier version of
 * this module had the identity wrong *and* the recovery wrong — it waited 2/5/10
 * seconds and re-sent the very identity it had just been refused, so four attempts
 * could only ever produce four identical refusals. Now each attempt presents the
 * next candidate number, and the status read participates, because a device the
 * campaign does not accept is refused on the read just as it is on the claim.
 *
 * The waits are short for the same reason: the number is what changes, so the pause
 * only has to keep the attempts from arriving in one burst.
 *
 * One thing the references do *not* do and this does: after the numbers are
 * exhausted, the status is read once more. A claim refused on its answer may still
 * have landed, and reporting a credit that arrived as a failure is the one outcome
 * a user cannot check for themselves.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/checkin
 */

import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { redactCredentialShapes } from '../secret-scan.ts'
import { buildTraeSoloHeaders } from './bridge.ts'
import {
  TRAE_CHECKIN_BODY,
  TRAE_CHECKIN_CLAIM_URL,
  TRAE_CHECKIN_RETRY_DELAYS_MS,
  TRAE_CHECKIN_STATUS_URL,
  TRAE_USER_REGION,
} from './endpoints.ts'
import { traeAhaDeviceId, traeCheckinDeviceNumbers, traeClientAhaDeviceId } from './device.ts'
import { TraeUpstreamError } from './errors.ts'
import { traeRealmConfig } from './realms.ts'
import type { FreeCodeGoCheckinOutcome } from '../types.ts'
import type { TraeAccount } from './types.ts'

/** Today's state of the check-in campaign, as the status endpoint reports it. */
export interface TraeCheckinStatus {
  /** Whether the campaign is running at all. */
  readonly enabled: boolean
  /** Whether today's credits are already on the account. */
  readonly checkedIn: boolean
  /** Today's stated award, when upstream names one. */
  readonly credits: number
}

/** The result of one account's claim attempt. */
export interface TraeCheckinOutcome {
  readonly status: FreeCodeGoCheckinOutcome
  readonly credits: number
  readonly message: string
}

/**
 * The headers a check-in call carries: the session's, the region, and the device
 * number this attempt presents.
 *
 * The number is stated last, because it *replaces* the hashed identity the
 * conversation path sends — that identity is what the risk control refuses (see
 * `trae/device.ts`), and a request carrying both would state neither.
 * @param account - the account the call is signed with.
 * @param deviceId - the 16-digit Aha number for this attempt.
 * @returns the headers.
 */
function checkinHeaders(account: TraeAccount, deviceId: string): Record<string, string> {
  return buildTraeSoloHeaders(account, false, {
    'x-user-region': TRAE_USER_REGION,
    'x-device-id': deviceId,
  })
}

/**
 * The risk-control code the credit endpoints answer instead of a verdict.
 *
 * It is a business code rather than an HTTP status, and it is *not* final: the
 * device number that earned it is what has to change.
 */
const TRAE_CHECKIN_THROTTLE_CODE = 9074

/** Whether a refusal is the risk control rather than a verdict on the request. */
function throttled(error: unknown): boolean {
  return error instanceof TraeUpstreamError && error.code === TRAE_CHECKIN_THROTTLE_CODE
}

/** Whether the status document says today's credits are already collected. */
function statusCheckedIn(payload: Record<string, unknown>): boolean {
  return payload.checked_in === true || payload.did_checked_in === true
}

/**
 * One credit-endpoint POST, judged by neither caller.
 *
 * Both endpoints answer a business code inside an accepted response, and the two
 * callers read those codes differently — the claim treats `1001` as success and
 * `9074` as "try another device", while the status read only has to reject the
 * rest. Sharing the transport keeps one place that knows the headers, the body
 * and the timeout.
 * @param url - the endpoint to call.
 * @param account - the account the call is signed with.
 * @param deviceId - the 16-digit Aha number for this attempt.
 * @param signal - aborts the call.
 * @returns the parsed document.
 * @throws TraeUpstreamError when the transport itself is refused.
 */
async function callCreditEndpoint(
  url: string,
  account: TraeAccount,
  deviceId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: checkinHeaders(account, deviceId),
    body: JSON.stringify(TRAE_CHECKIN_BODY),
    ...(signal === undefined ? { signal: AbortSignal.timeout(20_000) } : { signal }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new TraeUpstreamError(response.status, detail.slice(0, 300))
  }
  return asRecord(await response.json().catch(() => ({})))
}

/**
 * Read the check-in status of one account.
 * @param account - the account to ask about.
 * @param signal - aborts the read.
 * @param deviceId - the Aha number to present, defaulting to the same order the claim
 *   uses (the client's own number first).
 * @returns the campaign state.
 * @throws TraeUpstreamError when the call is refused or answers a non-zero code;
 *   a refusal of the device arrives with its code attached, so the caller can rotate.
 */
export async function readTraeCheckinStatus(
  account: TraeAccount,
  signal?: AbortSignal,
  deviceId?: string,
): Promise<TraeCheckinStatus> {
  // The guard is here as well as in the claim, because this is the function that
  // would put an international token on the China host if it were ever reached
  // from a path that did not ask first.
  if (!traeRealmConfig(account.realm).creditCheckin) {
    throw new TraeUpstreamError(501, 'TRAE_CHECKIN_UNSUPPORTED: the daily campaign is only served by the China deployment')
  }
  const device = deviceId ?? traeClientAhaDeviceId() ?? traeAhaDeviceId(account.deviceId)
  const payload = await callCreditEndpoint(TRAE_CHECKIN_STATUS_URL, account, device, signal)
  const code = asNumber(payload.code)
  if (code !== 0) {
    // The message is upstream's, and the call that produced it carried the access
    // token in its headers — an upstream that echoed the request back would name
    // the credential here.
    const detail = redactCredentialShapes(asString(payload.message) ?? '')
    throw new TraeUpstreamError(502, `checkin status answered code=${String(code)}: ${detail}`.trim(), code)
  }
  return {
    // Absent reads as enabled: upstream normally states it, and treating a missing
    // flag as "the campaign is off" would report a working feature as retired.
    enabled: payload.enable !== false,
    checkedIn: statusCheckedIn(payload),
    credits: asNumber(asRecord(payload.data).points) ?? asNumber(payload.credits) ?? 0,
  }
}

/** How long to wait before the next attempt; the last delay is never waited out. */
function retryDelay(attempt: number): number {
  const delays = TRAE_CHECKIN_RETRY_DELAYS_MS
  return delays[Math.min(attempt, delays.length - 1)] ?? 0
}

/**
 * Claim today's credits for one account.
 *
 * The status read happens first, so the caller can say "already signed in" for
 * an account rather than reporting a claim the upstream refused as a failure —
 * and it happens **inside** the attempt loop, because the device number is what
 * the risk control judges: a flagged number is refused on the status read too,
 * and a version that only rotated around the claim would never reach it.
 * @param account - the account to claim for.
 * @param signal - aborts the claim, including the waits between retries.
 * @param wait - the sleep between retries, injectable so a test is not a real wait.
 * @returns what the campaign answered.
 * @throws TraeUpstreamError when the status or the claim is refused outright.
 */
export async function claimTraeCredits(
  account: TraeAccount,
  signal?: AbortSignal,
  wait: (ms: number) => Promise<void> = defaultWait,
): Promise<TraeCheckinOutcome> {
  // An unsupported realm answers as "nothing to collect" rather than as a failure:
  // the account is fine and the feature simply does not exist there, and a red
  // failure line would send the user looking for a problem with their sign-in.
  if (!traeRealmConfig(account.realm).creditCheckin) {
    return { status: 'unavailable', credits: 0, message: '国际版暂无每日签到接口（未验证）' }
  }
  const attempts = TRAE_CHECKIN_RETRY_DELAYS_MS.length + 1
  // Resolved once per run rather than once per attempt: reading the client's storage
  // file five times would answer the same thing, and the fallbacks are derived.
  const clientDeviceId = traeClientAhaDeviceId()
  const devices = traeCheckinDeviceNumbers(account.deviceId, attempts, clientDeviceId)
  let deviceId = devices[0] ?? traeAhaDeviceId(account.deviceId)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(retryDelay(attempt - 1))
    // A new device number per attempt: the refusal names the device, so the way
    // past it is a different one, and this is the whole difference from the
    // ladder that used to sleep on the identity it had just been refused.
    deviceId = devices[attempt] ?? deviceId
    let status: TraeCheckinStatus
    try {
      status = await readTraeCheckinStatus(account, signal, deviceId)
    } catch (error) {
      if (throttled(error)) continue
      throw error
    }
    if (!status.enabled) return { status: 'unavailable', credits: 0, message: '签到活动未开启' }
    if (status.checkedIn) return { status: 'already', credits: 0, message: '今日已签到' }
    let payload: Record<string, unknown>
    try {
      payload = await callCreditEndpoint(TRAE_CHECKIN_CLAIM_URL, account, deviceId, signal)
    } catch (error) {
      if (throttled(error)) continue
      throw error
    }
    const code = asNumber(payload.code)
    if (code === 0) {
      const credits = asNumber(asRecord(payload.data).points) ?? asNumber(payload.points) ?? status.credits
      return { status: 'claimed', credits, message: `签到成功 +${credits} 积分` }
    }
    // The campaign's own "you already have today's credits" answer.
    if (code === 1001) return { status: 'already', credits: 0, message: '今日已签到' }
    if (code === TRAE_CHECKIN_THROTTLE_CODE) continue
    // Masked at the boundary rather than at the card: the report is the value
    // that crosses to the browser, so this is the last place the credential's
    // context is known.
    const detail = redactCredentialShapes(asString(payload.message) ?? `code=${String(code)}`)
    return { status: 'failed', credits: 0, message: `签到失败：${detail}` }
  }

  // Every device number was refused. A throttle answers the *request* and says
  // nothing about whether the claim landed, so the status decides: a credit that
  // arrived while the answer was refused is a sign-in that worked. The read uses
  // the last device this run presented, so the question is asked in the same
  // context as the claim it is asking about.
  const recheck = await readTraeCheckinStatus(account, signal, deviceId).catch(() => undefined)
  if (recheck?.checkedIn === true) {
    return { status: 'already', credits: 0, message: '今日已签到（claim 被限流，但回查已到账）' }
  }
  // "Devices", not "retries": what the run actually did was present a sequence of
  // device numbers, and a message that miscounts the work it did is the kind of
  // detail a user checks when they report the failure. The hint is added only when
  // this machine had no client number to offer, because the measurement says that is
  // the case most likely to end here.
  const hint = clientDeviceId === undefined
    ? '；本机未找到官方客户端的设备号，在官方客户端登录一次后重试'
    : ''
  return { status: 'failed', credits: 0, message: `签到失败：9074（设备号未被接受，已尝试 ${String(attempts)} 个）${hint}` }
}

/** The plain sleep the retry ladder uses in production. */
function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
