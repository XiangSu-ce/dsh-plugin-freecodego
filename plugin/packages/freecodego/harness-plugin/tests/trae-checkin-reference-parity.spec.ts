import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTraeCheckinStatus } from '../src/trae/checkin.ts'
import { traeAhaDeviceId } from '../src/trae/device.ts'
import { TRAE_CHECKIN_STATUS_URL, TRAE_IDE_VERSION } from '../src/trae/endpoints.ts'
import type { TraeAccount } from '../src/trae/types.ts'
import { changedReferenceSources, headerReport, type ReferenceSource } from './support/reference-parity.ts'

/**
 * Header-for-header parity with the reference TRAE check-in.
 *
 * Why this exists
 * ---------------
 * Two implementations claim the same daily credit, and they do not send the same
 * request. `dsh-our-free-model`'s `vendor/channel-pack/src/trae-credits.ts` signs
 * its claim with `traeCheckinHeaders` — a *marketplace client's* identity
 * (`X-Market-Client-Id`, `X-Market-User-Id`, `Vscode-Sessionid`, `X-Tt-Trace-Id`,
 * `Package-Type`, the `X-Lscbd-*` pair) with every value derived from the
 * account's own user id — while this plugin has been presenting the IDE protocol's
 * own header family instead, with two headers of its own that the reference client
 * never sends and a device number of its own choosing.
 *
 * That difference is invisible in behaviour until the risk control decides it
 * matters (`9074`, which is a refusal of the *device*, not of the request), which
 * is exactly the class of difference this spec exists to make visible. The
 * reference's set is transcribed here once, with the lines it came from, and what
 * this plugin actually sends is measured against it.
 *
 * The transcription is pinned to the reference revision it was read from
 * ({@link REFERENCE_SOURCES}); when that checkout is present, a digest mismatch
 * fails the spec and says to re-read the source rather than quietly comparing
 * against a file that has since changed.
 */

/** Where the reference implementation lives, and the bytes this spec was read from. */
const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  {
    path: 'C:/Users/Administrator/Downloads/dsh-our-free-model-main/vendor/channel-pack/src/trae.ts',
    sha256: 'db34e23b129bf85db24fcb7394278650c7dae846062af7f2a2cb9a75d740b1f0',
    what: 'traeCheckinHeaders and the seeded derivations behind X-Market-User-Id / Vscode-Sessionid',
  },
  {
    path: 'C:/Users/Administrator/Downloads/dsh-our-free-model-main/vendor/channel-pack/src/trae-credits.ts',
    sha256: '8cd67b4b4b72245e27bc6e9a9e072814ed237d6dfe24d65f9293c7a9547c3f52',
    what: 'which header set the check-in POST carries, and the endpoint it carries it to',
  },
]

/**
 * The check-in header set the reference sends, field for field.
 *
 * Transcribed from `trae.ts` `traeCheckinHeaders` (`:281`–`:310`), which
 * `trae-credits.ts` (`:156`) puts on every `POST /trae/api/v2/ug/checkin_credits/*`
 * to `https://api.trae.cn`. The two derived values are the reference's own
 * `deriveMarketUserId` (`:331`) and `deriveSessionId` (`:342`) evaluated on the
 * account's user id — pinned as literals rather than recomputed here, so that a
 * change of salt or algorithm on either side is a failure rather than a match.
 */
const REFERENCE_CHECKIN_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  accept: '*/*',
  'accept-encoding': 'gzip, deflate',
  'accept-language': 'zh-CN',
  authorization: 'Cloud-IDE-JWT access-1',
  // The reference states its product's IDE build here. For this connector that is
  // the realm's declared build, which is also what `x-ide-version` carries — see
  // the test below, which is where the two are held together.
  'app-version': TRAE_IDE_VERSION,
  'x-market-client-id': 'VSCode 1.107.1',
  'x-market-user-id': '3c7de0b9-c35b-44cd-a458-82d925ea0db0',
  'x-user-region': 'CN',
  'x-lgw-req-sdk-type': '3',
  'package-type': 'stable_cn',
  'x-lscbd-aid': '787976',
  'x-lscbd-platform': 'windows',
  'vscode-sessionid': '7c7f3160b45d2e197e46d362af2fbb11910c4964325b38d2bf1d639441c29884',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-site': 'none',
}

/** The names both sides mint per request, compared by shape rather than by value. */
const REFERENCE_PER_REQUEST_HEADERS: Readonly<Record<string, RegExp>> = {
  'x-request-id': /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  'x-tt-trace-id': /^00-[0-9a-f]{32}-01$/u,
}

/**
 * The three fields this plugin answers differently on purpose.
 *
 * A divergence is recorded rather than tolerated: the test below asserts the
 * values, so changing one — in either direction — is a failure that has to be
 * argued for here rather than a silent drift. Each carries the reason it is not
 * the reference's value.
 */
const RECORDED_DIVERGENCES: Readonly<Record<string, string>> = {
  // The reference presents a marketplace client's User-Agent. This plugin
  // presents the declared IDE build, which is the same string the conversation
  // path signs with and the value the upstream keys model availability on
  // (`trae/endpoints.ts`: "the declared IDE build is not cosmetic").
  'user-agent': `Trae/${TRAE_IDE_VERSION}`,
  // Ours states the one media type it accepts; the reference states `*/*`.
  accept: 'application/json',
}

/**
 * The IDE-protocol family this plugin sends beside the reference's client set.
 *
 * These are not extras to be pruned: the two token spellings and the app/IDE build
 * headers are what the upstream's own IDE channel reads, and they are what this
 * plugin's conversation path already signs with. They are listed so that *adding*
 * one is a visible change — an unlisted extra fails the comparison below.
 */
const PLUGIN_ONLY_HEADERS = [
  'x-cloudide-token', 'x-ide-token', 'x-uid',
  'x-app-id', 'x-app-version', 'x-app-version-code', 'x-ide-version', 'x-ide-version-code', 'x-ide-version-type',
  'x-device-type', 'x-os-version', 'x-device-brand', 'request-traffic-type', 'x-machine-id',
] as const

/** The names both sides mint per request, this plugin's own included. */
const PLUGIN_PER_REQUEST_HEADERS = ['x-custom-trace-id', 'x-flow-traceparent'] as const

/** The account the comparison runs as, with `uid` as the reference derives from. */
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

/** The `APPDATA` this process started with, so a scratch directory is undone. */
const REAL_APPDATA = process.env.APPDATA

afterEach(() => {
  vi.unstubAllGlobals()
  if (REAL_APPDATA === undefined) delete process.env.APPDATA
  else process.env.APPDATA = REAL_APPDATA
})

/**
 * Run one real check-in status read and hand back the request it posted.
 *
 * The client-device lookup is pointed at an empty directory, so the number under
 * test is this plugin's own derivation rather than whatever the developer's
 * machine happens to have registered — the same isolation
 * `provider-checkin.spec.ts` uses, and the reason the device divergence below is
 * a comparison of policies rather than of machines.
 * @returns the headers the read sent.
 */
async function postedStatusRead(): Promise<Record<string, string>> {
  process.env.APPDATA = mkdtempSync(join(tmpdir(), 'trae-parity-'))
  let headers: Record<string, string> | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) === TRAE_CHECKIN_STATUS_URL) {
      headers = Object.fromEntries(new Headers(init?.headers).entries())
    }
    return new Response(JSON.stringify({ code: 0, enable: true, checked_in: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  await readTraeCheckinStatus(account)
  if (headers === undefined) throw new Error('the check-in status read posted no request')
  return headers
}

describe('TRAE check-in reference parity', () => {
  it('sends every header the reference check-in sends, with the same value', async () => {
    const sent = await postedStatusRead()
    const report = headerReport(sent, REFERENCE_CHECKIN_HEADERS, Object.keys(REFERENCE_PER_REQUEST_HEADERS), Object.keys(RECORDED_DIVERGENCES))
    // `TRAE_PARITY_REPORT=1` prints the whole side-by-side, for a reader who wants
    // the picture rather than a verdict.
    if (process.env.TRAE_PARITY_REPORT === '1') console.log(`\nTRAE check-in identity, this plugin vs the reference:\n${report}`)
    // The report is the failure message: a diff a reader can act on, not "false".
    for (const [name, value] of Object.entries(REFERENCE_CHECKIN_HEADERS)) {
      if (name in RECORDED_DIVERGENCES) continue
      expect(sent[name], `${name}\n${report}`).toBe(value)
    }
    for (const [name, shape] of Object.entries(REFERENCE_PER_REQUEST_HEADERS)) {
      expect(sent[name], `${name}\n${report}`).toMatch(shape)
    }
  })

  it('derives the market identity and the session from the account, as the reference derives them', async () => {
    const sent = await postedStatusRead()
    // The reference's own derivation, evaluated on this account's user id. A
    // different salt, a different seed, or a random value all fail here.
    expect(sent['x-market-user-id']).toBe('3c7de0b9-c35b-44cd-a458-82d925ea0db0')
    expect(sent['vscode-sessionid']).toBe('7c7f3160b45d2e197e46d362af2fbb11910c4964325b38d2bf1d639441c29884')
    // Stable for one account across requests: the identity is the account's, not
    // the request's, which is what lets the risk control remember it.
    const second = await postedStatusRead()
    expect(second['x-market-user-id']).toBe(sent['x-market-user-id'])
    expect(second['vscode-sessionid']).toBe(sent['vscode-sessionid'])
    // And per request, the two trace ids are not reused between calls.
    expect(second['x-request-id']).not.toBe(sent['x-request-id'])
    expect(second['x-tt-trace-id']).not.toBe(sent['x-tt-trace-id'])
  })

  it('states one build for the marketplace and the IDE headers alike', async () => {
    const sent = await postedStatusRead()
    // Asserting the imported constant rather than a literal is deliberate: the
    // durable fact is that the marketplace header and the IDE header name the
    // *same* build, so a change of the realm's declared build moves both or
    // fails here.
    expect(sent['app-version']).toBe(TRAE_IDE_VERSION)
    expect(sent['x-ide-version']).toBe(TRAE_IDE_VERSION)
  })

  it('answers the three recorded divergences with the values recorded here', async () => {
    const sent = await postedStatusRead()
    for (const [name, value] of Object.entries(RECORDED_DIVERGENCES)) {
      expect(sent[name], name).toBe(value)
    }
    // The device number is the fourth, and it is a policy rather than a string:
    // the reference derives 15 digits from the user id, while this plugin presents
    // the number the official client registered on this machine when there is one,
    // and a 16-digit derivation when there is not — see `trae/device.ts` for the
    // measurement that made that the order. With no client storage present, the
    // derivation is the one under test.
    expect(sent['x-device-id']).toMatch(/^[1-9]\d{15}$/u)
    expect(sent['x-device-id']).toBe(traeAhaDeviceId(account.deviceId))
  })

  it('lists exactly the headers it sends beyond the reference, and no others', async () => {
    const sent = await postedStatusRead()
    const recorded = [
      ...Object.keys(REFERENCE_CHECKIN_HEADERS),
      ...Object.keys(REFERENCE_PER_REQUEST_HEADERS),
      ...Object.keys(RECORDED_DIVERGENCES),
      'x-device-id',
      ...PLUGIN_ONLY_HEADERS,
      ...PLUGIN_PER_REQUEST_HEADERS,
    ]
    const extra = Object.keys(sent).filter(name => !recorded.includes(name))
    // Anything here is a header neither the reference nor the recorded lists name:
    // a new one has to be recorded (and explained) where it is added.
    expect(extra, `unrecorded extra headers:\n${headerReport(sent, REFERENCE_CHECKIN_HEADERS)}`).toEqual([])
  })

  it.skipIf(!REFERENCE_SOURCES.every(source => existsSync(source.path)))('compares against the reference revision this spec was read from', () => {
    expect(changedReferenceSources(REFERENCE_SOURCES)).toEqual([])
  })
})
