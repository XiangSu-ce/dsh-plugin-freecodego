/**
 * The settings card's two ends: what the microphone would use, and the write that
 * changes it.
 *
 * Three facts carry this module, and each is asserted rather than described:
 *
 * 1. **The projection never carries the key.** The route does, and it crosses the
 *    Remote boundary here — so `hasKey` is the whole of what a browser learns, and a
 *    key that leaked into the projection would be a secret in the settings page's own
 *    state, its React tree, and every bug report that copied it.
 * 2. **The route is answered before a key exists.** The card's first job is to show
 *    where transcription *would* go, so an empty vault has to describe the built-in
 *    Groq endpoint rather than nothing at all.
 * 3. **A refused field writes nothing.** The three inputs are one route; a patch that
 *    stored the endpoint and then rejected the model would leave a route nobody
 *    composed, and the error would name a field whose value was actually kept.
 *
 * The write also re-decides the registration (`refresh`), which is what makes storing
 * a key the same gesture as enabling the feature — the roster learns about it from
 * that call and nowhere else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GROQ_WHISPER_API_KEY_REF, GROQ_WHISPER_BASE_URL_REF, GROQ_WHISPER_MODEL_REF } from '../src/managed-catalog-utils.ts'
import { speechEndpoint, speechModelId } from '../src/managed-catalogs.ts'
import { probeWave, speechSetRoute, speechStatus, speechTest, type SpeechRouteHost } from '../src/speech-route.ts'

/**
 * The name a credential slot is filed under.
 *
 * `credentialRef` is a branded string, so this is branding removal rather than
 * decoding — a vault double keys its slots by the same name the real vault does.
 */
function refName(ref: unknown): string {
  return String(ref)
}

/**
 * A vault and a catalog runtime that read each other, which is the shape the real
 * pair has: the catalog resolves the route out of the slots the card wrote.
 *
 * Simulating the resolution instead of stubbing a fixed route is what lets one test
 * assert the *effect* of a write — store an endpoint, then read the route back — which
 * is the only way the defaults-versus-custom half of the projection is testable at all.
 */
function hostDouble(options: {
  readonly stored?: ReadonlyMap<string, string>
  readonly enabled?: boolean
  readonly registered?: boolean
  readonly selected?: string
} = {}): { readonly host: SpeechRouteHost; readonly slots: Map<string, string>; readonly refreshes: () => number } {
  const slots = new Map<string, string>(options.stored ?? [])
  let refreshes = 0
  const host: SpeechRouteHost = {
    credentials: {
      set: async (ref: unknown, value: string) => { slots.set(refName(ref), value) },
      unset: async (ref: unknown) => { slots.delete(refName(ref)) },
    } as never,
    catalogs: {
      groqWhisperRoute: async () => {
        const baseUrl = speechEndpoint(slots.get(refName(GROQ_WHISPER_BASE_URL_REF))) ?? 'https://api.groq.com/openai/v1'
        const model = speechModelId(slots.get(refName(GROQ_WHISPER_MODEL_REF))) ?? 'whisper-large-v3-turbo'
        return {
          baseUrl,
          model,
          apiKey: slots.get(refName(GROQ_WHISPER_API_KEY_REF)),
          custom: baseUrl !== 'https://api.groq.com/openai/v1' || model !== 'whisper-large-v3-turbo',
        }
      },
    } as never,
    voiceInputEnabled: () => options.enabled ?? true,
    registered: () => options.registered ?? true,
    selected: () => options.selected ?? 'freecodego',
    refresh: async () => { refreshes += 1 },
  }
  return { host, slots, refreshes: () => refreshes }
}

const withKey = new Map([[refName(GROQ_WHISPER_API_KEY_REF), 'gsk_test']])

describe('the route the settings card describes', () => {
  it('describes the built-in Groq endpoint before any key exists', async () => {
    const { host } = hostDouble()
    const status = await speechStatus(host)
    expect(status.hasKey).toBe(false)
    expect(status.baseUrl).toBe('https://api.groq.com/openai/v1')
    expect(status.model).toBe('whisper-large-v3-turbo')
    expect(status.custom).toBe(false)
  })

  it('never carries the key, only the fact that one resolves', async () => {
    const { host } = hostDouble({ stored: withKey })
    const status = await speechStatus(host)
    expect(status.hasKey).toBe(true)
    // The projection is spread into a Remote result, so anything on it is public.
    expect(JSON.stringify(status)).not.toContain('gsk_test')
  })

  it('reports the Harness\'s own registration and selection, not this plugin\'s opinion', async () => {
    const { host } = hostDouble({ stored: withKey, registered: true, selected: 'sensevoice-local' })
    const status = await speechStatus(host)
    expect(status.registered).toBe(true)
    expect(status.selected).toBe('sensevoice-local')
    const off = hostDouble({ stored: withKey, enabled: false })
    expect((await speechStatus(off.host)).enabled).toBe(false)
  })

  it('marks a stored endpoint or model as custom, so the card cannot describe the wrong route', async () => {
    const stored = new Map(withKey)
    stored.set(refName(GROQ_WHISPER_BASE_URL_REF), 'https://asr.example.com/v1')
    const { host } = hostDouble({ stored })
    const status = await speechStatus(host)
    expect(status.custom).toBe(true)
    expect(status.baseUrl).toBe('https://asr.example.com/v1')
    expect(status.model).toBe('whisper-large-v3-turbo')
  })
})

describe('one write for one route', () => {
  it('stores all three fields and re-decides the registration once', async () => {
    const { host, slots, refreshes } = hostDouble({ stored: withKey })
    const status = await speechSetRoute(host, {
      baseUrl: 'https://asr.example.com/v1/',
      model: 'sensevoice-small',
      apiKey: 'other-key',
    })
    // The trailing slash is dropped, because `${baseUrl}/audio/transcriptions` is the
    // request and a doubled slash is a 404 at some endpoints.
    expect(slots.get(refName(GROQ_WHISPER_BASE_URL_REF))).toBe('https://asr.example.com/v1')
    expect(slots.get(refName(GROQ_WHISPER_MODEL_REF))).toBe('sensevoice-small')
    expect(slots.get(refName(GROQ_WHISPER_API_KEY_REF))).toBe('other-key')
    expect(status.baseUrl).toBe('https://asr.example.com/v1')
    expect(status.custom).toBe(true)
    // Once, at the end: this is what moves the roster and the selection with the write.
    expect(refreshes()).toBe(1)
  })

  it('leaves fields the card did not touch alone', async () => {
    const stored = new Map(withKey)
    stored.set(refName(GROQ_WHISPER_MODEL_REF), 'sensevoice-small')
    const { host, slots } = hostDouble({ stored })
    await speechSetRoute(host, { apiKey: 'rotated-key' })
    expect(slots.get(refName(GROQ_WHISPER_MODEL_REF))).toBe('sensevoice-small')
    expect(slots.get(refName(GROQ_WHISPER_API_KEY_REF))).toBe('rotated-key')
  })

  it('restores the defaults from an empty string, and clears the key', async () => {
    const stored = new Map(withKey)
    stored.set(refName(GROQ_WHISPER_BASE_URL_REF), 'https://asr.example.com/v1')
    stored.set(refName(GROQ_WHISPER_MODEL_REF), 'sensevoice-small')
    const { host, slots } = hostDouble({ stored })
    const status = await speechSetRoute(host, { baseUrl: '', model: '', apiKey: '' })
    expect(slots.has(refName(GROQ_WHISPER_BASE_URL_REF))).toBe(false)
    expect(slots.has(refName(GROQ_WHISPER_MODEL_REF))).toBe(false)
    expect(slots.has(refName(GROQ_WHISPER_API_KEY_REF))).toBe(false)
    expect(status.baseUrl).toBe('https://api.groq.com/openai/v1')
    expect(status.hasKey).toBe(false)
  })

  it('refuses a malformed field without writing any of the three', async () => {
    const { host, slots, refreshes } = hostDouble({ stored: withKey })
    await expect(speechSetRoute(host, { baseUrl: 'asr.example.com/v1', model: 'ok-model', apiKey: 'ok-key' })).rejects.toThrow(/http\(s\) URL/u)
    expect(slots.get(refName(GROQ_WHISPER_BASE_URL_REF))).toBeUndefined()
    expect(slots.get(refName(GROQ_WHISPER_MODEL_REF))).toBeUndefined()
    expect(slots.get(refName(GROQ_WHISPER_API_KEY_REF))).toBe('gsk_test')
    // A refused write changes nothing, so it must not move the registration either.
    expect(refreshes()).toBe(0)

    await expect(speechSetRoute(host, { model: 'bad model!' })).rejects.toThrow(/model id/u)
    await expect(speechSetRoute(host, { apiKey: 'line\nbreak' })).rejects.toThrow(/invalid characters/u)
    expect(refreshes()).toBe(0)
  })

  it('refuses the whole write when the vault is not mounted', async () => {
    const { host } = hostDouble({ stored: withKey })
    const unmounted: SpeechRouteHost = { ...host, credentials: undefined }
    await expect(speechSetRoute(unmounted, { apiKey: 'x' })).rejects.toThrow(/Credential provider is not configured/u)
  })

  it('reports a failed refresh to the caller rather than pretending the write landed', async () => {
    const { host } = hostDouble({ stored: withKey })
    const failing: SpeechRouteHost = { ...host, refresh: async () => { throw new Error('registry is shutting down') } }
    await expect(speechSetRoute(failing, { apiKey: 'x' })).rejects.toThrow(/registry is shutting down/u)
  })
})

describe('the endpoint and model ids this module accepts', () => {
  it('accepts the addresses a recognizer is actually served at', () => {
    expect(speechEndpoint('https://api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai/v1')
    // The one legitimate non-TLS case: a recognizer on this machine or the LAN.
    expect(speechEndpoint('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1')
    expect(speechEndpoint('  https://asr.internal/v1  ')).toBe('https://asr.internal/v1')
  })

  it('rejects what is not an address', () => {
    for (const value of ['asr.example.com/v1', 'javascript:alert(1)', 'https://', 'ftp://asr/v1', '/v1', 'https://a b/v1']) {
      expect(speechEndpoint(value), value).toBeUndefined()
    }
  })

  it('keeps model ids a syntax check, not a vocabulary', () => {
    for (const value of ['whisper-large-v3-turbo', 'openai/whisper-1', 'sensevoice-small:free', 'Qwen3-ASR']) {
      expect(speechModelId(value), value).toBe(value)
    }
    for (const value of ['', '   ', '-leading', 'has space', 'x'.repeat(121)]) {
      expect(speechModelId(value), value).toBeUndefined()
    }
  })
})

describe('the connection test the card runs on demand', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /**
   * Answer every request the probe makes, and record what it asked for.
   *
   * The request is captured rather than ignored because the point of this remote is
   * that it *sends* something: a test that only stubbed the response would pass for an
   * implementation that never left the process, which is the exact failure mode the
   * probe exists to rule out.
   */
  function responder(status: number, body: string): { readonly calls: () => { url: string; authorization: string | undefined; model: string | undefined; audio: Blob | undefined }[] } {
    const calls: { url: string; authorization: string | undefined; model: string | undefined; audio: Blob | undefined }[] = []
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: FormData }) => {
      calls.push({
        url: String(url),
        authorization: init.headers.authorization,
        model: init.body.get('model') === null ? undefined : String(init.body.get('model')),
        audio: init.body.get('file') instanceof Blob ? init.body.get('file') as Blob : undefined,
      })
      return new Response(body, { status })
    })
    return { calls: () => calls }
  }

  it('posts a real recording through the stored route, key and model included', async () => {
    const stored = new Map(withKey)
    stored.set(refName(GROQ_WHISPER_BASE_URL_REF), 'https://asr.example.com/v1')
    stored.set(refName(GROQ_WHISPER_MODEL_REF), 'sensevoice-small')
    const responderDouble = responder(200, '{"text":""}')
    const result = await speechTest(hostDouble({ stored }).host)
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('ok')
    expect(result.baseUrl).toBe('https://asr.example.com/v1')
    expect(result.model).toBe('sensevoice-small')
    const call = responderDouble.calls()[0]
    expect(call?.url).toBe('https://asr.example.com/v1/audio/transcriptions')
    expect(call?.authorization).toBe('Bearer gsk_test')
    expect(call?.model).toBe('sensevoice-small')
    // A real audio file, not an empty part: 0.5 s of 16 kHz mono PCM16 plus its header.
    expect(call?.audio?.size).toBe(44 + 16_000 / 2 * 2)
    expect(call?.audio?.type).toBe('audio/wav')
  })

  it('names each refusal separately, because each has a different fix', async () => {
    const cases = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [500, 'provider-error'],
    ] as const
    for (const [status, reason] of cases) {
      responder(status, `{"error":{"message":"upstream said ${String(status)}"}}`)
      const result = await speechTest(hostDouble({ stored: withKey }).host)
      expect(result.ok, String(status)).toBe(false)
      expect(result.reason, String(status)).toBe(reason)
      expect(result.status, String(status)).toBe(status)
      expect(result.detail, String(status)).toContain(String(status))
      vi.unstubAllGlobals()
    }
  })

  it('separates a refused route from an unreachable one', async () => {
    // The distinction a user cannot make from the microphone: both leave dictation
    // silent, and only one of them is fixed by editing the key.
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed') })
    const result = await speechTest(hostDouble({ stored: withKey }).host)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unreachable')
    expect(result.status).toBeUndefined()
    expect(result.detail).toContain('fetch failed')
  })

  it('answers about a missing key without sending anything', async () => {
    const responderDouble = responder(200, '{"text":""}')
    const result = await speechTest(hostDouble().host)
    expect(result.reason).toBe('unauthorized')
    expect(responderDouble.calls()).toHaveLength(0)
  })

  it('never lets an upstream body carry a credential into the card', async () => {
    // A gateway that echoes the request it rejected would otherwise put the live key
    // into the settings page and into any transcript of it.
    // A full-length Groq shape, because the rule is a length and a prefix: this is
    // the fixture that would leak if the shape were unknown, not a short placeholder.
    const echoed = `gsk_${'a'.repeat(52)}`
    responder(403, `{"error":"invalid key ${echoed}"}`)
    const result = await speechTest(hostDouble({ stored: withKey }).host)
    // The surrounding prose proves this is the same body the endpoint sent, so the
    // absence of the key is the masking rather than a fixture that never carried it.
    expect(result.detail).toContain('invalid key')
    expect(result.detail).not.toContain(echoed)
    expect(result.detail).toContain('[redacted credential]')
  })

  it('bounds what a provider may make the card render', async () => {
    responder(500, 'x'.repeat(5_000))
    const result = await speechTest(hostDouble({ stored: withKey }).host)
    expect(result.detail.length).toBe(300)
  })
})

describe('the probe recording', () => {
  it('is a canonical 16 kHz mono PCM16 WAV of the requested length', () => {
    const bytes = Buffer.from(probeWave())
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE')
    expect(bytes.subarray(36, 40).toString()).toBe('data')
    expect(bytes.readUInt16LE(22)).toBe(1)
    expect(bytes.readUInt32LE(24)).toBe(16_000)
    expect(bytes.readUInt16LE(34)).toBe(16)
    // Half a second by default: enough for a provider's own validation, cheap enough
    // that one click is not a recording anybody pays attention to.
    expect(bytes.readUInt32LE(40)).toBe(16_000)
    expect(bytes.length).toBe(44 + 16_000)
    expect(bytes.subarray(44).every(byte => byte === 0)).toBe(true)
    expect(Buffer.from(probeWave(2)).readUInt32LE(40)).toBe(16_000 * 2 * 2)
  })
})

describe('a stored value that no longer parses', () => {
  it('falls back to the built-in route instead of refusing to dictate', async () => {
    // The value is user input kept across upgrades, so it can go stale under a rule
    // that tightened later. A route that answers with a provider error is more useful
    // than a microphone that will not start — and the fallback is visible, because
    // `custom` is computed against the route actually in force.
    const stored = new Map(withKey)
    stored.set(refName(GROQ_WHISPER_BASE_URL_REF), 'asr.example.com/v1')
    stored.set(refName(GROQ_WHISPER_MODEL_REF), 'bad model')
    const { host } = hostDouble({ stored })
    const status = await speechStatus(host)
    expect(status.baseUrl).toBe('https://api.groq.com/openai/v1')
    expect(status.model).toBe('whisper-large-v3-turbo')
    expect(status.custom).toBe(false)
    expect(status.hasKey).toBe(true)
  })
})
