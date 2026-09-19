import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountOAuthLogin,
  accountOAuthPendingBind,
  accountOAuthPendingCreate,
  accountOAuthPendingSendVerifyCode,
  accountOAuthPendingStatus,
} from '../src/account-remotes.ts'
import { OAUTH_HANDOFF_STATE_HEADER, OAUTH_LOGIN_POLL_INTERVAL_MS } from '../src/oauth-login.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'

// The browser step is the OS's business and must not be spawned by a test.
// Only the OS opener is stubbed; the module's real URL allow-list stays in
// place, because the OAuth tickets are validated with it.
vi.mock('../src/system-browser.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/system-browser.ts')>()
  return { ...actual, openUrlInSystemBrowser: async () => true }
})

const ORIGIN = 'https://freecodego.example'
const STATE = 'fcg_oauth_state_0123456789'

/**
 * The OAuth callback sets the pending-session cookies on the browser the
 * sign-in was opened in, so this Host only ever holds the handoff state it
 * minted. Every completion call has to present that state, or the backend
 * answers PENDING_AUTH_SESSION_NOT_FOUND and the completion form is a dead end.
 */
function host(state: string | undefined): AccountRemotesHost {
  return {
    account: { origin: ORIGIN },
    api: {
      getCurrentUser: vi.fn(async () => ({ id: 1, username: 'u', email: 'a@b.c', role: 'user', balance: 0, status: 'active' })),
    },
    state: { restorePromise: undefined, restoreCompleted: false, pendingOAuthState: state },
  } as unknown as AccountRemotesHost
}

/** One fake backend: records every request and answers per path. */
interface RecordedBackend {
  readonly requests: { readonly url: string; readonly init: RequestInit }[]
}

function mockBackend(answer: (url: string) => { readonly status: number; readonly body: Record<string, unknown> }): RecordedBackend {
  const requests: { readonly url: string; readonly init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const { status, body } = answer(url)
    requests.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  return { requests }
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>
}

/**
 * The one request a case made.
 *
 * Read through a checked accessor instead of an indexed one: a case that sent
 * nothing has to fail on the recorded request, and the assertion that names the
 * absence reads better than an index into an empty array.
 */
function sentRequest(backend: RecordedBackend): { readonly url: string; readonly init: RequestInit } {
  const request = backend.requests[0]
  if (request === undefined) throw new Error('the backend received no request')
  return request
}

const CHOICE_PAYLOAD = { code: 0, data: { step: 'choose_account_action_required', email: 'a@b.c' } }
const TOKEN_PAYLOAD = { code: 0, data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }

describe('pending federated registration completion', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('addresses the pending session with the handoff state the host minted', async () => {
    const backend = mockBackend(() => ({ status: 200, body: CHOICE_PAYLOAD }))
    await expect(accountOAuthPendingStatus(host(STATE))).resolves.toMatchObject({ step: 'choose-account', email: 'a@b.c' })

    expect(backend.requests).toHaveLength(1)
    const request = sentRequest(backend)
    expect(request.url).toBe(`${ORIGIN}/api/v1/auth/oauth/desktop/pending`)
    expect(headersOf(request.init)[OAUTH_HANDOFF_STATE_HEADER]).toBe(STATE)
  })

  it('carries the state on every completion step, not just the status read', async () => {
    const backend = mockBackend(url => url.includes('/pending') ? { status: 200, body: TOKEN_PAYLOAD } : { status: 200, body: {} })
    await accountOAuthPendingSendVerifyCode(host(STATE), 'a@b.c').catch(() => undefined)
    await accountOAuthPendingBind(host(STATE), { email: 'a@b.c', password: 'pw' }).catch(() => undefined)
    await accountOAuthPendingCreate(host(STATE), { email: 'a@b.c', password: 'pw' }).catch(() => undefined)

    const completionCalls = backend.requests.filter(request => request.url.includes('/oauth/desktop/pending'))
    expect(completionCalls.map(call => call.url.split('/api/v1/auth/oauth/desktop/pending')[1])).toEqual(['/verify-code', '/bind-login', '/create-account'])
    for (const call of completionCalls) {
      expect(headersOf(call.init)[OAUTH_HANDOFF_STATE_HEADER]).toBe(STATE)
    }
  })

  it('sends the two-factor code when binding a pending identity', async () => {
    const backend = mockBackend(() => ({ status: 200, body: { code: 0, data: { requires_2fa: true } } }))
    await expect(accountOAuthPendingBind(host(STATE), { email: 'a@b.c', password: 'pw', totpCode: '123456' })).rejects.toThrow('OAUTH_PENDING_2FA_REQUIRED')
    expect(JSON.parse(String(sentRequest(backend).init.body))).toMatchObject({
      email: 'a@b.c',
      password: 'pw',
      totpCode: '123456',
    })
  })

  it('sends no handoff header when the host holds no pending state', async () => {
    const backend = mockBackend(() => ({ status: 200, body: CHOICE_PAYLOAD }))
    await accountOAuthPendingStatus(host(undefined))
    expect(Object.keys(headersOf(sentRequest(backend).init))).not.toContain(OAUTH_HANDOFF_STATE_HEADER)
  })

  it('surfaces the backend refusal instead of reporting a completion', async () => {
    mockBackend(() => ({ status: 404, body: { code: 404, reason: 'PENDING_AUTH_SESSION_NOT_FOUND', message: 'pending auth session not found' } }))
    await expect(accountOAuthPendingCreate(host(undefined), { email: 'a@b.c', password: 'pw' }))
      .rejects.toThrow('OAUTH_PENDING_FAILED: pending auth session not found')
  })

  it('masks a credential the backend echoes back in its refusal', async () => {
    // The bind and create calls post the account email and password, and the
    // refusal is shown verbatim in the completion form. A backend that answers
    // with what it rejected — or with any other credential it saw — must not put
    // it into the message. The password itself is not a recognizable shape, so
    // what this pins is that the message goes through the shared masking rather
    // than straight to the form.
    const leaked = `ghp_${'A'.repeat(36)}`
    mockBackend(() => ({ status: 400, body: { code: 400, message: `rejected request carrying ${leaked}` } }))
    const failure = await accountOAuthPendingCreate(host(STATE), { email: 'a@b.c', password: 'pw' })
      .then(() => new Error('the completion was expected to be refused'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('OAUTH_PENDING_FAILED: rejected request carrying')
    expect(failure.message).not.toContain(leaked)
  })

  it('masks a credential quoted by a pending-request transport failure', async () => {
    // A transport can report proxy text in its error message. This reaches the
    // same settings form as a backend refusal, so it must use the same masking.
    const leaked = `ghp_${'A'.repeat(36)}`
    vi.stubGlobal('fetch', async () => { throw new Error(`proxy refused request carrying ${leaked}`) })

    const failure = await accountOAuthPendingStatus(host(STATE))
      .then(() => new Error('the pending request was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))

    expect(failure.message).toContain('OAUTH_PENDING_REQUEST_FAILED: proxy refused request carrying')
    expect(failure.message).not.toContain(leaked)
  })
})

describe('browser handoff poll', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('reports a refused poll instead of polling out the whole window', async () => {
    // The shared rate limiter answers 429 with `{error, message}` and no poll
    // answer at all (no code, no status, no data). Reading a body like that as
    // "still pending" spent the whole ten-minute window re-polling a limiter
    // that was already refusing — the 1.5s cadence is 40 polls a minute against
    // a 60-a-minute budget — and then reported a timeout, blaming the user.
    const backend = mockBackend(() => ({ status: 429, body: { error: 'rate limit exceeded', message: 'Too many requests, please try again later' } }))
    vi.useFakeTimers()
    const login = accountOAuthLogin(host(undefined), 'github')
    const rejection = expect(login).rejects.toThrow('OAUTH_LOGIN_POLL_FAILED: Too many requests, please try again later')
    await vi.advanceTimersByTimeAsync(OAUTH_LOGIN_POLL_INTERVAL_MS + 10)
    await rejection
    // One refused poll is enough; the loop must not keep asking.
    expect(backend.requests).toHaveLength(1)
  })

  it('masks a credential the refusing poll echoes back', async () => {
    // The poll's refusal is the message the sign-in reports, and it comes
    // straight from the backend body — the same text the completion steps take,
    // which was masked while this one was not.
    const leaked = `npm_${'A'.repeat(36)}`
    const backend = mockBackend(() => ({ status: 429, body: { error: 'rate limit exceeded', message: `Too many requests for ${leaked}, please try again later` } }))
    vi.useFakeTimers()
    const login = accountOAuthLogin(host(undefined), 'github')
    const rejection = expect(login).rejects.toThrow('OAUTH_LOGIN_POLL_FAILED: Too many requests for')
    await vi.advanceTimersByTimeAsync(OAUTH_LOGIN_POLL_INTERVAL_MS + 10)
    await rejection
    const failure = await login.then(() => new Error('the poll was expected to be refused'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).not.toContain(leaked)
    expect(backend.requests).toHaveLength(1)
  })

  it('reports an unreadable error page rather than hanging', async () => {
    // A proxy in front of the backend answers 502 with HTML, which has no poll
    // answer inside it either.
    const backend = mockBackend(() => ({ status: 502, body: {} }))
    vi.useFakeTimers()
    const login = accountOAuthLogin(host(undefined), 'github')
    const rejection = expect(login).rejects.toThrow('OAUTH_LOGIN_POLL_FAILED: the backend answered HTTP 502')
    await vi.advanceTimersByTimeAsync(OAUTH_LOGIN_POLL_INTERVAL_MS + 10)
    await rejection
    expect(backend.requests).toHaveLength(1)
  })

  it('asks for the pending registration without pasting the handoff state into the message', async () => {
    // `oauth-login.ts` documents the state as "the *sole* key that the public
    // poll endpoint resolves an issued token pair with", whose unpredictability
    // "is what keeps one client from being handed another client's pair" — so it
    // is a credential handle, and this message is shown to the user and kept in
    // the session record. It used to be interpolated into the text, where it had
    // no reader at all: the Settings card parses from the first `{`, and the
    // plugin keeps the state in `pendingOAuthState`, which is what the completion
    // calls actually present. The handle has to keep reaching those calls; what
    // it must not do is travel through the message.
    const backend = mockBackend(() => ({ status: 200, body: { pending_completion: true, step: 'email_completion', email: 'a@b.c' } }))
    vi.useFakeTimers()
    const session = host(undefined)
    const login = accountOAuthLogin(session, 'github')
    // Branch the rejection *before* any timer runs. A handler attached after the
    // rejection has already fired is too late to keep the runtime from counting it
    // as an unhandled rejection, which the runner reports as an error beside an
    // otherwise passing test — the same "the assertion ran, but the thing it
    // asserted was already an accident" shape this suite exists to catch.
    const settled = login.then(
      () => new Error('the poll was expected to ask for a registration'),
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    )
    await vi.advanceTimersByTimeAsync(OAUTH_LOGIN_POLL_INTERVAL_MS + 10)
    const failure = await settled
    // The state is minted inside the sign-in, so the value to check is the one
    // the flow itself stashed — not one this test supplied.
    const minted = session.state.pendingOAuthState
    expect(typeof minted).toBe('string')
    expect(minted).not.toBe('')
    // The UI's parser needs the marker and the JSON object, and nothing else.
    // (`parseOAuthPendingStep` normalizes `email_completion` to the hyphenated
    // spelling the card maps back to `email-completion`.)
    expect(failure.message).toContain('OAUTH_REGISTRATION_REQUIRED:')
    expect(failure.message).toContain('"step":"email-completion"')
    expect(failure.message).not.toContain(minted)
    expect(backend.requests).toHaveLength(1)
  })
})
