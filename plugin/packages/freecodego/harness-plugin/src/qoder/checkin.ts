/**
 * The Qoder daily credit campaign.
 *
 * Qoder does not have a "check in" call; it has campaigns, and the daily credits
 * are one of them. The id changes every day, which is why the claim cannot be
 * addressed until the list has been read — a hard-coded id would work exactly
 * once. The list also carries the two facts that make a run honest: whether the
 * campaign is running at all, and whether today's benefit is still claimable.
 *
 * Two answers mean success rather than failure. `CLAIMED` is this run's claim;
 * `replayed: true` is the same claim arriving twice, which is what a user who
 * presses the button twice — or a Host that retried — produces. Reporting a
 * replay as a failure would teach the user not to press the button, on a day the
 * credits are already theirs.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/checkin
 */

import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { redactCredentialShapes } from '../secret-scan.ts'
import { QODER_CAMPAIGNS_PATH, qoderEndpoints } from './endpoints.ts'
import type { FreeCodeGoCheckinOutcome } from '../types.ts'
import type { QoderRegion } from './types.ts'

/**
 * The client type header the desktop app sends.
 *
 * The campaign endpoints accept a plain `Bearer` device token, but only when
 * this header says the caller is a desktop client; without it the same token is
 * refused. There is no signature to compute here, unlike the chat endpoints.
 */
const QODER_COSY_CLIENT_TYPE = '10'

/** One campaign the account can be awarded. */
export interface QoderCampaign {
  readonly campaignId: string
  /** What the campaign awards, as upstream states it. */
  readonly amount: number
}

/** The result of one account's campaign run. */
export interface QoderCheckinOutcome {
  readonly status: FreeCodeGoCheckinOutcome
  readonly credits: number
  /** How many campaigns this run actually collected. */
  readonly claimed: number
  readonly message: string
  /** The refusals this run hit while still collecting something, if any. */
  readonly refused?: string
}

/** The headers one campaign call carries. */
function campaignHeaders(deviceToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${deviceToken}`,
    accept: 'application/json',
    'cosy-clienttype': QODER_COSY_CLIENT_TYPE,
  }
}

/** The campaign list URL for one region. */
function campaignsUrl(region: QoderRegion): string {
  return `${qoderEndpoints(region).campaignsBase}${QODER_CAMPAIGNS_PATH}`
}

/** The claim URL for one campaign. */
function claimUrl(region: QoderRegion, campaignId: string): string {
  return `${campaignsUrl(region)}/${encodeURIComponent(campaignId)}/claim`
}

/**
 * Read the account's claimable campaigns.
 * @param region - the account's region.
 * @param deviceToken - the account's bearer token.
 * @param signal - aborts the read.
 * @returns whether the campaign is running and which benefits are claimable.
 * @throws Error when the read is refused.
 */
export async function readQoderCampaigns(
  region: QoderRegion,
  deviceToken: string,
  signal?: AbortSignal,
): Promise<{ readonly claimable: boolean; readonly campaigns: readonly QoderCampaign[] }> {
  const response = await fetch(campaignsUrl(region), {
    headers: campaignHeaders(deviceToken),
    signal: signal ?? AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status}`)
  const payload = asRecord(await response.json().catch(() => ({})))
  const rows = Array.isArray(payload.campaigns) ? payload.campaigns : []
  const campaigns: QoderCampaign[] = []
  for (const row of rows) {
    const campaign = asRecord(row)
    // Only this action type awards credits, and only a claimable row can be
    // claimed: a claimed or expired row would answer a replay at best.
    if (asString(campaign.actionType) !== 'CLAIM_BENEFIT') continue
    if (asString(campaign.claimStatus) !== 'CLAIMABLE') continue
    const campaignId = asString(campaign.campaignId)
    if (campaignId === undefined || campaignId === '') continue
    campaigns.push({ campaignId, amount: asNumber(asRecord(campaign.benefit).amount) ?? 0 })
  }
  return { claimable: payload.claimable === true, campaigns }
}

/**
 * Claim every campaign the account still has available.
 *
 * Campaigns are claimed one at a time and a refusal is recorded rather than
 * thrown: a run that collected one of two benefits is a partial success, and
 * failing the whole run would hide the credits that did arrive.
 * @param region - the account's region.
 * @param deviceToken - the account's bearer token.
 * @param signal - aborts the run.
 * @returns what the campaigns answered.
 * @throws Error when the campaign list itself cannot be read.
 */
export async function claimQoderCampaigns(
  region: QoderRegion,
  deviceToken: string,
  signal?: AbortSignal,
): Promise<QoderCheckinOutcome> {
  const list = await readQoderCampaigns(region, deviceToken, signal)
  if (!list.claimable) return { status: 'unavailable', credits: 0, claimed: 0, message: '今日无待领取活动或活动未开启' }
  if (list.campaigns.length === 0) return { status: 'already', credits: 0, claimed: 0, message: '今日已领取或无可领取活动' }

  let claimed = 0
  let credits = 0
  const failures: string[] = []
  for (const campaign of list.campaigns) {
    const response = await fetch(claimUrl(region, campaign.campaignId), {
      method: 'POST',
      headers: { ...campaignHeaders(deviceToken), 'content-type': 'application/json' },
      body: '{}',
      signal: signal ?? AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    if (response === undefined || !response.ok) {
      failures.push(`${campaign.campaignId}: HTTP ${response?.status ?? 'network'}`)
      continue
    }
    const payload = asRecord(await response.json().catch(() => ({})))
    if (asString(payload.status) === 'CLAIMED') {
      claimed += 1
      credits += campaign.amount
      continue
    }
    // A replay is this campaign's benefit, already on the account.
    if (payload.replayed === true) continue
    // Masked where it is read: the campaign call carries the account's bearer
    // token, and the failure line is surfaced in the card.
    failures.push(`${campaign.campaignId}: ${redactCredentialShapes(asString(payload.message) ?? asString(payload.status) ?? 'unknown')}`)
  }

  if (claimed === 0) {
    return failures.length === 0
      ? { status: 'already', credits: 0, claimed: 0, message: '今日已领取（无新增）' }
      : { status: 'failed', credits: 0, claimed: 0, message: `领取失败：${failures.join('；')}` }
  }
  // A run that collected some benefits and was refused others has to say both:
  // the total leads, and the refusals follow it. Reporting only the total is the
  // one outcome the user cannot act on, because the account that failed is the
  // account they would have to look at.
  const refused = failures.length === 0 ? '' : `${failures.length} 项未领取：${failures.join('；')}`
  return {
    status: 'claimed',
    credits,
    claimed,
    message: `签到成功 +${credits} Credits，共 ${claimed} 项${refused === '' ? '' : `（${refused}）`}`,
    // Carried separately as well, because the card renders a collected amount
    // from `credits` and would otherwise show this refusal to nobody.
    ...(refused === '' ? {} : { refused }),
  }
}
