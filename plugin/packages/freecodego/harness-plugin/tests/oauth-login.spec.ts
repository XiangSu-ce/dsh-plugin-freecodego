import { describe, expect, it, vi } from 'vitest'
import { generateOAuthLoginState, oauthHandoffPollUrl, oauthPendingActionUrl, oauthPendingStatusUrl, oauthPollRejection, parseOAuthHandoffPoll, parseOAuthPendingRegistration, pluginOAuthStartUrl } from '../src/oauth-login.ts'

describe('plugin OAuth login helpers', () => {
  it('generates high-entropy states that satisfy the backend pattern', () => {
    const state = generateOAuthLoginState(1_700_000_000_000, () => 0.123456789)
    expect(state).toMatch(/^fcg_oauth_[a-z0-9]+_[a-z0-9]{10}$/)
    expect(state.length).toBeGreaterThanOrEqual(16)
    expect(state).not.toContain('=') // URL-safe: never needs percent-encoding
    const second = generateOAuthLoginState(1_700_000_000_000, () => 0.987654321)
    expect(second).not.toEqual(state)
  })

  it('draws the state from the crypto source rather than the ambient PRNG', () => {
    // This string is the only key the public poll endpoint resolves an issued
    // token pair with, so its unpredictability is what keeps one client from
    // being handed another client's pair. `Math.random` was the single
    // non-cryptographic source used for a credential handle in this plugin.
    const spy = vi.spyOn(Math, 'random')
    try {
      const state = generateOAuthLoginState()
      expect(state).toMatch(/^fcg_oauth_[a-z0-9]+_[a-z0-9]{10}$/)
      expect(state).not.toEqual(generateOAuthLoginState())
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('classifies a refused poll as a failure and a served poll as an answer', () => {
    // The backend's shared rate limiter answers 429 with this exact body: no
    // code, no status, no data.
    expect(oauthPollRejection(429, { error: 'rate limit exceeded', message: 'Too many requests, please try again later' }))
      .toBe('Too many requests, please try again later')
    expect(oauthPollRejection(502, {})).toBe('the backend answered HTTP 502')
    // A served poll is not rejected, whatever it says — pending included.
    expect(oauthPollRejection(200, { status: 'pending' })).toBeUndefined()
    expect(oauthPollRejection(200, { access_token: 'at', refresh_token: 'rt' })).toBeUndefined()
    // The body the limiter sends is *not* a poll answer, which is exactly why the
    // caller has to gate on the status rather than on the parse result.
    expect(parseOAuthHandoffPoll({ error: 'rate limit exceeded', message: 'Too many requests, please try again later' }))
      .toEqual({ kind: 'pending' })
  })

  it('builds the double-encoded desktop start URL', () => {
    const state = 'fcg_oauth_mabc_0123456789'
    const url = pluginOAuthStartUrl('https://freecodego.com/', 'github', state)
    expect(url).toBe('https://freecodego.com/api/v1/auth/oauth/github/start?redirect=' + encodeURIComponent('/oauth/desktop?state=fcg_oauth_mabc_0123456789&plugin=1'))
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/v1/auth/oauth/github/start')
    // Decoding once yields the inner redirect the backend sanitizes; decoding
    // the inner query yields the state.
    const redirect = decodeURIComponent(parsed.searchParams.get('redirect') ?? '')
    expect(redirect.startsWith('/oauth/desktop?')).toBe(true)
    expect(new URLSearchParams(redirect.split('?')[1]).get('state')).toBe(state)
    expect(new URLSearchParams(redirect.split('?')[1]).get('plugin')).toBe('1')
  })

  it('builds the poll URL against the backend origin', () => {
    expect(oauthHandoffPollUrl('https://freecodego.com', 'fcg_oauth_x_0123456789'))
      .toBe('https://freecodego.com/api/v1/auth/oauth/desktop/poll?state=fcg_oauth_x_0123456789')
  })

  it('parses the pending envelope', () => {
    expect(parseOAuthHandoffPoll({ code: 0, message: 'success', data: { status: 'pending' } })).toEqual({ kind: 'pending' })
    expect(parseOAuthHandoffPoll({ data: { status: 'pending' } })).toEqual({ kind: 'pending' })
  })

  it('parses the flat token-pair payload', () => {
    const parsed = parseOAuthHandoffPoll({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' })
    expect(parsed).toEqual({ kind: 'authenticated', tokens: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600, tokenType: 'Bearer' } })
  })

  it('parses a token pair that arrived inside the data envelope', () => {
    const parsed = parseOAuthHandoffPoll({ code: 0, data: { access_token: 'at-2', refresh_token: 'rt-2' } })
    expect(parsed.kind).toBe('authenticated')
    // expires_in falls back to one hour when the backend omits it.
    expect(parsed.kind === 'authenticated' && parsed.tokens.expiresIn).toBe(3600)
  })

  it('maps non-zero codes and missing payloads to failures', () => {
    expect(parseOAuthHandoffPoll({ code: 404, message: 'not found' })).toEqual({ kind: 'failed', message: 'not found' })
    expect(parseOAuthHandoffPoll({ code: 500 })).toMatchObject({ kind: 'failed' })
    expect(parseOAuthHandoffPoll({ status: 'expired' })).toEqual({ kind: 'failed', message: 'oauth handoff reported status expired' })
    expect(parseOAuthHandoffPoll(null)).toMatchObject({ kind: 'failed' })
    expect(parseOAuthHandoffPoll('nope')).toMatchObject({ kind: 'failed' })
  })

  it('carries the backend-reported reason out of a failed browser step', () => {
    // The browser step is closed by the backend now, so the plugin must show
    // the real reason ("why could this sign-in not finish?") instead of a bare
    // status word after waiting out its poll window.
    expect(parseOAuthHandoffPoll({
      code: 0,
      data: { status: 'failed', error: 'BACKEND_MODE_ADMIN_ONLY', message: 'Backend mode is active. Only admin login is allowed.' },
    })).toEqual({ kind: 'failed', message: 'BACKEND_MODE_ADMIN_ONLY: Backend mode is active. Only admin login is allowed.' })
    expect(parseOAuthHandoffPoll({ data: { status: 'failed', error: 'oauth_login_failed' } })).toEqual({ kind: 'failed', message: 'oauth_login_failed' })
  })

  it('surfaces a pending registration from the poll payload', () => {
    const parsed = parseOAuthHandoffPoll({
      code: 0,
      data: {
        status: 'pending',
        pending_completion: true,
        step: 'choose_account_action_required',
        email: 'someone@example.com',
        email_verified: true,
        invitation_required: false,
        suggested_display_name: 'Someone',
      },
    })
    expect(parsed.kind).toBe('pending-registration')
    if (parsed.kind !== 'pending-registration') return
    expect(parsed.registration.step).toBe('choose-account')
    expect(parsed.registration.email).toBe('someone@example.com')
    expect(parsed.registration.displayName).toBe('Someone')
  })

  it('keeps a plain pending poll untouched', () => {
    expect(parseOAuthHandoffPoll({ data: { status: 'pending' } }).kind).toBe('pending')
  })

  it('builds the pending endpoints against the backend origin', () => {
    expect(oauthPendingStatusUrl('https://freecodego.com')).toBe('https://freecodego.com/api/v1/auth/oauth/desktop/pending')
    expect(oauthPendingActionUrl('https://freecodego.com', 'bind-login')).toBe('https://freecodego.com/api/v1/auth/oauth/desktop/pending/bind-login')
    expect(oauthPendingActionUrl('https://freecodego.com', 'create-account')).toBe('https://freecodego.com/api/v1/auth/oauth/desktop/pending/create-account')
  })

  it('parses pending registration payloads and rejects unknown steps', () => {
    expect(parseOAuthPendingRegistration({ step: 'bind_login_required', invitation_required: true })).toMatchObject({ step: 'bind-login', invitationRequired: true })
    expect(parseOAuthPendingRegistration({ step: 'email_completion' })).toMatchObject({ step: 'email-completion' })
    expect(parseOAuthPendingRegistration({ step: 'nonsense' })).toBeUndefined()
    expect(parseOAuthPendingRegistration(null)).toBeUndefined()
  })
})
