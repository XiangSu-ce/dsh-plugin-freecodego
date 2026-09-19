/**
 * Account, backend, inference, and provider-key remotes for the FreeCodeGo
 * Harness plugin: browser-safe authentication snapshots, redacted backend
 * snapshots, provider API-key storage, Logfare registration, and the Groq
 * Whisper transcription relay. The plugin class satisfies the narrow host
 * view below; members that map to plugin methods delegate back to the live
 * instance so instance-level overrides (tests, future remotes) keep working.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/account-remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { FreeCodeGoAccountCoordinator, FreeCodeGoApiClient } from '@deepseek-ai/dsh-freecodego-api'
import type { FreeCodeGoAccountSnapshot, FreeCodeGoBackendSnapshot, FreeCodeGoDeviceSessions, FreeCodeGoLogfareRegistrationRequest, FreeCodeGoLogfareStatus, FreeCodeGoLoginRequest, FreeCodeGoManagedCatalog, FreeCodeGoNvidiaStatus, FreeCodeGoRegistrationRequest, FreeCodeGoSenseNovaStatus, FreeCodeGoVyceStatus, ClineDeviceLogin, ClineLoginPoll, ClineStatus, WorkBuddyBrowserLogin, WorkBuddyInternationalAccount, WorkBuddyInternationalAccountInfo, WorkBuddyInternationalStatus, WorkBuddyLoginPoll } from './types.ts'
import type { WorkBuddyPoolService } from './workbuddy-pool.ts'
import type { ClineClient } from './cline.ts'
import { accountIdentity, accountSnapshot, backendNotConfigured } from './account-utils.ts'
import { importWorkBuddyDesktopCredential } from './workbuddy-intl-auth.ts'
import { parseWorkBuddyAuthState, parseWorkBuddyLoginAccount, parseWorkBuddyLoginPoll, type WorkBuddyDeviceAuthorization } from './workbuddy-intl.ts'
import { openUrlInSystemBrowser } from './system-browser.ts'
import { generateOAuthLoginState, oauthHandoffPollUrl, oauthPendingActionUrl, oauthPendingStatusUrl, oauthPollRejection, OAUTH_HANDOFF_STATE_HEADER, OAUTH_LOGIN_POLL_INTERVAL_MS, OAUTH_LOGIN_POLL_REQUEST_TIMEOUT_MS, OAUTH_LOGIN_POLL_TIMEOUT_MS, parseOAuthHandoffPoll, parseOAuthPendingRegistration, pluginOAuthStartUrl, type OAuthLoginPendingRegistration, type OAuthLoginProvider } from './oauth-login.ts'
import { toJsonValue } from './engineering-remote-utils.ts'
import { record, text } from './media-generation.ts'
import { WORKBUDDY_INTL_AUTH_PLATFORM, WORKBUDDY_INTL_AUTH_STATE_URL, WORKBUDDY_INTL_AUTH_USER_AGENT, WORKBUDDY_INTL_LOGIN_ACCOUNT_URL, WORKBUDDY_INTL_TOKEN_POLL_URL, WORKBUDDY_LOGIN_STATE_TTL_MS } from './managed-catalog-utils.ts'
import { enrichCatalogChoices, managedCatalogGroups, mergeCatalogModels } from './model-catalog.ts'
import {
  GROQ_WHISPER_BASE_URL, GROQ_WHISPER_MODEL,
  LOGFARE_API_KEY_REF, LOGFARE_CATALOG_TIMEOUT_MS, LOGFARE_REGISTER_URL, LOGFARE_SESSION_REF,
  logfareResponseError, logfareSessionCookie,
  NVIDIA_API_KEY_REF, NVIDIA_BASE_URL,
  SENSENOVA_API_KEY_REF, SENSENOVA_BASE_URL,
  VYCE_API_KEY_REF, VYCE_MODELS,
} from './managed-catalog-utils.ts'
import type { FreeCodeGoManagedCatalogs } from './managed-catalogs.ts'
import { redactCredentialShapes } from './secret-scan.ts'

/**
 * The upload name's extension, read off the media type so the two halves of one
 * request cannot disagree.
 *
 * This used to be a chain of `includes` tests whose fallback was `mp3`, while the
 * tool derived the media type from the file's extension with a *different* list —
 * so a `.flac` recording went out as `type: audio/flac` next to
 * `filename: recording.mp3`, and an OpenAI-compatible transcriber reads the
 * container off the name. The subtype is now the extension, except where the
 * subtype is not one: `mpeg`/`mp3` are `mp3`, and `mp4`/`x-m4a` are `m4a`.
 * @param mimeType - the validated `audio/<subtype>` this request declares.
 */
function audioExtension(mimeType: string): string {
  const subtype = mimeType.slice(mimeType.indexOf('/') + 1).toLowerCase()
  if (subtype === 'mpeg' || subtype === 'mp3') return 'mp3'
  if (subtype === 'mp4' || subtype === 'm4a' || subtype === 'x-m4a') return 'm4a'
  return /^[a-z0-9]{1,8}$/u.test(subtype) ? subtype : 'mp3'
}

/**
 * Upstream text on its way into an error message, redacted first.
 *
 * Every provider and backend message this module surfaces goes through here.
 * The requests those messages describe carry credentials — the Groq key in an
 * Authorization header, the pending-account email and password in the body —
 * so a backend that echoes what it rejected would otherwise put a live secret
 * into the UI error and into any transcript of it. The message is bounded by
 * the caller; this only removes credential shapes.
 */
function upstreamMessage(value: unknown, fallback: string): string {
  const message = typeof value === 'string' ? value.trim() : ''
  return redactCredentialShapes(message === '' ? fallback : message)
}

/**
 * Mutable per-instance coordination state for the durable account-restore.
 * The plugin instance owns this object and hands it out through its
 * `accountRemotesHost` accessor; the extracted implementations mutate it in
 * place so the in-flight restore promise and completion flag keep their
 * original semantics.
 */
export interface AccountRemotesState {
  /** In-flight durable-session restore, deduplicating concurrent restores. */
  restorePromise: Promise<void> | undefined
  /** Whether a durable session has already been restored successfully. */
  restoreCompleted: boolean
  /**
   * Handoff state of the browser sign-in whose federated identity landed in a
   * pending registration.
   *
   * It is the only handle this Host has on that pending session: the OAuth
   * callback set the pending-session cookies on the browser it opened, not on
   * this process, so the completion calls present this state instead. It stays
   * Host-side, because the browser must never hold a credential for it.
   */
  pendingOAuthState: string | undefined
}

/**
 * Narrow view of the plugin surface required by the account, backend, and
 * provider-key remotes. The plugin satisfies it through its
 * `accountRemotesHost` accessor.
 */
export interface AccountRemotesHost {
  readonly ctx: Context
  readonly account: FreeCodeGoAccountCoordinator | undefined
  readonly api: FreeCodeGoApiClient | undefined
  readonly credentials: CredentialProvider | undefined
  /** Host-only Cline account pool; absent before the credential vault mounts. */
  readonly cline: ClineClient | undefined
  /** Pool maintenance for WorkBuddy: credits and the daily check-in. */
  readonly workbuddyPool: WorkBuddyPoolService | undefined
  readonly catalogs: FreeCodeGoManagedCatalogs
  readonly state: AccountRemotesState
  readonly restoreAccount: () => Promise<void>
  readonly logfareStatus: () => Promise<FreeCodeGoLogfareStatus>
  readonly sensenovaStatus: () => Promise<FreeCodeGoSenseNovaStatus>
  readonly nvidiaStatus: () => Promise<FreeCodeGoNvidiaStatus>
}

export async function accountStatus(host: AccountRemotesHost): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined || host.api === undefined) return { status: 'backend-not-configured' }
  try {
    await host.restoreAccount()
  } catch (error) {
    // A revoked/removed vault session is an expected signed-out state after
    // refresh-token rotation. Do not fail the whole settings surface: return
    // a browser-safe auth state so the login form remains available.
    if (host.account.snapshot().status === 'reauth-required') return accountSnapshot(host.account.snapshot())
    if (await host.account.hasStoredSession()) {
      // Startup networking must not make an encrypted, durable session look
      // like a logout. The settings client retries this state in background.
      return { status: 'restoring' }
    }
    if (error instanceof Error && /FreeCodeGo authentication is required(?: after (?:token refresh|unauthorized response))?/i.test(error.message)) return { status: 'signed-out' }
    throw error
  }
  const current = host.account.snapshot()
  if (current.status === 'mfa-required' || current.status === 'reauth-required') return accountSnapshot(current)
  // Refresh the browser-safe identity after a Host restart. The vault is
  // the source of truth; no password is retained or rehydrated.
  try {
    const user = await host.account.withAccessToken(accessToken => host.api!.getCurrentUser({ accessToken }))
    const identity = accountIdentity(user)
    host.account.setAuthenticated(identity)
    return { status: 'authenticated', user: identity }
  } catch (error) {
    const status = error !== null && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined
    if (status === 401 || status === 403 || (error instanceof Error && /FreeCodeGo authentication is required|unauthori[sz]ed|invalid token|token expired/i.test(error.message))) return { status: 'reauth-required' }
    throw error
  }
}

/** Fetch the existing `/auth/me` profile through the Host vault. */
export async function accountDetail(host: AccountRemotesHost): Promise<FreeCodeGoBackendSnapshot> {
  if (host.api === undefined || host.account === undefined) return { status: 'backend-not-configured' }
  try {
    await host.restoreAccount()
    const data = await host.account.withAccessToken(accessToken => host.api!.getCurrentUser({ accessToken }))
    return { status: 'available', data: toJsonValue(data) }
  } catch (error) {
    if (error instanceof Error && /FreeCodeGo authentication is required(?: after (?:token refresh|unauthorized response))?/i.test(error.message)) return { status: 'signed-out' }
    return { status: 'error', message: upstreamMessage(error instanceof Error ? error.message : String(error), 'account details request failed') }
  }
}

export async function register(host: AccountRemotesHost, input: FreeCodeGoRegistrationRequest): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  const result = await host.account.register(input)
  host.state.restoreCompleted = true
  const snapshot = await confirmAccountAuthorization(host, result)
  // A new session changes the resolvable model directory: notify the UI the
  // same way logout does so the login-required badge clears immediately.
  host.ctx.emit('llm/adapters-updated')
  return snapshot
}

export async function sendVerifyCode(host: AccountRemotesHost, email: string): Promise<{ readonly countdown: number }> {
  if (host.account === undefined) throw backendNotConfigured()
  return host.account.sendVerifyCode(email)
}

export async function login(host: AccountRemotesHost, input: FreeCodeGoLoginRequest): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  // `remember === false` keeps the issued pair out of the credential file for
  // this process: the coordinator holds it in memory and erases any session an
  // earlier remembered login left on disk.
  const result = await host.account.login({ ...input, ...(input.remember === undefined ? {} : { remember: input.remember }) })
  host.state.restoreCompleted = true
  const snapshot = await confirmAccountAuthorization(host, result)
  // Signed-in routes (FreeCodeGo gateway, Logfare auto model, …) resolve only
  // after login; republish adapters so model menus drop the login badge now.
  host.ctx.emit('llm/adapters-updated')
  return snapshot
}

export async function completeMfa(host: AccountRemotesHost, totpCode: string, deviceId?: string): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  const result = await host.account.completeMfa(totpCode, deviceId)
  host.state.restoreCompleted = true
  const snapshot = await confirmAccountAuthorization(host, result)
  // MFA completion finally stores the session; treat it like a fresh login for
  // the browser model directory.
  host.ctx.emit('llm/adapters-updated')
  return snapshot
}

export async function refreshAccount(host: AccountRemotesHost, deviceId?: string): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  await host.account.refresh(deviceId)
  host.state.restoreCompleted = true
  const snapshot = await confirmAccountAuthorization(host, host.account.snapshot())
  // A token rotation can also switch the effective account: keep the browser
  // adapter list in sync with the live vault identity.
  host.ctx.emit('llm/adapters-updated')
  return snapshot
}

export async function logout(host: AccountRemotesHost): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  host.state.pendingOAuthState = undefined
  await host.account.logout()
  host.ctx.emit('llm/adapters-updated')
  host.catalogs.invalidateGatewayHealth()
  host.state.restoreCompleted = false
  return accountSnapshot(host.account.snapshot())
}

/** Return the existing backend model directory without exposing access tokens. */
export async function backendCatalog(host: AccountRemotesHost): Promise<FreeCodeGoManagedCatalog> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  try {
    await host.restoreAccount()
    const resolved = await host.account.withAccessToken(async (accessToken) => {
      const catalog = await host.api!.getCatalog({ accessToken })
      // One read of `/models/options` yields both the per-model choices and the
      // account's groups. The groups are what the picker groups by, so dropping
      // them here is what left the list headed by a model's vendor instead of
      // the plan it is bought through.
      const snapshot = await host.api!.getModelOptionsSnapshot({ accessToken }).catch(() => ({ groups: [], models: [] }))
      // Filter the gateway-owned rows FIRST, then merge the dynamic Logfare
      // media rows: `mergeCatalogModels` drops every `logfare/` id, so running
      // it after the merge silently deleted the image/video/audio models (and
      // the written cache lost them with it).
      const gatewayModels = mergeCatalogModels(enrichCatalogChoices(catalog.models, snapshot.models))
      const groups = managedCatalogGroups(snapshot.groups)
      return await host.catalogs.withDynamicMediaCatalog({ ...catalog, ...(groups.length === 0 ? {} : { groups }), models: gatewayModels })
    })
    await host.catalogs.writeManagedCatalogCache(resolved)
    return resolved
  } catch (error) {
    // Catalog metadata is browser-safe and has its own durable cache. A
    // transient identity refresh failure must not erase selectable models.
    const cached = await host.catalogs.readManagedCatalogCache()
    if (cached !== undefined) return host.catalogs.withDynamicMediaCatalog({ ...cached, models: mergeCatalogModels(cached.models) })
    // Direct media providers remain independent of a FreeCodeGo login.
    // Return their redacted directory even when no gateway cache exists.
    const local = await host.catalogs.withDynamicMediaCatalog({ catalogRevision: 'local-media', models: [] })
    if (local.models.length > 0) return local
    throw error
  }
}

export async function vyceStatus(host: AccountRemotesHost): Promise<FreeCodeGoVyceStatus> {
  return {
    configured: (await host.catalogs.vyceApiKey()) !== undefined,
    models: VYCE_MODELS.map(model => ({ id: model.id, name: model.name })),
  }
}

export async function vyceSetKey(host: AccountRemotesHost, value: string): Promise<FreeCodeGoVyceStatus> {
  if (host.credentials === undefined) throw new Error('Credential provider is not configured')
  const normalized = value.trim()
  if (normalized !== '' && !/^[\x21-\x7E]+$/.test(normalized)) throw new Error('VyceAI API key contains invalid characters')
  if (normalized === '') await host.credentials.unset(VYCE_API_KEY_REF)
  else await host.credentials.set(VYCE_API_KEY_REF, normalized)
  host.ctx.emit('llm/adapters-updated')
  return vyceStatus(host)
}

export async function groqWhisperTranscribe(host: AccountRemotesHost, audioBase64: string, mimeType: string, language?: string): Promise<{ readonly text: string; readonly model: string }> {
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0 || audioBase64.length > 36_000_000) throw new Error('Groq audio payload is invalid or exceeds 27 MB')
  if (typeof mimeType !== 'string' || !/^audio\/[A-Za-z0-9.+-]+$/u.test(mimeType)) throw new Error('Groq audio MIME type is invalid')
  const bytes = Buffer.from(audioBase64, 'base64')
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/u, '') !== audioBase64.replace(/=+$/u, '')) throw new Error('Groq audio payload is not canonical base64')
  const form = new FormData()
  form.set('model', GROQ_WHISPER_MODEL)
  form.set('response_format', 'json')
  // The caller's hint travels as given, trimmed. The guard this replaces kept
  // `[A-Za-z-]{2,16}`, which forwarded `chinese` — a value no provider reads as a
  // code — and discarded `zh_Hans`, `pt-BR ` and `  en` without a word in the
  // result, so the caller believed a hint it never got. It was therefore neither a
  // vocabulary check nor a syntax check: it kept the nonsense and dropped the
  // plausible. This tool's schema declares no vocabulary for the value, which
  // makes the caller's request the only contract there is, and a value the
  // provider cannot read is answered by the provider — loudly, which is the
  // outcome a caller can act on.
  if (typeof language === 'string' && language.trim() !== '') form.set('language', language.trim())
  const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  form.set('file', new Blob([audio], { type: mimeType }), `recording.${audioExtension(mimeType)}`)
  const apiKey = await host.catalogs.groqWhisperApiKey()
  if (apiKey === undefined) throw new Error('Groq Whisper API key is not configured')
  const response = await fetch(`${GROQ_WHISPER_BASE_URL}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) })
  const value = record(await response.json().catch(() => ({})))
  if (!response.ok) {
    const detail = typeof value.error === 'object' ? text(record(value.error).message) ?? 'provider error' : text(value.error) ?? 'provider error'
    throw new Error(`Groq Whisper transcription failed (HTTP ${response.status}): ${upstreamMessage(detail, 'provider error')}`)
  }
  const transcript = text(value.text)
  if (transcript === undefined) throw new Error('Groq Whisper returned no transcript')
  return { text: transcript, model: GROQ_WHISPER_MODEL }
}

/** Return Logfare readiness and the current standard/premium model counts without exposing secrets. */
export async function logfareStatus(host: AccountRemotesHost): Promise<FreeCodeGoLogfareStatus> {
  const [key, session, models, trainingOptIn] = await Promise.all([
    host.catalogs.logfareApiKey(),
    host.catalogs.logfareSession(),
    host.catalogs.refreshLogfareModels(),
    host.catalogs.logfareTrainingOptIn(),
  ])
  const standard = models.filter(model => model.tier === 1)
  const premiumModels = models.filter(model => model.tier === 2 && model.requiresTrainingOptIn)
  return {
    configured: key !== undefined,
    sessionConfigured: session !== undefined,
    trainingOptIn,
    premiumUnlocked: trainingOptIn || premiumModels.some(model => model.premiumUnlocked),
    standardModelCount: standard.length,
    premiumModelCount: premiumModels.length,
    // The names come from the same resolution that produced the counts, so the
    // panel can never describe a different catalogue than the one it counted.
    standardModelNames: standard.map(model => model.name),
    premiumModelNames: premiumModels.map(model => model.name),
  }
}

/** Store or clear a user-provided Logfare key without ever returning its value. */
export async function logfareSetKey(host: AccountRemotesHost, value: string): Promise<FreeCodeGoLogfareStatus> {
  if (host.credentials === undefined) throw new Error('Credential provider is not configured')
  const normalized = value.trim()
  if (normalized !== '' && !/^[\x21-\x7E]+$/.test(normalized)) throw new Error('FreeCodeGo model access key contains invalid characters')
  if (normalized === '') await host.credentials.unset(LOGFARE_API_KEY_REF)
  else await host.credentials.set(LOGFARE_API_KEY_REF, normalized)
  // A manually pasted key may belong to another Logfare account, so never
  // reuse a prior account's consent session with it.
  await host.credentials.unset(LOGFARE_SESSION_REF)
  host.catalogs.invalidateLogfareCatalog()
  host.ctx.emit('llm/adapters-updated')
  return host.logfareStatus()
}

/** Create one user-confirmed Logfare account and save its issued API key in the Host vault. */
export async function logfareRegister(host: AccountRemotesHost, input: FreeCodeGoLogfareRegistrationRequest): Promise<FreeCodeGoLogfareStatus> {
  if (host.credentials === undefined) throw new Error('Credential provider is not configured')
  const username = typeof input?.username === 'string' ? input.username.trim() : ''
  const password = typeof input?.password === 'string' ? input.password : ''
  if (!/^[A-Za-z0-9-]{3,64}$/.test(username)) throw new Error('FreeCodeGo account name must contain 3-64 letters, numbers, or hyphens')
  if (password.length < 8 || password.length > 256) throw new Error('FreeCodeGo account password must contain 8-256 characters')
  if (!input?.tosAccepted || ! input?.ageConfirmed) throw new Error('Confirm FreeCodeGo age and terms requirements before creating an account')
  const response = await fetch(LOGFARE_REGISTER_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'FreeCodeGo-Harness' },
    body: JSON.stringify({ username, password, tos_accepted: true, age_confirmed: true }),
    signal: AbortSignal.timeout(LOGFARE_CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(await logfareResponseError(response, 'FreeCodeGo model access registration failed'))
  const payload = record(await response.json())
  const apiKey = typeof payload.api_key === 'string' ? payload.api_key.trim() : ''
  if (apiKey === '') throw new Error('FreeCodeGo registration did not return a model access key')
  await host.credentials.set(LOGFARE_API_KEY_REF, apiKey)
  const session = logfareSessionCookie(response)
  if (session !== undefined) await host.credentials.set(LOGFARE_SESSION_REF, session)
  host.catalogs.invalidateLogfareCatalog()
  if (input.trainingOptIn) await host.catalogs.updateLogfareTrainingPreference(true)
  host.ctx.emit('llm/adapters-updated')
  return host.logfareStatus()
}

/** Apply the user's explicit, reversible Logfare training preference. */
export async function logfareSetTrainingOptIn(host: AccountRemotesHost, enabled: boolean): Promise<FreeCodeGoLogfareStatus> {
  if (typeof enabled !== 'boolean') throw new Error('FreeCodeGo training preference must be a boolean')
  await host.catalogs.updateLogfareTrainingPreference(enabled)
  host.ctx.emit('llm/adapters-updated')
  // Delegate to the one projection that owns this shape: deriving the counts
  // and names here as well is how the two views drift apart.
  return host.logfareStatus()
}

/** Return only whether a SenseNova key is configured in the Host. */
export async function sensenovaStatus(host: AccountRemotesHost): Promise<FreeCodeGoSenseNovaStatus> {
  const key = await host.catalogs.sensenovaApiKey()
  return { configured: key !== undefined, baseUrl: SENSENOVA_BASE_URL }
}

/** Store or clear the SenseNova key without returning its value. */
export async function sensenovaSetKey(host: AccountRemotesHost, value: string): Promise<FreeCodeGoSenseNovaStatus> {
  if (host.credentials === undefined) throw new Error('Credential provider is not configured')
  const normalized = value.trim()
  if (normalized !== '' && !/^[\x21-\x7E]+$/.test(normalized)) throw new Error('SenseNova API key contains invalid characters')
  if (normalized === '') await host.credentials.unset(SENSENOVA_API_KEY_REF)
  else await host.credentials.set(SENSENOVA_API_KEY_REF, normalized)
  host.catalogs.invalidateSenseNovaCatalog()
  host.ctx.emit('llm/adapters-updated')
  return host.sensenovaStatus()
}

/** Return only whether an NVIDIA key is configured in the Host. */
export async function nvidiaStatus(host: AccountRemotesHost): Promise<FreeCodeGoNvidiaStatus> {
  const key = await host.catalogs.nvidiaApiKey()
  return { configured: key !== undefined, baseUrl: NVIDIA_BASE_URL }
}

/** Store or clear the NVIDIA key without returning its value. */
export async function nvidiaSetKey(host: AccountRemotesHost, value: string): Promise<FreeCodeGoNvidiaStatus> {
  if (host.credentials === undefined) throw new Error('Credential provider is not configured')
  const normalized = value.trim()
  if (normalized !== '' && !/^[\x21-\x7E]+$/.test(normalized)) throw new Error('NVIDIA API key contains invalid characters')
  if (normalized === '') await host.credentials.unset(NVIDIA_API_KEY_REF)
  else await host.credentials.set(NVIDIA_API_KEY_REF, normalized)
  host.catalogs.invalidateNvidiaCatalog()
  host.ctx.emit('llm/adapters-updated')
  return host.nvidiaStatus()
}

/** Return the existing FreeCodeGo bootstrap snapshot through a redacted Remote. */
export async function backendBootstrap(host: AccountRemotesHost): Promise<FreeCodeGoBackendSnapshot> {
  if (host.api === undefined || host.account === undefined) return { status: 'backend-not-configured' }
  try {
    await host.restoreAccount()
    const data = await host.account.withAccessToken(accessToken => host.api!.getBootstrap({ accessToken }))
    return { status: 'available', data: toJsonValue(data) }
  } catch (error) {
    return { status: 'error', message: upstreamMessage(error instanceof Error ? error.message : String(error), 'bootstrap request failed') }
  }
}

/** Return the existing backend quota snapshot without exposing credentials. */
export async function backendQuota(host: AccountRemotesHost): Promise<FreeCodeGoBackendSnapshot> {
  if (host.api === undefined || host.account === undefined) return { status: 'backend-not-configured' }
  try {
    await host.restoreAccount()
    const data = await host.account.withAccessToken(accessToken => host.api!.getQuota({ accessToken }))
    return { status: 'available', data: toJsonValue(data) }
  } catch (error) {
    return { status: 'error', message: upstreamMessage(error instanceof Error ? error.message : String(error), 'quota request failed') }
  }
}

/** Return existing backend runtime health. */
export async function backendRuntimeHealth(host: AccountRemotesHost): Promise<FreeCodeGoBackendSnapshot> {
  if (host.api === undefined || host.account === undefined) return { status: 'backend-not-configured' }
  try {
    await host.restoreAccount()
    const data = await host.account.withAccessToken(accessToken => host.api!.getRuntimeHealth({ accessToken }))
    return { status: 'available', data: toJsonValue(data) }
  } catch (error) {
    return { status: 'error', message: upstreamMessage(error instanceof Error ? error.message : String(error), 'runtime health request failed') }
  }
}

export async function backendUsage(host: AccountRemotesHost, days: number): Promise<FreeCodeGoBackendSnapshot> {
  if (host.api === undefined || host.account === undefined) return { status: 'backend-not-configured' }
  try {
    await host.restoreAccount()
    const data = await host.account.withAccessToken(accessToken => host.api!.getUsage({ accessToken, days }))
    return { status: 'available', data: toJsonValue(data) }
  } catch (error) {
    return { status: 'error', message: upstreamMessage(error instanceof Error ? error.message : String(error), 'usage request failed') }
  }
}

export function restoreAccount(host: AccountRemotesHost): Promise<void> {
  const state = host.state
  if (state.restoreCompleted) return Promise.resolve()
  if (state.restorePromise !== undefined) return state.restorePromise
  if (host.account === undefined) return Promise.resolve()
  state.restorePromise = (async () => {
    const hydrateIdentity = async (accessToken: string): Promise<void> => {
      const user = await host.api!.getCurrentUser({ accessToken })
      host.account!.setAuthenticated(accountIdentity(user))
    }
    try {
      await host.account!.withAccessToken(hydrateIdentity)
      state.restoreCompleted = true
    } catch (error) {
      // Do not silently downgrade to an old access token. The caller sees
      // the refresh failure and can explicitly retry or sign in again.
      throw error
    }
  })().finally(() => { state.restorePromise = undefined })
  return state.restorePromise
}

/** Confirm a newly stored OAuth/password session against the live account route.
 * Login responses are accepted only after the same bearer token can read
 * `/auth/me`; this keeps the UI's authenticated state aligned with the
 * authorization actually usable by plugin requests. */
async function confirmAccountAuthorization(
  host: AccountRemotesHost,
  result: ReturnType<FreeCodeGoAccountCoordinator['snapshot']>,
): Promise<FreeCodeGoAccountSnapshot> {
  if (result.status !== 'authenticated' || host.account === undefined || host.api === undefined) return accountSnapshot(result)
  const user = await host.account.withAccessToken(accessToken => host.api!.getCurrentUser({ accessToken }))
  const identity = accountIdentity(user)
  host.account.setAuthenticated(identity)
  return accountSnapshot(host.account.snapshot())
}

/**
 * List the account's desktop device sessions.
 *
 * The backend marks one row as `current`; without a locally persisted device id
 * it falls back to the most recent active session, which is also what the
 * returned `currentDeviceId` reports.
 */
export async function deviceSessions(host: AccountRemotesHost): Promise<FreeCodeGoDeviceSessions> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.getDeviceSessions({ accessToken }))
}

/** Revoke one device session, then return the refreshed listing. */
export async function revokeDeviceSession(host: AccountRemotesHost, deviceId: string): Promise<FreeCodeGoDeviceSessions> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  const id = deviceId.trim()
  if (id === '') throw new Error('FreeCodeGo device id is required')
  await host.restoreAccount()
  // Revoking is idempotent enough to replay after a 401: the rejected request
  // never reached the session store, so a retry cannot revoke a second session.
  await host.account.withAccessToken(accessToken => host.api!.revokeDeviceSession({ accessToken, deviceId: id }))
  return deviceSessions(host)
}

/** Revoke every session of the account and report how many the backend revoked. */
export async function revokeAllSessions(host: AccountRemotesHost): Promise<number> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  // This revokes the caller's own session too, so nothing may read the account
  // afterwards; the caller refreshes the account snapshot instead.
  return host.account.withAccessToken(accessToken => host.api!.revokeAllSessions({ accessToken }))
}

// ============================================================================
// Cline (api.cline.bot)
// ============================================================================

/** Cline account state. Absent before the Host credential vault mounts. */
function requireCline(host: AccountRemotesHost): ClineClient {
  if (host.cline === undefined) throw new Error('CLINE_NOT_CONFIGURED: Cline credentials are not configured')
  return host.cline
}


/**
 * Browser-safe Cline pool plus the live free-model directory.
 *
 * The directory is read from the same feed the adapter serves, so the card and
 * the picker can never disagree about which free routes exist. Usage rides
 * along as a best-effort extra: an upstream failure there degrades to an empty
 * panel instead of failing the whole status read.
 */
export async function clineStatus(host: AccountRemotesHost): Promise<ClineStatus> {
  const client = requireCline(host)
  const accounts = await client.accounts()
  const freeModels = await client.freeModels()
  if (accounts.length === 0) return { status: 'signed-out', accounts: [], freeModels }
  const active = accounts.find(account => account.status === 'active') ?? accounts[0]!
  const usage = await client.usage()
  return {
    status: 'authenticated',
    accounts,
    activeAccountId: active.id,
    ...(active.email === undefined ? {} : { email: active.email }),
    freeModels,
    usage,
  }
}

/**
 * Start a device login and open the verification page in the user's browser.
 *
 * Opening the page is the part users read as "the button did something": the
 * ticket is fetched first so the URL exists, and a failed open never fails the
 * login itself — the card still renders the manual link and the user code.
 */
export async function clineStartLogin(host: AccountRemotesHost): Promise<ClineDeviceLogin> {
  const ticket = await requireCline(host).startDeviceLogin()
  await openUrlInSystemBrowser(ticket.verificationUrl).catch(() => false)
  return ticket
}

/** One device-login poll. `pending` means the browser step is unfinished. */
export async function clinePollLogin(host: AccountRemotesHost, deviceCode: string): Promise<ClineLoginPoll> {
  const pending = await requireCline(host).pollDeviceLogin(deviceCode)
  if (pending) return { pending: true }
  host.ctx.emit('llm/adapters-updated')
  return { pending: false, state: await clineStatus(host) }
}

/** Add (or replace) one account from a Cline refresh token. */
export async function clineAddAccount(host: AccountRemotesHost, refreshToken: string): Promise<ClineStatus> {
  await requireCline(host).addAccountFromRefreshToken(refreshToken)
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

/** Remove one account from the rotation. */
export async function clineRemoveAccount(host: AccountRemotesHost, accountId: string): Promise<ClineStatus> {
  await requireCline(host).removeAccount(accountId)
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

/** Refresh one account, or every account when no id is given. */
export async function clineRefresh(host: AccountRemotesHost, accountId?: string): Promise<ClineStatus> {
  await requireCline(host).refreshAccounts(accountId)
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

/** Remove every Cline account. */
export async function clineLogout(host: AccountRemotesHost): Promise<ClineStatus> {
  await requireCline(host).logout()
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

// ============================================================================
// WorkBuddy International Edition (workbuddy.ai)
// ============================================================================

/**
 * One account's stored credit position, in the browser-safe shape.
 *
 * Present only once a sweep has looked: an account that was just imported has
 * no credit row, which the card renders as "not queried yet" rather than as a
 * balance of zero.
 */
function workbuddyCreditsInfo(account: WorkBuddyInternationalAccount): WorkBuddyInternationalAccountInfo['credits'] {
  if (account.creditCheckedAt === undefined && account.creditRemaining === undefined && account.creditError === undefined) return undefined
  const expiresAt = account.creditExpiresAt
  return {
    total: account.creditTotal,
    remaining: account.creditRemaining ?? 0,
    used: account.creditUsed ?? 0,
    ...(expiresAt === undefined ? {} : { soonestExpireAt: expiresAt }),
    expiringSoon: account.creditExpiringSoon === true,
    expired: expiresAt !== undefined && expiresAt <= Date.now(),
    checkedAt: account.creditCheckedAt ?? 0,
    ...(account.creditError === undefined ? {} : { error: account.creditError }),
  }
}

/** Return browser-safe WorkBuddy International account and free-model state. */
export async function workbuddyStatus(host: AccountRemotesHost): Promise<WorkBuddyInternationalStatus> {
  const accounts = await host.catalogs.workbuddyAccounts()
  if (accounts.length === 0) return { configured: false, accounts: [], freeModels: [] }
  // The account the user chose wins while it is still there and able to serve;
  // recomputing the selection from the pool ignored the card's own write, so
  // "Use this account" left the badge where it was. A selection that names a
  // removed row (or one whose token no longer exists) falls back to the pool.
  const selected = await host.catalogs.workbuddyActiveAccountId()
  const chosen = selected === undefined ? undefined : accounts.find(account => account.id === selected && account.accessToken.trim() !== '')
  const active = chosen ?? accounts.find(a => a.accessToken.trim() !== '') ?? accounts[0]!
  const freeModels = await host.catalogs.workbuddyFreeModels()
  return {
    configured: true,
    activeAccountId: active.id,
    accounts: accounts.map((account) => {
      const credits = workbuddyCreditsInfo(account)
      return {
        id: account.id,
        ...(account.email === undefined ? {} : { email: account.email }),
        apiKeyConfigured: account.accessToken.trim() !== '',
        ...(credits === undefined ? {} : { credits }),
      }
    }),
    freeModels,
    ...(host.workbuddyPool?.busy === true ? { sweepInProgress: true } : {}),
  }
}

/**
 * Import the WorkBuddy International desktop sign-in as one pool account.
 *
 * The email/password form is gone: the supported flow is "sign in once in the
 * WorkBuddy desktop app (or its web sign-in), then import here", which is how
 * the rest of the ecosystem reads WorkBuddy credentials. The import reuses the
 * existing account shape, so refresh and rotation keep working unchanged.
 */
export async function workbuddyImportDesktopLogin(host: AccountRemotesHost): Promise<WorkBuddyInternationalStatus> {
  const result = await importWorkBuddyDesktopCredential()
  if (!result.ok) throw new Error(`WORKBUDDY_IMPORT_FAILED: ${result.message}`)
  await host.catalogs.workbuddyImportAccount({
    accessToken: result.credential.accessToken,
    ...(result.credential.refreshToken === '' ? {} : { refreshToken: result.credential.refreshToken }),
    expiresAt: result.credential.expiresAtMs,
    ...(result.credential.nickname === undefined ? {} : { email: result.credential.nickname }),
    ...(result.credential.uid === '' ? {} : { id: result.credential.uid, uid: result.credential.uid }),
    // The desktop file is the one source that always states the login domain
    // and the uid, and both are what the chat host routes on.
    ...(result.credential.domain === '' ? {} : { domain: result.credential.domain }),
    ...(result.credential.enterpriseId === undefined ? {} : { enterpriseId: result.credential.enterpriseId }),
  })
  host.catalogs.invalidateWorkbuddyCatalog()
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/**
 * Ask the product for a device-authorization grant.
 *
 * `POST /v2/plugin/auth/state` is the only way to obtain a pollable state: it
 * mints the `state` *and* the `authUrl` the browser must open. The gateway
 * splits this path by User-Agent, so the CLI identity is sent rather than the
 * plugin's own name.
 */
async function requestWorkbuddyDeviceAuthorization(): Promise<WorkBuddyDeviceAuthorization> {
  const response = await fetch(`${WORKBUDDY_INTL_AUTH_STATE_URL}?platform=${WORKBUDDY_INTL_AUTH_PLATFORM}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'user-agent': WORKBUDDY_INTL_AUTH_USER_AGENT,
    },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  })
  const grant = parseWorkBuddyAuthState(await response.json().catch(() => ({})))
  if (grant === undefined) {
    throw new Error(`WORKBUDDY_LOGIN_FAILED: 无法向 WorkBuddy 申请授权（HTTP ${response.status}）。 Could not start the WorkBuddy authorization (HTTP ${response.status}).`)
  }
  return grant
}

/** Open the WorkBuddy International sign-in page in the user's browser. */
export async function workbuddyOpenSignIn(_host: AccountRemotesHost): Promise<{ readonly opened: boolean; readonly url: string }> {
  const grant = await requestWorkbuddyDeviceAuthorization()
  const opened = await openUrlInSystemBrowser(grant.authUrl).catch(() => false)
  return { opened, url: grant.authUrl }
}

/**
 * Start a WorkBuddy International browser authorization.
 *
 * The upstream flow is server-issued: `POST /v2/plugin/auth/state` answers with
 * a `state` and the `authUrl` to open ("platform=CLI"), the browser sign-in
 * records the issued tokens under that state, and the plugin polls
 * `GET /v2/plugin/auth/token?state=<it>` until it stops saying code 11217
 * (`login ing...`). This Remote requests the grant, opens the URL in the system
 * browser, and returns the ticket for polling.
 *
 * The state must be the one the server minted: a client-side state cannot be
 * bound to the browser step, because the login page 302s into Keycloak, which
 * rewrites the callback URI without the caller's query — the poll then answers
 * "still signing in" forever and the card never receives the account.
 */
export async function workbuddyStartBrowserLogin(_host: AccountRemotesHost): Promise<WorkBuddyBrowserLogin> {
  const grant = await requestWorkbuddyDeviceAuthorization()
  const opened = await openUrlInSystemBrowser(grant.authUrl).catch(() => false)
  return {
    state: grant.state,
    loginUrl: grant.authUrl,
    expiresAt: Date.now() + WORKBUDDY_LOGIN_STATE_TTL_MS,
    ...(opened ? {} : { note: 'BROWSER_OPEN_FAILED' }),
  }
}

/**
 * One authenticated identity read for a state that just issued tokens.
 *
 * Best effort: the uid is both the pool key and the `X-User-Id` the host routes
 * by, so it is worth one call when the token payload did not state it.
 */
async function workbuddyLoginAccount(state: string, accessToken: string): Promise<ReturnType<typeof parseWorkBuddyLoginAccount>> {
  try {
    const response = await fetch(`${WORKBUDDY_INTL_LOGIN_ACCOUNT_URL}?state=${encodeURIComponent(state)}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': WORKBUDDY_INTL_AUTH_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return {}
    return parseWorkBuddyLoginAccount(await response.json().catch(() => ({})))
  } catch {
    return {}
  }
}

/**
 * Poll one WorkBuddy authorization.
 *
 * One poll per call so the Settings page owns the cadence. `11217:login ing...`
 * means the user has not finished signing in; anything else with a `data`
 * payload is the issued credential pair, which lands in the same pool the
 * desktop import uses.
 */
export async function workbuddyPollBrowserLogin(host: AccountRemotesHost, state: string): Promise<WorkBuddyLoginPoll> {
  const trimmed = state.trim()
  if (trimmed === '') throw new Error('WORKBUDDY_LOGIN_FAILED: state is required')
  const response = await fetch(`${WORKBUDDY_INTL_TOKEN_POLL_URL}?state=${encodeURIComponent(trimmed)}`, {
    headers: { 'X-No-Authorization': 'true', 'user-agent': WORKBUDDY_INTL_AUTH_USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  const result = parseWorkBuddyLoginPoll(await response.json().catch(() => ({})))
  if (result.kind === 'pending') return { pending: true }
  if (result.kind === 'failed') throw new Error(`WORKBUDDY_LOGIN_FAILED: ${result.message}`)
  const { ticket } = result
  const identity = ticket.uid === undefined ? await workbuddyLoginAccount(trimmed, ticket.accessToken) : {}
  const uid = ticket.uid ?? identity.uid
  await host.catalogs.workbuddyImportAccount({
    accessToken: ticket.accessToken,
    ...(ticket.refreshToken === undefined ? {} : { refreshToken: ticket.refreshToken }),
    expiresAt: ticket.expiresAt,
    // The uid is both the pool key and the `X-User-Id` the host routes by.
    ...(uid === undefined ? {} : { id: uid, uid }),
    ...(ticket.domain === undefined ? {} : { domain: ticket.domain }),
    ...((ticket.enterpriseId ?? identity.enterpriseId) === undefined ? {} : { enterpriseId: (ticket.enterpriseId ?? identity.enterpriseId)! }),
    // The card has one human-readable field; prefer a real address over a
    // display name, but show something when only the latter was issued.
    ...((ticket.email ?? ticket.nickname ?? identity.email ?? identity.nickname) === undefined ? {} : { email: (ticket.email ?? ticket.nickname ?? identity.email ?? identity.nickname)! }),
  })
  host.catalogs.invalidateWorkbuddyCatalog()
  host.ctx.emit('llm/adapters-updated')
  return { pending: false, state: await workbuddyStatus(host) }
}

/** Logout from WorkBuddy International, clearing all stored accounts. */
export async function workbuddyLogout(host: AccountRemotesHost): Promise<WorkBuddyInternationalStatus> {
  host.catalogs.clearWorkbuddyAccounts()
  host.catalogs.invalidateWorkbuddyCatalog()
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** Remove a specific WorkBuddy account by ID. */
export async function workbuddyRemoveAccount(host: AccountRemotesHost, accountId: string): Promise<WorkBuddyInternationalStatus> {
  await host.catalogs.workbuddyRemoveAccount(accountId)
  host.catalogs.invalidateWorkbuddyCatalog()
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** Set the active WorkBuddy account by ID. */
export async function workbuddySetActiveAccount(host: AccountRemotesHost, accountId: string): Promise<WorkBuddyInternationalStatus> {
  await host.catalogs.workbuddySetActiveAccount(accountId)
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** Refresh WorkBuddy access token using refresh token. */
export async function workbuddyRefreshToken(host: AccountRemotesHost, refreshToken: string): Promise<{ readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number }> {
  const result = await host.catalogs.workbuddyRefreshToken(refreshToken)
  // Update the account with new tokens - for simplicity, we replace all accounts
  // The caller should manage which account to update
  return result
}

/** Refresh credit information for all WorkBuddy accounts. */
export async function workbuddyRefreshCredits(host: AccountRemotesHost): Promise<WorkBuddyInternationalStatus> {
  await workbuddyPool(host).run()
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** The pool maintenance service, required for every sweep-shaped Remote. */
function workbuddyPool(host: AccountRemotesHost): WorkBuddyPoolService {
  if (host.workbuddyPool === undefined) throw new Error('WORKBUDDY_NOT_CONFIGURED: WorkBuddy credentials are not configured')
  return host.workbuddyPool
}

// ============================================================================
// FreeCodeGo federated sign-in (GitHub / Google via browser handoff)
// ============================================================================

/**
 * Run one browser-mediated FreeCodeGo OAuth sign-in to completion.
 *
 * The Host opens the provider authorization page in the system browser with a
 * client-owned handoff state, then polls the backend handoff endpoint until
 * the provider callback delivers the token pair. On success the pair is
 * adopted into the Host credential vault (confirmed against `/auth/me` by the
 * coordinator) and the browser-safe snapshot is returned; the tokens
 * themselves never cross back over the Remote boundary.
 *
 * This Remote intentionally blocks until the flow finishes so the Settings
 * card keeps its existing single-call contract; the UI renders a busy state
 * while the browser step is pending.
 */
// Membership rather than two `!==` guards: the guards narrowed `provider` to
// `never` at the throw, which erases the value the message has to name.
const OAUTH_LOGIN_PROVIDERS: readonly OAuthLoginProvider[] = ['google', 'github']

export async function accountOAuthLogin(host: AccountRemotesHost, provider: OAuthLoginProvider): Promise<FreeCodeGoAccountSnapshot> {
  if (!OAUTH_LOGIN_PROVIDERS.includes(provider)) throw new Error(`OAUTH_PROVIDER_UNSUPPORTED:${provider}`)
  if (host.account === undefined || host.api === undefined) throw backendNotConfigured()
  const state = generateOAuthLoginState()
  // A new sign-in supersedes the previous flow's pending handle: that session is
  // finished or abandoned, and completing it under a later flow's state would
  // switch which session the completion calls address.
  host.state.pendingOAuthState = undefined
  const loginUrl = pluginOAuthStartUrl(host.account.origin, provider, state)
  const opened = await openUrlInSystemBrowser(loginUrl).catch(() => false)
  if (!opened) {
    // No browser means no path to the provider; fail loudly with the URL in
    // the message so the user can still finish the flow manually.
    throw new Error(`OAUTH_BROWSER_OPEN_FAILED: open ${loginUrl} in a browser to sign in with ${provider}`)
  }

  const deadline = Date.now() + OAUTH_LOGIN_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`OAUTH_LOGIN_TIMEOUT: ${provider} sign-in was not completed in time`)
    await new Promise(resolve => setTimeout(resolve, OAUTH_LOGIN_POLL_INTERVAL_MS))
    const response = await fetch(oauthHandoffPollUrl(host.account.origin, state), {
      headers: { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' },
      signal: AbortSignal.timeout(OAUTH_LOGIN_POLL_REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => { throw new Error(`OAUTH_LOGIN_POLL_FAILED: ${upstreamMessage(error instanceof Error ? error.message : String(error), 'poll failed')}`) })
    // A backend without the handoff route would otherwise be polled for the
    // whole window; report the missing wire immediately instead.
    if (response.status === 404) throw new Error('OAUTH_HANDOFF_UNSUPPORTED: the configured backend does not offer the browser sign-in handoff')
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    // A poll that was refused is not "still pending": see `oauthPollRejection`.
    const rejection = oauthPollRejection(response.status, body)
    if (rejection !== undefined) throw new Error(`OAUTH_LOGIN_POLL_FAILED: ${upstreamMessage(rejection, 'sign-in was refused')}`)
    const parsed = parseOAuthHandoffPoll(body)
    if (parsed.kind === 'pending') continue
    if (parsed.kind === 'failed') throw new Error(`OAUTH_LOGIN_FAILED: ${upstreamMessage(parsed.message, 'sign-in failed')}`)
    // The provider profile could not map onto an existing account (new email
    // or invitation required). The browser step closed without issuing a
    // pair; surface the pending registration so the Settings card can finish
    // it over the JSON completion endpoints.
    if (parsed.kind === 'pending-registration') {
      // Remember the state before surfacing the registration: the completion
      // calls that follow carry it, and this polling loop is the only place
      // that knows it.
      //
      // The state travels through `pendingOAuthState`, not through this
      // message. `oauth-login.ts` documents it as "the *sole* key that the
      // public poll endpoint resolves an issued token pair with", so pasting it
      // into an error that the Settings card displays and the session records
      // is a credential handle leaving the process — and it had no reader
      // there: the card's parser starts at the first `{`, and the completion
      // steps read the field above. The sibling completion path below never
      // included it, so the two now agree.
      host.state.pendingOAuthState = state
      throw new Error(`OAUTH_REGISTRATION_REQUIRED:${JSON.stringify(parsed.registration)}`)
    }

    host.state.restoreCompleted = true
    const result = await host.account.adoptExternalSession(parsed.tokens, async (accessToken, signal) => {
      const user = await host.api!.getCurrentUser({ accessToken, ...(signal === undefined ? {} : { signal }) })
      return accountIdentity(user)
    })
    const snapshot = await confirmAccountAuthorization(host, result)
    // Federated sign-in resolves the same signed-in routes as the password
    // login, so the browser model directory must drop the login badge now.
    host.ctx.emit('llm/adapters-updated')
    return snapshot
  }
}

// ============================================================================
// Pending federated registration completion (headless JSON flow)
// ============================================================================

/**
 * Fetch for one backend-pending endpoint, addressed by this Host's handoff
 * state.
 *
 * The pending session is keyed by the cookies the OAuth callback set on the
 * browser the sign-in was opened in, which this process never receives, so the
 * backend resolves the stored credentials from the state the Host minted. A
 * backend that does not know the state answers `PENDING_AUTH_SESSION_NOT_FOUND`
 * and nothing else changes.
 */
async function oauthPendingFetch(
  host: AccountRemotesHost,
  url: string,
  init: { readonly method: 'GET' | 'POST'; readonly body?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  if (host.account === undefined) throw backendNotConfigured()
  const state = host.state.pendingOAuthState
  const response = await fetch(url, {
    method: init.method,
    headers: {
      accept: 'application/json',
      'user-agent': 'FreeCodeGo-Harness',
      ...(state === undefined ? {} : { [OAUTH_HANDOFF_STATE_HEADER]: state }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(OAUTH_LOGIN_POLL_REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => { throw new Error(`OAUTH_PENDING_REQUEST_FAILED: ${upstreamMessage(error instanceof Error ? error.message : String(error), 'request failed')}`) })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`OAUTH_PENDING_FAILED: ${upstreamMessage(payload.message, `HTTP ${response.status}`)}`)
  }
  // The standard envelope is {code, data}; flat bodies are accepted too.
  const data = payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : payload
  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new Error(`OAUTH_PENDING_FAILED: ${upstreamMessage(payload.message, `code ${payload.code}`)}`)
  }
  return data
}

/** Read the pending registration the browser step left behind. */
export async function accountOAuthPendingStatus(host: AccountRemotesHost): Promise<OAuthLoginPendingRegistration | undefined> {
  if (host.account === undefined) throw backendNotConfigured()
  const payload = await oauthPendingFetch(host, oauthPendingStatusUrl(host.account.origin), { method: 'GET' })
  return parseOAuthPendingRegistration(payload)
}

/** Send the registration verification email for the pending session. */
export async function accountOAuthPendingSendVerifyCode(host: AccountRemotesHost, email: string): Promise<{ readonly countdown: number }> {
  if (host.account === undefined) throw backendNotConfigured()
  const payload = await oauthPendingFetch(host, oauthPendingActionUrl(host.account.origin, 'verify-code'), { method: 'POST', body: { email } })
  const countdown = typeof payload.countdown === 'number' && Number.isFinite(payload.countdown) && payload.countdown > 0 ? payload.countdown : 60
  return { countdown }
}

/** Flat token pair inside one completion response (JSON, machine client). */
function oauthPendingTokens(payload: Record<string, unknown>): { accessToken: string; refreshToken: string; expiresIn: number } | undefined {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token.trim() : ''
  if (accessToken === '' || refreshToken === '') return undefined
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? payload.expires_in : 3600
  return { accessToken, refreshToken, expiresIn }
}

/** Adopt one completion token pair into the Host vault, like the poll path. */
async function adoptOAuthCompletionTokens(host: AccountRemotesHost, tokens: { accessToken: string; refreshToken: string; expiresIn: number }): Promise<FreeCodeGoAccountSnapshot> {
  // The pending session is consumed by the completion that just succeeded, so
  // its state must not address a later flow.
  host.state.pendingOAuthState = undefined
  host.state.restoreCompleted = true
  const result = await host.account!.adoptExternalSession({ ...tokens, tokenType: 'Bearer' }, async (accessToken, signal) => {
    const user = await host.api!.getCurrentUser({ accessToken, ...(signal === undefined ? {} : { signal }) })
    return accountIdentity(user)
  })
  const snapshot = await confirmAccountAuthorization(host, result)
  host.ctx.emit('llm/adapters-updated')
  return snapshot
}

/** Bind the pending federated identity to an existing password account. */
export async function accountOAuthPendingBind(host: AccountRemotesHost, input: { readonly email: string; readonly password: string; readonly totpCode?: string }): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined || host.api === undefined) throw backendNotConfigured()
  const payload = await oauthPendingFetch(host, oauthPendingActionUrl(host.account.origin, 'bind-login'), {
    method: 'POST',
    body: { email: input.email, password: input.password, ...(input.totpCode === undefined || input.totpCode.trim() === '' ? {} : { totpCode: input.totpCode.trim() }) },
  })
  if (payload.requires_2fa === true) throw new Error('OAUTH_PENDING_2FA_REQUIRED')
  const tokens = oauthPendingTokens(payload)
  if (tokens === undefined) throw new Error(`OAUTH_PENDING_FAILED: ${upstreamMessage(payload.message, 'completion did not return a session')}`)
  return adoptOAuthCompletionTokens(host, tokens)
}

/** Create a new account from the pending federated identity. */
export async function accountOAuthPendingCreate(
  host: AccountRemotesHost,
  input: { readonly email: string; readonly password: string; readonly verifyCode?: string; readonly invitationCode?: string },
): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined || host.api === undefined) throw backendNotConfigured()
  const payload = await oauthPendingFetch(host, oauthPendingActionUrl(host.account.origin, 'create-account'), {
    method: 'POST',
    body: {
      email: input.email,
      password: input.password,
      ...(input.verifyCode === undefined || input.verifyCode.trim() === '' ? {} : { verify_code: input.verifyCode.trim() }),
      ...(input.invitationCode === undefined || input.invitationCode.trim() === '' ? {} : { invitation_code: input.invitationCode.trim() }),
    },
  })
  // An email collision flips the session back to the chooser; report the
  // new payload instead of a generic failure.
  if (typeof payload.step === 'string') {
    const registration = parseOAuthPendingRegistration(payload)
    if (registration !== undefined) throw new Error(`OAUTH_REGISTRATION_REQUIRED:${JSON.stringify(registration)}`)
  }
  const tokens = oauthPendingTokens(payload)
  if (tokens === undefined) throw new Error(`OAUTH_PENDING_FAILED: ${upstreamMessage(payload.message, 'completion did not return a session')}`)
  return adoptOAuthCompletionTokens(host, tokens)
}
