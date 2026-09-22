import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimTraeCredits, readTraeCheckinStatus } from '../src/trae/checkin.ts'
import { claimQoderCampaigns, readQoderCampaigns } from '../src/qoder/checkin.ts'
import { traeAhaDeviceId } from '../src/trae/device.ts'
import { TRAE_CHECKIN_CLAIM_URL, TRAE_CHECKIN_RETRY_DELAYS_MS, TRAE_CHECKIN_STATUS_URL } from '../src/trae/endpoints.ts'
import type { TraeAccount } from '../src/trae/types.ts'

const account: TraeAccount = {
  id: '8123',
  realm: 'cn',
  uid: '8123',
  nickname: 'trae-user',
  machineId: 'a'.repeat(32),
  deviceId: 'b'.repeat(32),
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 0,
  createdAt: 0,
  lastChecked: 0,
}

/** One upstream answer, as a minimal `Response`. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The request a stubbed fetch received, recorded so headers can be asserted. */
interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** Stub `fetch` with a per-URL answer, returning the requests it saw. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): readonly Recorded[] {
  const seen: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, init })
    return handler(url, init)
  }))
  return seen
}

/** The `APPDATA` this process started with, so a test's scratch directory is undone. */
const REAL_APPDATA = process.env.APPDATA

/**
 * Point the client-device lookup at a scratch directory.
 *
 * The real lookup reads this machine's official client data, and a test that let it
 * would assert against whatever device number the developer's machine happens to
 * hold — including on machines where the file is absent. Passing a number writes the
 * storage file the lookup reads; passing `undefined` leaves the directory empty.
 * @param ahaNumber - the Aha device number to place, or `undefined` for none.
 */
function useClientStorage(ahaNumber: string | undefined): void {
  const root = mkdtempSync(join(tmpdir(), 'trae-client-'))
  if (ahaNumber !== undefined) {
    const directory = join(root, 'Trae CN', 'User', 'globalStorage')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'storage.json'), JSON.stringify({ [`iCubeAuthInfo://icube-dc:${ahaNumber}`]: 'secret' }))
  }
  process.env.APPDATA = root
}

afterEach(() => {
  vi.unstubAllGlobals()
  if (REAL_APPDATA === undefined) delete process.env.APPDATA
  else process.env.APPDATA = REAL_APPDATA
})

describe('Trae daily check-in', () => {
  const noWait = async (): Promise<void> => undefined

  /** A device number the way the official client stores it on this machine. */
  const CLIENT_DEVICE = '2363287550100217'

  it('reads the campaign state with the region and a 16-digit device number', async () => {
    // No client storage here, so the fallback number is the one under test.
    useClientStorage(undefined)
    const seen = stubFetch(() => json({ code: 0, enable: true, checked_in: false, credits: 200 }))
    await expect(readTraeCheckinStatus(account)).resolves.toEqual({ enabled: true, checkedIn: false, credits: 200 })
    expect(seen[0]?.url).toBe(TRAE_CHECKIN_STATUS_URL)
    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>
    // Without this header the claim answers 9074 (risk control) instead of claiming.
    expect(headers['x-user-region']).toBe('CN')
    expect(headers.authorization).toBe('Cloud-IDE-JWT access-1')
    // The device number, not the hashed identity the conversation path signs with:
    // a device id that is not 16 digits is answered 9074 on every attempt.
    expect(headers['x-device-id']).toBe(traeAhaDeviceId(account.deviceId))
    expect(headers['x-device-id']).toMatch(/^[1-9]\d{15}$/u)
    expect(headers['x-device-id']).not.toBe(account.deviceId)
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ req_source: 1 })
  })

  it('claims once and reports what the campaign awarded', async () => {
    const seen = stubFetch((url) => url === TRAE_CHECKIN_STATUS_URL
      ? json({ code: 0, enable: true, checked_in: false })
      : json({ code: 0, data: { points: 300 } }))
    await expect(claimTraeCredits(account, undefined, noWait)).resolves.toEqual({ status: 'claimed', credits: 300, message: '签到成功 +300 积分' })
    expect(seen.map(entry => entry.url)).toEqual([TRAE_CHECKIN_STATUS_URL, TRAE_CHECKIN_CLAIM_URL])
  })

  it('does not claim when today is already collected, and says so as a success', async () => {
    // The read is what makes a pool's second account honest: claiming blind would
    // answer 1001 and be reported as a failure on a day that went perfectly.
    const seen = stubFetch(() => json({ code: 0, enable: true, did_checked_in: true }))
    await expect(claimTraeCredits(account, undefined, noWait)).resolves.toMatchObject({ status: 'already', credits: 0 })
    expect(seen).toHaveLength(1)
  })

  it('reports a closed campaign as unavailable rather than as an error', async () => {
    stubFetch(() => json({ code: 0, enable: false, checked_in: false }))
    await expect(claimTraeCredits(account, undefined, noWait)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('treats upstream’s own "already collected" answer as success', async () => {
    stubFetch((url) => url === TRAE_CHECKIN_STATUS_URL
      ? json({ code: 0, enable: true, checked_in: false })
      : json({ code: 1001, message: 'already checked in' }))
    await expect(claimTraeCredits(account, undefined, noWait)).resolves.toMatchObject({ status: 'already' })
  })

  it('presents the device number the official client registered on this machine', async () => {
    // Measured: this is the only number the claim accepts. Every other shape of the
    // request — same token, same headers, same body — is answered 9074.
    useClientStorage(CLIENT_DEVICE)
    const seen = stubFetch((url) => url === TRAE_CHECKIN_STATUS_URL
      ? json({ code: 0, enable: true, checked_in: false })
      : json({ code: 0, data: { points: 150 } }))
    await expect(claimTraeCredits(account, undefined, noWait))
      .resolves.toMatchObject({ status: 'claimed', credits: 150 })
    const devices = seen.map(entry => ((entry.init?.headers ?? {}) as Record<string, string>)['x-device-id'])
    expect(devices).toEqual([CLIENT_DEVICE, CLIENT_DEVICE])
  })

  it('rotates the device number on 9074 instead of re-sending the refused one', async () => {
    // The refusal names the *device*, so this is the only thing that can clear it.
    // The earlier ladder slept 2/5/10 seconds and presented the same number again,
    // which is how four attempts produced four identical refusals.
    useClientStorage(undefined)
    let claims = 0
    const seen = stubFetch((url) => {
      if (url === TRAE_CHECKIN_STATUS_URL) return json({ code: 0, enable: true, checked_in: false })
      claims += 1
      return claims <= 2 ? json({ code: 9074, message: 'risk control' }) : json({ code: 0, data: { points: 250 } })
    })
    await expect(claimTraeCredits(account, undefined, async () => undefined))
      .resolves.toEqual({ status: 'claimed', credits: 250, message: '签到成功 +250 积分' })
    const devices = seen
      .filter(entry => entry.url === TRAE_CHECKIN_CLAIM_URL)
      .map(entry => ((entry.init?.headers ?? {}) as Record<string, string>)['x-device-id'])
    expect(devices).toHaveLength(3)
    expect(new Set(devices).size).toBe(3)
    expect(devices.every(device => /^[1-9]\d{15}$/u.test(String(device)))).toBe(true)
  })

  it('rotates when the status read is the call that gets throttled', async () => {
    // A device the campaign does not accept is refused on the read too, and a ladder
    // that only rotated around the claim would report that as an upstream refusal of
    // the status instead of trying the next number.
    useClientStorage(CLIENT_DEVICE)
    let reads = 0
    const seen = stubFetch((url) => {
      if (url === TRAE_CHECKIN_STATUS_URL) {
        reads += 1
        return reads === 1 ? json({ code: 9074, message: 'risk control' }) : json({ code: 0, enable: true, checked_in: false })
      }
      return json({ code: 0, data: { points: 100 } })
    })
    await expect(claimTraeCredits(account, undefined, async () => undefined))
      .resolves.toMatchObject({ status: 'claimed', credits: 100 })
    expect(seen.filter(entry => entry.url === TRAE_CHECKIN_STATUS_URL)).toHaveLength(2)
  })

  it('trusts a status re-check that shows the credits landed while every claim was throttled', async () => {
    // The throttle answers the *claim*, so it says nothing about whether the claim
    // landed. The reference client's last move is to ask the status again, and a
    // credit that arrived has to be reported as a sign-in, not as a failure. The
    // sixth read is the re-check, after the five attempts each read once.
    let statusReads = 0
    let waits = 0
    stubFetch((url) => {
      if (url === TRAE_CHECKIN_STATUS_URL) {
        statusReads += 1
        return json({ code: 0, enable: true, checked_in: statusReads > 5 })
      }
      return json({ code: 9074, message: 'risk control' })
    })
    const outcome = await claimTraeCredits(account, undefined, async () => { waits += 1 })
    expect(outcome).toMatchObject({ status: 'already' })
    expect(outcome.message).toContain('回查')
    expect(waits).toBe(TRAE_CHECKIN_RETRY_DELAYS_MS.length)
    expect(statusReads).toBe(TRAE_CHECKIN_RETRY_DELAYS_MS.length + 2)
  })

  it('fails when every device number is refused, and says what the number would have to be', async () => {
    useClientStorage('2363287550100217')
    stubFetch((url) => url === TRAE_CHECKIN_STATUS_URL
      ? json({ code: 0, enable: true, checked_in: false })
      : json({ code: 9074, message: 'risk control' }))
    const outcome = await claimTraeCredits(account, undefined, async () => undefined)
    expect(outcome.status).toBe('failed')
    // No hint: this machine does have a client number, and it was the first thing tried.
    expect(outcome.message).toBe('签到失败：9074（设备号未被接受，已尝试 5 个）')
  })

  it('tells a machine with no client number what would make the claim work', async () => {
    useClientStorage(undefined)
    stubFetch((url) => url === TRAE_CHECKIN_STATUS_URL
      ? json({ code: 0, enable: true, checked_in: false })
      : json({ code: 9074, message: 'risk control' }))
    const outcome = await claimTraeCredits(account, undefined, async () => undefined)
    expect(outcome.message).toContain('本机未找到官方客户端的设备号')
  })

  it('carries upstream’s message for a refusal that is not a throttle', async () => {
    stubFetch((url) => url === TRAE_CHECKIN_STATUS_URL
      ? json({ code: 0, enable: true, checked_in: false })
      : json({ code: 4001, message: 'account restricted' }))
    await expect(claimTraeCredits(account, undefined, async () => undefined)).resolves.toMatchObject({ status: 'failed', message: '签到失败：account restricted' })
  })

  it('refuses to read a campaign state that came back as a failure', async () => {
    stubFetch(() => json({ code: 500, message: 'boom' }))
    await expect(readTraeCheckinStatus(account)).rejects.toThrow(/code=500/u)
  })
})

describe('Qoder daily campaign', () => {
  const campaigns = (payload: unknown): Response => json(payload)

  it('claims every claimable benefit and sums what it collected', async () => {
    const seen = stubFetch((url) => {
      if (!url.endsWith('/claim')) {
        return campaigns({
          claimable: true,
          campaigns: [
            { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
            { campaignId: 'c2', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 50 } },
            // Neither of these can be claimed: one is a different action, the other
            // is already collected — a claim on either would answer a replay.
            { campaignId: 'c3', actionType: 'SURVEY', claimStatus: 'CLAIMABLE', benefit: { amount: 999 } },
            { campaignId: 'c4', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 999 } },
          ],
        })
      }
      return json({ status: 'CLAIMED' })
    })
    await expect(claimQoderCampaigns('cn', 'token-1')).resolves.toEqual({ status: 'claimed', credits: 150, claimed: 2, message: '签到成功 +150 Credits，共 2 项' })
    const claimed = seen.filter(entry => entry.url.endsWith('/claim')).map(entry => entry.url)
    expect(claimed).toEqual([
      'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/c1/claim',
      'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/c2/claim',
    ])
    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-1')
    // The campaign endpoints accept a plain bearer token only when the caller says
    // it is a desktop client.
    expect(headers['cosy-clienttype']).toBe('10')
  })

  it('reads the global region from its own origin', async () => {
    const seen = stubFetch(() => json({ claimable: false }))
    await expect(claimQoderCampaigns('global', 'token-1')).resolves.toMatchObject({ status: 'unavailable' })
    expect(seen[0]?.url).toBe('https://openapi.qoder.sh/sash/api/v1/me/campaigns')
  })

  it('reports nothing to collect as already collected', async () => {
    stubFetch(() => json({ claimable: true, campaigns: [] }))
    await expect(claimQoderCampaigns('cn', 'token-1')).resolves.toMatchObject({ status: 'already' })
  })

  it('keeps a replay from being reported as a failure', async () => {
    // A user who presses the button twice, or a Host that retried, gets a replay —
    // and today's credits are on the account either way.
    stubFetch((url) => url.endsWith('/claim')
      ? json({ replayed: true })
      : json({ claimable: true, campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }] }))
    await expect(claimQoderCampaigns('cn', 'token-1')).resolves.toMatchObject({ status: 'already', credits: 0 })
  })

  it('keeps the benefits it collected and still names the campaign that was refused', async () => {
    stubFetch((url) => {
      if (!url.endsWith('/claim')) {
        return json({
          claimable: true,
          campaigns: [
            { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
            { campaignId: 'c2', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 50 } },
          ],
        })
      }
      return url.includes('/c2/') ? json({ status: 'FAILED', message: 'quota exhausted' }) : json({ status: 'CLAIMED' })
    })
    const outcome = await claimQoderCampaigns('cn', 'token-1')
    expect(outcome).toMatchObject({ status: 'claimed', credits: 100, claimed: 1 })
    // The total leads because the run succeeded, but c2's refusal has to survive
    // as its own field: the card renders the collected amount from `credits`, so a
    // refusal that lived only inside this sentence would never be shown.
    expect(outcome.message).toBe('签到成功 +100 Credits，共 1 项（1 项未领取：c2: quota exhausted）')
    expect(outcome.refused).toBe('1 项未领取：c2: quota exhausted')
  })

  it('reads a campaign list that is not claimable as a closed campaign', async () => {
    stubFetch(() => json({ claimable: false, campaigns: [] }))
    await expect(claimQoderCampaigns('cn', 'token-1')).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('fails when every claim was refused, naming the campaigns', async () => {
    stubFetch((url) => url.endsWith('/claim')
      ? json({ status: 'FAILED', message: 'quota exhausted' })
      : json({ claimable: true, campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }] }))
    await expect(claimQoderCampaigns('cn', 'token-1')).resolves.toMatchObject({ status: 'failed', message: '领取失败：c1: quota exhausted' })
  })

  it('surfaces a refused campaign list rather than an empty run', async () => {
    stubFetch(() => json({ message: 'nope' }, 401))
    await expect(readQoderCampaigns('cn', 'token-1')).rejects.toThrow(/HTTP 401/u)
  })
})
