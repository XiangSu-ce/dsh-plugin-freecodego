/**
 * This plugin's cloud recognizer, registered on the Harness's own speech
 * registry — the seam that lets the Harness's microphone work without the local
 * model download.
 *
 * What the Harness owns, and what it left for a provider
 * -----------------------------------------------------
 * `@deepseek-ai/dsh-experimental-speech-to-text` is the Host-side registry
 * (`ctx.speechToText`): providers register by name, one is selected, and audio
 * goes to exactly the selected provider. The optional voice bundle mounts four
 * rows — the registry, a local SenseVoice recognizer, the Remote controller the
 * browser talks to, and the composer microphone — and it sets
 * `defaultProvider: sensevoice-local`.
 *
 * SenseVoice is `host-local`: its models are downloaded on first use, and the
 * client turns that into the "使用语音输入前需要安装" prompt. The gate is one
 * expression in `client-ui-voice-input/src/client/VoiceInput.tsx`:
 *
 *     needsInstallation={readiness.connected && provider?.location === 'host-local'
 *       && provider.preparation.phase === 'unprepared'}
 *
 * So a provider that reports `location: 'cloud'` and carries **no `preparation`**
 * can never raise that prompt: there is no local resource to prepare, and the
 * two conditions cannot both hold. That is the whole reason this module exists —
 * the plugin already had a working cloud transcriber
 * (`freecodego_generate_audio`'s sibling `groqWhisperTranscribe`, Groq
 * `whisper-large-v3-turbo`), and the Harness already had a seam to serve it on.
 * Nothing downstream is re-implemented: the Harness's microphone, its language
 * picker, its Remote controller and its settings surface stay the Harness's.
 *
 * Which recognizer is selected
 * ---------------------------
 * Registering a provider *is* the feature: the Harness's own 识别服务 picker lists
 * whatever is registered, so ours appearing there is what makes "no download, or
 * the local model" a choice the user makes on the Harness's own page.
 *
 * Registration alone, though, left the microphone on the local recognizer: the
 * selection is persisted state, the composition opens with the bundled local model
 * selected, and the cloud provider therefore arrived in the roster *unused* — the
 * plugin's own switch read as "on" while the next dictation still downloaded a
 * model, which is the report this behaviour answers.
 *
 * So the plugin's switch is what elects it: **entering the roster** adopts the
 * selection, and the two gestures that leave it — the switch off, and a credential
 * that stopped resolving — hand the selection back (see {@link handSelectionBack}).
 * The adoption happens on the registration *edge*, never on every refresh, so a
 * user who answers the picker with another recognizer keeps it: while this plugin
 * stays registered, its own refresh calls only re-check readiness, and the next
 * adoption is a switch that was turned off and on again. That is the reading under
 * which "on" means "use this plugin's cloud recognizer" instead of "offer it".
 *
 * The alternative — pointing the composition default at ourselves — is still
 * rejected, and for the reason it always was: `speech-to-text`'s `resolve` throws
 * for a selection it cannot serve (`Speech provider is unavailable: freecodego`),
 * so a default that named us would break dictation on every composition where we
 * then declined to register (no credential, or the user's own switch off). An
 * adoption that only ever runs *after* a successful registration cannot reach that
 * state.
 *
 * Owing the user the selection back
 * --------------------------------
 * Withdrawing is the one case where this module *does* write the selection, and
 * it is not optional: the moment this provider leaves the roster, a selection
 * still naming it turns into `Speech provider is unavailable: freecodego` on the
 * user's next dictation. So a withdrawal checks whether the selection is ours and
 * hands it back to another registered recognizer through the registry's own
 * `configure`. The plugin's switch therefore cannot strand the microphone, which
 * is what "let the Harness's own recognizers stay in place" has to mean when we
 * were the selected one.
 *
 * Why the contract is mirrored here rather than imported
 * -----------------------------------------------------
 * Every type below is declared in this file instead of imported from
 * `@deepseek-ai/dsh-experimental-speech-to-text/types`, and that is not a
 * preference. This package is built with `rootDir: src`, and the workspace maps
 * that package's id straight onto its sources, so even a type-only import of it is
 * a file outside this package's root: the packaged build refuses the project
 * outright (`TS6059`), which was measured rather than predicted — the first
 * version of this module imported the types and built under the aggregate program
 * while failing `build:freecodego`.
 *
 * So the seam is held by tests instead of by the compiler, which is also how this
 * plugin reads every other Host service: `upstream-seam-contracts.spec.ts` pins the
 * registry's service name, its `register`/`snapshot`/`configure` shapes, the
 * refusal a stale selection produces, and the two members the client's install
 * prompt reads — and the e2e lane boots a real Host and reads the real roster. A
 * rename upstream turns this repository red rather than reaching a user's
 * microphone, and the plugin carries no runtime dependency on a package it only
 * participates in.
 *
 * Yielding when this plugin cannot serve
 * --------------------------------------
 * Whether this provider can serve is the caller's `canTranscribe`, which is two
 * facts: the user's own switch for this plugin's recognizer, and whether the Groq
 * credential resolves. The credential is read asynchronously from the credentials
 * service, and the answer can be "no" on a deployment that never configured it.
 * In either case this module registers nothing, which leaves the Harness's own
 * roster and its local-model prompt exactly as they were. A plugin that registered
 * a provider it cannot serve would take the download path away from the user and
 * hand them a broken microphone instead — which is also why the answer is read
 * before registering rather than inside `transcribe`, and why the switch moves the
 * registration rather than a check inside it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/speech-provider
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Provider id this plugin registers.
 *
 * A plain string, and deliberately so: upstream brands it (`SpeechProviderId`),
 * but the registry only ever compares and stores it, so the brand buys nothing here
 * and pricing it in would mean importing the type this module cannot import. It is
 * a durable key all the same — the selection a user makes is persisted under it.
 */
export const FREECODEGO_SPEECH_PROVIDER_ID = 'freecodego'

/**
 * Languages this provider claims.
 *
 * `auto` is not decoration: the registry refuses a selection whose language the
 * selected provider does not list, and `auto` is the registry's own default
 * (`speech-to-text`'s `language` config), so omitting it would make this provider
 * unselectable until the user first changed the language picker.
 *
 * The two named languages are the ones this deployment actually exercises. The
 * recognizer behind this provider auto-detects everything else, and a caller that
 * wants another language spells it out on the request; claiming a language here
 * that nobody tests would be a promise this plugin cannot keep.
 */
export const FREECODEGO_SPEECH_LANGUAGES: readonly string[] = ['auto', 'zh', 'en']

/**
 * One replaceable recognizer, as the registry declares it.
 *
 * Mirrors `SpeechProvider` in `experimental/speech-to-text/src/types.ts`; see the
 * module note on why it is mirrored. Only the members this plugin writes are
 * declared: `info` and the one `transcribe` method. `preparation` is deliberately
 * absent from the interface rather than present-and-optional, because the whole
 * point of this provider is that it has none — see
 * {@link createFreeCodeGoSpeechProvider}.
 */
export interface SpeechProvider {
  /** Public facts the picker and the install prompt read. */
  readonly info: SpeechProviderInfo
  /**
   * Recognize one complete recording without submitting an Agent message.
   * @param input - WAV bytes and the language hint.
   * @param signal - caller or registration cancellation.
   * @returns final text and the two measured durations.
   */
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>
}

/** Public provider facts; credentials and filesystem paths are excluded. */
export interface SpeechProviderInfo {
  /** Configured identity, and the key a persisted selection is stored under. */
  readonly id: string
  /** Name shown in the 识别服务 picker. */
  readonly name: string
  /**
   * Where the audio is processed. This is half of the install prompt's condition,
   * so it is not a label: `cloud` is what makes the local-model prompt unreachable.
   */
  readonly location: 'host-local' | 'cloud'
  /** Accepted language hints, including automatic detection when supported. */
  readonly languages: readonly string[]
}

/** Complete audio recording and an explicit language hint. */
export interface SpeechInput {
  /** The recording, as the Remote controller validated it: canonical 16 kHz mono PCM16 WAV. */
  readonly audio: Uint8Array
  /** The selected language, or the registry's own `auto`. */
  readonly language: string
}

/** Final transcription; an empty string means no speech was recognized. */
export interface Transcript {
  /** The recognized text. */
  readonly text: string
  /** Seconds of audio in the recording, as read from its own header. */
  readonly audioSeconds: number
  /** Seconds this recognizer spent, which the voice surface reports as latency. */
  readonly inferenceSeconds: number
}

/**
 * One registered recognizer as the registry reports it.
 *
 * Structural and narrowed to the two fields a withdrawal reads: which ids are in
 * the roster, and which one is selected. The roster's readiness phases and audio
 * plumbing are the Harness's business, and a reader that declared them would be
 * asserting a contract it does not use.
 */
export interface SpeechRosterLike {
  /** The registered providers, in registration order. */
  readonly providers: readonly { readonly id: string }[]
  /** The current selection, resolved from the composition default and the user's stored answer. */
  readonly selection: { readonly providerId: string }
}

/**
 * The registry, as this plugin reads it: one service name, four methods.
 *
 * Structural rather than imported, because `ctx.speechToText` is an augmentation
 * contributed by a package this plugin deliberately does not depend on at
 * runtime. `register` and `configure` are the contributor's side (add a
 * recognizer, move the selection); `snapshot` is read only to answer "is the
 * selection ours, and what else could carry it".
 */
export interface SpeechRegistryLike {
  /**
   * Register one recognizer on the Harness registry.
   * @param provider - the recognizer to serve; duplicate ids are the registry's error.
   * @returns the disposer that withdraws it.
   */
  register(provider: SpeechProvider): () => Promise<void>
  /**
   * Read the roster and the current selection.
   * @returns the registered providers and the resolved selection.
   */
  snapshot(): SpeechRosterLike
  /**
   * Persist a selection change into the voice bundle's own profile entry.
   * Throws when no settings service is mounted, when the named provider is not
   * registered, and when it does not support the selected language.
   * @param patch - the selection fields to move.
   */
  configure(patch: { readonly providerId: string }): Promise<void>
}

/** What the provider needs from its host, so the mapping is testable on its own. */
export interface FreeCodeGoSpeechDeps {
  /**
   * Whether the recognizer is usable at all, asked before every registration
   * attempt. A false answer registers nothing, so the Harness keeps its own
   * providers; it is asked again whenever the switch moves, not just at boot.
   * @returns true when this plugin can transcribe.
   */
  readonly canTranscribe: () => Promise<boolean>
  /**
   * Send one recording to the plugin's own transcriber.
   * @param audioBase64 - the recording, canonical base64.
   * @param mimeType - the recording's MIME type.
   * @param language - a concrete language hint, or `undefined` to auto-detect.
   * @returns the transcript text.
   */
  readonly transcribe: (audioBase64: string, mimeType: string, language?: string) => Promise<{ readonly text: string }>
}

/**
 * The live registration this plugin owns.
 *
 * Returned so the switch that turns this recognizer on is the same switch that
 * turns it off: a Host that only re-read the decision at boot would leave the
 * picker showing a provider the user just disabled.
 *
 * Every method is safe to call before there is a registry to serve — the calls
 * are queued onto the registration rather than dropped, because the Harness's own
 * plugin page can mount the voice bundle at any point in the Host's life.
 */
export interface FreeCodeGoSpeechHandle {
  /**
   * Re-ask {@link FreeCodeGoSpeechDeps.canTranscribe} and register or withdraw to
   * match. Never rejects: a refusal is logged and the Harness's own recognizers
   * stay in place.
   * @returns after the roster reflects the current answer.
   */
  refresh(): Promise<void>
  /**
   * Withdraw and hand the selection back, for plugin unload.
   * @returns after the registry no longer holds this provider.
   */
  dispose(): Promise<void>
  /**
   * Where this registration stands, for the settings surface.
   *
   * Read from the registry rather than remembered here, because the selection is the
   * Harness's state: a cached answer would report the picker this plugin asked for
   * instead of the picker the user last answered. The registry is only read while
   * this provider is registered, so a snapshot that throws is reported as "unknown
   * selection" beside a registration that is known to be ours.
   * @returns whether this plugin's recognizer is in the roster, and what is selected.
   */
  roster(): { readonly registered: boolean; readonly selected: string }
}

/**
 * Seconds of audio in a canonical 16 kHz mono PCM16 WAV, which is the only shape
 * the Harness's Remote controller admits (`validateWave` in
 * `speech-to-text/src/wave.ts` rejects anything else before a provider is
 * reached). Unknown or unreadable headers report `0` rather than throwing: the
 * duration is a report about the request, not a gate on it, and the recognizer
 * itself is the authority on audio it cannot use.
 * @param audio - the recording as received.
 * @returns the recording's duration in seconds, or 0 when the header is unreadable.
 */
export function wavSeconds(audio: Uint8Array): number {
  // `46` mirrors the seizure in `wave.ts`: fewer bytes cannot carry the header
  // this reads, and a length-44 file with a `data` chunk is a silent recording.
  if (audio.byteLength < 44) return 0
  const header = (offset: number, length: number): string => {
    let text = ''
    for (let index = 0; index < length; index += 1) text += String.fromCharCode(audio[offset + index] ?? 0)
    return text
  }
  if (header(0, 4) !== 'RIFF' || header(8, 4) !== 'WAVE' || header(36, 4) !== 'data') return 0
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  // 32000 bytes per second: 16000 samples × 2 bytes, mono PCM16.
  return view.getUint32(40, true) / 32_000
}

/**
 * One recognizer for the Harness registry, backed by this plugin's transcriber.
 *
 * Deliberately without `preparation`: the optional member is what the client
 * reads to decide that a local model must be downloaded, and this provider has no
 * local resource. `location: 'cloud'` states where the audio goes, which is also
 * what the voice settings surface shows the user.
 * @param deps - the transcriber this provider serves through.
 * @returns the provider to register.
 */
export function createFreeCodeGoSpeechProvider(deps: FreeCodeGoSpeechDeps): SpeechProvider {
  return {
    info: {
      id: FREECODEGO_SPEECH_PROVIDER_ID,
      name: 'FreeCodeGo (Groq Whisper)',
      location: 'cloud',
      languages: FREECODEGO_SPEECH_LANGUAGES,
    },
    async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
      signal.throwIfAborted()
      const audioSeconds = wavSeconds(input.audio)
      const started = Date.now()
      // The registry's own default language is the literal `auto`, which is a
      // selection rather than a hint: forwarding it would ask the recognizer for
      // a language named "auto" instead of asking it to detect one.
      const language = input.language === '' || input.language === 'auto' ? undefined : input.language
      const result = await deps.transcribe(
        Buffer.from(input.audio).toString('base64'),
        'audio/wav',
        language,
      )
      signal.throwIfAborted()
      return {
        text: result.text,
        audioSeconds,
        inferenceSeconds: (Date.now() - started) / 1_000,
      }
    },
  }
}

/** One line to the Host log, at whichever level the logger supports. */
type SpeechLog = (message: string) => void

/** The two log levels this module writes: an outcome, and a degradation. */
interface SpeechLogger {
  readonly info: SpeechLog
  readonly debug: SpeechLog
  readonly warn: SpeechLog
}

/**
 * The logger as this module reads it, with every level optional.
 *
 * `Context.logger` is declared non-nullable, but a bare context — a test, a minimal
 * composition, the constructor path before `start` — carries none, which is why
 * every module in this package guards its logger reads. Declaring the levels here
 * is what keeps those guards honest instead of a lint finding about a check that
 * cannot fire.
 */
interface SpeechLogSink {
  /** Report an outcome worth seeing by default. */
  readonly info?: ((message: string) => void) | undefined
  /** Report a decision that changed nothing. */
  readonly debug?: ((message: string) => void) | undefined
  /** Report a degradation this plugin worked around. */
  readonly warn?: ((message: string) => void) | undefined
}

/** Bind the Host logger once, tolerating a context that carries none. */
function speechLogger(ctx: Context): SpeechLogger {
  const sink = (ctx as unknown as { readonly logger?: SpeechLogSink }).logger
  return {
    info: (message) => { sink?.info?.(message) },
    debug: (message) => { sink?.debug?.(message) },
    warn: (message) => { sink?.warn?.(message) },
  }
}

/**
 * Serve this plugin's recognizer on the Harness speech registry when there is one.
 *
 * Three ways this is a no-op, all of them deliberate: the registry is absent (the
 * optional voice bundle is not mounted, so the Harness has no speech feature to
 * serve), this plugin cannot transcribe (no configured credential — see the
 * module note on yielding), or another contributor already holds this provider
 * id. Each writes one line, because "this plugin contributes no recognizer" and
 * "this plugin tried and failed" are different facts for whoever reads the log.
 *
 * The registry is waited for rather than read once. It belongs to an optional
 * bundle that the Harness's own plugin page can enable *after* this plugin
 * started, and a one-shot read at boot would leave the recognizer unregistered on
 * every Host where that page is the way it was switched on — silently, since a
 * service that is simply absent is not an error. `ctx.inject` is the Harness's own
 * answer to that: the callback runs when the service is provided, and again if it
 * is withdrawn and provided anew.
 *
 * The returned handle is how the switch reaches this registration, whether or not
 * the registry has arrived yet.
 * @param ctx - the plugin's context; the registry is injected by service name.
 * @param deps - readiness and the transcriber to route audio through.
 * @returns the live registration.
 */
export function installFreeCodeGoSpeechProvider(ctx: Context, deps: FreeCodeGoSpeechDeps): FreeCodeGoSpeechHandle {
  const logger = speechLogger(ctx)
  /** The registration inside the injected scope, for the lifetime of that service. */
  let live: FreeCodeGoSpeechHandle | undefined
  /** The answer a Host with no registry at all gives: nothing is registered. */
  const unregistered = { registered: false, selected: '' } as const
  ctx.inject(['speechToText'], (scope) => {
    const registry = (scope as unknown as { readonly speechToText?: unknown }).speechToText as SpeechRegistryLike | undefined
    if (registry === undefined || typeof registry.register !== 'function' || typeof registry.snapshot !== 'function') {
      logger.debug('freecodego: the Harness speech service is present without a usable registry, so this plugin contributes no recognizer')
      return
    }
    scope.effect(() => {
      const registration = serve(registry, deps, logger)
      live = registration
      // Not awaited: the callback is the service-arrival hook, and the roster a
      // client reads is read after this boot settles. `refresh` reports its own
      // refusals.
      void registration.refresh()
      return () => {
        live = undefined
        return registration.dispose()
      }
    }, 'freecodego: speech provider')
  })
  return {
    async refresh() { await live?.refresh() },
    async dispose() { await live?.dispose() },
    roster() { return live?.roster() ?? unregistered },
  }
}

/**
 * Hold one registration on one registry.
 *
 * Split out from the installer because its lifetime is the *service's*, not the
 * plugin's: the injected scope can end and be re-entered, and each entry needs
 * its own answer to "are we in the roster", not a shared one.
 * @param registry - the registry this registration serves.
 * @param deps - readiness and the transcriber to route audio through.
 * @param logger - where outcomes are reported.
 * @returns the handle for this registration.
 */
function serve(registry: SpeechRegistryLike, deps: FreeCodeGoSpeechDeps, logger: SpeechLogger): FreeCodeGoSpeechHandle {
  /** The registry's own withdraw function, present exactly while we are in the roster. */
  let unregister: (() => Promise<void>) | undefined
  let unloading = false

  /**
   * Leave the roster, and take the selection off us on the way out.
   *
   * The withdrawal is attempted first and the repair second, in that order: while
   * this provider is still registered, a selection naming it is legitimate, so a
   * failed repair is the only case that leaves the user pointed at nothing — and
   * that case is logged with what to do about it rather than swallowed.
   */
  const withdraw = async (): Promise<void> => {
    const disposer = unregister
    unregister = undefined
    if (disposer !== undefined) {
      try {
        await disposer()
      } catch (error: unknown) {
        // The registry refuses a disposal whose lifetime already ended, which is
        // what a Host shutdown looks like from here. The provider is gone either
        // way, so this is a debug fact rather than a fault.
        logger.debug(`freecodego: the Harness speech registry declined the withdrawal: ${reasonOf(error)}`)
      }
    }
    await handSelectionBack(registry, logger)
  }

  /**
   * Register, once.
   *
   * A composition that already holds this id is the registry's own duplicate
   * refusal, and it must not cost the Host its boot; `unregister` stays unset so a
   * later refresh treats the roster as someone else's to keep.
   */
  const register = (): boolean => {
    try {
      unregister = registry.register(createFreeCodeGoSpeechProvider(deps))
      logger.info(`freecodego: serving Harness speech recognition through provider "${FREECODEGO_SPEECH_PROVIDER_ID}"`)
      return true
    } catch (error: unknown) {
      unregister = undefined
      logger.warn(`freecodego: could not register the speech provider, leaving the Harness recognizers in place: ${reasonOf(error)}`)
      return false
    }
  }

  const refresh = async (): Promise<void> => {
    if (unloading) return
    let ready: boolean
    try {
      ready = await deps.canTranscribe()
    } catch (error: unknown) {
      // An unreadable credential is not a servable one: guessing here would take
      // the Harness's own recognizers out of the roster on the strength of an
      // exception.
      logger.warn(`freecodego: could not resolve the speech transcriber, leaving the Harness recognizers in place: ${reasonOf(error)}`)
      return
    }
    if (ready) {
      // Election follows the registration edge, not the refresh: see the module
      // note on which recognizer is selected. A refresh while we are already in the
      // roster changes nothing, which is what leaves a manual pick alone.
      if (unregister === undefined && register()) await adoptSelection(registry, logger)
      return
    }
    if (unregister !== undefined) await withdraw()
    logger.debug('freecodego: no speech transcriber credential is configured, leaving the Harness recognizers in place')
  }

  return {
    refresh,
    dispose: async () => {
      unloading = true
      await withdraw()
    },
    roster: () => {
      if (unregister === undefined) return { registered: false, selected: '' }
      try {
        return { registered: true, selected: registry.snapshot().selection.providerId }
      } catch {
        // A registry that cannot be read still holds our registration: the failure is
        // about the selection, and reporting `selected: ''` says exactly that.
        return { registered: true, selected: '' }
      }
    },
  }
}

/**
 * Take the selection for this plugin, once, right after it joined the roster.
 *
 * Loud on both outcomes, because this is the decision the user's switch asked for
 * and the reason a microphone either stops asking for a download or keeps asking
 * for one. A refusal is not an error to retry: the registry refuses a selection
 * whose language the provider does not list, and the answer to that is the user's
 * language picker, not a second attempt.
 * @param registry - the registry this plugin just registered on.
 * @param logger - where the outcome is reported.
 */
async function adoptSelection(registry: SpeechRegistryLike, logger: SpeechLogger): Promise<void> {
  let roster: SpeechRosterLike
  try {
    roster = registry.snapshot()
  } catch (error: unknown) {
    logger.warn(`freecodego: could not read the speech roster to select this plugin's recognizer; pick 识别服务 → FreeCodeGo: ${reasonOf(error)}`)
    return
  }
  if (roster.selection.providerId === FREECODEGO_SPEECH_PROVIDER_ID) return
  try {
    await registry.configure({ providerId: FREECODEGO_SPEECH_PROVIDER_ID })
    logger.info('freecodego: speech input now uses this plugin\'s cloud recognizer, so the local model is no longer needed')
  } catch (error: unknown) {
    logger.warn(`freecodego: the Harness kept its own recognizer (${roster.selection.providerId}); pick 识别服务 → FreeCodeGo to use the cloud one: ${reasonOf(error)}`)
  }
}

/**
 * Point the selection back at a recognizer that is actually registered.
 *
 * Only ever runs when the selection is this plugin's own id and this plugin is
 * about to leave the roster — the state the registry's `resolve` fails on. The
 * replacement is the first other provider in registration order, which is the
 * composition's own order and therefore prefers the recognizer the bundle mounted
 * over anything a later contributor added.
 * @param registry - the registry to read and write.
 * @param logger - where the outcome is reported.
 */
async function handSelectionBack(registry: SpeechRegistryLike, logger: SpeechLogger): Promise<void> {
  let roster: SpeechRosterLike
  try {
    roster = registry.snapshot()
  } catch (error: unknown) {
    logger.warn(`freecodego: could not read the speech roster to release the selection: ${reasonOf(error)}`)
    return
  }
  if (roster.selection.providerId !== FREECODEGO_SPEECH_PROVIDER_ID) return
  const successor = roster.providers.find(provider => provider.id !== FREECODEGO_SPEECH_PROVIDER_ID)
  if (successor === undefined) {
    logger.warn('freecodego: speech input is set to this plugin\'s recognizer with no other provider registered; pick another 识别服务 or re-enable this plugin')
    return
  }
  try {
    await registry.configure({ providerId: successor.id })
    logger.info(`freecodego: speech input returned to provider "${successor.id}" now that this plugin no longer serves it`)
  } catch (error: unknown) {
    // The registry refuses this without a settings service or entry, and refuses a
    // provider whose languages exclude the selected language. Either way the
    // selection still names a provider that is gone, so the message says which
    // control fixes it rather than leaving the next dictation to explain.
    logger.warn(`freecodego: speech input is still set to this plugin\'s recognizer, which is no longer registered — pick another 识别服务: ${reasonOf(error)}`)
  }
}

/** One message out of an unknown throw, for a log line. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
