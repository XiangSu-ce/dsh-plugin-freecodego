/** Host-only Agnes accounts, API-key provisioning, media transport, and LLM adapter. */
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { activeAccountIdAfterRemoval, activeAccountIdAfterWrite } from './account-utils.ts'
import { logfareResponseError } from './managed-catalog-utils.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { asRecord as object, asString as string } from './untrusted-json.ts'
import { llmCodeForUpstreamStatus } from './upstream-status-code.ts'
import { clampMaxOutputTokens } from './openai-compatible-adapter.ts'
import { hasImageContent, serializeRequest, serializeRequestWithInlineImages, translate } from './openai-wire.ts'
import { parseSse } from './wire-shared.ts'

/**
 * Credential reference holding the account-scoped Agnes session token.
 */
export const AGNES_AUTH_REF: CredentialRef = credentialRef('AGNES_AUTH')
/** Legacy key ref is retained only for migration/cleanup; keys are now account scoped. */
export const AGNES_API_KEY_REF: CredentialRef = credentialRef('AGNES_API_KEY')
const PLATFORM = 'https://platform-backend.agnes-ai.com'
const API_BASE = 'https://apihub.agnes-ai.com/v1'
const VIDEO_STATUS_BASE = 'https://apihub.agnes-ai.com/agnesapi'
/** The Agnes model family the picker always exposes, whether or not the live directory answers. */
export const AGNES_DOCUMENTED_MODELS = [
  { id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash', description: 'Agnes AI · ×0 · health:operational|uptime:100|success:100|traffic:0|latency:na', inputModalities: ['text'] as const },
  { id: 'agnes-image-2.5-flash', name: 'Agnes Image 2.5 Flash', description: 'Agnes AI · ×0 · health:operational|uptime:100|success:100|traffic:0|latency:na', inputModalities: ['text', 'image'] as const },
  { id: 'agnes-video-2.5-flash', name: 'Agnes Video 2.5 Flash', description: 'Agnes AI · ×0 · health:operational|uptime:100|success:100|traffic:0|latency:na', inputModalities: ['text', 'image'] as const },
] as const
const DOCUMENTED_MODELS = AGNES_DOCUMENTED_MODELS
/** Fallback floor for media routes only. The text picker keeps the documented
 * chat model because the adapter implements exactly that chat contract; media
 * tools instead follow the live directory so newly added Agnes image/video
 * models become usable without a plugin update. */
const AGNES_MEDIA_FALLBACK_MODELS = [
  AGNES_DOCUMENTED_MODELS[1],
  AGNES_DOCUMENTED_MODELS[2],
] as const
const AGNES_MODELS_URL = `${API_BASE}/models`
const AGNES_MODELS_CACHE_TTL_MS = 5 * 60_000
/** Bound on one fetch of Agnes' live model directory. */
export const AGNES_MODELS_TIMEOUT_MS = 8_000
/**
 * Bound on one account or sign-in round trip.
 *
 * Mirrors the Cline pool's `CLINE_REQUEST_TIMEOUT_MS`: verification, register,
 * login and token provisioning are user-initiated and the upstream may be slow,
 * but a wedged request must never leave the settings card waiting forever.
 */
export const AGNES_AUTH_TIMEOUT_MS = 30_000
/**
 * The durations the Agnes video route can render, in seconds as strings.
 *
 * One list, three readers: the request validator on `createVideo`, the
 * `agnes_generate_video` legacy tool's schema, and the media ladder's check that
 * a requested duration is something this route can serve at all. They used to be
 * two hand-written copies of `4`..`12` plus a third range — `1`..`60`, advertised
 * by the generic video tool — so a duration the schema called legal was rejected
 * by the one route that serves first-party video.
 */
export const AGNES_VIDEO_SECONDS: readonly string[] = ['4', '5', '6', '7', '8', '9', '10', '11', '12']
/**
 * Bound on one media generation request.
 *
 * Agnes accepts an image or video task and renders it server side, so this is
 * the long-request cap the Cline adapter uses for a chat stream rather than a
 * metadata read. The video *status* read has its own, much shorter bound.
 */
export const AGNES_MEDIA_TIMEOUT_MS = 120_000
/** Bound on one chat completion stream, matching `CLINE_CHAT_TIMEOUT_MS`. */
export const AGNES_CHAT_TIMEOUT_MS = 120_000
/**
 * The most completion tokens Agnes accepts on one chat request.
 *
 * Measured against the live endpoint: `65536` is answered with a stream while
 * `131072` is rejected with `HTTP 400 {"error":{"message":"max_tokens exceeds
 * the limit of 65536"}}`. The Harness fills an unnamed budget from its own far
 * larger default, so without this cap every Agnes turn failed with a bare `400`
 * that named neither the field nor the ceiling.
 */
export const AGNES_MAX_OUTPUT_TOKENS = 65_536
/**
 * Bound on one video-status poll.
 *
 * The polling loop repeats every two seconds and owns its own ten minute
 * window, so a long per-poll bound would only delay the loop's deadline check
 * while a single stalled read held the turn open.
 */
export const AGNES_STATUS_TIMEOUT_MS = 15_000
const AGNES_REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

function supportsAgnesReasoning(model: string): boolean {
  return model === 'agnes-3.0-flash'
}

/**
 * One signed-in Agnes account, as the settings surface lists it.
 */
export interface AgnesAccountStatus {
  readonly id: string
  readonly email?: string
  readonly username?: string
  readonly apiKeyConfigured: boolean
}

/** The media kind an Agnes model id names. */
export type AgnesMediaCategory = 'image' | 'video' | 'audio'
/** One entry from Agnes' media model directory. */
export interface AgnesMediaModel { readonly id: string; readonly name: string }

/** Classify a raw Agnes model id by its embedded media keyword. The live
 * `/models` directory is free-form, so this stays a keyword heuristic over
 * the id and display name rather than a pinned id list.
 * @param value - the raw model id or display name to classify.
 * @returns the media category, or `undefined` when the name names none.
 */
export function agnesMediaCategory(value: string): AgnesMediaCategory | undefined {
  const normalized = value.toLowerCase()
  if (/(?:^|[-_.\s])videos?(?:[-_.\s]|\d|$)/u.test(normalized)) return 'video'
  if (/(?:^|[-_.\s])(?:images?|img)(?:[-_.\s]|\d|$)/u.test(normalized)) return 'image'
  if (/(?:^|[-_.\s])(?:tts|speech|audio|transcri|whisper|asr)(?:[-_.\s]|\d|$)/u.test(normalized)) return 'audio'
  return undefined
}
/** Parse one `/models` row into the catalog shape; ids and names are required. */
function parseAgnesModelRow(value: unknown): AgnesMediaModel | undefined {
  const row = object(value)
  const id = string(row.id ?? row.model ?? row.name)
  if (id === undefined || id.startsWith('chat') || id.includes('/')) return undefined
  const name = string(row.displayName ?? row.title) ?? id
  return { id, name }
}

/**
 * Parse one `/models` row as a chat route.
 *
 * Deliberately not {@link parseAgnesModelRow}: that parser serves the media
 * directory and drops `chat`-prefixed ids, which are precisely the ids a chat
 * directory uses. What the two share is the media filter — a row naming an image
 * or video generator is not a chat route, whichever half of the document it
 * arrived in.
 *
 * The id is taken from `id`/`model` only, never from a display name: a route id
 * invented from a label would be sent upstream and 4xx on every call. A
 * path-shaped id is dropped for the same reason the media parser drops one —
 * this picker spells a provider-qualified route with a slash of its own, so a
 * directory id that already carries one cannot be addressed unambiguously.
 * @param value - the raw directory row.
 * @returns the row, or `undefined` when it names no usable chat route.
 */
function parseAgnesTextRow(value: unknown): AgnesMediaModel | undefined {
  const row = object(value)
  const id = string(row.id ?? row.model)
  if (id === undefined || id.trim() === '' || id.includes('/')) return undefined
  const name = string(row.displayName ?? row.title) ?? id
  if (agnesMediaCategory(`${id} ${name}`) !== undefined) return undefined
  return { id, name }
}

/** The Agnes account status the settings surface reports. */
export type AgnesStatus =
  | { readonly status: 'signed-out'; readonly accounts: readonly [] }
  | {
    readonly status: 'authenticated'
    readonly accounts: readonly AgnesAccountStatus[]
    readonly activeAccountId?: string
    readonly email?: string
    readonly username?: string
    readonly apiKeyConfigured: boolean
  }

interface AgnesAccount {
  readonly id: string
  readonly accessToken: string
  readonly email?: string
  readonly username?: string
  readonly apiKey?: string
  /**
   * Set when the platform rejected this account's session.
   *
   * Agnes exposes session validation rather than a refresh token, so nothing
   * local can revive the credential — but the row still carries the email, the
   * provisioned API key and the user's own choice of account, so it is kept and
   * merely taken out of rotation until a fresh sign-in replaces it.
   */
  readonly note?: string
}

/** The marker one rejected Agnes session is parked under. */
const AGNES_REAUTH_NOTE = 'AGNES_REAUTH_REQUIRED'

/** Whether an account can still carry a request. */
function sessionUsable(account: AgnesAccount): boolean {
  return account.note !== AGNES_REAUTH_NOTE
}

interface AgnesStore { readonly accounts: readonly AgnesAccount[]; readonly activeAccountId?: string }

function message(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value ?? 'request failed') }
function redact(value: string): string { return redactCredentialShapes(value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>').replace(/("(?:token|access_token|api_key|key)"\s*:\s*")[^"]+(")/gi, '$1<redacted>$2').slice(0, 1024) }
function accountId(email?: string, username?: string): string { return (email ?? username ?? `agnes-${Date.now()}`).trim().toLowerCase() }
/** Providers spell terminal video statuses differently (`succeed`, `Completed`);
 * normalize them so polling and UI gates agree on one vocabulary. */
function normalizeVideoStatus(value: string | undefined): string {
  const status = value?.trim().toLowerCase() ?? ''
  if (['completed', 'succeed', 'success', 'succeeded', 'done', 'ok'].includes(status)) return 'completed'
  if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed'
  return value?.trim() === '' || value === undefined ? 'unknown' : value.trim()
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted')) }, { once: true })
  })
}

/**
 * Merge a caller's abort signal with this call's own deadline.
 *
 * The caller's signal is what makes a disposed session stop the work it started,
 * so it must not be replaced; the deadline is what keeps a wedged upstream from
 * holding the turn open. `AbortSignal.any` yields whichever arrives first and
 * keeps that signal's reason, which is how the failure below can still tell a
 * timeout apart from a caller abort.
 */
function agnesDeadline(timeoutMs: number, signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal === undefined || signal === null ? deadline : AbortSignal.any([signal, deadline])
}

/**
 * The wording a timeout starts with.
 *
 * Shared with the adapter so it can pass the bound on to the user instead of
 * collapsing it into the generic transport line; two literals would drift.
 */
const AGNES_TIMEOUT_PREFIX = 'Agnes request timed out'

/**
 * The failure to report for a request whose merged signal has already aborted.
 *
 * A timeout is spelled out with the bound that was exceeded; a caller abort
 * keeps the caller's own reason, because the harness that aborted is the only
 * one that knows why. Neither branch quotes the URL, headers, or body, so no
 * credential the request carried can ride out on the error text.
 */
function agnesAbortError(signal: AbortSignal, timeoutMs: number): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') return new Error(`${AGNES_TIMEOUT_PREFIX} after ${Math.round(timeoutMs / 1_000)}s`)
  return signal.reason instanceof Error ? signal.reason : new Error('Agnes request was aborted before it completed')
}

/** One request on an already-merged signal, so a rotation can share one deadline. */
async function agnesSend(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal })
  } catch (error) {
    if (signal.aborted) throw agnesAbortError(signal, timeoutMs)
    throw error instanceof Error ? error : new Error('Agnes request failed')
  }
}

/** One bounded request: the caller's signal (when it has one) merged with the deadline. */
function agnesFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return agnesSend(url, init, agnesDeadline(timeoutMs, init.signal), timeoutMs)
}

/**
 * One image generation request against the Agnes media API.
 */
export interface AgnesImageRequest { readonly prompt: string; readonly model?: string; readonly size?: string; readonly ratio?: string; readonly images?: readonly string[]; readonly signal?: AbortSignal }
/**
 * The images one generation produced, as URLs or inline base64 bytes.
 */
export interface AgnesImageResult { readonly model: string; readonly images: { readonly url?: string; readonly b64Json?: string }[] }
/**
 * One video generation request against the Agnes media API.
 */
export interface AgnesVideoRequest {
  readonly prompt: string
  readonly model?: string
  readonly seconds?: string
  readonly mode?: 'text' | 'keyframe' | 'reference'
  readonly size?: '720P'
  readonly aspectRatio?: string
  readonly firstFrame?: string
  readonly lastFrame?: string
  readonly images?: readonly string[]
  readonly audios?: readonly string[]
  readonly videos?: readonly string[]
  readonly signal?: AbortSignal
}
/**
 * State of one Agnes video job.
 */
export interface AgnesVideoResult { readonly videoId: string; readonly status: string; readonly url?: string; readonly error?: string }

/**
 * Agnes accounts, keys, and media calls, with sessions kept in the Host credential store.
 */
export class AgnesClient {
  private cursor = 0
  private mediaModelsCache: { readonly expiresAt: number; readonly models: readonly AgnesMediaModel[] } | undefined
  private mediaModelsPromise: Promise<readonly AgnesMediaModel[]> | undefined
  /** Chat rows from the same directory read; cached on the same window. */
  private textModelsCache: { readonly expiresAt: number; readonly models: readonly AgnesMediaModel[] } | undefined
  private textModelsPromise: Promise<readonly AgnesMediaModel[]> | undefined
  constructor(private readonly credentials: CredentialProvider) {}

    /**
   * Send a verification code for one Agnes flow.
   * @param email - the address the code is sent to.
   * @param purpose - whether the code belongs to registration or a password reset.
   * @returns true once the platform accepted the request.
   */
async sendVerificationCode(email: string, purpose: 'register' | 'reset' = 'register'): Promise<{ readonly sent: boolean }> {
    const response = await agnesFetch(`${PLATFORM}/api/verification?email=${encodeURIComponent(email)}&purpose=${purpose}`, {}, AGNES_AUTH_TIMEOUT_MS)
    const data = object(await this.responseJson(response))
    if (data.code !== 200) throw new Error(`Agnes verification failed: ${redact(message(data.message))}`)
    return { sent: true }
  }

    /**
   * Send the password-reset verification code.
   * @param email - the address the code is sent to.
   * @returns true once the platform accepted the request.
   */
async sendPasswordResetCode(email: string): Promise<{ readonly sent: boolean }> { return this.sendVerificationCode(email, 'reset') }

    /**
   * Set a new password using the code the platform mailed.
   * @param input - the address, the new password, and the mailed code.
   * @returns true once the platform accepted the change.
   */
async resetPassword(input: { readonly email: string; readonly password: string; readonly code: string }): Promise<{ readonly updated: boolean }> {
    const response = await agnesFetch(`${PLATFORM}/api/reset_password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input.email, new_password: input.password, new_password_confirm: input.password, code: input.code }),
    }, AGNES_AUTH_TIMEOUT_MS)
    const data = object(await this.responseJson(response))
    if (data.code !== 200) throw new Error(`Agnes password reset failed: ${redact(message(data.message))}`)
    return { updated: true }
  }

    /**
   * Register an account, then sign in with the credentials just created.
   * @param input - the address, password, and mailed code.
   * @returns the client's state after the sign-in.
   */
async register(input: { readonly email: string; readonly password: string; readonly code: string }): Promise<AgnesStatus> {
    const response = await agnesFetch(`${PLATFORM}/api/user/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.email, password: input.password, password_confirm: input.password, code: input.code }) }, AGNES_AUTH_TIMEOUT_MS)
    const data = object(await this.responseJson(response))
    if (data.code !== 200) throw new Error(`Agnes registration failed: ${redact(message(data.message))}`)
    return this.login(input.email, input.password)
  }

  /** Adds or replaces only the matching account; existing accounts remain usable. 
   * @returns the agnes Status.
   * @param username - the account's sign-in name.
   * @param password - the account's password.
   */
  async login(username: string, password: string): Promise<AgnesStatus> {
    const response = await agnesFetch(`${PLATFORM}/api/user/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }, AGNES_AUTH_TIMEOUT_MS)
    const data = object(await this.responseJson(response))
    if (data.code !== 200) throw new Error(`Agnes login failed: ${redact(message(data.message))}`)
    const payload = object(data.data)
    const accessToken = string(payload.access_token ?? payload.accessToken ?? payload.token)
    if (accessToken === undefined) throw new Error('Agnes login returned no access token')
    const email = string(payload.email) ?? username
    const payloadUsername = string(payload.username)
    const account: AgnesAccount = { id: accountId(email, payloadUsername), accessToken, email, ...(payloadUsername === undefined ? {} : { username: payloadUsername }) }
    // Re-login replaces the session token but must keep the already-provisioned
    // API key; dropping it here would mint a new platform key on every login.
    // Signing in is a choice: this becomes the account the card reports.
    await this.updateAccount(account.id, previous => ({
      ...account,
      ...(previous?.apiKey === undefined ? {} : { apiKey: previous.apiKey }),
    }), { adopt: true })
    await this.createApiKey(account.id)
    return this.status()
  }

    /**
   * Read the signed-in accounts and which of them is active.
   * @returns the state the settings surface renders.
   */
async status(): Promise<AgnesStatus> {
    const store = await this.readStore()
    if (store.accounts.length === 0) return { status: 'signed-out', accounts: [] }
    const accounts = store.accounts.map(account => ({ id: account.id, ...(account.email === undefined ? {} : { email: account.email }), ...(account.username === undefined ? {} : { username: account.username }), apiKeyConfigured: account.apiKey !== undefined && account.apiKey.trim() !== '', ...(sessionUsable(account) ? {} : { reauthRequired: true }) }))
    const active = store.accounts.find(account => account.id === store.activeAccountId) ?? store.accounts[0]
    if (active === undefined) return { status: 'signed-out', accounts: [] }
    return { status: 'authenticated', accounts, activeAccountId: active.id, ...(active.email === undefined ? {} : { email: active.email }), ...(active.username === undefined ? {} : { username: active.username }), apiKeyConfigured: active.apiKey !== undefined && active.apiKey.trim() !== '' }
  }

  /** Stable name used for the FreeCodeGo-provisioned Agnes API key. */
  private static readonly API_KEY_NAME = 'freecodego'

    /**
   * Provision, or reuse, this plugin's Agnes API key for one account.
   * @param accountIdValue - the account to provision for; defaults to the active one.
   * @returns whether a key is configured, and the account it belongs to.
   */
async createApiKey(accountIdValue?: string): Promise<{ readonly configured: boolean; readonly accountId: string }> {
    const store = await this.readStore(); const account = this.pickAccount(store, accountIdValue)
    if (account === undefined) throw new Error('AGNES_LOGIN_REQUIRED: sign in to Agnes first')
    // Provisioning against a rejected session would only surface an upstream
    // 401; the account has to be signed in again first.
    if (!sessionUsable(account)) throw new Error('AGNES_REAUTH_REQUIRED: Agnes session expired; sign in again')
    // Minting on every login orphans keys on the platform; reuse the stored key
    // first, then any existing key the platform already issued under the
    // stable `freecodego` name.
    const existing = account.apiKey !== undefined && account.apiKey.trim() !== '' ? account.apiKey : await this.findExistingApiKey(account)
    if (existing !== undefined) {
      // Provisioning a key for one account (the card can ask for any of them)
      // is not a switch, so the reported account stays where it was.
      await this.updateAccount(account.id, previous => previous === undefined ? undefined : { ...previous, apiKey: existing })
      // Keep the legacy Host-only slot populated for older harness builds; the
      // active account store remains the source of truth for multi-account use.
      await this.credentials.set(AGNES_API_KEY_REF, existing)
      return { configured: true, accountId: account.id }
    }
    const response = await agnesFetch(`${PLATFORM}/api/token`, { method: 'POST', headers: this.authHeaders(account), body: JSON.stringify({ name: AgnesClient.API_KEY_NAME, api_key_profile: 'default' }) }, AGNES_AUTH_TIMEOUT_MS)
    const data = object(await this.responseJson(response))
    if (data.code !== 200) throw new Error(`Agnes API key creation failed: ${redact(typeof data.message === 'string' ? data.message : JSON.stringify(data.message ?? 'request failed'))}`)
    const payload = object(data.data);    const key = string(payload.key ?? payload.api_key ?? payload.token)
    if (key === undefined) throw new Error('Agnes API key creation returned no key')
    await this.updateAccount(account.id, previous => previous === undefined ? undefined : { ...previous, apiKey: key })
    await this.credentials.set(AGNES_API_KEY_REF, key)
    return { configured: true, accountId: account.id }
  }

  /** Agnes lists existing tokens; reuse the FreeCodeGo one before minting a new key. */
  private async findExistingApiKey(account: AgnesAccount): Promise<string | undefined> {
    try {
      const response = await agnesFetch(`${PLATFORM}/api/token`, { headers: { Authorization: `Bearer ${account.accessToken}` } }, AGNES_AUTH_TIMEOUT_MS)
      if (!response.ok) return undefined
      const data = object(await response.json())
      const nested = object(data.data)
      const list = Array.isArray(data.data) ? data.data : Array.isArray(nested.items) ? nested.items : Array.isArray(data.items) ? data.items : []
      for (const raw of list) {
        const item = object(raw)
        const name = string(item.name)
        if (name !== undefined && name.trim().toLowerCase() !== AgnesClient.API_KEY_NAME) continue
        const key = string(item.key ?? item.api_key ?? item.token ?? object(item.token_record).key)
        if (key !== undefined) return key
      }
      return undefined
    } catch { /* reuse is best-effort; minting remains the fallback */ }
  }

  /**
   * Write one account's row into the store as it is *now*.
   *
   * Every caller here reached this point through a network request, and each one
   * builds its write out of a store it read before that request. Persisting such
   * a list wholesale undoes whatever else happened while the request was in
   * flight: an account the user removed in the meantime comes back with its
   * session token, and one signed in on another surface disappears. The row this
   * call owns is merged into a fresh read instead, which is also what keeps the
   * selection honest — a stale row would restore an `activeAccountId` the user
   * has since changed.
   *
   * @param id - the account this call owns; nothing else in the store moves.
   * @param update - the row to persist, given the one the store holds now. It
   *   may answer `undefined` to leave the store alone, which is what a caller
   *   does when the account is no longer there to update: an account removed
   *   while its own request was in flight must not be resurrected by it.
   * @param options - `adopt` when the user just authorized this account, the one
   *   case where a write may move the identity the card reports.
   */
  private async updateAccount(
    id: string,
    update: (previous: AgnesAccount | undefined) => AgnesAccount | undefined,
    options: { readonly adopt?: boolean } = {},
  ): Promise<void> {
    const store = await this.readStore()
    const next = update(store.accounts.find(account => account.id === id))
    if (next === undefined) return
    // Replaced where it stands rather than moved to the end: the store's order is
    // the order the settings card lists accounts in, and a park or a key write is
    // no reason for an account to jump.
    const accounts = store.accounts.some(account => account.id === id)
      ? store.accounts.map(account => account.id === id ? next : account)
      : [...store.accounts, next]
    await this.saveStore({
      accounts,
      activeAccountId: activeAccountIdAfterWrite(accounts, {
        previousActiveId: store.activeAccountId,
        writtenId: id,
        ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
      }),
    })
  }

    /**
   * Forget one account locally, leaving the others usable.
   * @param id - id of the account to remove.
   * @returns the state after the removal.
   */
async removeAccount(id: string): Promise<AgnesStatus> {
    const store = await this.readStore(); const accounts = store.accounts.filter(account => account.id !== id)
    const activeAccountId = activeAccountIdAfterRemoval(accounts, store.activeAccountId)
    await this.saveStore({ accounts, ...(activeAccountId === undefined ? {} : { activeAccountId }) }); return this.status()
  }

  /** Agnes currently exposes session validation rather than a refresh token. 
   * @returns the agnes Status.
   * @param accountIdValue - the account to revalidate; defaults to the active one.
   */
  async refreshAccount(accountIdValue?: string): Promise<AgnesStatus> {
    const store = await this.readStore(); const account = this.pickAccount(store, accountIdValue)
    if (account === undefined) throw new Error('AGNES_LOGIN_REQUIRED: sign in to Agnes first')
    const response = await agnesFetch(`${PLATFORM}/api/user/self`, { headers: this.authHeaders(account) }, AGNES_AUTH_TIMEOUT_MS)
    if (response.status === 401) {
      // Keep the account and rotate away from it: Agnes cannot mint a new
      // session locally, and dropping the row would also drop the API key the
      // user already provisioned (plus the record that this account exists).
      await this.updateAccount(account.id, previous => previous === undefined ? undefined : { ...previous, note: AGNES_REAUTH_NOTE })
      throw new Error('AGNES_REAUTH_REQUIRED: Agnes session expired; sign in again')
    }
    const data = object(await this.responseJson(response)); const profile = object(data.data ?? data)
    const email = string(profile.email) ?? account.email; const username = string(profile.username) ?? account.username
    // A validity probe is not a switch: refreshing one account must not make it
    // the identity the card reports.
    await this.updateAccount(account.id, previous => previous === undefined ? undefined : {
      ...previous,
      ...(email === undefined ? {} : { email }),
      ...(username === undefined ? {} : { username }),
    })
    return this.status()
  }

    /**
   * Sign one account out, or every account, revoking its session and clearing the stored keys.
   * @param accountIdValue - the account to sign out; omitted signs every account out.
     * @returns the state after the sign-out.
     */
async logout(accountIdValue?: string): Promise<AgnesStatus> {
    const store = await this.readStore()
    if (accountIdValue === undefined) {
      for (const account of store.accounts) { try { await agnesFetch(`${PLATFORM}/api/user/logout`, { headers: this.authHeaders(account) }, AGNES_AUTH_TIMEOUT_MS) } catch { /* local removal still wins */ } }
      await this.credentials.unset(AGNES_AUTH_REF); await this.credentials.unset(AGNES_API_KEY_REF); return { status: 'signed-out', accounts: [] }
    }
    const account = store.accounts.find(item => item.id === accountIdValue)
    if (account !== undefined) { try { await agnesFetch(`${PLATFORM}/api/user/logout`, { headers: this.authHeaders(account) }, AGNES_AUTH_TIMEOUT_MS) } catch { /* ignore remote logout failure */ } }
    return this.removeAccount(accountIdValue)
  }

  /**
   * Chat-capable Agnes routes: the documented chat model, plus every non-media
   * route the live directory lists.
   *
   * The document is one directory holding both halves, split here by
   * {@link agnesMediaCategory}. Media generators stay out because the chat picker
   * cannot start a chat against a route that only takes an image prompt, and they
   * have their own path anyway (`agnesMediaModels` / `liveMediaCatalog`). The text
   * half is *included* because a chat route the directory lists is one the
   * account can reach: returning only the documented model left every other Agnes
   * chat route invisible until a plugin release named it.
   *
   * A directory that cannot be read is not a reason to lose the seed — the live
   * rows are an addition to the documented one, never a replacement for it.
   * @returns the llm Model Info rows, documented rows first.
   */
  async listModels(): Promise<readonly LlmModelInfo[]> {
    await this.requireApiKey()
    const merged = new Map<string, LlmModelInfo>()
    for (const model of DOCUMENTED_MODELS) {
      if (agnesMediaCategory(model.id) !== undefined) continue
      merged.set(model.id.toLowerCase(), { provider: 'agnes', ...model })
    }
    for (const model of await this.liveTextRows().catch(() => [] as readonly AgnesMediaModel[])) {
      const key = model.id.toLowerCase()
      if (merged.has(key)) continue
      // No availability flag here: the adapter stamps that once for the whole list
      // (see `AgnesAdapter.listModels`), and a second answer per row would be a
      // second place for the two to disagree.
      merged.set(key, { provider: 'agnes', id: model.id, name: model.name, inputModalities: ['text'] })
    }
    return [...merged.values()]
  }

  /** The live directory's chat rows, cached like its media rows. 
   * @returns the non-media routes the directory lists, in backend order.
   */
  private async liveTextRows(): Promise<readonly AgnesMediaModel[]> {
    const cached = this.textModelsCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models
    const inFlight = this.textModelsPromise
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<readonly AgnesMediaModel[]> => {
      const payload = object(await this.directoryJson())
      const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
      return rows.map(parseAgnesTextRow).filter((model): model is AgnesMediaModel => model !== undefined)
    })()
    this.textModelsPromise = operation
    try {
      const models = await operation
      this.textModelsCache = { expiresAt: Date.now() + AGNES_MODELS_CACHE_TTL_MS, models }
      return models
    } finally {
      if (this.textModelsPromise === operation) this.textModelsPromise = undefined
    }
  }

    /**
   * Open a streaming chat completion against the Agnes gateway.
   * @param body - the serialized request body.
   * @param signal - aborts the request when the turn is cancelled.
   * @returns the streamed response, with its body still unread.
   */
async chat(body: string, signal: AbortSignal): Promise<Response> { return this.requestWithAccounts(`${API_BASE}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body, signal }, AGNES_CHAT_TIMEOUT_MS) }

    /**
   * Generate images and return their URLs or inline bytes.
   * @param input - the prompt, model, size, and any seed images.
   * @returns the resolved model and the images it produced.
   */
async generateImage(input: AgnesImageRequest): Promise<AgnesImageResult> {
    const prompt = input.prompt.trim(); if (prompt === '') throw new Error('AGNES_IMAGE_PROMPT_REQUIRED')
    // A caller-provided model must still be an image-capable Agnes route; the
    // live directory decides membership rather than a pinned id list.
    const model = input.model?.trim() ?? ''
    const resolved = model !== '' && agnesMediaCategory(model) === 'image' ? model : 'agnes-image-2.5-flash'
    const extraBody = { response_format: 'url', ...(input.images === undefined ? {} : { image: input.images }) }
    const payload: Record<string, unknown> = { model: resolved, prompt, size: input.size ?? '1024x1024', ...(input.ratio === undefined ? {} : { ratio: input.ratio }), extra_body: extraBody }
    const data = object(await this.requestJsonWithAccounts(`${API_BASE}/images/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...(input.signal === undefined ? {} : { signal: input.signal }) }, AGNES_MEDIA_TIMEOUT_MS))
    const images = Array.isArray(data.data) ? data.data.map(object).map((item) => { const url = string(item.url); const b64Json = string(item.b64_json); return url === undefined ? (b64Json === undefined ? undefined : { b64Json }) : (b64Json === undefined ? { url } : { url, b64Json }) }).filter((item): item is { url?: string; b64Json?: string } => item !== undefined) : []
    if (images.length === 0) throw new Error('Agnes image response contained no image')
    return { model: resolved, images }
  }

    /**
   * Start a video job and return the handle to poll.
   * @param input - the prompt, model, and video options.
   * @returns the job id and its first reported state.
   */
async createVideo(input: AgnesVideoRequest): Promise<AgnesVideoResult> {
    const prompt = input.prompt.trim(); if (prompt === '') throw new Error('AGNES_VIDEO_PROMPT_REQUIRED')
    if (input.seconds !== undefined && !AGNES_VIDEO_SECONDS.includes(input.seconds)) throw new Error('AGNES_VIDEO_SECONDS_INVALID: use 4 through 12 seconds')
    // Same live-directory rule as images: honor any video-capable Agnes id,
    // fall back to the documented video model when absent or mismatched.
    const requestedModel = input.model?.trim() ?? ''
    const resolvedModel = requestedModel !== '' && agnesMediaCategory(requestedModel) === 'video' ? requestedModel : 'agnes-video-2.5-flash'
    const payload: Record<string, unknown> = { model: resolvedModel, prompt, seconds: input.seconds ?? '4', mode: input.mode ?? 'text', size: input.size ?? '720P', aspect_ratio: input.aspectRatio ?? '16:9', ...(input.firstFrame === undefined ? {} : { first_frame: input.firstFrame }), ...(input.lastFrame === undefined ? {} : { last_frame: input.lastFrame }), ...(input.images === undefined ? {} : { images: input.images }), ...(input.audios === undefined ? {} : { audios: input.audios }), ...(input.videos === undefined ? {} : { videos: input.videos }) }
    const data = object(await this.requestJsonWithAccounts(`${API_BASE}/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...(input.signal === undefined ? {} : { signal: input.signal }) }, AGNES_MEDIA_TIMEOUT_MS))
    const item = object(data.data ?? data); const videoId = string(item.video_id ?? item.videoId ?? item.id)
    if (videoId === undefined) throw new Error('Agnes video response contained no video id')
    return this.pollVideo(videoId, input.signal)
  }

    /**
   * Read the state of one previously started Agnes video job.
   * @param videoId - the id the create call returned.
   * @param signal - aborts the poll when the caller cancels.
   * @returns the job's current state.
   */
async getVideo(videoId: string, signal?: AbortSignal): Promise<AgnesVideoResult> {
    const id = videoId.trim(); if (id === '') throw new Error('AGNES_VIDEO_ID_REQUIRED')
    const data = object(await this.requestJsonWithAccounts(`${VIDEO_STATUS_BASE}?video_id=${encodeURIComponent(id)}`, { method: 'GET', ...(signal === undefined ? {} : { signal }) }, AGNES_STATUS_TIMEOUT_MS))
    const item = object(data.data ?? data)
    const url = string(item.url); const error = string(item.error)
    return { videoId: id, status: normalizeVideoStatus(string(item.status)), ...(url === undefined ? {} : { url }), ...(error === undefined ? {} : { error }) }
  }

  /** `/models` payload: authenticated with account rotation when signed in,
   * plain public request otherwise (the endpoint is commonly gated). */
  private async directoryJson(): Promise<unknown> {
    const store = await this.readStore()
    if (store.accounts.length > 0) return this.requestJsonWithAccounts(AGNES_MODELS_URL, { method: 'GET' }, AGNES_MODELS_TIMEOUT_MS)
    const response = await fetch(AGNES_MODELS_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(AGNES_MODELS_TIMEOUT_MS) })
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`Agnes model directory request failed (HTTP ${response.status})`) }
    return response.json()
  }

  /** Live media directory parsed from Agnes' `/models` endpoint. 
   * @returns the agnes Media Model rows, in backend order.
   */
  async listLiveMediaModels(): Promise<readonly AgnesMediaModel[]> {
    const cached = this.mediaModelsCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models
    const inFlight = this.mediaModelsPromise
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<readonly AgnesMediaModel[]> => {
      const payload = object(await this.directoryJson())
      const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
      const models = rows.map(parseAgnesModelRow).filter((model): model is AgnesMediaModel => model !== undefined && agnesMediaCategory(model.id) !== undefined)
      const merged = new Map<string, AgnesMediaModel>()
      // Documented media models stay selectable even when the live directory
      // omits them (pagination gaps, preview pruning); live rows win on
      // conflict so renames surface immediately.
      for (const model of AGNES_MEDIA_FALLBACK_MODELS) merged.set(model.id.toLowerCase(), { id: model.id, name: model.name })
      for (const model of models) merged.set(model.id.toLowerCase(), model)
      return [...merged.values()]
    })()
    this.mediaModelsPromise = operation
    try {
      const models = await operation
      this.mediaModelsCache = { expiresAt: Date.now() + AGNES_MODELS_CACHE_TTL_MS, models }
      return models
    } finally {
      if (this.mediaModelsPromise === operation) this.mediaModelsPromise = undefined
    }
  }

  /** Media category of a raw Agnes model id, resolved against the live
   * directory first and the documented fallbacks second. An unreachable
   * directory degrades to the documented ids instead of dropping the
   * provider from the media fallback chain. 
   * @returns the matching names, in the order the backend listed them.
   * @param category - the media kind to list models for.
   */
  async agnesMediaModels(category: AgnesMediaCategory): Promise<readonly string[]> {
    const models = await this.listLiveMediaModels().catch(() => AGNES_MEDIA_FALLBACK_MODELS.map(model => ({ id: model.id, name: model.name })))
    return models.filter(model => agnesMediaCategory(model.id) === category).map(model => model.id)
  }

  /** Live media directory parsed from Agnes' public `/models` endpoint, shared
   * with the plugin-side managed catalog so the settings picker and the media
   * fallback chain see the same availability facts. 
   * @returns the agnes Media Model rows, in backend order.
   */
  async liveMediaCatalog(): Promise<readonly AgnesMediaModel[]> { return this.listLiveMediaModels().catch(() => AGNES_MEDIA_FALLBACK_MODELS.map(model => ({ id: model.id, name: model.name }))) }

  private async pollVideo(videoId: string, signal?: AbortSignal): Promise<AgnesVideoResult> {
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      const result = await this.getVideo(videoId, signal)
      // Completed results are returned even when the provider spells the
      // status differently (`succeed`, `Completed`); a done video must never
      // be dropped in favor of a timeout error.
      if (result.status === 'completed' || result.status === 'failed') return result
      if (result.url !== undefined) return { ...result, status: 'completed' }
      await sleep(2_000, signal)
    }
    // A still-running task must not masquerade as a success result: the tool
    // would render this stub as a completed generation and no other video
    // route would be tried. Fail loudly (like the gateway polling path) so the
    // media fallback chain can attempt the next candidate route.
    throw new Error(`Agnes video task ${videoId} did not complete within the 10 minute polling window`)
  }

  private async requestJsonWithAccounts(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> { return this.requestWithAccounts(url, init, timeoutMs).then(response => this.responseJson(response)) }
  private async requireApiKey(): Promise<void> { const store = await this.readStore(); if (store.accounts.length === 0) throw new Error('AGNES_LOGIN_REQUIRED: sign in to Agnes first'); if (store.accounts.every(account => account.apiKey === undefined || account.apiKey.trim() === '')) throw new Error('AGNES_API_KEY_REQUIRED: sign in and create an Agnes API key first') }
  private async requestWithAccounts(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const store = await this.readStore(); if (store.accounts.length === 0) throw new Error('AGNES_LOGIN_REQUIRED: sign in to Agnes first')
    // One deadline covers the whole call rather than one per attempt: failing
    // over through the pool must not multiply the caller's wait by the number
    // of accounts it happens to hold.
    const signal = agnesDeadline(timeoutMs, init.signal)
    let last: Response | undefined
    for (let attempt = 0; attempt < store.accounts.length; attempt++) {
      // An aborted caller is an instruction to stop, not a reason to fail over:
      // another attempt would outlive the session that asked for this one.
      if (signal.aborted) throw agnesAbortError(signal, timeoutMs)
      const account = this.nextAccount(store); if (account === undefined) continue
      const headers = new Headers(init.headers)
      for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
      headers.set('Authorization', `Bearer ${account.apiKey}`)
      const response = await agnesSend(url, { ...init, headers }, signal, timeoutMs)
      // 401/402/403/429 rotate accounts on any method. 408/409 are only retried
      // for idempotent GETs: re-POSTing a media generation may duplicate an
      // already-accepted (and billed) task.
      const rotateStatuses = (init.method ?? 'GET').toUpperCase() === 'GET'
        ? [401, 402, 403, 408, 409, 429]
        : [401, 402, 403, 429]
      if (!rotateStatuses.includes(response.status)) return response
      // Drain the failed body before reusing the connection for the next attempt.
      await response.body?.cancel().catch(() => undefined)
      last = response
    }
    if (last !== undefined) return last
    // Every account was skipped: saying "no API key" would send the user to
    // provision something that cannot help, so name the real state.
    if (store.accounts.length > 0 && store.accounts.every(account => !sessionUsable(account))) throw new Error('AGNES_REAUTH_REQUIRED: every Agnes account needs to be signed in again')
    throw new Error('AGNES_API_KEY_REQUIRED: sign in and create an Agnes API key first')
  }
  private nextAccount(store: AgnesStore): AgnesAccount | undefined { const available = store.accounts.filter(account => sessionUsable(account) && account.apiKey !== undefined && account.apiKey.trim() !== ''); if (available.length === 0) return undefined; const account = available[this.cursor % available.length]; this.cursor = (this.cursor + 1) % available.length; return account }
  private pickAccount(store: AgnesStore, id?: string): AgnesAccount | undefined { return id === undefined ? store.accounts.find(account => account.id === store.activeAccountId && sessionUsable(account)) ?? store.accounts.find(sessionUsable) ?? store.accounts[0] : store.accounts.find(account => account.id === id) }
  private async readStore(): Promise<AgnesStore> {
    const value = await this.credentials.resolve(AGNES_AUTH_REF)
    if (value !== undefined) {
      try {
        const parsed = object(JSON.parse(value.value)); const list = Array.isArray(parsed.accounts) ? parsed.accounts : [parsed]
        const accounts = list.map(item => object(item)).map((item) => { const accessToken = string(item.accessToken); if (accessToken === undefined) return undefined; const email = string(item.email); const username = string(item.username); const apiKey = string(item.apiKey); const note = string(item.note); return { id: string(item.id) ?? accountId(email, username), accessToken, ...(email === undefined ? {} : { email }), ...(username === undefined ? {} : { username }), ...(apiKey === undefined ? {} : { apiKey }), ...(note === undefined ? {} : { note }) } }).filter((item): item is AgnesAccount => item !== undefined)
        const legacyKey = await this.credentials.resolve(AGNES_API_KEY_REF)
        const migrated = legacyKey === undefined || accounts.some(account => account.apiKey !== undefined)
          ? accounts
          : accounts.map((account, index) => index === 0 ? { ...account, apiKey: legacyKey.value.trim() } : account)
        const activeAccountId = string(parsed.activeAccountId)
        return activeAccountId === undefined ? { accounts: migrated } : { accounts: migrated, activeAccountId }
      } catch { /* malformed credentials are treated as signed out */ }
    }
    return { accounts: [] }
  }
  private saveStore(store: AgnesStore): Promise<void> { return this.credentials.set(AGNES_AUTH_REF, JSON.stringify(store)) }
  private authHeaders(account: AgnesAccount): Record<string, string> { return { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' } }
  private async responseJson(response: Response): Promise<unknown> {
    const raw = await response.text()
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new Error(`Agnes returned invalid JSON (HTTP ${response.status})`) }
    if (!response.ok) {
      if (/sending too frequently/i.test(raw)) throw new Error('AGNES_VERIFICATION_RATE_LIMITED: verification code requests are temporarily limited; wait before trying again')
      if (/password reset is not supported for this account/i.test(raw)) throw new Error('AGNES_PASSWORD_RESET_UNSUPPORTED: Agnes does not support password reset for this account')
      throw new Error(`Agnes request failed (HTTP ${response.status}): ${redact(raw)}`)
    }
    return value
  }
}

/**
 * One failed Agnes response as an operator-readable message.
 *
 * `logfareResponseError` is the shared bounded, credential-redacted reader for a
 * failed upstream response; its name is historical (it predates the second
 * caller) and its body carries no Logfare rule.
 * @param response - the failed response, whose body is read once.
 * @returns the message, including the upstream's own explanation when it gave one.
 */
function agnesResponseError(response: Response): Promise<string> {
  return logfareResponseError(response, 'Agnes provider request failed')
}

/**
 * LLM adapter that surfaces Agnes chat routes in the Harness model directory.
 */
export class AgnesAdapter extends LlmAdapter {
  constructor(
    private readonly client: AgnesClient,
    private readonly resolveAttachments: () => AttachmentStore | undefined = () => undefined,
  ) { super() }
  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Agnes AI' } }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const status = await this.client.status()
    const configured = status.status === 'authenticated' && status.apiKeyConfigured
    // `client.listModels` already returns chat-capable routes only, so the
    // adapter does not re-filter by id: a second hardcoded id would need
    // updating twice on every model change and could silently disagree with
    // the client. The predicate below is the same one the client uses.
    try { return (await this.client.listModels()).map(model => ({ ...model, provider, availability: 'available' as const })) }
    catch (error) {
      // Keep the documented Agnes group visible before sign-in; actual calls
      // still fail closed in the Host with AGNES_LOGIN_REQUIRED.
      if (error instanceof Error && (error.message.startsWith('AGNES_LOGIN_REQUIRED') || error.message.startsWith('AGNES_API_KEY_REQUIRED'))) return DOCUMENTED_MODELS.filter(model => agnesMediaCategory(model.id) === undefined).map(model => ({ provider, ...model, ...(configured ? { availability: 'available' as const } : { availability: 'unavailable' as const, unavailableReason: status.status === 'authenticated' ? 'AGNES_API_KEY_REQUIRED' : 'AGNES_LOGIN_REQUIRED' }) }))
      throw error
    }
  }
  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // The live list, not just the documented seed: a route the directory added
    // has to resolve to its own display name, or choosing it would put its raw id
    // in the composer. The read is cached, and an unreadable directory degrades
    // to the documented row rather than failing the selection.
    const known = (await this.client.listModels().catch(() => [] as readonly LlmModelInfo[])).find(item => item.id === model)
      ?? DOCUMENTED_MODELS.find(item => item.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      // Respect the documented modality list: the text-only chat model must
      // not advertise image input (the chat stream path cannot carry images).
      inputModalities: known?.inputModalities ? [...known.inputModalities] : ['text'],
      context: { contextWindow: 131072 },
      defaultMaxTokens: AGNES_MAX_OUTPUT_TOKENS,
      ...(supportsAgnesReasoning(model) ? {
        reasoning: {
          efforts: AGNES_REASONING_EFFORTS.map(effort => ({
            id: ReasoningEffortId(effort),
            name: effort.slice(0, 1).toUpperCase() + effort.slice(1),
          })),
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {}),
    }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request = supportsAgnesReasoning(options.model)
      ? { ...options, reasoningEffort: options.reasoningEffort ?? ReasoningEffortId('high') }
      : options
    const body = await this.serialize(request, supportsAgnesReasoning(options.model) ? { reasoningWire: 'gateway' } : {})
    delete (body).stream_options
    // The budget is capped rather than passed through: the caller's default is
    // sized for the biggest route in the Harness, and Agnes rejects anything
    // above its own ceiling with a `400` instead of trimming it. An unnamed
    // budget is dropped so the service picks its own, which is what the omitted
    // field has always meant on this wire.
    const budget = clampMaxOutputTokens(typeof body.max_tokens === 'number' ? body.max_tokens : undefined, AGNES_MAX_OUTPUT_TOKENS)
    if (budget === undefined) delete (body).max_tokens
    else body.max_tokens = budget
    let response: Response
    try { response = await this.client.chat(JSON.stringify(body), options.signal ?? new AbortController().signal) } catch (error) {
      // The caller's own abort is not a provider failure: reporting it as one
      // would blame Agnes for a request the harness itself cancelled. Cline's
      // adapter draws the same line.
      if (options.signal?.aborted === true) throw new LlmError('Agnes request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof Error && error.message.startsWith('AGNES_')) throw new LlmError(error.message, 'AUTH', { cause: error })
      // A bounded request states its own reason, and the bound it exceeded is
      // the only fact the user needs to tell a slow provider apart from a bad
      // credential; the generic line below would hide it.
      if (error instanceof Error && error.message.startsWith(AGNES_TIMEOUT_PREFIX)) throw new LlmError(error.message, 'TRANSPORT', { cause: error })
      throw new LlmError('Agnes request failed', 'TRANSPORT', { cause: error })
    }
    // The upstream's own sentence rides the error. A bare status left the user
    // (and the next debugging session) unable to tell an unsupported request
    // field from an unknown model, which are the same `400` and different fixes.
    // The shared reader also bounds and redacts what it echoes, and Agnes is a
    // strict endpoint: it rejects a body field it does not know, so what it
    // names is the field to remove.
    if (!response.ok) throw new LlmError(await agnesResponseError(response), llmCodeForUpstreamStatus(response.status), { status: response.status })
    if (response.body === null) throw new LlmError('Agnes returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body))
  }

  private async serialize(
    options: GenerateOptions,
    defaults: { readonly reasoningWire?: 'gateway' },
  ): Promise<Record<string, unknown>> {
    if (!hasImageContent(options)) return serializeRequest(options, defaults)
    const attachments = this.resolveAttachments()
    if (attachments === undefined) throw new LlmError('Agnes cannot resolve image attachments in this deployment', 'UNSUPPORTED_CONTENT')
    return serializeRequestWithInlineImages(options, {
      resolveImage: (ref: ImageAttachmentRef): Promise<RequestImageAttachment> => attachments.readImageRequest(ref, inlineImageTarget(ref), options.signal),
    }, defaults)
  }
}

/** Per-route pixel and byte ceiling for Agnes inline images. */
const INLINE_IMAGE_POLICY = { maxPixels: 6_000_000, maxBytes: 10 * 1024 * 1024 } as const

/**
 * Harness 0.1.6 replaced the attachment service's `ImageRequestPolicy` with an
 * `ImageRequestTarget` of explicit width, height, and byte budget, so the pixel
 * ceiling is projected onto each source's geometry before the request.
 * @param ref - durable normalized image reference whose source geometry drives the projection.
 * @returns the request target for this route.
 */
function inlineImageTarget(ref: Pick<ImageAttachmentRef, 'width' | 'height'>) {
  return {
    ...requestImageDimensions(ref.width, ref.height, INLINE_IMAGE_POLICY.maxPixels),
    maxBytes: INLINE_IMAGE_POLICY.maxBytes,
  }
}
