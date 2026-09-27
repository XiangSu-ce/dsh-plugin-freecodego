/**
 * The speech-recognition route the settings surface reads and writes.
 *
 * Why this module exists
 * ----------------------
 * The plugin transcribes through one OpenAI-compatible endpoint — `POST
 * {baseUrl}/audio/transcriptions`, a multipart file, a model id, a bearer key — and
 * that shape is the whole reason the route is configurable: Groq's
 * `whisper-large-v3-turbo` is the built-in default, and anything else (a
 * self-hosted whisper, a gateway that resells one, a provider whose model id the
 * user knows) is the same request with two fields changed.
 *
 * Until this module existed, "the route" was two constants in
 * `managed-catalog-utils.ts` plus one credential, and the settings page could only
 * report half of it: the card claimed a free Groq transcriber was available while
 * the key that would make it available had no field to be entered in, so enabling
 * the feature produced a local-model download prompt and no explanation. The three
 * values now have one reader ({@link speechStatus}) and one writer
 * ({@link speechSetRoute}), which is what makes the card able to say which endpoint
 * the microphone would actually use.
 *
 * Why the write is one call and not three
 * ---------------------------------------
 * The three inputs are one route, and a route that is half-written is a route
 * nobody asked for — a new endpoint with the previous provider's model id, a model
 * swapped while the endpoint still points at the old one. So the patch carries
 * whichever fields the card touched, the write applies them, and **the registration
 * is re-decided once at the end**: whether this plugin can serve the microphone is
 * exactly "a key resolves", and the Harness roster only learns that through
 * {@link SpeechRouteHost.refresh}. A write that skipped it would leave the picker
 * showing a provider the key just enabled — or still offering one whose key the
 * user just cleared.
 *
 * What the browser is allowed to see
 * ----------------------------------
 * The endpoint and the model, because the card describes them, and `hasKey` as a
 * boolean rather than the key itself. That asymmetry is the point of typing the
 * projection here instead of returning the route: the route carries the bearer
 * token, and this is the boundary where it stops.
 *
 * @module speech-route
 */

import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { GROQ_WHISPER_API_KEY_REF, GROQ_WHISPER_BASE_URL_REF, GROQ_WHISPER_MODEL_REF } from './managed-catalog-utils.ts'
import { speechEndpoint, speechModelId, type FreeCodeGoManagedCatalogs } from './managed-catalogs.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import type { FreeCodeGoSpeechRouteInput, FreeCodeGoSpeechStatus, FreeCodeGoSpeechTest, FreeCodeGoSpeechTestReason } from './types.ts'

/**
 * Narrow view of the plugin surface these two calls need.
 *
 * The readiness readers are callables rather than values because they answer about
 * state that moves while the Host runs — the switch, and a roster that is mounted
 * and unmounted by another plugin. A captured `false` would be a card that keeps
 * claiming a microphone is unserved after it started working.
 */
export interface SpeechRouteHost {
  /** The Host credential vault; absent before it mounts, which is a refusal to write. */
  readonly credentials: CredentialProvider | undefined
  /** The catalog runtime, which owns the route's three stored values. */
  readonly catalogs: FreeCodeGoManagedCatalogs
  /** Whether this plugin's recognizer switch is on. */
  readonly voiceInputEnabled: () => boolean
  /** Whether the Harness speech registry currently holds this plugin's recognizer. */
  readonly registered: () => boolean
  /** The recognizer the Harness has selected, or `''` when no registry is mounted. */
  readonly selected: () => string
  /** Re-decide the registration against the route as it now stands. */
  readonly refresh: () => Promise<void>
}

/**
 * Read the route the microphone would use, and where it stands with the Harness.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the browser-safe projection of the current route.
 */
export async function speechStatus(host: SpeechRouteHost): Promise<FreeCodeGoSpeechStatus> {
  const route = await host.catalogs.groqWhisperRoute()
  return {
    enabled: host.voiceInputEnabled(),
    hasKey: route.apiKey !== undefined,
    baseUrl: route.baseUrl,
    model: route.model,
    custom: route.custom,
    registered: host.registered(),
    selected: host.selected(),
  }
}

/**
 * Store the recognizer route, then bring the registration in line with it.
 *
 * An absent field is left alone and an empty string clears it, which is how one card
 * saves three inputs and one button restores the defaults. Values are validated
 * *before* anything is written and the whole write is refused on the first bad one:
 * a half-applied patch would leave the stored route describing a request the user
 * never composed, and the error they see would name a field whose value was in fact
 * discarded.
 *
 * The key is checked for printable ASCII only, the same shape the sibling provider
 * keys use (`vyceSetKey`, `nvidiaSetKey`): a key with a newline or a full-width
 * character is a paste accident, and one that reached a header would fail as an
 * opaque 401 from a provider rather than as a field the user can fix here.
 * @param host - the Host surface this remote call reaches its services through.
 * @param input - the fields the card saved; omitted fields are unchanged.
 * @returns the route as it stands after the write.
 */
export async function speechSetRoute(host: SpeechRouteHost, input: FreeCodeGoSpeechRouteInput): Promise<FreeCodeGoSpeechStatus> {
  const credentials = host.credentials
  if (credentials === undefined) throw new Error('Credential provider is not configured')
  const key = input.apiKey?.trim()
  if (key !== undefined && key !== '' && !/^[\x21-\x7E]+$/u.test(key)) throw new Error('Speech API key contains invalid characters')
  const endpoint = input.baseUrl === undefined || input.baseUrl.trim() === '' ? undefined : speechEndpoint(input.baseUrl)
  if (input.baseUrl !== undefined && input.baseUrl.trim() !== '' && endpoint === undefined) {
    throw new Error('Speech endpoint must be an http(s) URL, for example https://api.groq.com/openai/v1')
  }
  const model = input.model?.trim()
  if (model !== undefined && model !== '' && speechModelId(model) === undefined) throw new Error('Speech model id contains invalid characters')

  if (input.apiKey !== undefined) {
    if (key === undefined || key === '') await credentials.unset(GROQ_WHISPER_API_KEY_REF)
    else await credentials.set(GROQ_WHISPER_API_KEY_REF, key)
  }
  if (input.baseUrl !== undefined) {
    if (endpoint === undefined) await credentials.unset(GROQ_WHISPER_BASE_URL_REF)
    else await credentials.set(GROQ_WHISPER_BASE_URL_REF, endpoint)
  }
  if (input.model !== undefined) {
    if (model === undefined || model === '') await credentials.unset(GROQ_WHISPER_MODEL_REF)
    else await credentials.set(GROQ_WHISPER_MODEL_REF, model)
  }
  await host.refresh()
  return speechStatus(host)
}

/**
 * How long the probe waits for the recognizer to answer.
 *
 * Longer than a healthy transcription of a half-second clip by a wide margin, because
 * the failure this has to distinguish from a slow provider is a *silent* network — and
 * a probe that gave up where the microphone would have succeeded would report a
 * working route as unreachable. Shorter than the transcription tool's own two
 * minutes, so the card can say something while the user is still looking at it.
 */
export const SPEECH_TEST_TIMEOUT_MS = 30_000

/**
 * The probe recording: half a second of digital silence, as canonical 16 kHz mono
 * PCM16 WAV.
 *
 * Silence on purpose. A recognizer asked about silence answers with the empty string
 * or with its own hallucination — both are a *successful* round trip, which is the
 * only thing this probe is about; and a fixed byte string keeps the answer a function
 * of the route rather than of anything the user recorded. The bytes are what the
 * Harness's own Remote controller would send, so a route that accepts this probe is
 * one the microphone can drive.
 * @param seconds - how long the clip should be; a half second is enough to reach the recognizer's
 *   own validation without spending a request on audio nobody will read.
 * @returns the WAV file's bytes.
 */
export function probeWave(seconds = 0.5): Uint8Array {
  const samples = Math.max(1, Math.round(16_000 * seconds))
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

/**
 * Classify one response, so the card can say what to do about it.
 *
 * The four named statuses are the four fixes: 401 is the key, 404 is the address or
 * the model id, 403 is a key the provider refused *or* a network that blocks the
 * provider (the two are one status from here — see the card's own sentence), and
 * everything else is upstream's problem to state in its own body.
 * @param status - the HTTP status the endpoint returned.
 * @returns the reason code for it.
 */
function reasonForStatus(status: number): FreeCodeGoSpeechTestReason {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  return 'provider-error'
}

/**
 * Post one silent recording through the configured route and report what happened.
 *
 * Why this is a remote and not something the card infers
 * -----------------------------------------------------
 * Every fact the card used to show was a *configuration* fact — a key resolves, a
 * switch is on, the registry holds us — and all of them were true on the machine
 * where dictation still failed. A configuration can be complete and the route still
 * be unusable, because the last step is the network: this deployment's recognizer is
 * `api.groq.com`, and a host whose outbound traffic must leave through a proxy that
 * the process does not know about reaches nothing there at all (Node's `fetch`
 * ignores the Windows proxy setting, which is why the browser may reach a provider
 * this process cannot). That failure arrived at the user as a download prompt and no
 * explanation, twice. This is the one question that separates the two halves: it
 * *sends something*, so the answer is about the route rather than about the vault.
 *
 * The probe reads the stored route rather than the card's unsaved fields, because it
 * is answering about the route the microphone would use — and the card disables the
 * button while the fields are dirty rather than testing a request nobody has saved.
 *
 * The key is never returned, and the response body only ever travels redacted and
 * bounded: a provider that echoed the request would otherwise put a live secret into
 * the settings page and into any transcript of it.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the outcome, the status when one arrived, and the route it used.
 */
export async function speechTest(host: SpeechRouteHost): Promise<FreeCodeGoSpeechTest> {
  const route = await host.catalogs.groqWhisperRoute()
  const base = { baseUrl: route.baseUrl, model: route.model }
  if (route.apiKey === undefined) {
    return { ...base, ok: false, reason: 'unauthorized', detail: 'No speech recognizer key is configured' }
  }
  const form = new FormData()
  form.set('model', route.model)
  form.set('response_format', 'json')
  // The same shape `groqWhisperTranscribe` builds a file from: a `Buffer` whose own
  // bytes are sliced out, because a `Uint8Array` view over a possibly-shared backing
  // store is not a `BlobPart`.
  const audio = Buffer.from(probeWave())
  const payload = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
  form.set('file', new Blob([payload], { type: 'audio/wav' }), 'probe.wav')
  let response: Response
  try {
    response = await fetch(`${route.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${route.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(SPEECH_TEST_TIMEOUT_MS),
    })
  } catch (error: unknown) {
    // Nothing answered: a filtered connection, a DNS failure, a timeout. Not "no key"
    // and not "bad model" — the message says so, because the fix is elsewhere and a
    // card that guessed here would send the user to change a value that is correct.
    const detail = error instanceof Error ? error.message : String(error)
    return { ...base, ok: false, reason: 'unreachable', detail: redactCredentialShapes(detail).slice(0, 300) }
  }
  const reason = reasonForStatus(response.status)
  if (reason === 'ok') return { ...base, ok: true, reason, status: response.status, detail: '' }
  const body = await response.text().catch(() => '')
  return { ...base, ok: false, reason, status: response.status, detail: redactCredentialShapes(body).slice(0, 300) }
}
