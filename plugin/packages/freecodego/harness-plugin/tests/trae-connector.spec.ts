import { describe, expect, it } from 'vitest'
import {
  decodeTraeNickname,
  parseTraeCallback,
  traeAccountFromLogin,
  traeAccountId,
  traeExpiresAt,
} from '../src/trae/login.ts'
import { buildTraeLoginUrl, traeCallbackUrl, traeLoginTraceId } from '../src/trae/endpoints.ts'
import { parseTraeModels, selectableTraeModels } from '../src/trae/directory.ts'
import { parseTraeFrame, synthesizeTraeOpenAiSse, traeOpenAiFrames } from '../src/trae/bridge.ts'
import { traeModelRow } from '../src/trae-intl.ts'
import { TraeUpstreamError } from '../src/trae/errors.ts'
import { TRAE_CLIENT_ID, TRAE_CONSOLE_HOST } from '../src/trae/endpoints.ts'
import type { TraeSseEvent } from '../src/trae/bridge.ts'

/**
 * A redirect as the SOLO sign-in page produces it.
 *
 * The credential rides in two JSON query parameters, which is what makes the
 * pasted-callback path (a browser that never reaches loopback) a parse rather
 * than a regex over a bespoke format.
 */
function callbackUrl(input: {
  readonly userInfo?: Record<string, unknown>
  readonly userJwt?: Record<string, unknown>
  readonly refreshToken?: string
}): string {
  const params = new URLSearchParams()
  if (input.userInfo !== undefined) params.set('userInfo', JSON.stringify(input.userInfo))
  if (input.userJwt !== undefined) params.set('userJwt', JSON.stringify(input.userJwt))
  if (input.refreshToken !== undefined) params.set('refreshToken', input.refreshToken)
  return `http://127.0.0.1:41999/authorize?${params.toString()}`
}

describe('Trae sign-in redirect', () => {
  it('reads the credential, the identity, and the tenant out of the redirect', () => {
    const parsed = parseTraeCallback(callbackUrl({
      userInfo: { UserID: '8123', ScreenName: 'trae-user', TenantID: 'ent-9' },
      userJwt: { Token: 'access-1', RefreshToken: 'refresh-1', TokenExpireAt: 1_800_000_000_000 },
    }))
    expect(parsed).toMatchObject({
      uid: '8123',
      nickname: 'trae-user',
      enterpriseId: 'ent-9',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
    // A redirect with a refresh token is dated by the exchange that follows it,
    // so the page's own expiry is deliberately not carried into the account.
    expect(parsed.expiresAt).toBe(0)
  })

  it('accepts the path a user copies out of the address bar, and the degraded refresh-only redirect', () => {
    // No scheme: the browser may show the request line rather than a full URL.
    const fromPath = parseTraeCallback('/authorize?refreshToken=refresh-only')
    expect(fromPath.refreshToken).toBe('refresh-only')
    expect(fromPath.accessToken).toBeUndefined()
    // Nothing will exchange this one, so the jwt's stated expiry is the only
    // thing that can date the session — and a refresh token alone has no jwt.
    expect(fromPath.expiresAt).toBe(0)
  })

  it('refuses an empty paste and a link that carries no credential at all', () => {
    expect(() => parseTraeCallback('   ')).toThrow(/TRAE_LOGIN_CALLBACK_EMPTY/u)
    // The failure a user actually hits: they paste the page they were *on*, not
    // the address it landed on, and an account must not be created from it.
    expect(() => parseTraeCallback('https://www.trae.cn/authorization?login_trace_id=abc')).toThrow(/TRAE_LOGIN_CALLBACK_WITHOUT_CREDENTIAL/u)
  })
})

describe('Trae nickname repair', () => {
  it('recovers a name the redirect double-encoded, and leaves readable text alone', () => {
    // `张三` percent-encoded twice arrives as the utf8 bytes read as latin1.
    const mangled = Buffer.from('张三', 'utf8').toString('latin1')
    expect(mangled).not.toBe('张三')
    expect(decodeTraeNickname(mangled)).toBe('张三')
    expect(decodeTraeNickname('trae-user')).toBe('trae-user')
    expect(decodeTraeNickname('  ')).toBeUndefined()
  })

  it('answers nothing rather than mojibake when a name cannot be trusted', () => {
    // Valid UTF-8 that is not already a name: repairing it invents characters, and
    // the caller falls back to the uid, which is always printable.
    expect(decodeTraeNickname('ÐÐ¾Ð²')).toBeUndefined()
  })
})

describe('Trae token expiry', () => {
  const now = 1_800_000_000_000

  it('tells milliseconds from seconds by magnitude', () => {
    expect(traeExpiresAt(1_900_000_000_000, 0, now)).toBe(1_900_000_000)
    expect(traeExpiresAt(1_900_000_000, 0, now)).toBe(1_900_000_000)
  })

  it('falls back to the stated duration when the expiry is stale or absent', () => {
    expect(traeExpiresAt(1_000, 3_600, now)).toBe(Math.floor(now / 1000) + 3_600)
    expect(traeExpiresAt(0, 3_600, now)).toBe(Math.floor(now / 1000) + 3_600)
    expect(traeExpiresAt(0, 0, now)).toBe(0)
  })
})

describe('Trae account identity', () => {
  it('keys an account by its uid so re-authorizing replaces its row', () => {
    const identity = { machineId: 'a'.repeat(32), deviceId: 'b'.repeat(32) }
    const token = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_900_000_000 }
    const first = traeAccountFromLogin({ uid: '8123', refreshToken: 'r1', expiresAt: 0 }, identity, token, 'cn', 1_800_000_000_000)
    const again = traeAccountFromLogin({ uid: '8123', refreshToken: 'r2', expiresAt: 0 }, identity, { ...token, accessToken: 'access-2' }, 'cn', 1_800_000_100_000)
    expect(first.id).toBe(again.id)
    expect(again.accessToken).toBe('access-2')
    // The machine identity is carried, because the conversation endpoint reads it
    // as headers and a session presented under another device is not the one the
    // user approved.
    expect(again.machineId).toBe(identity.machineId)
    expect(again.deviceId).toBe(identity.deviceId)
  })

  it('falls back to a seed-derived id when the redirect carried no usable uid', () => {
    expect(traeAccountId('', 'access-1')).toBe('trae-access-1')
    expect(traeAccountId('  ', 'access-token-2')).toBe('trae-cess-token-2')
    expect(traeAccountId('8123', 'access-1')).toBe('8123')
  })
})

describe('Trae model directory', () => {
  it('names each configuration and drops the rows that cannot be asked for', () => {
    const models = parseTraeModels({
      config_info_list: [
        { config_name: 'solo-lite', display_config: { display_name: 'SOLO Lite' } },
        { config_name: 'solo-auto', display_config: { display_name: 'Auto' } },
        { config_name: 'solo-lite', display_config: { display_name: 'SOLO Lite' } },
        { config_name: '', display_config: { display_name: 'nameless' } },
        { config_name: 'solo-bare' },
      ],
    })
    // Sorted by what the picker shows, deduplicated, and a configuration without
    // a display name is listed under its own id rather than dropped.
    expect(models.map(model => model.displayName)).toEqual(['Auto', 'SOLO Lite', 'solo-bare'])
    expect(models.map(model => model.id)).toEqual(['solo-auto', 'solo-lite', 'solo-bare'])
  })

  it('answers an empty directory for a document it cannot read', () => {
    expect(parseTraeModels(undefined)).toEqual([])
    expect(parseTraeModels({ config_info_list: 'nope' })).toEqual([])
  })

  it('keeps the internal rows out of the picker without losing them from the parse', () => {
    // Shaped like the measured table (44 rows), which is where these rules come
    // from: the sub-agent and alias rows carry the upstream's own visibility flag,
    // the `custom_model_*` rows are the IDE's BYOK slots, and the ones with no
    // display name are internal ids the product never shows a user.
    const models = parseTraeModels({
      config_info_list: [
        { config_name: 'glm-5.3', display_config: { display_name: 'GLM-5.3', model_capability: 'reasoning_model' } },
        { config_name: 'browser_use_subagent', is_invisible_to_user: true, display_config: { display_name: 'browser_use_subagent', model_capability: 'reasoning_model' } },
        { config_name: 'glm-5', is_invisible_to_user: true, display_config: { display_name: 'GLM-5', model_capability: 'reasoning_model' } },
        { config_name: 'custom_model_gemini', custom_models: ['gemini//gemini-3-flash'], display_config: { display_name: 'Gemini-3.1-Pro-Preview', model_capability: 'reasoning_model' } },
        { config_name: 'custom_model_1M', custom_models: ['x//y'], display_config: { display_name: '', model_capability: 'reasoning_model' } },
        { config_name: 'custom_model_placeholder', display_config: { display_name: '', model_capability: 'reasoning_model' } },
        { config_name: 'summary', display_config: { display_name: 'summary' } },
      ],
    })
    expect(selectableTraeModels(models).map(model => model.id)).toEqual(['glm-5.3'])
    // The parse keeps every row: routing answers "which realm serves this name" for
    // a session stored before the filter existed too, and a hidden row's realm is
    // still worth knowing when one is asked for by name.
    expect(models.map(model => model.id)).toContain('glm-5')
    expect(models.find(model => model.id === 'summary')?.selectable).toBe(false)
  })

  it('publishes the limits the adapter enforces, not limits it invented for the picker', () => {
    // The numbers are the adapter's own constants (module-private, because the
    // column is published from one place); spelled here so a change to them has
    // to be a deliberate change to the panel's promise as well.
    expect(traeModelRow({ id: 'solo-auto', displayName: 'Auto', selectable: true })).toEqual({
      id: 'solo-auto',
      name: 'Auto',
      // The row carries its realm: the picker has one list across both
      // deployments and a name is only routable through the realm that listed it.
      realm: 'cn',
      contextWindow: 128_000,
      maxTokens: 16_384,
    })
    expect(traeModelRow({ id: 'solo-auto', displayName: 'Auto', selectable: true }, 'sg').realm).toBe('sg')
  })
})

describe('Trae authorization URL', () => {
  it('sends the browser back to the loopback listener with this attempt identity', () => {
    const identity = { machineId: '1'.repeat(32), deviceId: '2'.repeat(32) }
    const callback = traeCallbackUrl(41999)
    const url = new URL(buildTraeLoginUrl(identity, callback))
    expect(url.origin).toBe(TRAE_CONSOLE_HOST)
    expect(url.searchParams.get('auth_callback_url')).toBe('http://127.0.0.1:41999/authorize')
    expect(url.searchParams.get('client_id')).toBe(TRAE_CLIENT_ID)
    // The trace id the page echoes back into the issued session must be stable
    // between the URL and the callback it produces.
    expect(url.searchParams.get('login_trace_id')).toBe(traeLoginTraceId(identity))
    expect(url.searchParams.get('login_trace_id')).toHaveLength(16)
  })
})

/** The payload of a mapped frame, refusing the two shapes the mapping must not produce. */
function openAiPayload(frame: string | undefined): { readonly choices: readonly { readonly delta?: Record<string, unknown>; readonly finish_reason?: string }[]; readonly usage?: Record<string, number> } & Record<string, unknown> {
  if (frame === undefined) throw new Error('the mapping produced no frame')
  expect(frame.startsWith('data: ')).toBe(true)
  expect(frame.endsWith('\n\n')).toBe(true)
  return JSON.parse(frame.replace(/^data: /u, '').trim()) as never
}

describe('Trae SOLO frames', () => {
  it('maps the upstream frames onto the OpenAI stream the shared reader consumes', () => {
    const delta = parseTraeFrame({ event: 'output', data: JSON.stringify({ response: 'hi', reasoning_content: 'why' }) })
    expect(delta).toMatchObject({ kind: 'delta', content: 'hi', reasoning: 'why' })
    const deltaFrames = traeOpenAiFrames(delta as never)
    expect(deltaFrames).toHaveLength(1)
    expect(openAiPayload(deltaFrames[0]).choices[0]?.delta).toEqual({ content: 'hi', reasoning_content: 'why' })

    // Usage rides in its own frame: a usage chunk that shared a frame with
    // content would be dropped by the reader.
    const usage = parseTraeFrame({ event: 'token_usage', data: JSON.stringify({ prompt_tokens: 7, completion_tokens: 3 }) })
    expect(usage).toMatchObject({ kind: 'usage', inputTokens: 7, outputTokens: 3 })
    const usageFrames = traeOpenAiFrames(usage as never)
    expect(usageFrames).toHaveLength(1)
    expect(openAiPayload(usageFrames[0]).usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 })

    const done = parseTraeFrame({ event: 'done', data: JSON.stringify({ finish_reason: 'stop' }) })
    expect(done).toMatchObject({ kind: 'done', finishReason: 'stop' })
  })

  it('ignores the frames that carry nothing and reports a mid-stream failure as one', () => {
    expect(parseTraeFrame({ event: 'output', data: '' })).toBeUndefined()
    expect(parseTraeFrame({ event: 'output', data: 'not json' })).toBeUndefined()
    expect(parseTraeFrame({ event: 'keepalive', data: '{}' })).toBeUndefined()
    // The transport accepted the turn, so the refusal is reported under the
    // status a refusal would have carried, with the business code kept: the pool
    // classifies `4008`/`4011` to decide whether another account should try.
    try {
      parseTraeFrame({ event: 'error', data: JSON.stringify({ code: 4008, message: 'quota exhausted' }) })
      throw new Error('expected the error frame to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TraeUpstreamError)
      expect((error as TraeUpstreamError).status).toBe(502)
      expect((error as TraeUpstreamError).code).toBe(4008)
    }
  })

  it('ends the synthesized stream at the done frame', async () => {
    const events: readonly TraeSseEvent[] = [
      { event: 'output', data: JSON.stringify({ response: 'he' }) },
      { event: 'output', data: JSON.stringify({ response: 'llo' }) },
      { event: 'done', data: JSON.stringify({ finish_reason: 'stop' }) },
      // Anything after the done frame is not this turn's answer.
      { event: 'output', data: JSON.stringify({ response: 'never' }) },
    ]
    const stream = synthesizeTraeOpenAiSse((async function* generate(): AsyncGenerator<TraeSseEvent> {
      for (const event of events) yield event
    })())
    const text = await new Response(stream).text()
    expect(text).toContain('"content":"he"')
    expect(text).toContain('"content":"llo"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).not.toContain('never')
  })
})
