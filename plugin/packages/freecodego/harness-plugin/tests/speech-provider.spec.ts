/**
 * The recognizer this plugin lends to the Harness's own voice input.
 *
 * Four facts carry the whole feature, and all four are asserted rather than
 * described: the provider is `cloud` **and carries no `preparation`** — that pair
 * is what makes `client-ui-voice-input`'s `needsInstallation` expression false, so
 * the user is never asked to download a local model; registration is refused
 * outright when this plugin cannot transcribe, so the Harness's own recognizers
 * (and their download) keep serving instead of being replaced by a broken one; the
 * registration follows the user's switch **live**, because a roster entry is not a
 * per-call lookup and a switch that needed a Host restart would look broken from
 * the settings page that renders it; and the registry is **waited for**, because
 * the bundle that owns it can be mounted after this plugin started.
 *
 * The fifth is the one with a failure mode of its own: a withdrawal has to take
 * the selection off this provider. The registry's `resolve` throws for a selection
 * naming an unregistered provider, so leaving ours behind would not merely disable
 * our recognizer — it would break dictation on every other one.
 *
 * The sixth is the pair around that one, and it is the difference between the switch
 * meaning "offer this" and "use this": registering adopts the selection, and the
 * adoption happens **once per registration** — so the next dictation is served by the
 * cloud recognizer without the user visiting the Harness's picker, while a picker
 * answer of their own is not taken back from them on the next readiness check.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SpeechProvider } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import {
  FREECODEGO_SPEECH_LANGUAGES,
  FREECODEGO_SPEECH_PROVIDER_ID,
  createFreeCodeGoSpeechProvider,
  installFreeCodeGoSpeechProvider,
  wavSeconds,
  type SpeechRegistryLike,
} from '../src/speech-provider.ts'

/** A canonical 16 kHz mono PCM16 WAV of `seconds` of silence, which is what the Harness records. */
function canonicalWav(seconds: number): Uint8Array {
  const dataBytes = Math.round(seconds * 32_000)
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16_000, 24)
  buffer.writeUInt32LE(32_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  return new Uint8Array(buffer)
}

/** One transcription request as the registry would deliver it. */
function input(audio: Uint8Array, language: string) {
  return { audio, language } as Parameters<SpeechProvider['transcribe']>[0]
}

/** The registry's own state, as its doubles need to report it back. */
interface RegistryDouble {
  readonly registry: SpeechRegistryLike
  /** Providers still in the roster, in registration order. */
  readonly roster: string[]
  readonly registered: SpeechProvider[]
  readonly withdrawn: number[]
  /** The provider ids `configure` was asked for. */
  readonly configured: string[]
  /** The registry's own answer to "which recognizer is selected". */
  selection: string
}

/**
 * A registry that records what it was handed and answers `snapshot` truthfully.
 *
 * `configure` moves the recorded selection **and** validates the id first, which
 * is the half that matters here: the real registry throws
 * `Speech provider is unavailable: <id>` for an id it does not hold, so a
 * hand-back to the wrong name has to be a failure this code sees, not one it
 * causes.
 */
function registryDouble(options: {
  readonly selection?: string
  readonly roster?: readonly string[]
  readonly registerThrows?: string
  readonly configureThrows?: string
} = {}): RegistryDouble {
  const registered: SpeechProvider[] = []
  const withdrawn: number[] = []
  const configured: string[] = []
  let roster = [...options.roster ?? ['sensevoice-local']]
  const state: RegistryDouble = {
    registry: {
      register(provider: SpeechProvider) {
        if (options.registerThrows !== undefined) throw new Error(options.registerThrows)
        registered.push(provider)
        roster = [...roster, provider.info.id]
        return async () => {
          withdrawn.push(registered.indexOf(provider))
          roster = roster.filter(id => id !== provider.info.id)
        }
      },
      snapshot: () => ({ providers: roster.map(id => ({ id })), selection: { providerId: state.selection } }),
      async configure(patch: { readonly providerId: string }) {
        if (options.configureThrows !== undefined) throw new Error(options.configureThrows)
        if (!roster.includes(patch.providerId)) throw new Error(`Speech provider is unavailable: ${patch.providerId}`)
        configured.push(patch.providerId)
        state.selection = patch.providerId
      },
    } as SpeechRegistryLike,
    get roster() { return roster },
    registered,
    withdrawn,
    configured,
    selection: options.selection ?? 'sensevoice-local',
  }
  return state
}

/**
 * A context that models the two things this module reads: the injected service,
 * and the logger.
 *
 * `inject` follows cordis's contract rather than a shortcut: the callback runs
 * when the service is there, and again the next time it is provided — which is how
 * a Host that mounts the voice bundle *after* this plugin started still gets served
 * (`provide` is that second arrival).
 *
 * `effect` records the disposer instead of running it: cordis disposes an effect
 * on fiber teardown, and a double that fired it immediately would model a Host
 * that unloads the service the moment it loads it.
 */
function fakeHost(initial?: SpeechRegistryLike): {
  readonly ctx: Context
  readonly lines: string[]
  /** The service arriving (or arriving again), as a mount of the voice bundle does. */
  provide(registry: SpeechRegistryLike): void
  dispose(): Promise<void>
} {
  const lines: string[] = []
  let service = initial
  let registered: ((target: unknown) => void) | undefined
  let teardown: (() => unknown) | undefined
  const scope = {
    get speechToText() { return service },
    effect: (callback: () => () => unknown) => {
      teardown = callback()
      return teardown
    },
  }
  const ctx = {
    get: (name: string) => (name === 'speechToText' ? service : undefined),
    logger: {
      debug: (line: string) => lines.push(`debug:${line}`),
      info: (line: string) => lines.push(`info:${line}`),
      warn: (line: string) => lines.push(`warn:${line}`),
    },
    inject: (deps: readonly string[], callback: (target: unknown) => void) => {
      if (!deps.includes('speechToText')) return
      registered = callback
      if (service !== undefined) callback(scope)
    },
  }
  return {
    ctx: ctx as unknown as Context,
    lines,
    provide(registry) { service = registry; registered?.(scope) },
    async dispose() { await teardown?.() },
  }
}

/** A readiness answer the test can flip between refreshes. */
function switchable(initial: boolean): { readonly canTranscribe: () => Promise<boolean>; set(value: boolean): void } {
  let ready = initial
  return { canTranscribe: async () => ready, set(value) { ready = value } }
}

const transcribe = async (): Promise<{ readonly text: string }> => ({ text: '' })

/** The first refresh is fire-and-forget inside the arrival callback; wait it out. */
async function untilRegistered(double: RegistryDouble): Promise<void> {
  await vi.waitFor(() => { expect(double.registered).toHaveLength(1) })
}

describe('the audio duration this provider reports', () => {
  it('reads seconds out of a canonical recording', () => {
    expect(wavSeconds(canonicalWav(2.5))).toBeCloseTo(2.5, 5)
  })

  it('reports zero rather than throwing on audio it cannot read', () => {
    // A duration is a report about the request, not a gate on it: the recognizer
    // stays the authority on audio it cannot use.
    expect(wavSeconds(new Uint8Array(0))).toBe(0)
    expect(wavSeconds(new Uint8Array(64))).toBe(0)
  })
})

describe('the provider this plugin registers', () => {
  it('is cloud with no preparation, which is what suppresses the install prompt', () => {
    const provider = createFreeCodeGoSpeechProvider({ canTranscribe: async () => true, transcribe })
    expect(provider.info.id).toBe(FREECODEGO_SPEECH_PROVIDER_ID)
    expect(provider.info.location).toBe('cloud')
    // `VoiceInput.tsx` gates the prompt on `location === 'host-local'` AND
    // `preparation.phase === 'unprepared'`; a provider that simply has no
    // `preparation` member can satisfy neither half.
    expect('preparation' in provider).toBe(false)
  })

  it('claims `auto`, because the registry refuses a selection it cannot name', () => {
    expect(FREECODEGO_SPEECH_LANGUAGES).toContain('auto')
  })

  it('sends canonical WAV bytes and reports both durations', async () => {
    const calls: { audioBase64: string; mimeType: string; language: string | undefined }[] = []
    const provider = createFreeCodeGoSpeechProvider({
      canTranscribe: async () => true,
      transcribe: async (audioBase64, mimeType, language) => {
        calls.push({ audioBase64, mimeType, language })
        return { text: 'hello there' }
      },
    })
    const audio = canonicalWav(1.5)
    const transcript = await provider.transcribe(input(audio, 'zh'), new AbortController().signal)
    expect(calls).toEqual([{ audioBase64: Buffer.from(audio).toString('base64'), mimeType: 'audio/wav', language: 'zh' }])
    expect(transcript.text).toBe('hello there')
    expect(transcript.audioSeconds).toBeCloseTo(1.5, 5)
    expect(transcript.inferenceSeconds).toBeGreaterThanOrEqual(0)
  })

  it('turns the registry default into a detection request instead of a language named auto', async () => {
    const languages: (string | undefined)[] = []
    const provider = createFreeCodeGoSpeechProvider({
      canTranscribe: async () => true,
      transcribe: async (_audio, _mime, language) => { languages.push(language); return { text: 'x' } },
    })
    const signal = new AbortController().signal
    await provider.transcribe(input(canonicalWav(1), 'auto'), signal)
    await provider.transcribe(input(canonicalWav(1), ''), signal)
    await provider.transcribe(input(canonicalWav(1), 'en'), signal)
    expect(languages).toEqual([undefined, undefined, 'en'])
  })

  it('refuses work the caller already cancelled, before spending a request', async () => {
    let called = 0
    const provider = createFreeCodeGoSpeechProvider({
      canTranscribe: async () => true,
      transcribe: async () => { called += 1; return { text: 'x' } },
    })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(provider.transcribe(input(canonicalWav(1), 'auto'), controller.signal)).rejects.toThrow('cancelled')
    expect(called).toBe(0)
  })
})

describe('waiting for the Harness speech registry', () => {
  it('serves nothing, and says nothing, while the voice bundle is not mounted', async () => {
    const host = fakeHost()
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    // A service that is simply absent is not a fault worth a log line: the voice
    // bundle is optional and off by default, so every Host without it would
    // otherwise carry a warning about a feature the user never enabled.
    await expect(handle.refresh()).resolves.toBeUndefined()
    expect(host.lines).toEqual([])
  })

  it('starts serving when the bundle is mounted after this plugin was', async () => {
    // The Harness's own plugin page enables the voice bundle live, so the registry
    // can arrive long after this plugin started — the case a one-shot read at boot
    // would leave dead until the next Host start.
    const double = registryDouble()
    const host = fakeHost()
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    expect(double.registered).toHaveLength(0)
    host.provide(double.registry)
    await untilRegistered(double)
    expect(double.registered[0]?.info.id).toBe(FREECODEGO_SPEECH_PROVIDER_ID)
    await handle.dispose()
    expect(double.withdrawn).toEqual([0])
  })

  it('ignores a speech service that offers no roster to read', async () => {
    // Without `snapshot` a withdrawal could not be completed, so this plugin stays
    // out of a registry it cannot fully participate in.
    const host = fakeHost({ register: () => async () => undefined } as unknown as SpeechRegistryLike)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    await handle.refresh()
    expect(host.lines).toEqual(['debug:freecodego: the Harness speech service is present without a usable registry, so this plugin contributes no recognizer'])
  })

  it('yields to the Harness recognizers when the user switched this plugin off', async () => {
    const double = registryDouble()
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => false, transcribe })
    await handle.refresh()
    expect(double.registered).toHaveLength(0)
    expect(double.configured).toEqual([])
    // The arrival refresh and the explicit one both asked, and both said the same
    // thing: this is a no-op decision, so saying it twice is not two different
    // facts. What matters is that nothing else was said.
    expect(host.lines.length).toBeGreaterThan(0)
    expect(host.lines.every(line => line === 'debug:freecodego: no speech transcriber credential is configured, leaving the Harness recognizers in place')).toBe(true)
  })

  it('yields, loudly, when readiness itself cannot be read', async () => {
    const double = registryDouble()
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, {
      canTranscribe: async () => { throw new Error('credentials unavailable') },
      transcribe,
    })
    await handle.refresh()
    // An unreadable credential is not a servable one, and guessing would remove the
    // download path from a user whose plugin cannot serve speech at all.
    expect(double.registered).toHaveLength(0)
    expect(host.lines[0]).toMatch(/^warn:freecodego: could not resolve the speech transcriber/)
    expect(host.lines[0]).toContain('credentials unavailable')
  })

  it('registers exactly once, takes the selection, and withdraws on disposal', async () => {
    const double = registryDouble()
    const host = fakeHost(double.registry)
    installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    await untilRegistered(double)
    // Two lines, and the second is the feature: joining the roster is not the same
    // act as being used, and the switch the user flipped asked for the second one.
    expect(host.lines).toEqual([
      `info:freecodego: serving Harness speech recognition through provider "${FREECODEGO_SPEECH_PROVIDER_ID}"`,
      'info:freecodego: speech input now uses this plugin\'s cloud recognizer, so the local model is no longer needed',
    ])
    expect(double.selection).toBe(FREECODEGO_SPEECH_PROVIDER_ID)
    await host.dispose()
    expect(double.withdrawn).toEqual([0])
    expect(double.roster).toEqual(['sensevoice-local'])
    // And the microphone is handed back where it was, not left pointing at a
    // provider that just left the roster.
    expect(double.selection).toBe('sensevoice-local')
  })

  it('keeps the Host alive when the id is already taken', async () => {
    const double = registryDouble({ registerThrows: `Speech provider already registered: ${FREECODEGO_SPEECH_PROVIDER_ID}` })
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    await handle.refresh()
    expect(host.lines[0]).toMatch(/^warn:freecodego: could not register the speech provider/)
    expect(host.lines[0]).toContain('already registered')
  })
})

describe('following the user\'s switch without a Host restart', () => {
  it('withdraws and re-registers as the switch moves', async () => {
    const double = registryDouble()
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)

    readiness.set(false)
    await handle.refresh()
    expect(double.withdrawn).toEqual([0])
    expect(double.registered).toHaveLength(1)

    readiness.set(true)
    await handle.refresh()
    expect(double.registered).toHaveLength(2)
  })

  it('registers nothing while the switch stays off, however often it is asked', async () => {
    const double = registryDouble()
    const readiness = switchable(false)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await handle.refresh()
    await handle.refresh()
    expect(double.registered).toHaveLength(0)
    expect(double.withdrawn).toEqual([])
  })

  it('reports a failed readiness read on a refresh instead of taking the roster down', async () => {
    const double = registryDouble()
    let answers = 0
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, {
      canTranscribe: async () => {
        answers += 1
        if (answers > 1) throw new Error('credentials unavailable')
        return true
      },
      transcribe,
    })
    await untilRegistered(double)
    await handle.refresh()
    // The registration from the readable answer stands: an exception is a reason to
    // change nothing, not a reason to withdraw what is working.
    expect(double.registered).toHaveLength(1)
    expect(double.withdrawn).toEqual([])
    expect(host.lines.some(line => line.startsWith('warn:freecodego: could not resolve the speech transcriber'))).toBe(true)
  })

  it('stops following the switch once the Host unloads the plugin', async () => {
    const double = registryDouble()
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)
    await host.dispose()
    const seen = host.lines.length

    readiness.set(true)
    await handle.refresh()
    expect(double.registered).toHaveLength(1)
    expect(host.lines).toHaveLength(seen)
  })
})

describe('handing the selection back when this provider leaves', () => {
  it('moves a selection this plugin owned onto a recognizer that is still registered', async () => {
    const double = registryDouble({ roster: ['sensevoice-local', FREECODEGO_SPEECH_PROVIDER_ID], selection: FREECODEGO_SPEECH_PROVIDER_ID })
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)

    readiness.set(false)
    await handle.refresh()
    // The registry's `resolve` throws for a selection it cannot serve, so leaving
    // the user's selection on a provider that just left is what this prevents.
    expect(double.configured).toEqual(['sensevoice-local'])
    expect(double.selection).toBe('sensevoice-local')
    expect(host.lines.some(line => line.startsWith('info:freecodego: speech input returned to provider "sensevoice-local"'))).toBe(true)
  })

  it('does not adopt the selection a second time while it stays registered', async () => {
    // The adoption belongs to the registration edge. Were it repeated on every
    // refresh, a user who answered the picker with another recognizer would have it
    // taken back from them the next time this plugin re-checked its readiness.
    const double = registryDouble()
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)
    expect(double.configured).toEqual([FREECODEGO_SPEECH_PROVIDER_ID])
    // The user answers the picker themselves.
    await double.registry.configure({ providerId: 'sensevoice-local' })
    await handle.refresh()
    await handle.refresh()
    expect(double.selection).toBe('sensevoice-local')
    expect(double.configured).toEqual([FREECODEGO_SPEECH_PROVIDER_ID, 'sensevoice-local'])
  })

  it('hands the selection back to the recognizer it took it from', async () => {
    const double = registryDouble()
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)
    readiness.set(false)
    await handle.refresh()
    // Register → adopt → withdraw → give back, in that order, which is what makes
    // the round trip leave the user exactly where they were.
    expect(double.configured).toEqual([FREECODEGO_SPEECH_PROVIDER_ID, 'sensevoice-local'])
    expect(double.selection).toBe('sensevoice-local')
  })

  it('says which picker to use when the harness refuses the takeover', async () => {
    const double = registryDouble({ configureThrows: 'Speech selection requires a language the provider supports' })
    const host = fakeHost(double.registry)
    installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    await untilRegistered(double)
    // A refusal is not retried and not fatal: the plugin is registered and usable,
    // and the one gesture that fixes it is the user's language picker.
    const warning = host.lines.find(line => line.startsWith('warn:freecodego: the Harness kept its own recognizer'))
    expect(warning).toContain('sensevoice-local')
    expect(warning).toContain('识别服务')
    expect(double.registered).toHaveLength(1)
  })

  it('says which control to use when the hand-back itself is refused', async () => {
    const double = registryDouble({
      roster: ['sensevoice-local', FREECODEGO_SPEECH_PROVIDER_ID],
      selection: FREECODEGO_SPEECH_PROVIDER_ID,
      configureThrows: 'Speech selection requires the settings service and a profile entry',
    })
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)
    readiness.set(false)
    await expect(handle.refresh()).resolves.toBeUndefined()
    // A voice bundle mounted without a settings service cannot store a selection,
    // and the message names the picker rather than leaving the next dictation to
    // explain a provider that is gone.
    const warning = host.lines.find(line => line.startsWith('warn:freecodego: speech input is still set to this plugin'))
    expect(warning).toContain('识别服务')
    expect(warning).toContain('profile entry')
  })

  it('says so when there is no other recognizer to hand the selection to', async () => {
    const double = registryDouble({ roster: [FREECODEGO_SPEECH_PROVIDER_ID], selection: FREECODEGO_SPEECH_PROVIDER_ID })
    const readiness = switchable(true)
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: readiness.canTranscribe, transcribe })
    await untilRegistered(double)
    readiness.set(false)
    await handle.refresh()
    expect(double.configured).toEqual([])
    expect(host.lines.some(line => line.startsWith('warn:freecodego: speech input is set to this plugin\'s recognizer with no other provider registered'))).toBe(true)
  })

  it('hands the selection back on unload too, not only on the switch', async () => {
    const double = registryDouble({ roster: ['sensevoice-local', FREECODEGO_SPEECH_PROVIDER_ID], selection: FREECODEGO_SPEECH_PROVIDER_ID })
    const host = fakeHost(double.registry)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    await untilRegistered(double)
    await handle.dispose()
    expect(double.configured).toEqual(['sensevoice-local'])
  })

  it('survives a registry that cannot be read at all', async () => {
    const double = registryDouble({ roster: [FREECODEGO_SPEECH_PROVIDER_ID], selection: FREECODEGO_SPEECH_PROVIDER_ID })
    // Wrapped rather than referenced: the registry's methods are borrowed from
    // another object here, and a bare method reference is the shape that reads as a
    // lost receiver.
    const broken: SpeechRegistryLike = {
      register: (provider) => double.registry.register(provider),
      snapshot: () => { throw new Error('registry is shutting down') },
      configure: (patch) => double.registry.configure(patch),
    }
    const host = fakeHost(broken)
    const handle = installFreeCodeGoSpeechProvider(host.ctx, { canTranscribe: async () => true, transcribe })
    await untilRegistered(double)
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(host.lines.some(line => line.startsWith('warn:freecodego: could not read the speech roster to release the selection'))).toBe(true)
  })
})
