// Web e2e scenario: this plugin's cloud recognizer, served into the Harness's own
// voice input on a real booted Host.
//
// Why this file exists
// --------------------
// The plugin no longer ships a microphone. It registers a `cloud` recognizer onto
// `ctx.speechToText` — the registry owned by the optional
// `@deepseek-ai/dsh-experimental-voice-input-bundle` — and the whole user-visible
// feature is that registry's own 识别服务 picker, the Harness's Remote controller,
// and the Harness's composer button. Every one of those belongs to another package,
// so an upstream update can move the seam without touching this repository: the
// service could be renamed, the provider contract could grow a `preparation`, or
// the bundle could stop shipping a local model. The failure mode would be the
// user's — a download prompt that should not be there, or a picker with no
// no-download option in it.
//
// `harness-plugin/tests/upstream-seam-contracts.spec.ts` pins the *text* of those
// seams; `harness-plugin/tests/speech-provider.spec.ts` pins this plugin's half
// against a double. This file pins the *behaviour* on the real thing: the provider
// really lands in the real roster, the real switch really moves it, and the real
// selection is really repaired when it leaves.
//
// What is asserted, and why each one
// ----------------------------------
// - **The roster gains this plugin's recognizer beside the Harness's own**, with
//   `location: 'cloud'` and a readiness phase that is *not* `unprepared`. That pair
//   is the whole feature: `client-ui-voice-input`'s `needsInstallation` expression
//   is `location === 'host-local' && preparation.phase === 'unprepared'`, so neither
//   conjunct can hold for this provider and the "使用语音输入前需要安装" prompt is
//   unreachable while it is the selection.
// - **The selection is left alone.** Registering is not electing: the composition's
//   own default stays selected until the user picks ours in the picker. Reading this
//   back on a real Host is the point — a plugin that pointed the default at itself
//   would break dictation on every composition where it then declined to register.
// - **The switch withdraws and re-registers live**, through the same remote the
//   settings page drives, with no Host restart between the two reads.
// - **A selection that named this plugin is handed back** when it withdraws, and the
//   registry's own `resolve` is the reason: it throws for an id it does not hold, so
//   leaving the selection behind would not disable our recognizer — it would break
//   every other one.
//
// The voice bundle is mounted *after* the plugin, on purpose. A user reaching the
// Harness's plugin page and switching 语音输入 on is exactly this ordering, and it is
// the case a one-shot service read at boot would leave permanently dead.
//
// The credential is the environment's, not a stored one: the scaffold pins an
// isolated `$DSH_HOME`, and `groqWhisperApiKey` resolves
// `GROQ_WHISPER_API_KEY` as its documented fallback. That is what makes this
// scenario hermetic — no keychain is touched, and the value is restored afterwards.
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const FREECODEGO_BUNDLE = fileURLToPath(new URL('../../../packages/freecodego/bundle-latest', import.meta.url))

/** The bundle that owns the registry, the Remote controller and the composer button. */
const OFFICIAL_VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'

/** The provider id this plugin registers, and the one that bundle ships. */
const OUR_PROVIDER_ID = 'freecodego'
const LOCAL_PROVIDER_ID = 'sensevoice-local'

/** The credential the plugin's transcriber resolves, and its environment fallback. */
const GROQ_KEY_VARIABLE = 'GROQ_WHISPER_API_KEY'
const GROQ_KEY_FIXTURE = 'freecodego-e2e-groq-key'

/**
 * One provider as the registry reports it to its clients.
 *
 * `preparation` is present for every provider in a snapshot: the registry fills in
 * `{ phase: 'ready' }` for a provider that declares none, which is the shape the
 * client's install prompt reads.
 */
interface SpeechProviderFacts {
  readonly id: string
  readonly name: string
  readonly location: string
  readonly preparation: { readonly phase: string }
}

interface SpeechSnapshot {
  readonly providers: readonly SpeechProviderFacts[]
  readonly selection: { readonly providerId: string; readonly language: string }
}

/**
 * The services this scenario reaches by name.
 *
 * `speechToText` is the Harness's own and is typed by its package; the plugin side
 * is declared narrowly here because `packages/freecodego/**` is excluded from the
 * host program (it checks through its own configs), so the plugin's `Context`
 * augmentation is not in scope. The two methods below are the whole contract this
 * file reads, which keeps the cast honest: a rename on the plugin side fails one
 * line here instead of silently widening an `any`.
 */
interface VoiceHost {
  readonly pluginManager: {
    setBundleEnabled(bundle: string, enabled: boolean): Promise<{ error?: string }>
  }
  readonly freeCodeGoHarness: {
    capabilitiesSetEnabled(input: { readonly voiceInputEnabled?: boolean }): Promise<unknown>
  }
}

/** The plugin-owned services, reached by name through the settled context. */
function pluginHost(scaffold: WebScaffold): VoiceHost {
  return scaffold.ctx as unknown as VoiceHost
}

/** The Harness speech registry, which exists only while its bundle is mounted. */
function registry(scaffold: WebScaffold): { snapshot(): SpeechSnapshot, configure(patch: { readonly providerId: string }): Promise<void> } {
  const service = (scaffold.ctx as unknown as { readonly speechToText?: { snapshot(): SpeechSnapshot, configure(patch: { readonly providerId: string }): Promise<void> } }).speechToText
  expect(service, 'the official voice bundle should have provided speechToText').toBeDefined()
  return service as { snapshot(): SpeechSnapshot, configure(patch: { readonly providerId: string }): Promise<void> }
}

/**
 * Poll until `read` answers, because a provider registry is state another fiber
 * settles: registration, withdrawal and the injected service's own arrival are all
 * asynchronous, and a fixed sleep would either be flaky or pointless.
 * @param read - the observation, `undefined` while it is not true yet.
 * @param what - what was being waited for, for the timeout message.
 * @returns the first defined answer.
 */
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** This plugin's own facts from one snapshot, or `undefined` while it is absent. */
function ourProvider(scaffold: WebScaffold): SpeechProviderFacts | undefined {
  return registry(scaffold).snapshot().providers.find(provider => provider.id === OUR_PROVIDER_ID)
}

/** Flip this plugin's own switch, which is the remote the settings page drives. */
async function setRecognizer(scaffold: WebScaffold, enabled: boolean): Promise<void> {
  await pluginHost(scaffold).freeCodeGoHarness.capabilitiesSetEnabled({ voiceInputEnabled: enabled })
}

describe('web e2e: this plugin\'s recognizer inside the Harness\'s voice input', () => {
  let scaffold: WebScaffold
  let originalKey: string | undefined

  beforeAll(async () => {
    originalKey = process.env[GROQ_KEY_VARIABLE]
    process.env[GROQ_KEY_VARIABLE] = GROQ_KEY_FIXTURE
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
    })
    // Mounted after the plugin started: the ordering a user produces by switching
    // 语音输入 on in the Harness's own plugin page.
    const enabled = await pluginHost(scaffold).pluginManager.setBundleEnabled(OFFICIAL_VOICE_BUNDLE, true)
    expect(enabled.error).toBeUndefined()
    await until(() => ourProvider(scaffold), 'this plugin to register its recognizer')
  }, 180_000)

  afterAll(async () => {
    await scaffold?.close().catch(() => undefined)
    if (originalKey === undefined) Reflect.deleteProperty(process.env, GROQ_KEY_VARIABLE)
    else process.env[GROQ_KEY_VARIABLE] = originalKey
  })

  it('offers a no-download recognizer beside the Harness\'s own', () => {
    const snapshot = registry(scaffold).snapshot()
    const ours = snapshot.providers.find(provider => provider.id === OUR_PROVIDER_ID)
    const local = snapshot.providers.find(provider => provider.id === LOCAL_PROVIDER_ID)
    expect(ours?.location).toBe('cloud')
    // The prompt's second conjunct, as the client would read it: a provider with no
    // `preparation` of its own is reported as ready, never as unprepared.
    expect(ours?.preparation.phase).not.toBe('unprepared')
    expect(local, 'the bundle should still ship its own recognizer').toBeDefined()
  })

  it('leaves the composition\'s own recognizer selected', () => {
    // Registering is not electing. The user's own gesture in the 识别服务 picker is
    // the only thing that moves this, and a plugin that moved it would break
    // dictation wherever it then declined to register.
    expect(registry(scaffold).snapshot().selection.providerId).toBe(LOCAL_PROVIDER_ID)
  })

  it('leaves the roster live when the plugin\'s own switch goes off', async () => {
    await setRecognizer(scaffold, false)
    await until(() => ourProvider(scaffold) === undefined ? true : undefined, 'this plugin\'s recognizer to leave the roster')
    const snapshot = registry(scaffold).snapshot()
    expect(snapshot.providers.map(provider => provider.id)).toEqual([LOCAL_PROVIDER_ID])
  })

  it('serves again, without a restart, when the switch goes back on', async () => {
    await setRecognizer(scaffold, true)
    const ours = await until(() => ourProvider(scaffold), 'this plugin\'s recognizer to come back')
    expect(ours.location).toBe('cloud')
  })

  it('hands the selection back to the Harness\'s recognizer when it withdraws', async () => {
    // The state the registry refuses to serve: its `resolve` throws
    // `Speech provider is unavailable: <id>` for a selection it does not hold, so a
    // withdrawal that left the user's selection on this plugin would break
    // dictation on every other recognizer. Selecting ours is the user's own gesture
    // in the picker, performed here through the registry's own API.
    await registry(scaffold).configure({ providerId: OUR_PROVIDER_ID })
    expect(registry(scaffold).snapshot().selection.providerId).toBe(OUR_PROVIDER_ID)

    await setRecognizer(scaffold, false)
    const selection = await until(
      () => registry(scaffold).snapshot().selection.providerId === OUR_PROVIDER_ID ? undefined : registry(scaffold).snapshot(),
      'the selection to come off this plugin',
    )
    expect(selection.selection.providerId).toBe(LOCAL_PROVIDER_ID)
    expect(selection.providers.map(provider => provider.id)).toEqual([LOCAL_PROVIDER_ID])
  })
})
