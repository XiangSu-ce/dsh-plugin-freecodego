import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { buildCosyHeaders, cosyDecode, cosyEncode, createQoderSession, deriveMachineId, deriveMachineToken, deriveMachineType, fingerprintSeed, md5Hex } from '../src/qoder/cosy.ts'
import { parseQoderCatalog, selectFreeQoderModels } from '../src/qoder/directory.ts'
import { buildQoderChatBody, normalizeContent, parseQoderFrame, QoderUpstreamError, synthesizeOpenAiSse } from '../src/qoder/bridge.ts'
import { qoderIdentityFromUserInfo } from '../src/qoder/oauth.ts'
import { QoderAdapter, QoderClient, qoderAccountId, qoderModelInfo } from '../src/qoder-intl.ts'
import type { QoderIdentity, QoderModel } from '../src/qoder/types.ts'

const IDENTITY: QoderIdentity = {
  name: 'Ada',
  aid: 'uid-1',
  uid: 'uid-1',
  userType: 'personal_standard',
  securityOauthToken: 'dt-abc',
}

describe('qoder cosy protocol', () => {
  it('round-trips arbitrary bytes through the shuffled base64', () => {
    for (const value of ['', 'a', 'hello', 'qwen-3.8-flash', '多字节 · 内容', 'x'.repeat(97)]) {
      const bytes = Buffer.from(value, 'utf8')
      expect(cosyDecode(cosyEncode(bytes)).toString('utf8')).toBe(value)
    }
    const random = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(cosyDecode(cosyEncode(random)).equals(random)).toBe(true)
  })

  it('derives a stable, correctly shaped device fingerprint', () => {
    const seed = fingerprintSeed('uid-1', 'dt-abc')
    expect(deriveMachineId(seed)).toBe(deriveMachineId(seed))
    expect(deriveMachineId(seed)).toMatch(/^[0-9a-f]{32}$/)
    expect(deriveMachineType(seed)).toHaveLength(18)
    expect(deriveMachineToken(seed)).toHaveLength(43)
    // A different account derives a different device; no cross-account linkage.
    expect(deriveMachineId('uid-2')).not.toBe(deriveMachineId('uid-1'))
    // With no uid the credential seeds it, stably.
    expect(fingerprintSeed('', 'dt-abc')).toBe('cred:dt-abc')
  })

  it('signs with the documented MD5 legacy digest', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })

  it('mints a session and signs a Bearer header', () => {
    const machineId = deriveMachineId('uid-1')
    const session = createQoderSession(IDENTITY, machineId, deriveMachineToken('uid-1'), deriveMachineType('uid-1'), 'global')
    expect(session.cosyKey.length).toBeGreaterThan(40)
    expect(session.info.length).toBeGreaterThan(40)
    const headers = buildCosyHeaders(session, '/api/v2/model/list', '', 'application/json')
    expect(headers.authorization?.startsWith('Bearer COSY.')).toBe(true)
    expect(headers['cosy-machineid']).toBe(machineId)
    expect(headers['cosy-user']).toBe('uid-1')
  })
})

describe('qoder directory', () => {
  const document = {
    assistant: [
      { key: 'qmodel_38flash', display_name: 'Qwen 3.8 Flash', enable: true, is_default: true, is_reasoning: false, max_input_tokens: 200000 },
      { key: 'dmodel', display_name: 'GPT Performance', enable: true, is_reasoning: false },
      { key: 'gmodel', display_name: 'Gemini', enable: false },
    ],
  }

  it('parses enabled models, default first', () => {
    const models = parseQoderCatalog(document)
    expect(models.map(model => model.key)).toEqual(['qmodel_38flash', 'dmodel'])
  })

  it('narrows the directory to the free Qwen flash route only', () => {
    const models = selectFreeQoderModels(parseQoderCatalog(document))
    expect(models.map(model => model.key)).toEqual(['qmodel_38flash'])
    // A directory without the route yields nothing rather than a guessed model.
    expect(selectFreeQoderModels([{ key: 'dmodel', displayName: 'GPT', enable: true, isDefault: false, isReasoning: false }])).toEqual([])
    // A sibling non-flash Qwen route must not be advertised.
    expect(selectFreeQoderModels([{ key: 'qmodel_38max', displayName: 'Qwen 3.8 Max', enable: true, isDefault: false, isReasoning: false }])).toEqual([])
    expect(selectFreeQoderModels([{ key: 'x', displayName: 'Qwen 3.8 Flash (free)', enable: true, isDefault: false, isReasoning: false }]).map(m => m.key)).toEqual(['x'])
  })
})

describe('qoder chat bridge', () => {
  it('normalizes string and block content', () => {
    expect(normalizeContent('plain')).toBe('plain')
    expect(normalizeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\n\nb')
    expect(normalizeContent(undefined)).toBe('')
  })

  it('assembles the upstream request body from OpenAI messages', () => {
    const body = buildQoderChatBody(
      { messages: [{ role: 'user', content: 'hello' }], model: 'qmodel_38flash', isReasoning: false },
      IDENTITY,
    )
    expect((body.model_config as Record<string, unknown>).key).toBe('qmodel_38flash')
    expect(body.aliyun_user_type).toBe('personal_standard')
    expect(body.stream).toBe(true)
    const messages = body.messages as readonly Record<string, unknown>[]
    expect(messages[0]!.role).toBe('user')
    expect((messages[0]!.contents as readonly Record<string, unknown>[])[0]!.text).toBe('hello')
    expect((body.business as Record<string, unknown>).name).toBe('hello')
  })

  it('reads a delta frame and reports an envelope failure', () => {
    const ok = parseQoderFrame(JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] }) }))
    expect(ok?.kind).toBe('delta')
    if (ok?.kind === 'delta') expect(ok.delta.content).toBe('hi')
    expect(parseQoderFrame('[DONE]')).toEqual({ kind: 'done' })

    expect(() => parseQoderFrame(JSON.stringify({ statusCodeValue: 500, body: 'boom' }))).toThrow(QoderUpstreamError)
    expect(() => parseQoderFrame(JSON.stringify({ body: JSON.stringify({ code: '115', message: 'nope' }) }))).toThrow(QoderUpstreamError)
  })

  it('keeps content that arrives in the same frame as usage', async () => {
    const payload = JSON.stringify({
      statusCodeValue: 200,
      body: JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    })
    const stream = synthesizeOpenAiSse((async function* () { yield payload })())
    const text = await new Response(stream).text()
    expect(text).toContain('"content":"hi"')
    expect(text).toContain('"completion_tokens":1')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})

describe('qoder account helpers', () => {
  it('addresses a stored account by id or token tail', () => {
    expect(qoderAccountId({ id: 'acct-1' })).toBe('acct-1')
    expect(qoderAccountId({ deviceToken: 'dt-0123456789ab' })).toBe('qoder-0123456789ab')
    expect(qoderAccountId({})).toBeUndefined()
  })

  it('maps a model to its browser-safe row', () => {
    const model: QoderModel = { key: 'qmodel_38flash', displayName: 'Qwen 3.8 Flash', enable: true, isDefault: true, isReasoning: false, contextWindow: 200000, maxOutputTokens: 16384 }
    expect(qoderModelInfo(model)).toEqual({ id: 'qmodel_38flash', displayName: 'Qwen 3.8 Flash', contextWindow: 200000, maxTokens: 16384, isReasoning: false })
  })

  it('builds a cosy identity from userinfo', () => {
    const identity = qoderIdentityFromUserInfo({ name: 'Ada', userId: 'u1', organization_id: 'org', userType: 'personal_standard' }, 'dt-xyz', 'drt-1')
    expect(identity.uid).toBe('u1')
    expect(identity.aid).toBe('u1')
    expect(identity.securityOauthToken).toBe('dt-xyz')
    expect(identity.refreshToken).toBe('drt-1')
    expect(identity.organizationId).toBe('org')
  })
})

/** The vault row the connector reads its pool from. */
function vault(): CredentialProvider {
  const value = JSON.stringify({
    accounts: [{
      id: 'acct-1',
      region: 'global',
      deviceToken: 'dt-0123456789ab',
      uid: 'uid-1',
      name: 'Ada',
      createdAt: 1,
      lastChecked: 1,
    }],
  })
  return {
    resolve: vi.fn(async ref => ref === 'QODER_STORE' ? { value, source: 'test' } : undefined),
    describe: vi.fn(async () => ({ configured: true, writable: true })),
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
  } as unknown as CredentialProvider
}

/**
 * The directory the connector reads, with the one route it serves.
 *
 * `is_reasoning` is deliberately false: that is what the product's own list has
 * reported for this route, and the menu has to offer the control anyway.
 */
const DIRECTORY = {
  assistant: [
    { key: 'qmodel_38flash', display_name: 'Qwen 3.8 Flash', enable: true, is_default: true, is_reasoning: false, max_input_tokens: 200_000, price_factor: 0 },
    { key: 'qmodel_38max', display_name: 'Qwen 3.8 Max', enable: true, is_default: false, is_reasoning: true, max_input_tokens: 200_000, price_factor: 2 },
  ],
}

afterEach(() => { vi.restoreAllMocks() })

describe('qoder reasoning wire', () => {
  /** Run one turn and hand back the body the adapter actually signed and sent. */
  async function postedBody(effort?: string): Promise<Record<string, unknown>> {
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('model/list')) {
        return new Response(JSON.stringify(DIRECTORY), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // The chat stream: capture what was posted and answer one content delta.
      bodies.push(String((init)?.body ?? ''))
      const frame = JSON.stringify({
        statusCodeValue: 200,
        body: JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'ok' } }] }),
      })
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const adapter = new QoderAdapter(new QoderClient(vault(), async () => undefined))
    for await (const _chunk of adapter.stream({
      provider: 'qoder',
      model: 'qmodel_38flash',
      messages: [{ id: MessageId('m1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    })) { /* drained */ }
    // The body is cosy-encoded, so it is decoded back before it is read.
    return JSON.parse(cosyDecode(String(bodies[0] ?? '')).toString('utf8')) as Record<string, unknown>
  }

  it('lists the priced routes with their own rate, and still advertises only the free one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(DIRECTORY), { status: 200, headers: { 'content-type': 'application/json' } }))
    const adapter = new QoderAdapter(new QoderClient(vault(), async () => undefined))
    const rows = await adapter.listModels('qoder')
    expect(rows.map(row => row.id)).toEqual(['qmodel_38flash', 'qmodel_38max'])
    // The rate rides in the description because that is the only price channel
    // the browser half has; it is what keeps the metered route out of the picker
    // until the user asks for it.
    expect(rows[0]!.description).toContain('×0')
    expect(rows[1]!.description).toContain('×2')
    // The settings card's model cloud still describes the free route only.
    await expect(new QoderClient(vault(), async () => undefined).freeModels()).resolves.toMatchObject([{ id: 'qmodel_38flash' }])
  })

  it('offers exactly the two levels the upstream boolean can express', async () => {
    // The directory is fetched here as well: `resolveModel` resolves the route against
    // the *whole* directory rather than the free list, so a case without this mock
    // reaches the network — which is what it did, as a five-second timeout, until it
    // was answered here. The ladder below does not depend on the answer, and that is
    // the property: it is offered on every route this connector serves.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(DIRECTORY), { status: 200, headers: { 'content-type': 'application/json' } }))
    const adapter = new QoderAdapter(new QoderClient(vault(), async () => undefined))
    const resolved = await adapter.resolveModel('qoder', 'qmodel_38flash')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'on'])
    expect(resolved.reasoning?.defaultEffort).toBe('on')
  })

  it('carries the chosen level into model_config.is_reasoning, which was dropped before', async () => {
    // The reported defect: the selector existed but the request never carried the
    // choice, so picking any level changed nothing on the wire.
    expect((await postedBody('on')).model_config).toMatchObject({ is_reasoning: true })
    expect(((await postedBody('on')).chat_context as Record<string, unknown>).extra).toMatchObject({ modelConfig: { is_reasoning: true } })
    // `off` is dropped by the shared serializer, so its absence has to be read as
    // the refusal it is — otherwise the level would silently do nothing.
    const off = await postedBody('off')
    expect(off).not.toHaveProperty('reasoning_effort')
    expect(off.model_config).toMatchObject({ is_reasoning: false })
  })

  it('does not think when no level was stated at all', async () => {
    expect((await postedBody()).model_config).toMatchObject({ is_reasoning: false })
  })
})
