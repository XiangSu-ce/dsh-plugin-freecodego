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
import { randomUUID } from 'node:crypto'
import type { FreeCodeGoAccountSnapshot, FreeCodeGoBackendSnapshot, FreeCodeGoCheckinReport, FreeCodeGoDeviceSessions, FreeCodeGoLogfareRegistrationRequest, FreeCodeGoLogfareStatus, FreeCodeGoLoginRequest, FreeCodeGoManagedCatalog, FreeCodeGoNvidiaStatus, FreeCodeGoRegistrationRequest, FreeCodeGoSenseNovaStatus, FreeCodeGoVyceStatus, ClineDeviceLogin, ClineLoginPoll, ClineStatus, QoderBrowserLogin, QoderLoginPoll, QoderStatus, TraeModel, TraeStatus, WorkBuddyBrowserLogin, WorkBuddyInternationalAccount, WorkBuddyInternationalAccountInfo, WorkBuddyInternationalStatus, WorkBuddyLoginPoll } from './types.ts'
import { buildTraeLoginUrl, TRAE_LOGIN_STATE_TTL_MS, traeCallbackUrl } from './trae/endpoints.ts'
import { startTraeCallbackListener, type TraeCallbackListener } from './trae/callback-server.ts'
import { exchangeTraeToken, parseTraeCallback, traeAccountFromLogin, traeMachineIdentity } from './trae/login.ts'
import type { TraeLoginAttempt } from './trae/types.ts'
import { traeAccountSnapshot, type TraeClient } from './trae-intl.ts'
import { traeRealmOf } from './trae/realms.ts'
import type { QoderClient } from './qoder-intl.ts'
import { qoderAccountInfo } from './qoder-intl.ts'
import { fetchQoderPlan, fetchQoderUserInfo, pollQoderDeviceToken, qoderAccountIdFromUserInfo, qoderIdentityFromUserInfo, startQoderLogin, type QoderLoginAttempt } from './qoder/oauth.ts'
import type { WorkBuddyPoolService } from './workbuddy-pool.ts'
import type { ClineClient } from './cline.ts'
import { accountIdentity, accountSnapshot, backendNotConfigured } from './account-utils.ts'
import { importWorkBuddyDesktopCredential } from './workbuddy-intl-auth.ts'
import { parseWorkBuddyAuthState, parseWorkBuddyLoginAccount, parseWorkBuddyLoginPoll, type WorkBuddyDeviceAuthorization } from './workbuddy-intl.ts'
import { openUrlInSystemBrowser } from './system-browser.ts'
import { generateOAuthLoginState, oauthHandoffPollUrl, oauthPendingActionUrl, oauthPendingStatusUrl, oauthPollRejection, OAUTH_HANDOFF_STATE_HEADER, OAUTH_LOGIN_POLL_INTERVAL_MS, OAUTH_LOGIN_POLL_REQUEST_TIMEOUT_MS, OAUTH_LOGIN_POLL_TIMEOUT_MS, parseOAuthHandoffPoll, parseOAuthPendingRegistration, pluginOAuthStartUrl, type OAuthLoginPendingRegistration, type OAuthLoginProvider } from './oauth-login.ts'
import { toJsonValue } from './engineering-remote-utils.ts'
import { asRecord as record, asString as text } from './untrusted-json.ts'
import { WORKBUDDY_INTL_AUTH_PLATFORM, WORKBUDDY_INTL_AUTH_STATE_URL, WORKBUDDY_INTL_AUTH_USER_AGENT, WORKBUDDY_INTL_LOGIN_ACCOUNT_URL, WORKBUDDY_INTL_TOKEN_POLL_URL, WORKBUDDY_LOGIN_STATE_TTL_MS } from './managed-catalog-utils.ts'
import { enrichCatalogChoices, managedCatalogGroups, mergeCatalogModels } from './model-catalog.ts'
import {
  GROQ_WHISPER_BASE_URL, GROQ_WHISPER_MODEL,
  LOGFARE_API_KEY_REF, LOGFARE_CATALOG_TIMEOUT_MS, LOGFARE_REGISTER_URL, LOGFARE_SESSION_REF,
  logfareResponseError, logfareSessionCookie,
  NVIDIA_API_KEY_REF, NVIDIA_BASE_URL,
  SENSENOVA_API_KEY_REF, SENSENOVA_BASE_URL,
  VYCE_API_KEY_REF, VYCE_MODEL_PREFIX,
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
  /** Host-only Qoder account pool; absent before the credential vault mounts. */
  readonly qoder: QoderClient | undefined
  /** Host-only TRAE account pool; absent before the credential vault mounts. */
  readonly trae: TraeClient | undefined
  /** Pool maintenance for WorkBuddy: credits and the daily check-in. */
  readonly workbuddyPool: WorkBuddyPoolService | undefined
  readonly catalogs: FreeCodeGoManagedCatalogs
  readonly state: AccountRemotesState
  readonly restoreAccount: () => Promise<void>
  readonly logfareStatus: () => Promise<FreeCodeGoLogfareStatus>
  readonly sensenovaStatus: () => Promise<FreeCodeGoSenseNovaStatus>
  readonly nvidiaStatus: () => Promise<FreeCodeGoNvidiaStatus>
}

/**
 * Read the account state the settings surface renders.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the account snapshot.
 */
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

/** Fetch the existing `/auth/me` profile through the Host vault. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the backend Snapshot.
 */
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

/**
 * Create an account and sign in with the credentials just registered.
 * @param host - the Host surface this remote call reaches its services through.
 * @param input - registration details and the remember-me intent of this attempt.
 * @returns the account snapshot after the sign-in.
 */
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

/**
 * Send the registration verification code to one address.
 * @param host - the Host surface this remote call reaches its services through.
 * @param email - the address the code is sent to.
 * @returns the countdown a resend control waits for.
 */
export async function sendVerifyCode(host: AccountRemotesHost, email: string): Promise<{ readonly countdown: number }> {
  if (host.account === undefined) throw backendNotConfigured()
  return host.account.sendVerifyCode(email)
}

/**
 * Sign in with a password, keeping the issued tokens in the Host vault.
 * @param host - the Host surface this remote call reaches its services through.
 * @param input - credentials and the remember-me intent of this attempt.
 * @returns the account snapshot after the sign-in.
 */
export async function login(host: AccountRemotesHost, input: FreeCodeGoLoginRequest): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  // `remember === false` keeps the issued pair out of the credential file for
  // this process: the coordinator holds it in memory and erases any session an
  // earlier remembered login left on disk.
  // `rememberPassword` is a second, independent intent: unticking it has to
  // erase a password an earlier attempt stored, so it is forwarded even when
  // false — unlike `remember`, whose absent value means "leave the mode alone".
  const result = await host.account.login({
    ...input,
    ...(input.remember === undefined ? {} : { remember: input.remember }),
    ...(input.rememberPassword === undefined ? {} : { rememberPassword: input.rememberPassword }),
  })
  host.state.restoreCompleted = true
  const snapshot = await confirmAccountAuthorization(host, result)
  // Signed-in routes (FreeCodeGo gateway, Logfare auto model, …) resolve only
  // after login; republish adapters so model menus drop the login badge now.
  host.ctx.emit('llm/adapters-updated')
  return snapshot
}

/**
 * Read the password this machine remembers for the sign-in form.
 *
 * It is deliberately not part of the account snapshot: the snapshot is
 * browser-safe state that every surface renders, while this value exists only to
 * prefill one field. The read is separate for the same reason — a surface that
 * shows the account never needs it, and the one that asks gets it once.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the remembered password, or an empty answer when there is none.
 */
export async function readRememberedPassword(host: AccountRemotesHost): Promise<{ readonly password?: string }> {
  if (host.account === undefined) return {}
  const password = await host.account.rememberedPassword()
  // An absent password is an absent field rather than an explicit undefined: the
  // remote boundary carries the answers it was given, and "no password" and
  // "null" are not the same answer for the form that prefills from it.
  return password === undefined ? {} : { password }
}

/**
 * Complete the pending two-factor challenge.
 * @param host - the Host surface this remote call reaches its services through.
 * @param totpCode - the code the user's authenticator produced.
 * @param deviceId - device identifier recorded with the session.
 * @returns the account snapshot after the second factor.
 */
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

/**
 * Rotate the stored session token.
 * @param host - the Host surface this remote call reaches its services through.
 * @param deviceId - device identifier recorded with the rotated session.
 * @returns the account snapshot after the rotation.
 */
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

/**
 * Sign out and erase the stored session from the Host vault.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the signed-out account snapshot.
 */
export async function logout(host: AccountRemotesHost): Promise<FreeCodeGoAccountSnapshot> {
  if (host.account === undefined) throw backendNotConfigured()
  host.state.pendingOAuthState = undefined
  await host.account.logout()
  host.ctx.emit('llm/adapters-updated')
  host.catalogs.invalidateGatewayHealth()
  host.state.restoreCompleted = false
  return accountSnapshot(host.account.snapshot())
}

/** Return the existing backend model directory without exposing access tokens. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the managed Catalog.
 */
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

/**
 * Read the Vyce account and key state.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the status the settings surface renders.
 */
export async function vyceStatus(host: AccountRemotesHost): Promise<FreeCodeGoVyceStatus> {
  // The card advertises the same roster the picker serves, live directory
  // included: a hand-typed list would disagree the moment VyceAI rotates it.
  const rows = await host.catalogs.listVyceModels('vyce')
  return {
    configured: (await host.catalogs.vyceApiKey()) !== undefined,
    models: rows.map(row => ({
      id: row.id.startsWith(VYCE_MODEL_PREFIX) ? row.id.slice(VYCE_MODEL_PREFIX.length) : row.id,
      name: row.name,
    })),
  }
}

/**
 * Store the Vyce API key in the Host credential vault.
 * @param host - the Host surface this remote call reaches its services through.
 * @param value - the key to store; an empty value clears it.
 * @returns the status after the change.
 */
export async function vyceSetKey(host: AccountRemotesHost, value: string): Promise<FreeCodeGoVyceStatus> {
  if (host.credentials === undefined) throw new Error('Credential provider is not configured')
  const normalized = value.trim()
  if (normalized !== '' && !/^[\x21-\x7E]+$/.test(normalized)) throw new Error('VyceAI API key contains invalid characters')
  if (normalized === '') await host.credentials.unset(VYCE_API_KEY_REF)
  else await host.credentials.set(VYCE_API_KEY_REF, normalized)
  // The directory is authenticated, so an answer cached before this change
  // describes the previous key (often: no key at all) and must not serve on.
  host.catalogs.invalidateVyceCatalog()
  host.ctx.emit('llm/adapters-updated')
  return vyceStatus(host)
}

/**
 * Transcribe one recorded clip through Groq Whisper.
 * @param host - the Host surface this remote call reaches its services through.
 * @param audioBase64 - the recorded audio, base64 encoded.
 * @param mimeType - the recording's MIME type.
 * @param language - the expected spoken language, when the caller knows it.
 * @returns the transcript and the model that produced it.
 */
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

/** Return Logfare readiness and the current standard/premium model counts without exposing secrets. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the logfare Status.
 */
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

/** Store or clear a user-provided Logfare key without ever returning its value. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the logfare Status.
 * @param value - the key to store; an empty value clears it.
 */
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

/** Create one user-confirmed Logfare account and save its issued API key in the Host vault. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the logfare Status.
 * @param input - the registration details.
 */
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

/** Apply the user's explicit, reversible Logfare training preference. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param enabled - whether this capability is switched on.
 * @returns the logfare Status.
 */
export async function logfareSetTrainingOptIn(host: AccountRemotesHost, enabled: boolean): Promise<FreeCodeGoLogfareStatus> {
  if (typeof enabled !== 'boolean') throw new Error('FreeCodeGo training preference must be a boolean')
  await host.catalogs.updateLogfareTrainingPreference(enabled)
  host.ctx.emit('llm/adapters-updated')
  // Delegate to the one projection that owns this shape: deriving the counts
  // and names here as well is how the two views drift apart.
  return host.logfareStatus()
}

/** Return only whether a SenseNova key is configured in the Host. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the sense Nova Status.
 */
export async function sensenovaStatus(host: AccountRemotesHost): Promise<FreeCodeGoSenseNovaStatus> {
  const key = await host.catalogs.sensenovaApiKey()
  return { configured: key !== undefined, baseUrl: SENSENOVA_BASE_URL }
}

/** Store or clear the SenseNova key without returning its value. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the sense Nova Status.
 * @param value - the key to store; an empty value clears it.
 */
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

/** Return only whether an NVIDIA key is configured in the Host. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the nvidia Status.
 */
export async function nvidiaStatus(host: AccountRemotesHost): Promise<FreeCodeGoNvidiaStatus> {
  const key = await host.catalogs.nvidiaApiKey()
  return { configured: key !== undefined, baseUrl: NVIDIA_BASE_URL }
}

/** Store or clear the NVIDIA key without returning its value. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the nvidia Status.
 * @param value - the key to store; an empty value clears it.
 */
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

/** Return the existing FreeCodeGo bootstrap snapshot through a redacted Remote. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the backend Snapshot.
 */
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

/** Return the existing backend quota snapshot without exposing credentials. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the backend Snapshot.
 */
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

/** Return existing backend runtime health. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the backend Snapshot.
 */
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

/**
 * Read the account's gateway usage over a number of days.
 * @param host - the Host surface this remote call reaches its services through.
 * @param days - how many days back the read starts.
 * @returns the usage payload, or the reason it is unavailable.
 */
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

/**
 * Rehydrate the stored session when the Host starts.
 * @param host - the Host surface this remote call reaches its services through.
 */
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
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the device Sessions.
 */
export async function deviceSessions(host: AccountRemotesHost): Promise<FreeCodeGoDeviceSessions> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.getDeviceSessions({ accessToken }))
}

/** Revoke one device session, then return the refreshed listing. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the device Sessions.
 * @param deviceId - id of the device session to revoke.
 */
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

/** Revoke every session of the account and report how many the backend revoked. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns how many sessions the backend revoked.
 */
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
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the cline Status.
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
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the cline Device Login.
 */
export async function clineStartLogin(host: AccountRemotesHost): Promise<ClineDeviceLogin> {
  const ticket = await requireCline(host).startDeviceLogin()
  await openUrlInSystemBrowser(ticket.verificationUrl).catch(() => false)
  return ticket
}

/** One device-login poll. `pending` means the browser step is unfinished. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the cline Login Poll.
 * @param deviceCode - the device code the start call returned.
 */
export async function clinePollLogin(host: AccountRemotesHost, deviceCode: string): Promise<ClineLoginPoll> {
  const pending = await requireCline(host).pollDeviceLogin(deviceCode)
  if (pending) return { pending: true }
  host.ctx.emit('llm/adapters-updated')
  return { pending: false, state: await clineStatus(host) }
}

/** Add (or replace) one account from a Cline refresh token. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param refreshToken - refresh token the session rotates with.
 * @returns the cline Status.
 */
export async function clineAddAccount(host: AccountRemotesHost, refreshToken: string): Promise<ClineStatus> {
  await requireCline(host).addAccountFromRefreshToken(refreshToken)
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

/** Remove one account from the rotation. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - account this operation is scoped to.
 * @returns the cline Status.
 */
export async function clineRemoveAccount(host: AccountRemotesHost, accountId: string): Promise<ClineStatus> {
  await requireCline(host).removeAccount(accountId)
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

/** Refresh one account, or every account when no id is given. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - account this operation is scoped to.
 * @returns the cline Status.
 */
export async function clineRefresh(host: AccountRemotesHost, accountId?: string): Promise<ClineStatus> {
  await requireCline(host).refreshAccounts(accountId)
  host.ctx.emit('llm/adapters-updated')
  return clineStatus(host)
}

/** Remove every Cline account. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the cline Status.
 */
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

/** Return browser-safe WorkBuddy International account and free-model state. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the work Buddy International Status.
 */
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
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the work Buddy International Status.
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

/** Open the WorkBuddy International sign-in page in the user's browser. 
 * @param _host - the Host surface; unused, kept for the shared remote signature.
 * @returns whether a browser opened, and the URL it was sent to.
 */
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
 * @returns the work Buddy Browser Login.
 * @param _host - the Host surface; unused, kept for the shared remote signature.
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
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the work Buddy Login Poll.
 * @param state - the handshake state the start call returned.
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

/** Logout from WorkBuddy International, clearing all stored accounts. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the work Buddy International Status.
 */
export async function workbuddyLogout(host: AccountRemotesHost): Promise<WorkBuddyInternationalStatus> {
  host.catalogs.clearWorkbuddyAccounts()
  host.catalogs.invalidateWorkbuddyCatalog()
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** Remove a specific WorkBuddy account by ID. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - account this operation is scoped to.
 * @returns the work Buddy International Status.
 */
export async function workbuddyRemoveAccount(host: AccountRemotesHost, accountId: string): Promise<WorkBuddyInternationalStatus> {
  await host.catalogs.workbuddyRemoveAccount(accountId)
  host.catalogs.invalidateWorkbuddyCatalog()
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** Set the active WorkBuddy account by ID. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - account this operation is scoped to.
 * @returns the work Buddy International Status.
 */
export async function workbuddySetActiveAccount(host: AccountRemotesHost, accountId: string): Promise<WorkBuddyInternationalStatus> {
  await host.catalogs.workbuddySetActiveAccount(accountId)
  host.ctx.emit('llm/adapters-updated')
  return workbuddyStatus(host)
}

/** Refresh WorkBuddy access token using refresh token. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param refreshToken - refresh token the session rotates with.
 * @returns the rotated token pair and its expiry.
 */
export async function workbuddyRefreshToken(host: AccountRemotesHost, refreshToken: string): Promise<{ readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number }> {
  const result = await host.catalogs.workbuddyRefreshToken(refreshToken)
  // Update the account with new tokens - for simplicity, we replace all accounts
  // The caller should manage which account to update
  return result
}

/** Refresh credit information for all WorkBuddy accounts. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the work Buddy International Status.
 */
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

/**
 * Sign in through a federated provider, opening the browser and waiting for the handoff.
 * @param host - the Host surface this remote call reaches its services through.
 * @param provider - which federated provider to sign in with.
 * @returns the account snapshot after the handoff.
 */
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

/** Read the pending registration the browser step left behind. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the pending registration, or `undefined` when none is waiting.
 */
export async function accountOAuthPendingStatus(host: AccountRemotesHost): Promise<OAuthLoginPendingRegistration | undefined> {
  if (host.account === undefined) throw backendNotConfigured()
  const payload = await oauthPendingFetch(host, oauthPendingStatusUrl(host.account.origin), { method: 'GET' })
  return parseOAuthPendingRegistration(payload)
}

/** Send the registration verification email for the pending session. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param email - the address the code is sent to.
 * @returns the countdown a resend control waits for.
 */
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

/** Bind the pending federated identity to an existing password account. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the account Snapshot.
 * @param input - the existing account's credentials and an optional second factor.
 */
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

/** Create a new account from the pending federated identity. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the account Snapshot.
 * @param input - the new account's credentials and codes.
 */
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

// ============================================================================
// Qoder (qoder.com / qoder.com.cn)
// ============================================================================

/**
 * In-flight Qoder browser authorizations, keyed by the ticket state the card
 * polls with. Held Host-side: the PKCE verifier and nonce must never reach the
 * browser.
 */
const qoderLogins = new Map<string, QoderLoginAttempt>()

/**
 * The upstream exchange already running for one ticket.
 *
 * A ticket is worth exactly one exchange. The Settings page polls on its own
 * clock, and the exchange is not instant — it reads the token, the identity, the
 * plan, the vault, and the model directory — so a poll that is still running
 * when the next tick fires used to start a second exchange for the same nonce.
 * That second one reaches a nonce upstream has already spent, which turned a
 * sign-in that had just succeeded and been stored into a failure the user saw.
 * A caller that arrives mid-exchange joins it instead of starting another.
 */
const qoderExchanges = new Map<string, Promise<QoderLoginPoll>>()

/**
 * Tickets whose token has already been exchanged and stored.
 *
 * Kept for the rest of the ticket's window instead of being deleted: the client
 * can poll once more before it has seen the answer (a reloaded page, a retried
 * call), and "this sign-in is done, here is the account state" is the honest
 * reply — deleting the ticket made the same question answer "authorization is no
 * longer pending", which is what the card then reported as a failure.
 */
const qoderCompleted = new Set<string>()

/**
 * Drop tickets that can no longer be answered.
 * @param now - the clock to compare each ticket's expiry against.
 */
function pruneQoderLogins(now: number): void {
  for (const [state, attempt] of qoderLogins) {
    if (now <= attempt.expiresAt) continue
    qoderLogins.delete(state)
    qoderExchanges.delete(state)
    qoderCompleted.delete(state)
  }
}

/**
 * Return browser-safe Qoder account, quota, and free-model state.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the Qoder status the settings surface renders.
 */
export async function qoderStatus(host: AccountRemotesHost): Promise<QoderStatus> {
  const accounts = await host.catalogs.qoderAccounts()
  if (accounts.length === 0) return { configured: false, accounts: [], freeModels: [] }
  const selected = await host.catalogs.qoderActiveAccountId()
  const active = (selected === undefined ? undefined : accounts.find(account => account.id === selected)) ?? accounts[0]!
  const freeModels = await host.catalogs.qoderFreeModels()
  return {
    configured: true,
    activeAccountId: active.id,
    accounts: accounts.map(qoderAccountInfo),
    freeModels,
  }
}

/**
 * Start a Qoder browser authorization: mint the PKCE ticket, open the login
 * page, and return the ticket the card polls.
 * @param _host - the Host surface; unused, kept for the shared remote signature.
 * @returns the browser-login ticket.
 */
export async function qoderStartBrowserLogin(_host: AccountRemotesHost): Promise<QoderBrowserLogin> {
  const attempt = startQoderLogin('global')
  // Every click mints a ticket that lives for the whole authorization window;
  // sweeping here keeps that map bounded by the clicks of one window rather
  // than by every click of the session.
  pruneQoderLogins(Date.now())
  qoderLogins.set(attempt.loginId, attempt)
  const opened = await openUrlInSystemBrowser(attempt.loginUrl).catch(() => false)
  return {
    state: attempt.loginId,
    loginUrl: attempt.loginUrl,
    expiresAt: attempt.expiresAt,
    ...(opened ? {} : { note: 'BROWSER_OPEN_FAILED' as const }),
  }
}

/**
 * Poll one Qoder authorization. One poll per call so the Settings page owns the
 * cadence; a `404` from upstream is the "keep polling" answer.
 *
 * Idempotent for the lifetime of one ticket: an exchange already running is
 * joined rather than started again, and a ticket that has already produced an
 * account keeps answering with that account's state. Both exist because the
 * caller's clock is not ours — the Settings page polls on a timer, so two calls
 * for one ticket are normal, and answering the second one with an error made a
 * completed sign-in look like a failed one.
 * @param host - the Host surface this remote call reaches its services through.
 * @param state - the ticket state the start call returned.
 * @returns the poll outcome.
 */
export async function qoderPollBrowserLogin(host: AccountRemotesHost, state: string): Promise<QoderLoginPoll> {
  const attempt = qoderLogins.get(state)
  if (attempt === undefined) throw new Error('QODER_LOGIN_FAILED: authorization is no longer pending; start again')
  if (Date.now() > attempt.expiresAt) {
    qoderLogins.delete(state)
    qoderExchanges.delete(state)
    qoderCompleted.delete(state)
    throw new Error('QODER_LOGIN_FAILED: authorization timed out')
  }
  // A ticket is exchanged once. Every later poll re-reads the state that
  // exchange left behind instead of exchanging the spent nonce again.
  if (qoderCompleted.has(state)) return { pending: false, state: await qoderStatus(host) }
  const running = qoderExchanges.get(state)
  if (running !== undefined) return running
  const exchange = exchangeQoderTicket(host, state, attempt)
  qoderExchanges.set(state, exchange)
  try {
    return await exchange
  } catch (error) {
    // The token could not be stored, so this ticket is spent: upstream has
    // already issued the nonce and will not answer it again. Dropping it lets a
    // retry start a new sign-in instead of polling for an answer that cannot
    // come, and the failure still reaches the caller unchanged.
    qoderLogins.delete(state)
    qoderCompleted.delete(state)
    throw error
  } finally {
    if (qoderExchanges.get(state) === exchange) qoderExchanges.delete(state)
  }
}

/**
 * Exchange one authorized ticket: read the token, the identity, and store the
 * account.
 * @param host - the Host surface this remote call reaches its services through.
 * @param state - the ticket state, recorded once the token has been stored.
 * @param attempt - the ticket's PKCE parameters.
 * @returns the poll outcome.
 */
async function exchangeQoderTicket(host: AccountRemotesHost, state: string, attempt: QoderLoginAttempt): Promise<QoderLoginPoll> {
  const tokens = await pollQoderDeviceToken(attempt)
  if (tokens === undefined) return { pending: true }
  const userInfo = await fetchQoderUserInfo(attempt.region, tokens.deviceToken)
  const identity = qoderIdentityFromUserInfo(userInfo, tokens.deviceToken, tokens.refreshToken)
  const plan = await fetchQoderPlan(attempt.region, tokens.deviceToken)
  const email = text(userInfo.email)
  await host.catalogs.qoderImportAccount({
    deviceToken: tokens.deviceToken,
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    id: qoderAccountIdFromUserInfo(userInfo, tokens.deviceToken),
    ...(identity.uid === '' ? {} : { uid: identity.uid }),
    ...(identity.name === '' ? {} : { name: identity.name }),
    ...(email === undefined ? {} : { email }),
    userType: identity.userType,
    ...(plan === undefined ? {} : { plan }),
    ...(identity.organizationId === undefined ? {} : { organizationId: identity.organizationId }),
    ...(identity.organizationName === undefined ? {} : { organizationName: identity.organizationName }),
    region: attempt.region,
  })
  host.catalogs.invalidateQoderCatalog()
  host.ctx.emit('llm/adapters-updated')
  // Recorded after the account is stored, never before: a replay must describe a
  // sign-in that really happened.
  qoderCompleted.add(state)
  return { pending: false, state: await qoderStatus(host) }
}

/**
 * Sign every Qoder account out and clear the stored sessions.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the signed-out status.
 */
export async function qoderLogout(host: AccountRemotesHost): Promise<QoderStatus> {
  host.catalogs.clearQoderAccounts()
  host.catalogs.invalidateQoderCatalog()
  host.ctx.emit('llm/adapters-updated')
  return qoderStatus(host)
}

/**
 * Forget one Qoder account locally.
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - id of the account to remove.
 * @returns the status after the removal.
 */
export async function qoderRemoveAccount(host: AccountRemotesHost, accountId: string): Promise<QoderStatus> {
  await host.catalogs.qoderRemoveAccount(accountId)
  host.catalogs.invalidateQoderCatalog()
  host.ctx.emit('llm/adapters-updated')
  return qoderStatus(host)
}

/**
 * Choose which Qoder account carries new requests.
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - id of the account to activate.
 * @returns the status after the change.
 */
export async function qoderSetActiveAccount(host: AccountRemotesHost, accountId: string): Promise<QoderStatus> {
  await host.catalogs.qoderSetActiveAccount(accountId)
  host.ctx.emit('llm/adapters-updated')
  return qoderStatus(host)
}

/**
 * Re-read every Qoder account's quota from upstream.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the status with the quota it read.
 */
export async function qoderRefreshQuota(host: AccountRemotesHost): Promise<QoderStatus> {
  const client = host.qoder
  const accounts = await host.catalogs.qoderAccounts()
  if (client !== undefined) {
    for (const account of accounts) {
      const quota = await client.quota(account).catch(() => undefined)
      if (quota !== undefined) await host.catalogs.qoderApplyQuota(account.id, quota)
    }
  }
  host.ctx.emit('llm/adapters-updated')
  return qoderStatus(host)
}

/**
 * Claim today's campaign credits for every Qoder account.
 *
 * The report is returned instead of the account status: the pool's state does not
 * change here, and a run's outcome — who collected what, and who could not — is
 * the only thing the card has to show.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the run's report.
 */
export async function qoderCheckin(host: AccountRemotesHost): Promise<FreeCodeGoCheckinReport> {
  // No pool means no account to claim for. An empty report rather than an error,
  // because "no accounts" is what the card already says on its own.
  if (host.qoder === undefined) return { checkedAt: Date.now(), credits: 0, accounts: [] }
  return host.qoder.checkin()
}

// ============================================================================
// TRAE (www.trae.cn, SOLO channel)
// ============================================================================

/**
 * The one in-flight TRAE sign-in.
 *
 * One attempt at a time, unlike Qoder's map of tickets, because this sign-in is
 * a redirect into a socket *this* Host opened: two live attempts would be two
 * listeners racing for one authorization, and the user is looking at exactly one
 * page either way. Starting a new attempt therefore abandons the previous one
 * rather than joining a pool.
 */
interface TraeLoginSession {
  readonly attempt: TraeLoginAttempt
  readonly listener: TraeCallbackListener
  /** The redirect's URL, once it arrived. */
  readonly callback: { url?: string }
  /** Whether the Host could hand the login URL to the system browser. */
  readonly browserOpenFailed: boolean
  /**
   * The one exchange this attempt is allowed to make, once it has started.
   *
   * One, because `ExchangeToken` rotates the refresh token family server-side: a
   * second exchange sent with the same token either wins the race and invalidates
   * the first, or loses and reports a credential failure for an account that did
   * authorize. The redirect, a pasted callback and a poll tick can all ask to
   * complete the same attempt, so they share this promise instead of each
   * spending the token.
   */
  completion?: Promise<void>
  /** The failure the exchange ended in, kept so a poll can report it to the card. */
  failure?: Error
  /** Set once the account is stored. */
  completed?: boolean
}

let traeLogin: TraeLoginSession | undefined

/**
 * Exchange one attempt's callback and store the account it yields.
 *
 * Started as soon as the redirect lands, rather than by the card's next poll: the
 * exchange is a single round trip, and waiting for a poll tick is most of the
 * delay the user sees between authorizing and seeing the account. The failure is
 * kept on the session instead of thrown into the listener, because the caller
 * that must be told about it is the card, which asks later.
 * @param host - the Host surface this remote call reaches its services through.
 * @param session - the attempt being completed.
 * @param url - the callback URL to exchange.
 * @returns the exchange, which never rejects.
 */
function startTraeCompletion(host: AccountRemotesHost, session: TraeLoginSession, url: string): Promise<void> {
  if (session.completion !== undefined) return session.completion
  session.completion = completeTraeLogin(host, session.attempt, url).then(() => {
    session.completed = true
  }, (error: unknown) => {
    session.failure = error instanceof Error ? error : new Error(String(error))
  }).finally(() => {
    // The redirect has been answered, so the socket has no one left to serve.
    void session.listener.close().catch(() => undefined)
  })
  return session.completion
}

/**
 * Stop the in-flight listener and forget the attempt.
 *
 * Called on every terminal path — completed, timed out, cancelled, replaced —
 * because a listener that outlives its attempt is a port held open for a
 * redirect nobody is waiting for.
 */
async function abandonTraeLogin(): Promise<void> {
  const session = traeLogin
  traeLogin = undefined
  await session?.listener.close().catch(() => undefined)
}

/**
 * Return browser-safe TRAE account and authorization state.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the status the settings surface renders.
 */
export async function traeStatus(host: AccountRemotesHost): Promise<TraeStatus> {
  const accounts = (await host.catalogs.traeAccounts()).map(traeAccountSnapshot)
  let session = traeLogin
  // An attempt whose exchange has finished is not pending any more: the account it
  // produced is in the list right above. Reporting "authorizing" beside it would say
  // the sign-in is still waiting on a browser that has already answered — and it
  // would do so for as long as the card takes to poll, which is how a completed
  // sign-in used to look stalled.
  if (session !== undefined && session.completed === true) {
    await abandonTraeLogin()
    session = undefined
  }
  if (session !== undefined) {
    return {
      status: 'login-pending',
      accounts,
      realm: session.attempt.realm,
      loginUrl: session.attempt.loginUrl,
      loginExpiresAt: session.attempt.expiresAt,
      ...(session.browserOpenFailed ? { note: 'BROWSER_OPEN_FAILED' as const } : {}),
    }
  }
  if (accounts.length === 0) return { status: 'signed-out', accounts }
  const selected = await host.catalogs.traeActiveAccountId()
  const active = (selected === undefined ? undefined : accounts.find(account => account.id === selected)) ?? accounts[0]!
  if (active.status === 'reauth-required') {
    return { status: 'reauth-required', accountId: active.id, label: active.label, accounts }
  }
  return { status: 'authenticated', accountId: active.id, label: active.label, accounts }
}

/**
 * Start a TRAE browser authorization: open the loopback listener, open the
 * sign-in page, and report the attempt as pending.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the pending status, carrying the URL the card can offer as a link.
 */
export async function traeStartBrowserLogin(host: AccountRemotesHost, realmValue?: string): Promise<TraeStatus> {
  await abandonTraeLogin()
  // An unstated realm means China: it is the deployment this connector has always
  // signed in to, and it is what a client that predates the international entry
  // point is asking for.
  const realm = traeRealmOf(realmValue)
  const identity = traeMachineIdentity()
  const callback: { url?: string } = {}
  // The handler completes the attempt, so it reaches the session through this
  // binding: the listener has to exist before the session (the attempt needs its
  // port), and the session has to exist before a redirect can arrive.
  let session: TraeLoginSession | undefined
  const listener = await startTraeCallbackListener((url) => {
    callback.url = url
    if (session !== undefined) void startTraeCompletion(host, session, url)
  })
  const loginUrl = buildTraeLoginUrl(identity, traeCallbackUrl(listener.port), realm)
  const attempt: TraeLoginAttempt = {
    state: randomUUID(),
    realm,
    loginUrl,
    machineId: identity.machineId,
    deviceId: identity.deviceId,
    callbackUrl: traeCallbackUrl(listener.port),
    expiresAt: Date.now() + TRAE_LOGIN_STATE_TTL_MS,
  }
  const opened = await openUrlInSystemBrowser(loginUrl).catch(() => false)
  session = { attempt, listener, callback, browserOpenFailed: !opened }
  traeLogin = session
  // A redirect cannot arrive before the browser was sent to the login URL, but a
  // URL already recorded here (anything that raced the assignment) still gets its
  // exchange rather than waiting for a poll that may never come.
  if (callback.url !== undefined) void startTraeCompletion(host, session, callback.url)
  return traeStatus(host)
}

/**
 * Poll the in-flight authorization. The exchange happens here rather than in the
 * listener, so a failure is reported to the caller that asked instead of
 * disappearing into a page already answered.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the status after the poll.
 */
export async function traePollBrowserLogin(host: AccountRemotesHost): Promise<TraeStatus> {
  const session = traeLogin
  if (session === undefined) throw new Error('TRAE_LOGIN_FAILED: authorization is no longer pending; start again')
  if (Date.now() > session.attempt.expiresAt && session.completion === undefined) {
    await abandonTraeLogin()
    throw new Error('TRAE_LOGIN_FAILED: authorization timed out')
  }
  const url = session.callback.url
  // A poll is also the last chance to notice a redirect that landed before the
  // listener could complete it (a callback submitted by hand), so it completes too
  // — through the same one promise, which is a no-op once the exchange has begun.
  if (url !== undefined) await startTraeCompletion(host, session, url)
  if (session.failure !== undefined) {
    const failure = session.failure
    await abandonTraeLogin()
    throw failure
  }
  if (session.completed === true) {
    await abandonTraeLogin()
    return traeStatus(host)
  }
  return traeStatus(host)
}

/**
 * Complete a sign-in from a callback URL the user pasted.
 *
 * The loopback redirect does not always arrive — a browser on another machine, a
 * page that refused to redirect, a firewall — and the callback URL is in the
 * browser's address bar in every one of those cases. The machine identity is the
 * one this attempt declared, because the issued session belongs to it.
 * @param host - the Host surface this remote call reaches its services through.
 * @param url - the callback URL as the user's browser shows it.
 * @returns the status after the sign-in.
 */
export async function traeSubmitCallback(host: AccountRemotesHost, url: string): Promise<TraeStatus> {
  const session = traeLogin
  if (session === undefined) throw new Error('TRAE_LOGIN_FAILED: authorization is no longer pending; start again')
  // A pasted callback and a captured redirect are the same exchange. When the
  // redirect already arrived — which is the case the paste box is a fallback for
  // being *slow*, not absent — its URL is the one that is already under way, and
  // the paste joins it instead of starting a second exchange with the same refresh
  // token.
  const captured = session.callback.url ?? url
  await startTraeCompletion(host, session, captured)
  if (session.failure !== undefined) {
    const failure = session.failure
    await abandonTraeLogin()
    throw failure
  }
  await abandonTraeLogin()
  return traeStatus(host)
}

/**
 * Abandon the in-flight authorization and close its listener.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the status after the cancellation.
 */
export async function traeCancelBrowserLogin(host: AccountRemotesHost): Promise<TraeStatus> {
  await abandonTraeLogin()
  return traeStatus(host)
}

/**
 * The configuration table the TRAE pool can serve right now.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the model rows, as the picker and the card render them.
 */
export async function traeModels(host: AccountRemotesHost): Promise<readonly TraeModel[]> {
  return host.catalogs.traeModels()
}

/**
 * Sign every TRAE account out and clear the stored sessions.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the signed-out status.
 */
export async function traeLogout(host: AccountRemotesHost): Promise<TraeStatus> {
  host.catalogs.clearTraeAccounts()
  host.catalogs.invalidateTraeModels()
  host.ctx.emit('llm/adapters-updated')
  return traeStatus(host)
}

/**
 * Forget one TRAE account locally.
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - id of the account to remove.
 * @returns the status after the removal.
 */
export async function traeRemoveAccount(host: AccountRemotesHost, accountId: string): Promise<TraeStatus> {
  await host.catalogs.traeRemoveAccount(accountId)
  host.catalogs.invalidateTraeModels()
  host.ctx.emit('llm/adapters-updated')
  return traeStatus(host)
}

/**
 * Choose which TRAE account carries new requests.
 * @param host - the Host surface this remote call reaches its services through.
 * @param accountId - id of the account to activate.
 * @returns the status after the change.
 */
export async function traeSetActiveAccount(host: AccountRemotesHost, accountId: string): Promise<TraeStatus> {
  await host.catalogs.traeSetActiveAccount(accountId)
  host.ctx.emit('llm/adapters-updated')
  return traeStatus(host)
}

/**
 * Claim today's credits for every TRAE account.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the run's report.
 */
export async function traeCheckin(host: AccountRemotesHost): Promise<FreeCodeGoCheckinReport> {
  if (host.trae === undefined) return { checkedAt: Date.now(), credits: 0, accounts: [] }
  return host.trae.checkin()
}

/**
 * Turn one callback URL into a stored account: exchange it, store it, and let
 * every consumer of the directory know it can ask again.
 * @param host - the Host surface this remote call reaches its services through.
 * @param attempt - the attempt whose machine identity the session belongs to.
 * @param url - the callback URL the redirect (or the user) produced.
 */
async function completeTraeLogin(host: AccountRemotesHost, attempt: TraeLoginAttempt, url: string): Promise<void> {
  const callback = parseTraeCallback(url)
  // The page issues a refresh token on every path this connector has seen; the
  // branch exists because the redirect may carry only a JWT, and refusing it
  // would throw away a session the user did authorize.
  const token = callback.refreshToken === undefined
    ? { accessToken: callback.accessToken ?? '', refreshToken: '', expiresAt: callback.expiresAt }
    : await exchangeTraeToken(callback.refreshToken, attempt.realm)
  const account = traeAccountFromLogin(callback, { machineId: attempt.machineId, deviceId: attempt.deviceId }, token, attempt.realm)
  await host.catalogs.traeImportAccount(account)
  host.catalogs.invalidateTraeModels()
  host.ctx.emit('llm/adapters-updated')
}
