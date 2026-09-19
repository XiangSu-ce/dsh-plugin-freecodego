import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import {
  AGNES_AUTH_TIMEOUT_MS,
  AGNES_CHAT_TIMEOUT_MS,
  AGNES_MEDIA_TIMEOUT_MS,
  AGNES_MODELS_TIMEOUT_MS,
  AGNES_STATUS_TIMEOUT_MS,
  AgnesAdapter,
  AgnesClient,
} from '../src/agnes.ts'

/** The smallest request the adapter will serialize, matching the other adapter specs. */
const userMessage = (text: string) => ({
  id: MessageId('m1'),
  role: 'user' as const,
  source: { kind: 'user' as const },
  content: [{ type: 'text' as const, text }],
})

/** One signed-in account carrying a provisioned key: every route below needs both. */
const SIGNED_IN = JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session-token', apiKey: 'secret-key', email: 'a@example.com' }], activeAccountId: 'a' })

/** A signed-in account with no key yet, so provisioning has to reach the platform. */
const SIGNED_IN_NO_KEY = JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session-token', email: 'a@example.com' }], activeAccountId: 'a' })

/** Two usable accounts, so a rotation has somewhere to fail over to. */
const POOL = JSON.stringify({
  accounts: [
    { id: 'a', accessToken: 's1', apiKey: 'k1' },
    { id: 'b', accessToken: 's2', apiKey: 'k2' },
  ],
  activeAccountId: 'a',
})

/** The credential store these specs drive; the account store round-trips in memory. */
function store(initialAuth?: string): CredentialProvider & { readonly set: Mock } {
  let auth: string | undefined = initialAuth
  let key: string | undefined
  return {
    resolve: vi.fn(async ref => ref === 'AGNES_AUTH' ? (auth === undefined ? undefined : { value: auth, source: 'test' }) : (key === undefined ? undefined : { value: key, source: 'test' })),
    describe: vi.fn(async () => ({ configured: false, writable: true })),
    set: vi.fn(async (ref, value: string) => { if (ref === 'AGNES_AUTH') auth = value; else key = value }),
    unset: vi.fn(async (ref) => { if (ref === 'AGNES_AUTH') auth = undefined; else key = undefined }),
  } as unknown as CredentialProvider & { readonly set: Mock }
}

/**
 * A fetch stub that settles only when the signal the client injected aborts.
 *
 * A request that carries no signal therefore rejects at once instead of hanging,
 * which is what makes a missing injection fail loudly rather than stall the suite.
 */
function hangOnSignal(): Mock {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal === undefined || signal === null) { reject(new Error('Agnes request carried no abort signal')); return }
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  }))
}

/**
 * Stub `AbortSignal.timeout` so a spec can fire the deadline on command and read
 * back the bound that was asked for. The native timer behind the real
 * `AbortSignal.timeout` is invisible to Vitest's fake timers, so it cannot be
 * advanced; recording the requested bound and aborting by hand is the honest
 * equivalent, and it keeps the spec instant rather than 30 seconds long.
 */
function stubDeadlines(): { readonly requested: number[]; readonly fire: () => void } {
  const requested: number[] = []
  const controller = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => { requested.push(timeoutMs); return controller.signal })
  return { requested, fire: () => { controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) } }
}

afterEach(() => vi.restoreAllMocks())

describe('Agnes network deadlines', () => {
  const bounded: readonly { readonly name: string; readonly timeoutMs: number; readonly run: (client: AgnesClient) => Promise<unknown> }[] = [
    { name: 'a verification code request', timeoutMs: AGNES_AUTH_TIMEOUT_MS, run: client => client.sendVerificationCode('a@example.com') },
    { name: 'a password reset', timeoutMs: AGNES_AUTH_TIMEOUT_MS, run: client => client.resetPassword({ email: 'a@example.com', password: 'Password1!', code: '123456' }) },
    { name: 'a registration', timeoutMs: AGNES_AUTH_TIMEOUT_MS, run: client => client.register({ email: 'a@example.com', password: 'Password1!', code: '123456' }) },
    { name: 'a login', timeoutMs: AGNES_AUTH_TIMEOUT_MS, run: client => client.login('a@example.com', 'Password1!') },
    { name: 'a session validation', timeoutMs: AGNES_AUTH_TIMEOUT_MS, run: client => client.refreshAccount() },
    { name: 'a chat stream', timeoutMs: AGNES_CHAT_TIMEOUT_MS, run: client => client.chat('{}', new AbortController().signal) },
    { name: 'an image generation', timeoutMs: AGNES_MEDIA_TIMEOUT_MS, run: client => client.generateImage({ prompt: 'a red kite' }) },
    { name: 'a video creation', timeoutMs: AGNES_MEDIA_TIMEOUT_MS, run: client => client.createVideo({ prompt: 'a red kite' }) },
    { name: 'a video status read', timeoutMs: AGNES_STATUS_TIMEOUT_MS, run: client => client.getVideo('video-1') },
    { name: 'the live model directory', timeoutMs: AGNES_MODELS_TIMEOUT_MS, run: client => client.listLiveMediaModels() },
  ]

  for (const item of bounded) {
    it(`bounds ${item.name} with the ${item.timeoutMs}ms deadline`, async () => {
      const deadlines = stubDeadlines()
      hangOnSignal()
      const pending = item.run(new AgnesClient(store(SIGNED_IN)))
      await vi.waitFor(() => { expect(deadlines.requested).toEqual([item.timeoutMs]) })
      deadlines.fire()
      await expect(pending).rejects.toThrow(`Agnes request timed out after ${item.timeoutMs / 1_000}s`)
    })
  }

  it('bounds API-key provisioning and the reuse lookup that precedes it', async () => {
    const deadlines = stubDeadlines()
    vi.spyOn(globalThis, 'fetch')
      // The reuse lookup answers "no existing key", so minting is the next step.
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined || signal === null) { reject(new Error('Agnes request carried no abort signal')); return }
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }))
    const pending = new AgnesClient(store(SIGNED_IN_NO_KEY)).createApiKey()
    await vi.waitFor(() => { expect(deadlines.requested).toEqual([AGNES_AUTH_TIMEOUT_MS, AGNES_AUTH_TIMEOUT_MS]) })
    deadlines.fire()
    await expect(pending).rejects.toThrow(`Agnes request timed out after ${AGNES_AUTH_TIMEOUT_MS / 1_000}s`)
  })

  it('bounds every remote logout attempt', async () => {
    const deadlines = stubDeadlines()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    // Signing out of the whole pool tells the upstream about each account, so
    // each of those calls needs its own bound.
    await new AgnesClient(store(POOL)).logout()
    expect(deadlines.requested).toEqual([AGNES_AUTH_TIMEOUT_MS, AGNES_AUTH_TIMEOUT_MS])
    deadlines.requested.length = 0
    await new AgnesClient(store(SIGNED_IN)).logout('a')
    expect(deadlines.requested).toEqual([AGNES_AUTH_TIMEOUT_MS])
  })

  it('reports a timeout without echoing the credentials the request carried', async () => {
    const deadlines = stubDeadlines()
    hangOnSignal()
    const pending = new AgnesClient(store()).login('a@example.com', 'Password1!')
    await vi.waitFor(() => { expect(deadlines.requested).toEqual([AGNES_AUTH_TIMEOUT_MS]) })
    deadlines.fire()
    const failure = await pending.then(
      () => new Error('the login was expected to fail'),
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    )
    expect(failure.message).toBe('Agnes request timed out after 30s')
    expect(failure.message).not.toContain('Password1!')
    expect(failure.message).not.toContain('platform-backend')
  })

  it('propagates the caller signal into the request and reports its abort', async () => {
    const controller = new AbortController()
    const fetchMock = hangOnSignal()
    const pending = new AgnesClient(store(SIGNED_IN)).generateImage({ prompt: 'a red kite', signal: controller.signal })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    // The injected signal is the merge, not the caller's own: the deadline has
    // to survive alongside it.
    const injected = fetchMock.mock.calls[0]?.[1]?.signal
    expect(injected).toBeInstanceOf(AbortSignal)
    expect(injected).not.toBe(controller.signal)
    expect(injected?.aborted).toBe(false)
    controller.abort(new Error('session disposed'))
    await expect(pending).rejects.toThrow('session disposed')
    expect(injected?.aborted).toBe(true)
  })

  it('does not start another account attempt once the caller has aborted', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // The session is disposed while the first account is still answering.
      controller.abort(new Error('session disposed'))
      return new Response(JSON.stringify({ code: 429, message: 'rate limited' }), { status: 429 })
    })
    // A 429 on any method is a rotation trigger; the abort must beat it.
    await expect(new AgnesClient(store(POOL)).chat('{}', controller.signal)).rejects.toThrow('session disposed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a network failure that is not an abort unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    await expect(new AgnesClient(store()).login('a@example.com', 'Password1!')).rejects.toThrow('network down')
  })

  it('tells the caller which bound a chat timeout exceeded', async () => {
    const deadlines = stubDeadlines()
    hangOnSignal()
    const adapter = new AgnesAdapter(new AgnesClient(store(SIGNED_IN)))
    const pending = adapter.stream({ provider: 'agnes', model: 'agnes-3.0-flash', messages: [userMessage('hello')] })[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(deadlines.requested).toEqual([AGNES_CHAT_TIMEOUT_MS]) })
    deadlines.fire()
    const failure = await pending.then(() => new Error('the stream was expected to fail'), (error: unknown) => error)
    // The generic transport line would hide the one fact the user needs: the
    // request was slow, not unauthorized.
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('TRANSPORT')
    expect((failure as LlmError).message).toBe('Agnes request timed out after 120s')
  })

  it('reports a caller abort on the chat route as an abort, not a provider failure', async () => {
    const controller = new AbortController()
    const fetchMock = hangOnSignal()
    const adapter = new AgnesAdapter(new AgnesClient(store(SIGNED_IN)))
    const pending = adapter.stream({ provider: 'agnes', model: 'agnes-3.0-flash', messages: [userMessage('hello')], signal: controller.signal })[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    controller.abort(new Error('session disposed'))
    const failure = await pending.then(() => new Error('the stream was expected to fail'), (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('ABORTED')
  })
})
