import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoNativeAgentFactory } from '../src/factory.ts'
import { ensureAgentEngineBinding, routeProvider, type AgentEnginePlan } from '../src/engine-plan.ts'

const plan: AgentEnginePlan = {
  engineId: 'codex',
  generation: 1,
  artifactDigest: 'sha256:codex-v1',
  protocolAbi: 'freecodego-agent/1',
  modelId: 'codex-auto',
  routeBindingId: 'harness:codex:codex-auto',
  catalogRevision: 'harness-local',
  capabilityFingerprint: 'freecodego-codex-native',
}

describe('FreeCodeGo native plan routing', () => {
  it('parses the provider back out of a durable route binding', () => {
    expect(routeProvider('harness:agnes:glm-5.3-flash')).toBe('agnes')
    expect(routeProvider('harness:freecodego:deepseek-v4-flash')).toBe('freecodego')
    // A binding this package did not mint carries no provider to read.
    expect(routeProvider('legacy-binding')).toBeUndefined()
  })

  it('opens the native worker with the provider recorded in the engine plan', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const opened: Array<{ provider: string; modelId: string }> = []
    const factory = new FreeCodeGoNativeAgentFactory(ctx, {
      openers: {
        codex: async (options) => {
          opened.push({ provider: options.provider, modelId: options.modelId })
          return {
            identity: {
              engine: 'codex',
              runtimeSessionId: 'thread-1',
              harnessSessionId: options.harnessSessionId,
              modelId: options.modelId,
              provider: options.provider,
              artifactDigest: options.artifactDigest,
              protocolAbi: options.protocolAbi,
            },
            prompt: async () => {},
            cancel: async () => {},
            respond: async () => {},
            dispose: async () => {},
          }
        },
      },
    })
    // Agent options carry no route here: the plan's binding is the only record of
    // which provider the lease was minted with.
    const handle = await factory.createAgent(ctx, { sessionId: SessionId('native-plan-provider'), enginePlan: plan })
    expect(opened).toEqual([{ provider: 'codex', modelId: 'codex-auto' }])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('names the field that no longer matches a durable engine binding', () => {
    const session = Session.create(SessionId('binding-mismatch'))
    ensureAgentEngineBinding(session, plan)
    expect(session.snapshotEvents().filter(event => event.type === 'agent-engine/selected')).toHaveLength(1)
    // The mismatching field is named: the two plans differ in one value, and the
    // operator needs to know which one moved.
    expect(() => { ensureAgentEngineBinding(session, { ...plan, artifactDigest: 'sha256:codex-v2' }) })
      .toThrow(/does not match the requested plan: artifactDigest/)
    // Re-recording the same plan is the resume path and must not append again.
    ensureAgentEngineBinding(session, plan)
    expect(session.snapshotEvents().filter(event => event.type === 'agent-engine/selected')).toHaveLength(1)
  })
})
