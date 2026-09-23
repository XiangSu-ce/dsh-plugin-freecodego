/**
 * Host-side client for the existing FreeCodeGo mobile authentication surface.
 * It returns tokens only to a caller-owned credential vault.
 */

/** Mutable secret pair that must remain in a host credential vault. */
export interface FreeCodeGoTokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
  readonly tokenType: 'Bearer'
}

/** Redacted account identity safe to project to a browser. */
export interface FreeCodeGoAccountIdentity {
  readonly id: number
  readonly username: string
  readonly email: string
  /** Provider avatar URL returned by the authenticated profile when present. */
  readonly avatarUrl?: string
  readonly role: string
  readonly balance: number
  readonly status: string
}

/** Result of a password login; MFA keeps tokens absent until completion. */
export type FreeCodeGoLoginResult =
  | { readonly kind: 'authenticated'; readonly tokens: FreeCodeGoTokenPair; readonly user: FreeCodeGoAccountIdentity }
  | { readonly kind: 'mfa-required'; readonly tempToken: string; readonly emailMasked: string }

/** Host credential-vault interface. Browser consumers receive identity only. */
export interface FreeCodeGoCredentialVault {
  load(origin: string): Promise<FreeCodeGoTokenPair | undefined>
  save(origin: string, tokens: FreeCodeGoTokenPair): Promise<void>
  delete(origin: string): Promise<void>
  /**
   * The password a user asked this machine to remember, for prefilling the next
   * sign-in form.
   *
   * Optional as one group: the session pair is the credential every vault
   * holds, while a vault that models only that pair (a test double, an
   * embedder's own store) is not obliged to keep a password. Only a sign-in that
   * ticked the box writes here, and {@link FreeCodeGoAccountCoordinator} is the
   * only writer — nothing else in the product reads or writes this value.
   */
  loadPassword?(origin: string): Promise<string | undefined>
  savePassword?(origin: string, password: string): Promise<void>
  deletePassword?(origin: string): Promise<void>
}

/** User-entered registration values; handled only by the host/browser authorization surface. */
export interface FreeCodeGoRegisterInput {
  readonly email: string
  readonly password: string
  readonly verifyCode?: string
  readonly promoCode?: string
  readonly invitationCode?: string
  readonly affCode?: string
  readonly deviceId?: string
  /** Keep the issued session on this machine for later launches (default true). */
  readonly remember?: boolean
}

/**
 * A password reset: the emailed code that proves the address, and the new secret.
 *
 * The gateway also accepts a link-borne `token` for its own web flow; the desktop
 * card only ever has the code, so that is the one this carries.
 */
export interface FreeCodeGoPasswordResetInput {
  readonly email: string
  readonly verifyCode: string
  readonly newPassword: string
}

/** User-entered password-login values. */
export interface FreeCodeGoLoginInput {
  readonly email: string
  readonly password: string
  readonly deviceId?: string
  /** Keep the issued session on this machine for later launches (default true). */
  readonly remember?: boolean
  /**
   * Keep this attempt's password itself in the vault so the next sign-in form
   * can prefill it. Off by default and deliberately separate from
   * {@link FreeCodeGoLoginInput.remember}: the pair is the session credential,
   * the password is a convenience the user has to ask for. A sign-in that leaves
   * it unset erases a password an earlier attempt stored.
   */
  readonly rememberPassword?: boolean
}

/** Mobile public authentication client. It does not cache credentials. */
export class FreeCodeGoMobileAuthClient {
    /**
   * Backend origin this client sends its authentication requests to.
   */
readonly origin: string
  private readonly baseUrl: URL
  private readonly fetch: typeof globalThis.fetch
  /**
   * The wall-clock bound on every request but a rotation.
   *
   * A rotation is not idempotent: aborting one can discard a response the server
   * has already acted on, and the refresh token it consumed is gone. This bound
   * is tuned for the small login/register calls, and it can fire while a heavier
   * refresh is still in flight — the client then aborts a request that would
   * have succeeded, and the coordinator above reads the abort as a transport
   * failure and retries with a token the server has already spent. So `/refresh`
   * is the one route that does not use it; see {@link refreshTimeoutMs}.
   */
  private readonly requestTimeoutMs: number
  /**
   * The wall-clock bound on a rotation, deliberately wider than the request bound.
   *
   * Both are injectable because the difference between them is the whole point:
   * a caller (and this package's own tests) may shorten them to prove that the
   * rotation path is not governed by the generic bound, which is otherwise a
   * property nothing can observe without waiting eight seconds.
   */
  private readonly refreshTimeoutMs: number

  constructor(options: {
    readonly baseUrl: string
    readonly fetch?: typeof globalThis.fetch
    readonly allowInsecureLocalhost?: boolean
    /** Overrides the bound on every request but a rotation. */
    readonly requestTimeoutMs?: number
    /** Overrides the bound on a rotation. */
    readonly refreshTimeoutMs?: number
  }) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 60_000
    this.baseUrl = authBaseUrl(options.baseUrl, options.allowInsecureLocalhost === true)
    this.origin = this.baseUrl.origin
    this.fetch = options.fetch ?? globalThis.fetch
    if (typeof this.fetch !== 'function') throw new Error('FreeCodeGo authentication requires a fetch implementation')
  }

  /** Request the verification email needed by registration. 
   * @param signal - aborts the request when the caller cancels.
   * @param email - the address the code is sent to.
   * @returns the countdown a resend control waits for.
   */
  async sendVerifyCode(email: string, signal?: AbortSignal): Promise<{ readonly countdown: number }> {
    const payload = await this.request('/send-verify-code', { email }, signal)
    return { countdown: finiteNumber(payload.countdown, 'countdown') }
  }

  /**
   * Ask the gateway to mail a password-reset code to one address.
   *
   * `method: 'code'` is what makes this the desktop flow: without it the gateway
   * mails a browser link built from its own frontend URL instead, which a
   * webview has nowhere to land. The gateway answers the same way whether or not
   * the address is registered — that is deliberate anti-enumeration behaviour on
   * its side, not an answer about this account.
   * @param email - the address to send the reset code to.
   * @param signal - aborts the request when the caller cancels.
   */
  async requestPasswordResetCode(email: string, signal?: AbortSignal): Promise<void> {
    await this.request('/forgot-password', { email, method: 'code' }, signal)
  }

  /**
   * Replace the account's password using the emailed reset code.
   *
   * Deliberately returns no tokens: the gateway does not issue a session here, so
   * signing in stays a separate, explicit step with the new password.
   * @param input - the address, the code, and the new password.
   * @param signal - aborts the request when the caller cancels.
   */
  async resetPassword(input: FreeCodeGoPasswordResetInput, signal?: AbortSignal): Promise<void> {
    await this.request('/reset-password', {
      email: input.email,
      verify_code: input.verifyCode,
      new_password: input.newPassword,
    }, signal)
  }

  /** Register and return an authenticated token pair to the host caller. 
   * @param signal - aborts the request when the caller cancels.
   * @param input - the address, password, and remember-me intent.
   * @returns the authenticated token pair for the new account.
   */
  async register(input: FreeCodeGoRegisterInput, signal?: AbortSignal): Promise<Extract<FreeCodeGoLoginResult, { kind: 'authenticated' }>> {
    const payload = await this.request('/register', {
      email: input.email,
      password: input.password,
      verify_code: input.verifyCode,
      promo_code: input.promoCode,
      invitation_code: input.invitationCode,
      aff_code: input.affCode,
      device_id: input.deviceId,
    }, signal)
    return authenticated(payload)
  }

  /** Login; callers complete MFA using {@link login2FA} when requested. 
   * @param signal - aborts the request when the caller cancels.
   * @returns the login Result.
   * @param input - credentials and the device identity of this attempt.
   */
  async login(input: FreeCodeGoLoginInput, signal?: AbortSignal): Promise<FreeCodeGoLoginResult> {
    const payload = await this.request('/login', { email: input.email, password: input.password, device_id: input.deviceId }, signal)
    if (payload.requires_2fa === true) {
      return {
        kind: 'mfa-required',
        tempToken: requiredString(payload.temp_token, 'temp_token'),
        emailMasked: requiredString(payload.user_email_masked, 'user_email_masked'),
      }
    }
    return authenticated(payload)
  }

  /** Complete a pending MFA login. 
   * @param signal - aborts the request when the caller cancels.
   * @param tempToken - the MFA challenge token the first factor issued.
   * @param totpCode - the code the user's authenticator produced.
   * @param deviceId - device identifier recorded with the session.
   * @returns the authenticated token pair.
   */
  async login2FA(tempToken: string, totpCode: string, deviceId?: string, signal?: AbortSignal): Promise<Extract<FreeCodeGoLoginResult, { kind: 'authenticated' }>> {
    return authenticated(await this.request('/login/2fa', { temp_token: tempToken, totp_code: totpCode, device_id: deviceId }, signal))
  }

  /** Rotate a refresh token; the caller must atomically replace its vault entry. 
   * @param refreshToken - refresh token the session rotates with.
   * @param signal - aborts the request when the caller cancels.
   * @returns the token Pair.
   * @param deviceId - device identifier recorded with the rotated session.
   */
  async refresh(refreshToken: string, deviceId?: string, signal?: AbortSignal): Promise<FreeCodeGoTokenPair> {
    return tokens(await this.request(
      '/refresh',
      { refresh_token: refreshToken, device_id: deviceId },
      signal,
      this.refreshTimeoutMs,
    ))
  }

  /** Revoke a refresh token best-effort on the server. 
   * @param signal - aborts the request when the caller cancels.
   * @param refreshToken - the token to revoke; omitted when the caller has none to revoke.
   */
  async logout(refreshToken: string | undefined, signal?: AbortSignal): Promise<void> {
    await this.request('/logout', refreshToken === undefined ? {} : { refresh_token: refreshToken }, signal)
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const response = await this.fetch(new URL(`/api/v1/freecodego/mobile/auth${path}`, this.baseUrl), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))),
      signal: requestSignal,
    })
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (error) {
      // The coordinator keys reauth-required off `error.status`; a non-JSON
      // error body (proxy HTML page, empty 204) must carry the HTTP class, or
      // every such response is misread as a transient failure and the refresh
      // loop never promotes the user back to sign-in.
      throw Object.assign(
        new Error(`FreeCodeGo authentication response was not valid JSON (HTTP ${response.status}): ${error instanceof Error ? error.message : String(error)}`),
        { status: response.status },
      )
    }
    if (!response.ok) {
      const message = typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).message === 'string'
        ? (parsed as Record<string, unknown>).message as string
        : undefined
      // Preserve the HTTP class for the Host coordinator without exposing the
      // response body or any credential-bearing fields to browser callers.
      throw Object.assign(
        new Error(`FreeCodeGo authentication request failed with HTTP ${response.status}${message === undefined ? '' : `: ${message}`}`),
        { status: response.status },
      )
    }
    const root = record(parsed)
    return record(root.data ?? root)
  }
}

function authenticated(payload: Record<string, unknown>): Extract<FreeCodeGoLoginResult, { kind: 'authenticated' }> {
  return { kind: 'authenticated', tokens: tokens(payload), user: user(record(payload.user)) }
}

function tokens(payload: Record<string, unknown>): FreeCodeGoTokenPair {
  return {
    accessToken: requiredString(payload.access_token, 'access_token'),
    refreshToken: requiredString(payload.refresh_token, 'refresh_token'),
    expiresIn: finiteNumber(payload.expires_in, 'expires_in'),
    tokenType: 'Bearer',
  }
}

/**
 * The identifying half of an address, used when the account carries no username.
 *
 * `slice` rather than a split-and-index so an address with no `@` at all yields
 * the address itself instead of throwing on an absent index.
 */
const addressLocalPart = (email: string): string => {
  const at = email.indexOf('@')
  return (at <= 0 ? email : email.slice(0, at)).trim()
}

function user(payload: Record<string, unknown>): FreeCodeGoAccountIdentity {
  const avatarUrl = typeof payload.avatar_url === 'string' && payload.avatar_url.trim() !== ''
    ? payload.avatar_url.trim()
    : typeof payload.avatarUrl === 'string' && payload.avatarUrl.trim() !== ''
      ? payload.avatarUrl.trim()
      : undefined
  const email = requiredString(payload.email, 'user.email')
  // An email registration carries no username: the gateway's own signup writes
  // the address and a password and nothing else, and its response type spells
  // `username` as an always-present string. Reading that as a required field made
  // every account created from this card fail to sign in *after the gateway had
  // already created it* — the registration succeeded, the response was refused,
  // and the next attempt was told the address was taken. The address is the
  // identity this card shows anyway, so an absent username falls back to it.
  const username = typeof payload.username === 'string' && payload.username.trim() !== ''
    ? payload.username.trim()
    : addressLocalPart(email)
  return {
    id: finiteNumber(payload.id, 'user.id'),
    username,
    email,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    role: requiredString(payload.role, 'user.role'),
    balance: finiteNumber(payload.balance, 'user.balance'),
    status: requiredString(payload.status, 'user.status'),
  }
}

function authBaseUrl(value: string, allowInsecureLocalhost: boolean): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('FreeCodeGo baseUrl must be an absolute URL')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new Error('FreeCodeGo baseUrl must use HTTPS')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FreeCodeGo response must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`FreeCodeGo response ${label} must be a non-empty string`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`FreeCodeGo response ${label} must be a finite number`)
  return value
}
