/**
 * Browser-mediated FreeCodeGo OAuth sign-in for the headless Harness plugin.
 *
 * The plugin has no window to receive the browser fragment and no
 * `freecodego://` protocol handler, so it drives the existing
 * `/auth/oauth/{provider}/start` flow with `redirect=/oauth/desktop?state=<ours>&plugin=1`.
 * The backend callback then stores the issued pair under that state (and shows
 * the user a plain confirmation page instead of a deep link), while this side
 * polls `GET /auth/oauth/desktop/poll` until the pair arrives and adopts it
 * into the Host credential vault.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/oauth-login
 */

import { randomBytes } from 'node:crypto'
import type { FreeCodeGoTokenPair } from '@deepseek-ai/dsh-freecodego-api'
import type { OAuthLoginPendingRegistration, OAuthLoginPendingStep } from './types.ts'

/** Federated providers the login card offers; mirrors the backend routes. */
export type OAuthLoginProvider = 'google' | 'github'

/** How often one sign-in polls the backend handoff. */
export const OAUTH_LOGIN_POLL_INTERVAL_MS = 1_500
/**
 * Request header carrying the client-owned handoff state on the pending
 * registration's completion calls.
 *
 * The OAuth callback sets the pending-session cookies on the response the
 * *browser* receives, and the Host only opened that browser — it never holds
 * those cookies. The state it minted is the handle it does have, and the
 * backend resolves the credentials it already stored from it.
 */
export const OAUTH_HANDOFF_STATE_HEADER = 'X-FreeCodeGo-Handoff-State'
/** Total budget for one browser sign-in; matches the backend handoff window. */
export const OAUTH_LOGIN_POLL_TIMEOUT_MS = 10 * 60_000
/** Per-request network budget; a slow poll must not eat the whole window. */
export const OAUTH_LOGIN_POLL_REQUEST_TIMEOUT_MS = 10_000

/**
 * Default entropy source for the handoff state.
 *
 * `Math.random` was the only non-cryptographic source used for a credential
 * handle anywhere in this plugin — every other correlation or secret identifier
 * (`advisor`, `action-reviewer`, `capabilities`, the memory store) draws from
 * `node:crypto` — and this string is the *sole* key that the public poll
 * endpoint resolves an issued token pair with, so its unpredictability is what
 * keeps one client from being handed another client's pair. The value stays a
 * `number` in `[0, 1)` only because the state format is fixed by the backend's
 * pattern; the entropy comes from 6 crypto bytes rather than from a PRNG that
 * is neither seeded nor specified for this purpose.
 */
function cryptoRandom(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48
}

/**
 * Generate the client-owned handoff state.
 *
 * It doubles as the only key to the issued pair on the public poll endpoint,
 * so it carries timestamp plus random entropy (≥16 URL-safe characters, which
 * the backend requires before it will ever store or return a pair).
 */
export function generateOAuthLoginState(nowMs: number = Date.now(), random: () => number = cryptoRandom): string {
  return `fcg_oauth_${nowMs.toString(36)}_${Math.floor(random() * 36 ** 10).toString(36).padStart(10, '0')}`
}

/**
 * Build the provider authorization URL for one headless sign-in.
 *
 * The redirect value is itself a query string, so it is encoded twice by
 * design: the backend decodes `redirect` once and reads `state`/`plugin` from
 * the inner query, exactly like the desktop deep-link mode does.
 */
export function pluginOAuthStartUrl(origin: string, provider: OAuthLoginProvider, state: string): string {
  const base = new URL(origin).origin
  const redirect = `/oauth/desktop?state=${encodeURIComponent(state)}&plugin=1`
  return `${base}/api/v1/auth/oauth/${provider}/start?redirect=${encodeURIComponent(redirect)}`
}

/** Build one handoff poll URL for the given client state. */
export function oauthHandoffPollUrl(origin: string, state: string): string {
  return `${new URL(origin).origin}/api/v1/auth/oauth/desktop/poll?state=${encodeURIComponent(state)}`
}

/**
 * The two pending-registration shapes are re-exported from `types.ts`: they
 * cross a Remote boundary, and the Typert generator only accepts a boundary
 * type declared in the package's public type subpath.
 */
export type { OAuthLoginPendingRegistration, OAuthLoginPendingStep } from './types.ts'

/** Outcome of one parsed handoff poll response. */
export type OAuthHandoffPollResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'authenticated'; readonly tokens: FreeCodeGoTokenPair }
  | { readonly kind: 'pending-registration'; readonly registration: OAuthLoginPendingRegistration }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Read the pending-registration step out of one status payload.
 *
 * The backend normalizes every choice alias onto `choose_account_action_required`;
 * `email_completion` and `bind_login_required` are the other two terminal steps.
 */
export function parseOAuthPendingStep(value: unknown): OAuthLoginPendingStep | undefined {
  const step = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (step === 'choose_account_action_required' || step === 'choose_account_action' || step === 'choice' || step === 'choose_account' || step === 'choose' || step === 'email_required') return 'choose-account'
  if (step === 'email_completion') return 'email-completion'
  if (step === 'bind_login_required') return 'bind-login'
  return undefined
}

/** Project one `/oauth/desktop/pending` status payload for the plugin UI. */
export function parseOAuthPendingRegistration(payload: unknown): OAuthLoginPendingRegistration | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const root = payload as Record<string, unknown>
  const step = parseOAuthPendingStep(root.step)
  if (step === undefined) return undefined
  const email = typeof root.email === 'string' && root.email.trim() !== '' ? root.email.trim() : undefined
  const displayName = typeof root.suggested_display_name === 'string' && root.suggested_display_name.trim() !== '' ? root.suggested_display_name.trim() : undefined
  const avatarUrl = typeof root.suggested_avatar_url === 'string' && root.suggested_avatar_url.trim() !== '' ? root.suggested_avatar_url.trim() : undefined
  return {
    step,
    ...(email === undefined ? {} : { email }),
    invitationRequired: root.invitation_required === true,
    emailVerified: root.email_verified === true,
    ...(displayName === undefined ? {} : { displayName }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  }
}

/** Build the pending-registration status URL for one headless sign-in. */
export function oauthPendingStatusUrl(origin: string): string {
  return `${new URL(origin).origin}/api/v1/auth/oauth/desktop/pending`
}

/** Build one pending-registration completion URL. */
export function oauthPendingActionUrl(origin: string, action: 'verify-code' | 'bind-login' | 'create-account'): string {
  return `${new URL(origin).origin}/api/v1/auth/oauth/desktop/pending/${action}`
}

/**
 * Why one poll response cannot be read as a poll answer, or `undefined` when it
 * can.
 *
 * The handoff endpoint answers every state the client should act on inside a
 * JSON envelope — pending, a pending registration, a browser-step failure, the
 * issued pair — and carries no HTTP error for any of them. So a non-2xx is a
 * refusal from something other than the handoff itself: the shared rate limiter
 * answers 429 with `{error, message}` (no `code`, no `status`, no `data`), and a
 * proxy in front of the backend answers 502 with an HTML page. Neither carries a
 * poll answer, and both used to be read as "still pending", which spent the
 * caller's whole ten-minute window re-asking a limiter that was already refusing
 * and then reported a timeout instead of the refusal.
 *
 * `message` is preferred over `error` because the limiter writes both and the
 * message is the one written for a human.
 *
 * A 404 is deliberately not special-cased here: its caller owns the specific
 * "this backend does not offer the handoff" message it wants to show.
 */
export function oauthPollRejection(status: number, body: Record<string, unknown>): string | undefined {
  if (status >= 200 && status < 300) return undefined
  for (const key of ['message', 'error'] as const) {
    const value = body[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return `the backend answered HTTP ${status}`
}

/**
 * Detect the pending-registration marker inside one poll response.
 *
 * When the federated callback ends in a pending registration instead of an
 * issued pair, the backend stores `pending_completion: true` plus the
 * completion payload under the desktop-handoff state; the poll then answers
 * `pending` with that marker until the plugin completes the session.
 */
export function parseOAuthPendingCompletion(body: Record<string, unknown>): OAuthLoginPendingRegistration | undefined {
  if (body.pending_completion !== true) return undefined
  const registration = parseOAuthPendingRegistration(body)
  return registration === undefined ? undefined : registration
}

/**
 * Parse one `/auth/oauth/desktop/poll` response.
 *
 * The pending answer rides the standard `{code, data:{status}}` envelope while
 * the issued pair is written flat (the same shape as every other token-pair
 * response), so both shapes are recognized here rather than assumed.
 */
export function parseOAuthHandoffPoll(payload: unknown): OAuthHandoffPollResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'failed', message: 'oauth handoff poll response was not an object' }
  const root = payload as Record<string, unknown>
  if (typeof root.code === 'number' && root.code !== 0) {
    return { kind: 'failed', message: typeof root.message === 'string' && root.message.trim() !== '' ? root.message : `oauth handoff poll failed with code ${root.code}` }
  }
  const body = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : root
  const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : ''
  if (accessToken !== '' && refreshToken !== '') {
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : 3600
    return { kind: 'authenticated', tokens: { accessToken, refreshToken, expiresIn, tokenType: 'Bearer' } }
  }
  if (typeof body.status === 'string' && body.status !== 'pending') {
    // The backend reports a browser-step failure (blocked login, refused
    // provider, closed registration) instead of leaving the plugin to wait out
    // its whole window: prefer its message, keep the reason code for context.
    const detail = typeof body.message === 'string' && body.message.trim() !== '' ? body.message.trim() : ''
    const reason = typeof body.error === 'string' && body.error.trim() !== '' ? body.error.trim() : ''
    if (detail === '') return { kind: 'failed', message: reason === '' ? `oauth handoff reported status ${body.status}` : reason }
    return { kind: 'failed', message: reason === '' ? detail : `${reason}: ${detail}` }
  }
  const registration = parseOAuthPendingCompletion(body)
  if (registration !== undefined) return { kind: 'pending-registration', registration }
  return { kind: 'pending' }
}
