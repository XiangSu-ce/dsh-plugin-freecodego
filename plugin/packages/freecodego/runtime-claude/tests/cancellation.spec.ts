import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query,
}))

import { openClaudeRootRuntime } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
  query.mockReset()
})

describe('Claude native runtime cancellation', () => {
  it('forwards the caller abort signal to the SDK controller and settles the turn as aborted', async () => {
    query.mockImplementation((request: { options: { abortController: AbortController } }) => {
      const { signal } = request.options.abortController
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<never> {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
          })
        },
      }
    })
    const stateDirectory = await mkdtemp(join(tmpdir(), 'freecodego-claude-cancel-'))
    cleanups.push(async () => { await rm(stateDirectory, { recursive: true, force: true }) })
    const events: { readonly method: string; readonly params: Record<string, unknown> }[] = []
    const session = await openClaudeRootRuntime({ stateDirectory }, {
      harnessSessionId: 'claude-cancel',
      modelId: 'claude-test',
      provider: 'test',
      workspace: process.cwd(),
      artifactDigest: 'test-artifact',
      protocolAbi: 'freecodego-agent/1',
      onEvent: (event) => { events.push({ method: event.method, params: event.params }) },
    })
    const controller = new AbortController()
    const prompt = session.prompt('cancel this request', undefined, controller.signal)
    await vi.waitFor(() => { expect(query).toHaveBeenCalledTimes(1) })
    controller.abort(new Error('caller cancelled'))
    await expect(prompt).resolves.toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ method: 'session/completed', params: expect.objectContaining({ status: 'aborted' }) }))
  })

  it('redacts SDK stderr before forwarding it as progress', async () => {
    const secret = `sk-ant-${'a'.repeat(32)}`
    query.mockImplementation((request: { options: { stderr: (detail: string) => void } }) => {
      request.options.stderr(`Authorization: Bearer ${secret}`)
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ readonly type: string; readonly subtype: string }> {
          yield { type: 'result', subtype: 'success' }
        },
      }
    })
    const stateDirectory = await mkdtemp(join(tmpdir(), 'freecodego-claude-stderr-'))
    cleanups.push(async () => { await rm(stateDirectory, { recursive: true, force: true }) })
    const events: { readonly method: string; readonly params: Record<string, unknown> }[] = []
    const session = await openClaudeRootRuntime({ stateDirectory }, {
      harnessSessionId: 'claude-stderr',
      modelId: 'claude-test',
      provider: 'test',
      workspace: process.cwd(),
      artifactDigest: 'test-artifact',
      protocolAbi: 'freecodego-agent/1',
      onEvent: (event) => { events.push({ method: event.method, params: event.params }) },
    })
    await session.prompt('run the test')
    expect(events).toContainEqual(expect.objectContaining({ method: 'tool/progress', params: expect.objectContaining({ detail: { text: 'Authorization: Bearer <redacted>' } }) }))
  })

  it('masks a gateway token the session holds even though no shape names it', async () => {
    // The case above passes because its sample is Anthropic-shaped. A
    // third-party gateway key is whatever string its provider chose, and the
    // subprocess holds it in its environment, so only the value can name it.
    const gatewayToken = 'vyce-gateway-abcdef123456789'
    query.mockImplementation((request: { options: { stderr: (detail: string) => void } }) => {
      request.options.stderr(`gateway refused credential ${gatewayToken}`)
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ readonly type: string; readonly subtype: string }> {
          yield { type: 'result', subtype: 'success' }
        },
      }
    })
    const stateDirectory = await mkdtemp(join(tmpdir(), 'freecodego-claude-gateway-token-'))
    cleanups.push(async () => { await rm(stateDirectory, { recursive: true, force: true }) })
    const events: { readonly method: string; readonly params: Record<string, unknown> }[] = []
    const session = await openClaudeRootRuntime({ stateDirectory, environment: { ANTHROPIC_AUTH_TOKEN: gatewayToken } }, {
      harnessSessionId: 'claude-gateway-token',
      modelId: 'claude-test',
      provider: 'test',
      workspace: process.cwd(),
      artifactDigest: 'test-artifact',
      protocolAbi: 'freecodego-agent/1',
      onEvent: (event) => { events.push({ method: event.method, params: event.params }) },
    })
    await session.prompt('run the test')
    // The matcher's `objectContaining` returns `any`, which is what the two
    // older copies of this assertion trip over; reading the frame out first
    // keeps the same claim and stays typed.
    const stderrProgress = events.filter(event => event.method === 'tool/progress')
    expect(stderrProgress).toHaveLength(1)
    expect(stderrProgress[0]?.params).toMatchObject({ detail: { text: 'gateway refused credential <redacted>' } })
  })

  it('masks a gateway token in a failed turn, which the Agent records as the turn error', async () => {
    // The third place this session's credentials are read: a thrown SDK error
    // becomes the turn's recorded failure, and unlike stderr that text is shown
    // to the user rather than to the model.
    const gatewayToken = 'vyce-gateway-abcdef123456789'
    query.mockImplementation(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<never> {
        throw new Error(`gateway refused credential ${gatewayToken}`)
      },
    }))
    const stateDirectory = await mkdtemp(join(tmpdir(), 'freecodego-claude-turn-error-'))
    cleanups.push(async () => { await rm(stateDirectory, { recursive: true, force: true }) })
    const session = await openClaudeRootRuntime({ stateDirectory, environment: { ANTHROPIC_AUTH_TOKEN: gatewayToken } }, {
      harnessSessionId: 'claude-turn-error',
      modelId: 'claude-test',
      provider: 'test',
      workspace: process.cwd(),
      artifactDigest: 'test-artifact',
      protocolAbi: 'freecodego-agent/1',
      onEvent: () => undefined,
    })
    await expect(session.prompt('run the test')).rejects.toThrow('gateway refused credential <redacted>')
  })
})
