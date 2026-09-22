/** Host-only account coordination over the Harness credential seam. */

import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  FreeCodeGoAccountIdentity,
  FreeCodeGoCredentialVault,
  FreeCodeGoLoginInput,
  FreeCodeGoLoginResult,
  FreeCodeGoMobileAuthClient,
  FreeCodeGoRegisterInput,
  FreeCodeGoTokenPair,
} from './mobile-auth.ts'
import { classifyRefreshFailure, runGuardedRefresh } from './refresh-guard.ts'
import type { RefreshFailureKind } from './refresh-guard.ts'

/**
 * The wall-clock bound on one rotation attempt.
 *
 * A rotation is not idempotent: the server consumes the old refresh token the
 * moment the exchange succeeds, so a client-side abort can discard a response
 * the server has already acted on. The bound therefore has to cover a real
 * rotation on a loaded gateway rather than a small read, which is why it is
 * wider than the client's generic request timeout. See {@link localAbort} for
 * what happens when it still fires.
 */
const REFRESH_TIMEOUT_MS = 60_000

/** Browser-safe account state; it cannot carry an access or refresh token. */
export type FreeCodeGoAccountState =
  | { readonly status: 'signed-out' }
  | { readonly status: 'mfa-required'; readonly emailMasked: string }
  | {
    readonly status: 'authenticated'
    readonly user: FreeCodeGoAccountIdentity
    /**
     * Set when the rotated pair is live but could not be written to the vault.
     *
     * The session keeps working for this process — the pair is held in memory —
     * but it will not survive a restart, so a surface that shows "signed in"
     * has to say so rather than promise a session the next launch will not have.
     */
    readonly persistence?: 'failed'
  }
  | { readonly status: 'reauth-required' }

/** Stores one origin-scoped token pair as one atomic credential value. */
export class HarnessFreeCodeGoCredentialVault implements FreeCodeGoCredentialVault {
  private readonly ref
  /**
   * The remembered password lives under its own reference, beside the session
   * rather than inside it. The pair is rewritten by every login and by every
   * background rotation, while this value changes only when the user asks for
   * it — and erasing the session must not erase what the sign-in form prefills.
   */
  private readonly passwordRef

  constructor(private readonly credentials: CredentialProvider, origin: string) {
    const digest = createHash('sha256').update(origin).digest('hex').slice(0, 24).toUpperCase()
    this.ref = credentialRef(`FREECODEGO_SESSION_${digest}`)
    this.passwordRef = credentialRef(`FREECODEGO_PASSWORD_${digest}`)
  }

  async load(_origin: string): Promise<FreeCodeGoTokenPair | undefined> {
    const resolved = await this.credentials.resolve(this.ref)
    if (resolved === undefined) return undefined
    return decodeTokenPair(resolved.value)
  }

  async save(_origin: string, tokens: FreeCodeGoTokenPair): Promise<void> {
    await this.credentials.set(this.ref, JSON.stringify(tokens))
  }

  async delete(_origin: string): Promise<void> {
    await this.credentials.unset(this.ref)
  }

  /**
   * Read the remembered password, treating an empty entry as no entry.
   * @returns the stored password, or undefined when the user never asked.
   */
  async loadPassword(_origin: string): Promise<string | undefined> {
    const resolved = await this.credentials.resolve(this.passwordRef)
    return resolved === undefined || resolved.value === '' ? undefined : resolved.value
  }

  async savePassword(_origin: string, password: string): Promise<void> {
    await this.credentials.set(this.passwordRef, password)
  }

  async deletePassword(_origin: string): Promise<void> {
    await this.credentials.unset(this.passwordRef)
  }
}

/** Coordinates login and token rotation without exposing secret values to callers. */
export class FreeCodeGoAccountCoordinator {
  private state: FreeCodeGoAccountState = { status: 'signed-out' }
  private pendingMfaToken: string | undefined
  private refreshInFlight: Promise<void> | undefined
  /** Set by logout() so an in-flight refresh never writes after the erase. */
  private signingOut = false
  /**
   * Whether this session is kept for the next launch.
   *
   * `remember: false` on a login means "do not keep me signed in on this
   * machine": the pair lives in memory for this process only, any vault entry
   * left by an earlier remembered login is erased, and a token rotation writes
   * back to memory instead of disk. The credential file is the only durable
   * session store there is, so opting out is this one flag rather than a second
   * store — and no password is ever written, because the token pair is the whole
   * credential.
   */
  private ephemeral = false
  /** In-memory pair backing an unremembered session. */
  private memoryTokens: FreeCodeGoTokenPair | undefined
  /**
   * Set when a rotation produced a pair the vault refused to keep.
   *
   * The pair itself is kept in `memoryTokens`; this flag is what lets
   * {@link snapshot} tell the UI that the session is not durable, instead of the
   * failure being visible only in a log nobody reads.
   */
  private persistenceFailed = false
  /**
   * The persistence intent of the login attempt in flight, committed only when a
   * pair is actually issued.
   *
   * It is separate from {@link ephemeral} because those are two different facts:
   * `ephemeral` is the mode this process is *in*, and this is what the attempt the
   * user is currently making *asked for*. Committing the second into the first at
   * the start of an attempt made a failure a mode change (a wrong password on an
   * unremembered login put the process into memory-only mode), and it survives the
   * MFA step on purpose: the second factor completes the same attempt, so it must
   * not silently reverse the choice made at the password.
   */
  private pendingRemember: boolean | undefined
  /**
   * What this attempt asked to do with the remembered password.
   *
   * It is a third state rather than a boolean because "no password was
   * mentioned" (a bare `login2FA`, a registration form with no such box) must
   * leave the vault alone, while an explicit untick has to erase: those are two
   * different answers and one of them is destructive. It survives the MFA step
   * for the same reason as {@link pendingRemember} — the second factor completes
   * the attempt that made the choice.
   */
  private pendingPassword: { readonly keep: string } | { readonly forget: true } | undefined

  constructor(
    private readonly auth: FreeCodeGoMobileAuthClient,
    private readonly vault: FreeCodeGoCredentialVault,
  ) {}

  /** Return the latest browser-safe account state. 
   * @returns the latest account state, flagged when the vault write failed.
   */
  snapshot(): FreeCodeGoAccountState {
    if (this.persistenceFailed && this.state.status === 'authenticated') return { ...this.state, persistence: 'failed' }
    return this.state
  }

  /** Backend origin this coordinator authenticates against. */
  get origin(): string {
    return this.auth.origin
  }

  /**
   * Whether a durable Host session exists, without network I/O.
   *
   * An entry this build cannot decode is not a session: the credential may
   * predate the stored token-pair shape, or be truncated. Callers use this as a
   * cheap gate — the model picker's availability row, the settings card's
   * `restoring` state, and the login form's own visibility — so an unreadable
   * entry answers `false` rather than taking those surfaces down with a
   * thrown decoder error. `refresh()` still erases the unreadable entry when it
   * reaches it, and the next successful login overwrites it.
   * @returns true when a usable vault session is present.
   */
  async hasStoredSession(): Promise<boolean> {
    try {
      return (await this.loadTokens()) !== undefined
    } catch {
      return false
    }
  }

  /**
   * The password this machine remembers for the sign-in form.
   *
   * An unreadable entry is reported as no entry: the form starts empty, which is
   * what a machine that was never asked looks like, instead of turning a
   * convenience into a sign-in error.
   * @returns the stored password, or undefined when there is none.
   */
  async rememberedPassword(): Promise<string | undefined> {
    try {
      return await this.vault.loadPassword?.(this.auth.origin)
    } catch {
      return undefined
    }
  }

  /** Keep the password a sign-in asked to remember; failure is not a login failure. */
  private async writeRememberedPassword(password: string): Promise<void> {
    try {
      await this.vault.savePassword?.(this.auth.origin, password)
    } catch { /* The next sign-in that asks again retries the write. */ }
  }

  /** Forget the remembered password after a sign-in that unticked the box. */
  private async eraseRememberedPassword(): Promise<void> {
    try {
      await this.vault.deletePassword?.(this.auth.origin)
    } catch { /* Erasing is best-effort: a sign-in does not fail over a convenience. */ }
  }

  /** Rehydrate the redacted identity after loading a vault session. 
   * @param user - the redacted identity to publish as authenticated.
   */
  setAuthenticated(user: FreeCodeGoAccountIdentity): void {
    this.pendingMfaToken = undefined
    this.state = { status: 'authenticated', user }
  }

  /** Send a registration verification code through the existing public auth route. 
   * @param email - the address the verification code is sent to.
   * @param signal - aborts the request when the caller cancels.
   * @returns the countdown a resend control waits for.
   */
  async sendVerifyCode(email: string, signal?: AbortSignal): Promise<{ readonly countdown: number }> {
    return this.auth.sendVerifyCode(email, signal)
  }

  /**
   * Authenticate and store a successful token pair in the host vault.
   *
   * The intent of this attempt is recorded here and committed in
   * `consumeLoginResult`, once a pair exists. Committing it up front made a failed
   * attempt a mode change: a wrong password on an unremembered login left the
   * process memory-only, so the next `refresh()` read the empty memory store and
   * reported the user signed out, and `withAccessToken` refused every call with
   * "authentication is required" — while the durable session sat in the vault,
   * unreachable until the next successful login.
   * @param input - credentials and the remember-me intent of this attempt.
   * @param signal - aborts the request when the caller cancels.
   * @returns the account state after the issued tokens were stored.
   */
  async login(input: FreeCodeGoLoginInput, signal?: AbortSignal): Promise<FreeCodeGoAccountState> {
    // Every entry point states its own persistence intent, so an unremembered
    // login cannot inherit the flag from an earlier remembered one (or the
    // reverse) for the rest of the process.
    this.pendingRemember = input.remember
    if (input.rememberPassword === undefined) this.pendingPassword = undefined
    else if (input.rememberPassword) this.pendingPassword = { keep: input.password }
    else this.pendingPassword = { forget: true }
    try {
      return await this.consumeLoginResult(await this.auth.login(input, signal))
    } catch (error) {
      // No pair was issued, so this attempt has no intent left to carry.
      this.pendingRemember = undefined
      this.pendingPassword = undefined
      throw error
    }
  }

  /** Register through the public flow while retaining returned tokens in the Host vault only. 
   * @param input - registration details and the remember-me intent of this attempt.
   * @param signal - aborts the request when the caller cancels.
   * @returns the account state after the issued tokens were stored.
   */
  async register(input: FreeCodeGoRegisterInput, signal?: AbortSignal): Promise<FreeCodeGoAccountState> {
    this.pendingRemember = input.remember
    try {
      return await this.consumeLoginResult(await this.auth.register(input, signal))
    } catch (error) {
      this.pendingRemember = undefined
      throw error
    }
  }

  /** Complete MFA and store credentials only after the second factor succeeds. 
   * @param tempToken - the MFA challenge token the first factor issued.
   * @param totpCode - the code the user's authenticator produced.
   * @param deviceId - device identifier recorded with the session.
   * @param signal - aborts the request when the caller cancels.
   * @returns the account state after the second factor succeeded.
   */
  async login2FA(tempToken: string, totpCode: string, deviceId?: string, signal?: AbortSignal): Promise<FreeCodeGoAccountState> {
    return this.consumeLoginResult(await this.auth.login2FA(tempToken, totpCode, deviceId, signal))
  }

  /** Complete the pending Host-owned MFA challenge without exposing its temp token. 
   * @param totpCode - the code the user's authenticator produced.
   * @param deviceId - device identifier recorded with the session.
   * @param signal - aborts the request when the caller cancels.
   * @returns the account state after the second factor succeeded.
   */
  async completeMfa(totpCode: string, deviceId?: string, signal?: AbortSignal): Promise<FreeCodeGoAccountState> {
    if (this.pendingMfaToken === undefined) throw new Error('no FreeCodeGo MFA challenge is pending')
    // The token stays pending until the second factor succeeds (consumeLoginResult
    // clears it), so a mistyped code can be retried without restarting the login.
    try {
      return await this.login2FA(this.pendingMfaToken, totpCode, deviceId, signal)
    } catch (error) {
      // A rejected code consumes the challenge only when the gateway says the
      // temp token itself is dead; anything else (network, 5xx, malformed
      // device id, transient 400) leaves the challenge retryable.
      const status = error !== null && typeof error === 'object' && 'status' in error
        && typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined
      if (status === 401 || status === 403 || status === 422
        || (error instanceof Error && /temp[_ ]?token/i.test(error.message))) {
        this.pendingMfaToken = undefined
        this.state = { status: 'signed-out' }
      }
      throw error
    }
  }

  /**
   * The rotation exchange, retried once when the failure was transport-level.
   *
   * The retry exists for the machine that resumed without a network yet: that is
   * the ordinary case after a suspend, and reporting it as an authentication
   * failure is how a resume becomes a forced sign-in. A persistent outage is not
   * fixed by trying harder, so the bound is one.
   *
   * The classification is `refresh-guard.ts`'s, which is also what decides
   * retryability everywhere else in this package; the *erasure* decision stays
   * below in `refresh`, because that is where its invariants are documented and
   * tested. This method contributes two things: the second attempt, and the
   * per-attempt verdicts the erasure decision needs.
   *
   * It resolves rather than throws so the caller can rethrow the original error
   * itself — every branch `refresh` already had (the newer-vault check, the
   * permanent-failure check, the rethrow) keeps seeing precisely the error it
   * saw before.
   *
   * A failure this process caused is not the gateway's verdict: a bound that
   * fires while the exchange is still in flight is classified `transient`, so it
   * is neither retried (the token a retry would send may already be spent) nor
   * erased (nothing said the credential is dead).
   * @param refreshToken - the token to rotate.
   * @param deviceId - the optional device identity the gateway expects.
   * @returns the rotated pair, or the verdicts that explain why there is none.
   */
  private async exchangeRefresh(
    refreshToken: string,
    deviceId: string | undefined,
  ): Promise<
    | { readonly ok: true; readonly tokens: FreeCodeGoTokenPair }
    | { readonly ok: false; readonly error: unknown; readonly kinds: readonly RefreshFailureKind[] }
  > {
    // Every attempt's verdict, in order. The guard's outcome keeps only the
    // last one, and the erasure rule needs all of them.
    const kinds: RefreshFailureKind[] = []
    let lastError: unknown
    const outcome = await runGuardedRefresh<FreeCodeGoTokenPair>({
      attempt: async () => {
        try {
          return await this.auth.refresh(refreshToken, deviceId, AbortSignal.timeout(REFRESH_TIMEOUT_MS))
        } catch (error) {
          lastError = error
          kinds.push(localAbort(error) ? 'transient' : classifyRefreshFailure(error).kind)
          throw error
        }
      },
      classify: (error) => localAbort(error)
        ? { kind: 'transient', message: 'the session token was not rotated before this process gave up waiting' }
        : classifyRefreshFailure(error),
    })
    if (outcome.ok) return { ok: true, tokens: outcome.value as FreeCodeGoTokenPair }
    return { ok: false, error: lastError ?? new Error('the session token could not be rotated'), kinds }
  }

  /** Rotate the stored session token; callers reauthenticate after any failure. 
   * @param deviceId - device identifier recorded with the rotated session.
   * @param signal - bounds this caller's wait; the shared rotation keeps running.
   */
  async refresh(deviceId?: string, signal?: AbortSignal): Promise<void> {
    if (this.refreshInFlight !== undefined) {
      // The shared refresh runs on its own bounded signal (below), so a
      // caller-supplied signal only bounds this caller's wait: it can stop
      // this caller from awaiting, but never cancels the network exchange the
      // other coalesced callers are sharing.
      return signal === undefined ? this.refreshInFlight : abortableWait(this.refreshInFlight, signal)
    }
    const operation = (async (): Promise<void> => {
      // A logout() that starts while this refresh is in flight must not have
      // its vault erase undone by the settlement save below.
      if (this.signingOut) return
      let tokens: FreeCodeGoTokenPair | undefined
      try {
        tokens = await this.loadTokens()
      } catch {
        // A corrupted stored session must not wedge every later refresh (and
        // logout depends on reaching its erase): treat it as definitively dead
        // and surface reauthentication instead of throwing forever.
        await this.deleteTokens().catch(() => undefined)
        this.state = { status: 'reauth-required' }
        return
      }
      if (tokens === undefined) {
        this.state = { status: 'signed-out' }
        return
      }
      // Bound the shared refresh independently of whichever caller arrived
      // first: coalesced callers must not inherit that caller's AbortSignal and
      // see the refresh fail (or hang) because they aborted.
      const exchange = await this.exchangeRefresh(tokens.refreshToken, deviceId)
      if (!exchange.ok) {
        if (this.signingOut) throw exchange.error
        // One classifier decides what a failure means, and only an invalidation
        // erases the vault: a network or 5xx failure during startup would otherwise
        // turn a transient outage into a forced manual login. `refresh-guard.ts` is
        // the single implementation of "when may I erase a user's credentials" — the
        // exchange above already ran under it — and a second wording check written
        // here is how the two drift: the copy that decided erasure listed one
        // spelling less than the guard treats as definitive (`token invalidated`),
        // so a credential the gateway had pronounced dead was kept in the vault
        // while the session went on reporting itself authenticated.
        if (erasableRefreshFailure(exchange.kinds)) {
          // Refresh tokens are rotated by the API. Another Harness process (or
          // another signed-in device) may have consumed this token and already
          // persisted the replacement while this request was in flight. Keep
          // that newer vault value instead of deleting a still-valid session.
          // Any rejection of the refresh credential — not just the literal
          // "reused" wording — must honor the newer pair another process saved.
          const latest = await this.loadTokens()
          if (latest !== undefined && latest.refreshToken !== tokens.refreshToken) return
          // Erase only what every attempt called an explicit invalidation. A
          // plain 400 is a request-validation failure (a malformed device id,
          // most often) and a network/5xx failure can be a gateway that is
          // briefly unavailable: neither is evidence that the stored credential
          // is dead, so neither may wipe the vault.
          await this.deleteTokens()
          this.state = { status: 'reauth-required' }
        }
        throw exchange.error
      }
      // Re-check after the network exchange: logout may have completed while the
      // refresh was in flight, and the rotated pair must not resurrect
      // credentials the user just erased.
      if (this.signingOut) return
      await this.persistRotatedTokens(exchange.tokens)
    })()
    this.refreshInFlight = operation.finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }

  /** Revoke the remote session best-effort, then erase the local vault entry. 
   * @param signal - aborts the best-effort revocation when the caller cancels.
   */
  async logout(signal?: AbortSignal): Promise<void> {
    this.signingOut = true
    // The attempt is over either way, so a pending intent cannot outlive it and
    // later speak for a login the user has not started.
    this.pendingRemember = undefined
    this.pendingPassword = undefined
    // An in-flight refresh must not write the rotated pair back after the
    // vault erase below: the refresh loop observes signingOut before its
    // settlement save, and this await keeps ordering deterministic.
    const inFlight = this.refreshInFlight
    if (inFlight !== undefined) await inFlight.catch(() => undefined)
    try {
      // A corrupted vault entry must not block logout: the local erase below
      // is what matters, and the remote session simply expires on its own.
      const tokens = await this.loadTokens().catch(() => undefined)
      try {
        await this.auth.logout(tokens?.refreshToken, signal)
      } catch {
        // Local sign-out is authoritative; remote revocation is best-effort.
      } finally {
        await this.deleteTokens()
        // Signing out forgets what this machine remembered, exactly as the
        // surface forgets the address it prefilled: a password left behind would
        // prefill the form of the account the user just signed out of.
        await this.eraseRememberedPassword()
        this.state = { status: 'signed-out' }
      }
    } finally {
      // A later login must be able to refresh again.
      this.signingOut = false
    }
  }

  /**
   * Run one Host-only authorized operation without returning the stored token.
   *
   * A `401` normally refreshes once and replays the operation, which is correct
   * for read-like calls. Non-idempotent callers (order creation, verification,
   * receipt email) must pass `{ replayOnUnauthorized: false }`: the gateway can
   * reject a request after already having observed it, so a blind replay would
   * duplicate the effect and can double-charge.
   * @param operation - runs with the current access token and an abort signal of its own.
   * @param signal - aborts the wait for credentials and the operation with it.
   * @param options - whether an unauthorized answer may replay the operation once.
   * @returns whatever the operation returned, behind a token refresh when the stored one was stale.
   */
  async withAccessToken<T>(
    operation: (accessToken: string, signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    options: { readonly replayOnUnauthorized?: boolean } = {},
  ): Promise<T> {
    signal?.throwIfAborted()
    let tokens = await this.loadTokens()
    // The browser-safe account snapshot is process-local, while credentials
    // intentionally survive a Host restart. A valid vault entry is therefore
    // sufficient to launch a native runtime before the settings tab refreshes
    // account identity again.
    if (tokens === undefined) throw new Error('FreeCodeGo authentication is required')
    if (tokenNeedsRefresh(tokens.accessToken)) {
      await this.refresh(undefined, signal)
      tokens = await this.loadTokens()
      if (tokens === undefined) throw new Error('FreeCodeGo authentication is required after token refresh')
    }
    try {
      return await operation(tokens.accessToken, signal)
    } catch (error) {
      // A token can be revoked or rotated by another client before its JWT
      // exp claim. Recover once through the durable refresh session; never
      // retry a model request with a different route or silently reuse stale
      // credentials.
      if (!isUnauthorized(error)) throw error
      // Non-idempotent operations opt out of the replay-once recovery below.
      if (options.replayOnUnauthorized === false) throw error
      const latest = await this.loadTokens()
      if (latest === undefined) throw new Error('FreeCodeGo authentication is required after unauthorized response')
      if (latest.accessToken === tokens.accessToken) await this.refresh(undefined, signal)
      const refreshed = await this.loadTokens()
      if (refreshed === undefined) throw new Error('FreeCodeGo authentication is required after unauthorized response')
      return operation(refreshed.accessToken, signal)
    }
  }

  /**
   * Store a token pair issued by an out-of-band flow (browser OAuth) without
   * returning it to the caller.
   *
   * The pair is proven, not trusted: the coordinator reads `/auth/me` through
   * it before reporting `authenticated`, so a malformed or rejected pair
   * surfaces as an error instead of a half-signed-in state.
   * @param tokens - the pair a federated sign-in already obtained.
   * @param hydrateIdentity - reads the redacted identity those tokens belong to.
   * @param signal - aborts the request when the caller cancels.
   * @returns the account state after the pair was verified and persisted.
   */
  async adoptExternalSession(
    tokens: FreeCodeGoTokenPair,
    hydrateIdentity: (accessToken: string, signal?: AbortSignal) => Promise<FreeCodeGoAccountIdentity>,
    signal?: AbortSignal,
  ): Promise<FreeCodeGoAccountState> {
    // Federated sign-in has no "keep me signed in" control of its own, and the
    // browser round trip is the whole point of it: always persist, so a later
    // Google/GitHub sign-in also clears an earlier ephemeral login's flag.
    this.ephemeral = false
    // Any half-finished password attempt is superseded by this session.
    this.pendingRemember = undefined
    // A failed vault write must not leave the UI authenticated with no
    // durable session, mirroring consumeLoginResult.
    await this.saveTokens(tokens)
    this.pendingMfaToken = undefined
    try {
      const user = await hydrateIdentity(tokens.accessToken, signal)
      this.state = { status: 'authenticated', user }
      return this.state
    } catch (error) {
      // The pair was rejected or unreachable; do not leave a credential that
      // was never confirmed stored for the refresh loop to churn on.
      await this.deleteTokens().catch(() => undefined)
      this.state = { status: 'signed-out' }
      throw error
    }
  }

  private async consumeLoginResult(result: FreeCodeGoLoginResult): Promise<FreeCodeGoAccountState> {
    if (result.kind === 'mfa-required') {
      // The challenge is the first half of an attempt, not a finished one: the
      // intent stays pending so `completeMfa` honours it, and the mode is left
      // alone until a pair exists.
      this.pendingMfaToken = result.tempToken
      this.state = { status: 'mfa-required', emailMasked: result.emailMasked }
      return this.state
    }
    this.pendingMfaToken = undefined
    // A pair exists now, so this is where `remember` takes effect — once per
    // attempt, from the entry point that started it. A bare `login2FA` (a temp
    // token completed outside a `login` call) states no intent and leaves the
    // mode as it is.
    if (this.pendingRemember !== undefined) this.ephemeral = !this.pendingRemember
    this.pendingRemember = undefined
    // The remembered password is committed here for the same reason, and a vault
    // that refuses the write is not worth failing a sign-in over: the password is
    // a convenience the form can ask for again, while the session is the thing
    // this call exists to establish.
    const passwordIntent = this.pendingPassword
    this.pendingPassword = undefined
    if (passwordIntent !== undefined) {
      if ('keep' in passwordIntent) await this.writeRememberedPassword(passwordIntent.keep)
      else await this.eraseRememberedPassword()
    }
    // A failed vault write must not leave the UI authenticated with no
    // durable session: surface the failure so the user can retry the login
    // instead of discovering the missing credentials on the next launch.
    await this.saveTokens(result.tokens)
    this.state = { status: 'authenticated', user: result.user }
    return this.state
  }

  /**
   * Write a pair the server just issued, retrying once, and record what happened.
   *
   * Rotation is crash-unsafe by default: the server consumed the old refresh
   * token the moment the exchange succeeded, so the pair in hand is the only
   * credential that still works. A failing vault write therefore cannot be
   * swallowed — that is how a session ends up holding a token the server has
   * already spent — and it cannot be answered by erasing either, which would
   * delete the vault entry and keep nothing. Instead the first failure is
   * retried once, and a second failure keeps the live pair in memory and marks
   * the session as not durable, so this process keeps working and the UI can say
   * the session will not survive a restart.
   * @param tokens - the pair the exchange just issued.
   * @returns true when the vault holds the pair.
   */
  private async persistRotatedTokens(tokens: FreeCodeGoTokenPair): Promise<boolean> {
    // An unremembered session is held in memory by definition, so there is no
    // durable write to retry here and nothing that can fail.
    if (this.ephemeral) {
      await this.saveTokens(tokens)
      return true
    }
    // The rotated pair supersedes the pair the vault still holds, so a read that
    // follows a failed write must not go back to the consumed token.
    this.memoryTokens = tokens
    try {
      await this.saveTokens(tokens)
    } catch {
      try {
        await this.saveTokens(tokens)
      } catch {
        this.persistenceFailed = true
        return false
      }
    }
    return true
  }

  /**
   * The live token pair, from wherever this session is being kept.
   *
   * An unremembered session is memory-only, so the vault is never consulted for
   * it: reading the file there would resurrect a session the user explicitly
   * declined to keep on this machine.
   *
   * A remembered session whose rotated pair the vault refused (see
   * {@link persistRotatedTokens}) is the one case where memory wins over the
   * vault: the vault still holds the refresh token the server consumed, and
   * answering from it would rotate the same spent token again.
   */
  private async loadTokens(): Promise<FreeCodeGoTokenPair | undefined> {
    if (this.ephemeral) return this.memoryTokens
    if (this.memoryTokens !== undefined) return this.memoryTokens
    return this.vault.load(this.auth.origin)
  }

  /** Persist the pair, or hold it in memory when the session is unremembered. */
  private async saveTokens(tokens: FreeCodeGoTokenPair): Promise<void> {
    if (!this.ephemeral) {
      await this.vault.save(this.auth.origin, tokens)
      // A durable write that landed answers whatever the last one could not, and
      // it supersedes any pair memory was holding: memory only ever stands in for
      // an unremembered session or a rotation the vault refused, and neither of
      // those outlives a write the vault accepted.
      this.memoryTokens = undefined
      this.persistenceFailed = false
      return
    }
    this.memoryTokens = tokens
    // Signing in without "remember" has to forget a session an earlier login
    // left on disk, or the next launch would restore the very account the user
    // declined to keep.
    await this.vault.delete(this.auth.origin).catch(() => undefined)
  }

  /** Drop the pair from both stores. */
  private async deleteTokens(): Promise<void> {
    this.memoryTokens = undefined
    // Nothing durable is claimed once the session is gone.
    this.persistenceFailed = false
    await this.vault.delete(this.auth.origin)
  }
}

function decodeTokenPair(value: string): FreeCodeGoTokenPair {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch (error) { throw new Error(`Stored FreeCodeGo session is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored FreeCodeGo session must be an object')
  const record = parsed as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.trim() === '' || typeof record.refreshToken !== 'string' || record.refreshToken.trim() === ''
    || typeof record.expiresIn !== 'number' || !Number.isFinite(record.expiresIn) || record.expiresIn <= 0 || record.tokenType !== 'Bearer') throw new Error('Stored FreeCodeGo session is incomplete')
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresIn: record.expiresIn,
    tokenType: 'Bearer',
  }
}

function tokenNeedsRefresh(accessToken: string): boolean {
  const parts = accessToken.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) && Date.now() >= payload.exp * 1000 - 60_000
  } catch {
    return false
  }
}

function isUnauthorized(error: unknown): boolean {
  // Status is authoritative: message text like "upstream unauthorized" or
  // "payment access token expired" can describe a *different* hop's failure
  // and must not trigger a credential refresh plus a non-idempotent POST
  // replay. Message matching applies only when the gateway gave no status.
  const status = error !== null && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined
  if (status !== undefined) return status === 401
  return error instanceof Error && /invalid api key|unauthori[sz]ed|access token.*(?:expired|invalid)|token version/i.test(error.message)
}

/**
 * Whether a failed rotation may erase the vault.
 *
 * Two conditions, and both are required. There has to be at least one attempt,
 * and *every* attempt must have been an explicit invalidation — a token this
 * process sent more than once is not evidence the credential is dead, because
 * the earlier send may itself be what consumed it. `refresh-guard.ts` retries a
 * transport failure on its own (its rule 2), so a 401 on the second attempt is
 * as likely to be the consequence of that retry as it is a verdict about the
 * credential, and the erasure path must not be reachable through one.
 * @param kinds - each attempt's verdict, oldest first.
 * @returns true when the vault entry may be deleted.
 */
function erasableRefreshFailure(kinds: readonly RefreshFailureKind[]): boolean {
  return kinds.length > 0 && kinds.every((kind) => kind === 'invalid')
}

/**
 * True when a failed attempt was stopped by this process rather than by the gateway.
 *
 * A wall-clock bound firing is indistinguishable from a transport failure in the
 * wording alone, which is how it ended up filed as retryable: `timeout` is in
 * `refresh-guard.ts`'s network table because for every other call a timeout means
 * the request never landed and trying again is free. For a rotation neither half
 * holds — the server may already have acted on it — so this case is pulled out
 * and classified `transient` before the table sees it.
 * @param error - the thrown value.
 * @returns true for an abort this process caused.
 */
function localAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  // `AbortSignal.timeout` rejects with a `TimeoutError` DOMException; a caller's
  // own signal rejects with `AbortError`.
  if (name === 'TimeoutError' || name === 'AbortError') return true
  // Some runtimes surface the abort as a plain Error carrying the DOMException's
  // message instead of the exception itself.
  return error instanceof Error && /\bthe operation was aborted\b/i.test(error.message)
}

/** Coerce an unknown thrown value into an Error without the lint-noisy ternary. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Await a shared promise while letting this caller's own signal end its wait early. */
function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(asError(signal.reason)) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(asError(error)) },
    )
  })
}
