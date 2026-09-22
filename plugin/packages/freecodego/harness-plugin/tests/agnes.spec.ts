import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import { AGNES_CHAT_TIMEOUT_MS, AGNES_MAX_OUTPUT_TOKENS, AgnesAdapter, AgnesClient, agnesMediaCategory } from '../src/agnes.ts'

/**
 * The credential store the specs inspect. Its members are spies, so they are
 * declared here as properties: the assertions read them as mocks instead of
 * passing the interface's methods around unbound.
 */
type CredentialStoreFixture = CredentialProvider & { readonly resolve: Mock; readonly describe: Mock; readonly set: Mock; readonly unset: Mock }

function store(initialAuth?: string, initialKey?: string): CredentialStoreFixture {
  let auth: string | undefined = initialAuth
  let key: string | undefined = initialKey
  return {
    resolve: vi.fn(async ref => ref === 'AGNES_AUTH' ? (auth === undefined ? undefined : { value: auth, source: 'test' }) : (key === undefined ? undefined : { value: key, source: 'test' })),
    describe: vi.fn(async () => ({ configured: false, writable: true })),
    set: vi.fn(async (ref, value: string) => { if (ref === 'AGNES_AUTH') auth = value; else key = value }),
    unset: vi.fn(async (ref) => { if (ref === 'AGNES_AUTH') auth = undefined; else key = undefined }),
  } as unknown as CredentialStoreFixture
}

/**
 * The account the stored Agnes state reports as signed in.
 *
 * Read through the parsed value rather than by walking the JSON inline: the
 * parsed result is `any`, and the assertions below are about which account the
 * host kept, not about the shape of the payload.
 */
async function storedActiveAccountId(credentials: CredentialProvider): Promise<unknown> {
  const stored = await credentials.resolve(credentialRef('AGNES_AUTH'))
  if (stored === undefined) return undefined
  const parsed: unknown = JSON.parse(stored.value)
  return (parsed as { readonly activeAccountId?: unknown }).activeAccountId
}

/** The account ids the stored Agnes state holds, in the order it holds them. */
async function storedAccountIds(credentials: CredentialProvider): Promise<readonly unknown[]> {
  const stored = await credentials.resolve(credentialRef('AGNES_AUTH'))
  if (stored === undefined) return []
  const parsed: unknown = JSON.parse(stored.value)
  return ((parsed as { readonly accounts?: readonly { readonly id?: unknown }[] }).accounts ?? []).map(account => account.id)
}

afterEach(() => vi.restoreAllMocks())

describe('AgnesClient', () => {
  it('registers, logs in, and creates an API key in the Host credential store', async () => {
    const credentials = store()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, message: 'ok', data: { email: 'a@example.com' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { access_token: 'session-token', email: 'a@example.com' } }), { status: 200 }))
      // createApiKey lists existing keys first and reuses the stored one.
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: [{ name: 'freecodego', key: 'agnes-secret-key' }] }), { status: 200 }))
    const client = new AgnesClient(credentials)
    await expect(client.register({ email: 'a@example.com', password: 'Password1!', code: '123456' })).resolves.toMatchObject({ status: 'authenticated', apiKeyConfigured: true })
    expect(credentials.set).toHaveBeenCalledWith('AGNES_API_KEY', 'agnes-secret-key')
  })

  it('reuses the stored API key instead of minting a new one on every login', async () => {
    const credentials = store(JSON.stringify({ accounts: [{ id: 'a@example.com', accessToken: 'session-token', apiKey: 'stored-key' }], activeAccountId: 'a@example.com' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { access_token: 'next-token', email: 'a@example.com' } }), { status: 200 }))
    const client = new AgnesClient(credentials)
    await expect(client.login('a@example.com', 'Password1!')).resolves.toMatchObject({ status: 'authenticated', apiKeyConfigured: true })
    // No /api/token traffic at all: the stored key is reused as-is.
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(['https://platform-backend.agnes-ai.com/api/user/login'])
    expect(credentials.set).toHaveBeenCalledWith('AGNES_API_KEY', 'stored-key')
    expect(JSON.parse((await credentials.resolve(credentialRef('AGNES_AUTH')))!.value)).toEqual({ accounts: [{ id: 'a@example.com', accessToken: 'next-token', email: 'a@example.com', apiKey: 'stored-key' }], activeAccountId: 'a@example.com' })
  })

  it('drains a retryable response body before the next account attempt', async () => {
    const credentials = store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 's1', apiKey: 'k1' }, { id: 'b', accessToken: 's2', apiKey: 'k2' }] }))
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 429, message: 'rate limited' }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const client = new AgnesClient(credentials)
    const response = await client.chat('{}', new AbortController().signal)
    await expect(response.json()).resolves.toEqual({ data: [] })
  })

  it('requires Agnes login before listing models', async () => {
    await expect(new AgnesClient(store()).listModels()).rejects.toThrow('AGNES_LOGIN_REQUIRED')
  })

  it('exposes only chat-capable ids, leaving media to the media tools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const models = await new AgnesClient(store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session', apiKey: 'key' }] }))).listModels()
    // The chat picker must not offer an image or video generator: selecting one
    // starts a chat request against a route that only accepts an image prompt.
    expect(models.map(model => model.id)).toEqual(['agnes-3.0-flash'])
    expect(models.some(model => agnesMediaCategory(model.id) !== undefined)).toBe(false)
  })

  it('splits one /models document into the chat directory and the media directory', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [
        { id: 'agnes-image-3.0-turbo', name: 'Agnes Image 3.0 Turbo' },
        { id: 'agnes-video-3', name: 'Agnes Video 3' },
        { id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' },
        { id: 'agnes-4.0-pro', name: 'Agnes 4.0 Pro' },
        { id: 'some-legacy-model/preview', name: 'excluded: path id' },
      ] }), { status: 200 })
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    const client = new AgnesClient(store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session', apiKey: 'key' }] })))
    const models = await client.listModels()
    // The chat half of the document is served in full: a text route the product
    // publishes is selectable without waiting for a plugin release to name it.
    expect(models.map(model => model.id)).toEqual(['agnes-3.0-flash', 'agnes-4.0-pro'])
    // A route naming a generator is not a chat route, and a path-shaped id
    // cannot be addressed unambiguously by this picker.
    expect(models.map(model => model.id)).not.toContain('agnes-image-3.0-turbo')
    expect(models.map(model => model.id)).not.toContain('agnes-video-3')
    expect(models.map(model => model.id)).not.toContain('some-legacy-model/preview')
    // Media candidates still follow the live directory per category.
    await expect(client.agnesMediaModels('image')).resolves.toContain('agnes-image-3.0-turbo')
    await expect(client.agnesMediaModels('video')).resolves.toContain('agnes-video-3')
    await expect(client.agnesMediaModels('audio')).resolves.toEqual([])
  })

  it('keeps the documented chat route when the live directory cannot be read', async () => {
    // The live rows are an addition to the seed, never a replacement: an
    // unreachable directory must not empty the Agnes group in the picker.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const client = new AgnesClient(store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session', apiKey: 'key' }] })))
    await expect(client.listModels()).resolves.toMatchObject([{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' }])
  })

  it('keeps documented media ids selectable when the live directory is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const client = new AgnesClient(store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session', apiKey: 'key' }] })))
    await expect(client.agnesMediaModels('image')).resolves.toEqual(['agnes-image-2.5-flash'])
    await expect(client.agnesMediaModels('video')).resolves.toEqual(['agnes-video-2.5-flash'])
  })

  it('keeps the Agnes provider group visible before sign-in while calls remain gated', async () => {
    const models = await new AgnesAdapter(new AgnesClient(store())).listModels('agnes')
    // Image/video routes are exposed through dedicated media tools and must
    // not appear in the text composer model picker.
    expect(models.map(model => model.id)).toEqual(['agnes-3.0-flash'])
  })

  it('advertises selectable reasoning depths only for the Agnes text model', async () => {
    const adapter = new AgnesAdapter(new AgnesClient(store()))
    await expect(adapter.resolveModel('agnes', 'agnes-3.0-flash')).resolves.toMatchObject({
      reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
    })
    await expect(adapter.resolveModel('agnes', 'agnes-image-2.5-flash')).resolves.not.toHaveProperty('reasoning')
  })

  it('uses Agnes reset verification and password-reset fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    const client = new AgnesClient(store())
    await expect(client.sendPasswordResetCode('a@example.com')).resolves.toEqual({ sent: true })
    await expect(client.resetPassword({ email: 'a@example.com', password: 'NewPassword1!', code: '123456' })).resolves.toEqual({ updated: true })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://platform-backend.agnes-ai.com/api/verification?email=a%40example.com&purpose=reset')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ email: 'a@example.com', new_password: 'NewPassword1!', new_password_confirm: 'NewPassword1!', code: '123456' })
  })

  it('normalizes Agnes verification rate-limit responses for the UI', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 400, message: 'Sending too frequently, please try again later', data: null }), { status: 400 }))
    await expect(new AgnesClient(store()).sendPasswordResetCode('a@example.com')).rejects.toThrow('AGNES_VERIFICATION_RATE_LIMITED')
  })

  it('reports accounts that do not support password reset without leaking raw JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 400, message: 'Password reset is not supported for this account', data: null }), { status: 400 }))
    await expect(new AgnesClient(store()).resetPassword({ email: 'a@example.com', password: 'NewPassword1!', code: '123456' })).rejects.toThrow('AGNES_PASSWORD_RESET_UNSUPPORTED')
  })

  it('keeps image generation on the Host and sends the documented endpoint/body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), { status: 200 }))
    const result = await new AgnesClient(store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session', apiKey: 'secret' }] }))).generateImage({ prompt: 'a red kite' })
    expect(result.images[0]?.url).toBe('https://cdn.example/image.png')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://apihub.agnes-ai.com/v1/images/generations')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'agnes-image-2.5-flash', prompt: 'a red kite', extra_body: { response_format: 'url' } })
  })

  it('masks a credential the platform echoes back in a failure body', async () => {
    // The other half of the inventory's trust assumption: this client throws the
    // upstream body as the message, so the masking has to be here.
    const leaked = `ghp_${'A'.repeat(36)}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 500, message: `rejected ${leaked}` }), { status: 500 }),
    )
    const failure = await new AgnesClient(store()).sendVerificationCode('a@example.com')
      .then(() => new Error('the request was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).toContain('Agnes request failed (HTTP 500)')
    expect(failure.message).not.toContain(leaked)
  })

  it('declares the endpoint ceiling as the budget the model reports', async () => {
    // The Harness fills an unnamed budget from a much larger default, and Agnes
    // answers anything above its ceiling with `400 max_tokens exceeds the limit`
    // rather than trimming it. Declaring the real budget keeps the caller's
    // request inside the limit before any serialization happens.
    await expect(new AgnesAdapter(new AgnesClient(store())).resolveModel('agnes', 'agnes-3.0-flash'))
      .resolves.toMatchObject({ defaultMaxTokens: AGNES_MAX_OUTPUT_TOKENS })
  })

  it('honors a live-directory image model id and rejects mismatched media kinds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), { status: 200 }))
    const client = new AgnesClient(store(JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session', apiKey: 'secret' }] })))
    await client.generateImage({ prompt: 'a red kite', model: 'agnes-image-3.0-turbo' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe('agnes-image-3.0-turbo')
    // A video id must never be forwarded to the image endpoint.
    await client.generateImage({ prompt: 'a red kite', model: 'agnes-video-2.5-flash' })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).model).toBe('agnes-image-2.5-flash')
  })

  it('keeps a session-rejected account instead of deleting it', async () => {
    const credentials = store(JSON.stringify({
      accounts: [
        { id: 'a', accessToken: 'stale', apiKey: 'k1', email: 'a@example.com' },
        { id: 'b', accessToken: 's2', apiKey: 'k2', email: 'b@example.com' },
      ],
      activeAccountId: 'a',
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 401, message: 'session expired' }), { status: 401 }))
    const client = new AgnesClient(credentials)
    await expect(client.refreshAccount('a')).rejects.toThrow('AGNES_REAUTH_REQUIRED')
    // The row survives with its provisioned key: Agnes cannot mint a session
    // locally, so deleting would lose the account record and the user's choice.
    const persisted = JSON.parse((await credentials.resolve(credentialRef('AGNES_AUTH')))!.value) as { readonly accounts: readonly Record<string, unknown>[]; readonly activeAccountId?: string }
    expect(persisted.accounts.map(account => account.id)).toEqual(['a', 'b'])
    expect(persisted.accounts[0]).toMatchObject({ accessToken: 'stale', apiKey: 'k1', note: 'AGNES_REAUTH_REQUIRED' })
    expect(persisted.activeAccountId).toBe('a')
    // And the card can say why that account is idle.
    await expect(client.status()).resolves.toMatchObject({
      accounts: [{ id: 'a', reauthRequired: true }, { id: 'b' }],
    })
  })

  it('rotates past a rejected account instead of retrying it', async () => {
    const credentials = store(JSON.stringify({
      accounts: [
        { id: 'a', accessToken: 'stale', apiKey: 'k1', note: 'AGNES_REAUTH_REQUIRED' },
        { id: 'b', accessToken: 's2', apiKey: 'k2' },
      ],
      activeAccountId: 'a',
    }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {}\n\n', { status: 200 }))
    await new AgnesClient(credentials).chat('{}', new AbortController().signal)
    // One attempt, against the account that can still serve.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit).get('authorization')).toBe('Bearer k2')
  })

  it('names the session problem when every account has been rejected', async () => {
    const credentials = store(JSON.stringify({
      accounts: [{ id: 'a', accessToken: 'stale', apiKey: 'k1', note: 'AGNES_REAUTH_REQUIRED' }],
      activeAccountId: 'a',
    }))
    const client = new AgnesClient(credentials)
    // "Create an API key" would send the user to provision something that
    // cannot help; the account has to be signed in again.
    await expect(client.chat('{}', new AbortController().signal)).rejects.toThrow('AGNES_REAUTH_REQUIRED')
    await expect(client.createApiKey('a')).rejects.toThrow('AGNES_REAUTH_REQUIRED')
  })

  it('keeps the signed-in account when another one is refreshed', async () => {
    const credentials = store(JSON.stringify({
      accounts: [
        { id: 'a', accessToken: 's1', apiKey: 'k1', email: 'a@example.com' },
        { id: 'b', accessToken: 's2', apiKey: 'k2', email: 'b@example.com' },
      ],
      activeAccountId: 'a',
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { email: 'b@example.com' } }), { status: 200 }))
    const client = new AgnesClient(credentials)
    await client.refreshAccount('b')
    // A validity probe is not a switch: the card keeps reporting the account
    // the user is signed in as.
    expect(await storedActiveAccountId(credentials)).toBe('a')
    await expect(client.status()).resolves.toMatchObject({ email: 'a@example.com' })
  })

  it('does not resurrect an account removed while its own request was in flight', async () => {
    const credentials = store(JSON.stringify({
      accounts: [
        { id: 'a', accessToken: 's1', apiKey: 'k1', email: 'a@example.com' },
        { id: 'b', accessToken: 's2', apiKey: 'k2', email: 'b@example.com' },
      ],
      activeAccountId: 'a',
    }))
    let answerProbe: (() => void) | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => {
      answerProbe = () => { resolve(new Response(JSON.stringify({ code: 200, data: { email: 'b@example.com' } }), { status: 200 })) }
    }))
    const client = new AgnesClient(credentials)
    const probe = client.refreshAccount('b')
    await vi.waitFor(() => { expect(answerProbe).toBeDefined() })
    // The user removes the account while the probe it started is still waiting.
    await client.removeAccount('b')
    if (answerProbe !== undefined) answerProbe()
    await probe
    // Writing the probe's own snapshot back would restore the session token the
    // user just asked to forget.
    await expect(storedAccountIds(credentials)).resolves.toEqual(['a'])
  })

  it('keeps the signed-in account when an unrelated account is removed', async () => {
    const credentials = store(JSON.stringify({
      accounts: [{ id: 'a', accessToken: 's1' }, { id: 'b', accessToken: 's2' }, { id: 'c', accessToken: 's3' }],
      activeAccountId: 'c',
    }))
    const client = new AgnesClient(credentials)
    await client.removeAccount('a')
    expect(await storedActiveAccountId(credentials)).toBe('c')
    // Only the account that was actually selected falls through to a survivor.
    await client.removeAccount('c')
    expect(await storedActiveAccountId(credentials)).toBe('b')
  })
})

describe('AgnesAdapter chat failures', () => {
  /** One signed-in account carrying a provisioned key: the chat route needs both. */
  const SIGNED_IN = JSON.stringify({ accounts: [{ id: 'a', accessToken: 'session-token', apiKey: 'secret-key' }], activeAccountId: 'a' })

  /** The smallest stream the adapter's translator accepts as a finished turn. */
  const DONE_STREAM = 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

  /** The smallest request the adapter will serialize. */
  const userMessage = (text: string) => ({
    id: MessageId('m1'),
    role: 'user' as const,
    source: { kind: 'user' as const },
    content: [{ type: 'text' as const, text }],
  })

  /**
   * A deadline this spec fires on command, recording the bound that was asked
   * for. The native timer behind `AbortSignal.timeout` is invisible to Vitest's
   * fake timers, so firing the abort by hand is the honest equivalent and keeps
   * the spec instant instead of 120 seconds long.
   */
  function deadlineOnCommand(): { readonly requested: number[]; readonly fire: (reason: unknown) => void } {
    const requested: number[] = []
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => { requested.push(timeoutMs); return controller.signal })
    return { requested, fire: (reason: unknown) => { controller.abort(reason) } }
  }

  it('surfaces its own timeout line even when the underlying TimeoutError quotes a credential', async () => {
    // The masking inventory exempts the adapter's timeout throw on the ground
    // that the message it forwards verbatim is built by `agnesAbortError` from a
    // constant rather than from anything the upstream sent back. Measured here
    // rather than assumed: a TimeoutError whose own text carries a key must
    // still come out as the constant line, with nothing appended to it.
    const leaked = `ghp_${'A'.repeat(36)}`
    const deadlines = deadlineOnCommand()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) { reject(new Error('Agnes request carried no abort signal')); return }
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    const adapter = new AgnesAdapter(new AgnesClient(store(SIGNED_IN)))
    const pending = adapter.stream({ provider: 'agnes', model: 'agnes-3.0-flash', messages: [userMessage('hello')] })[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(deadlines.requested).toEqual([AGNES_CHAT_TIMEOUT_MS]) })
    deadlines.fire(new DOMException(`timed out: ${leaked}`, 'TimeoutError'))
    const failure = await pending.then(() => new Error('the stream was expected to fail'), (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('TRANSPORT')
    expect((failure as LlmError).message).toBe(`Agnes request timed out after ${AGNES_CHAT_TIMEOUT_MS / 1_000}s`)
    expect((failure as LlmError).message).not.toContain(leaked)
  })

  it('caps a caller budget larger than the endpoint ceiling', async () => {
    // Measured against the live endpoint: this exact shape (the Harness's own
    // default budget) is answered with `HTTP 400 {"error":{"message":"max_tokens
    // exceeds the limit of 65536"}}`, while the capped value streams.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(DONE_STREAM, { status: 200 }))
    const adapter = new AgnesAdapter(new AgnesClient(store(SIGNED_IN)))
    for await (const _chunk of adapter.stream({ provider: 'agnes', model: 'agnes-3.0-flash', messages: [userMessage('hello')], maxTokens: 131_072 })) { /* drain */ }
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { readonly max_tokens?: number }
    expect(body.max_tokens).toBe(AGNES_MAX_OUTPUT_TOKENS)
  })

  it('sends no budget at all when the caller named none', async () => {
    // The service picks its own default when the field is absent, which is a
    // legal request; inventing one is what the cap above exists to bound.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(DONE_STREAM, { status: 200 }))
    const adapter = new AgnesAdapter(new AgnesClient(store(SIGNED_IN)))
    for await (const _chunk of adapter.stream({ provider: 'agnes', model: 'agnes-3.0-flash', messages: [userMessage('hello')] })) { /* drain */ }
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.max_tokens).toBeUndefined()
  })
})
