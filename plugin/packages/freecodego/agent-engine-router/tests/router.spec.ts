import { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { AgentEngineLease } from '../src/engine-registry.ts'
import { FreeCodeGoAgentEngineRegistry } from '../src/engine-registry.ts'
import { effectiveProviderOf, enforceSameEngine, inheritSameEngineRoute } from '../src/engine-affinity.ts'
import type { AgentEngineDefinition } from '@deepseek-ai/dsh-freecodego-root-agent'

function definition(
  id: 'deepseek' | 'codex' | 'claude',
  digest: string,
  options: {
    readonly availability?: AgentEngineDefinition['availability']
    readonly reasons?: readonly string[]
    /** Held open by a test that needs two reservations to overlap. */
    readonly gate?: Promise<void>
  } = {},
): AgentEngineDefinition {
  return {
    id,
    availability: options.availability ?? 'available',
    reasons: options.reasons ?? [],
    async createPlan(input) {
      await options.gate
      return {
        artifactDigest: digest,
        protocolAbi: 'freecodego-agent/1',
        modelId: input.modelId,
        routeBindingId: input.routeBindingId,
        catalogRevision: input.catalogRevision,
        capabilityFingerprint: input.capabilityFingerprint,
      }
    },
  }
}

/** A promise a test releases while two reservations are both in flight. */
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

const planInput = (provider: string, model: string) => ({
  modelId: model,
  routeBindingId: `harness:${provider}:${model}`,
  catalogRevision: 'test',
  capabilityFingerprint: 'test',
})

describe('FreeCodeGoAgentEngineRouter hot-plug regression', () => {
  it.each([
    ['deepseek', 'claude'],
    ['codex', undefined],
    ['claude', 'deepseek'],
  ] as const)('forces child route onto parent %s engine', (parentEngine, requested) => {
    const child = enforceSameEngine(
      requested === undefined ? { provider: 'deepseek-official' } : { engine: requested, provider: 'freecodego' },
      { engine: parentEngine },
    )
    expect(child.engine).toBe(parentEngine)
  })

  it('yields an inherited ordinary default to the parent route, but keeps a provider the caller named', () => {
    const parent = { engine: 'claude' as const, provider: 'claude', model: 'claude-sonnet' }
    // The Web API's own default is not a choice: a native child carrying it takes
    // the parent's route rather than the ordinary one.
    expect(inheritSameEngineRoute({ provider: 'freecodego' }, parent)).toMatchObject({ provider: 'claude' })
    expect(inheritSameEngineRoute({ provider: 'deepseek-official' }, parent)).toMatchObject({ provider: 'claude' })
    // The other engine's native marker is foreign for the same reason.
    expect(inheritSameEngineRoute({ provider: 'codex' }, parent)).toMatchObject({ provider: 'claude' })
    // A provider the caller actually named is not the default, so it stays — and
    // the parent's model stays behind with the route it was minted for. Inheriting
    // it here asked agnes for a `claude-sonnet` it never served.
    expect(inheritSameEngineRoute({ provider: 'agnes' }, parent)).toMatchObject({ provider: 'agnes' })
    expect(inheritSameEngineRoute({ provider: 'agnes' }, parent).model).toBeUndefined()
    // A child that kept the parent's own provider is on the parent's route, so the
    // model travels with it.
    expect(inheritSameEngineRoute({ provider: 'claude' }, parent)).toMatchObject({ provider: 'claude', model: 'claude-sonnet' })
  })

  it('inherits provider and model when a child omits its route', () => {
    expect(inheritSameEngineRoute({}, { engine: 'codex', provider: 'codex', model: 'codex-auto' })).toMatchObject({
      engine: 'codex', provider: 'codex', model: 'codex-auto',
    })
    expect(inheritSameEngineRoute({ provider: 'freecodego', model: 'child-model' }, { engine: 'claude', provider: 'claude', model: 'claude-sonnet' })).toMatchObject({
      engine: 'claude', provider: 'claude', model: 'child-model',
    })
  })

  it('withholds a parent route that names another engine', () => {
    // A parent pair claiming another engine's native provider contributes
    // neither half: keeping the provider would hand the child a foreign
    // protocol, and keeping only the model would pair that model id with the
    // engine's own provider.
    expect(inheritSameEngineRoute({}, { engine: 'deepseek', provider: 'codex', model: 'codex-auto' })).toEqual({ engine: 'deepseek' })
    expect(inheritSameEngineRoute({}, { engine: 'claude', provider: 'codex', model: 'codex-auto' })).toEqual({ engine: 'claude' })
    // A Host-adapter provider is not foreign to a native engine — the Claude
    // engine reaches it through the plugin's bridge and the Codex engine carries
    // the route it was opened with — so that route still travels.
    expect(inheritSameEngineRoute({}, { engine: 'codex', provider: 'freecodego', model: 'glm-5.3-flash' }))
      .toMatchObject({ engine: 'codex', provider: 'freecodego', model: 'glm-5.3-flash' })
    // The same route still travels when it fits, and a parent with no engine
    // marker is unconstrained because there is no engine to contradict.
    expect(inheritSameEngineRoute({}, { engine: 'codex', provider: 'codex', model: 'codex-auto' }))
      .toMatchObject({ engine: 'codex', provider: 'codex', model: 'codex-auto' })
    expect(inheritSameEngineRoute({}, { provider: 'codex', model: 'codex-auto' }))
      .toMatchObject({ provider: 'codex', model: 'codex-auto' })
  })

  it('names the provider each engine runs when the caller named none', () => {
    // The durable route binding is what the resume path reads the provider back
    // from, so it has to record the provider the engine actually runs.
    expect(effectiveProviderOf('deepseek', undefined)).toBe('deepseek-official')
    expect(effectiveProviderOf('codex', undefined)).toBe('codex')
    expect(effectiveProviderOf('claude', undefined)).toBe('freecodego')
    expect(effectiveProviderOf('claude', '   ')).toBe('freecodego')
    expect(effectiveProviderOf('codex', ' agnes ')).toBe('agnes')
  })

  it('resolves the fallback loop through the service registry during resume', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/index.ts'), 'utf8')
    expect(source).toContain("this.ctx.get('agentLoop')")
    expect(source).not.toContain('this.ctx.agentLoop.resume')
    expect(source).not.toContain('this.ctx.agentLoop.createAgent')
  })

  it('keeps leased generations isolated while replacing one native engine', async () => {
    const ctx = new Context()
    const engines = new FreeCodeGoAgentEngineRegistry(ctx)
    engines.register(definition('deepseek', 'builtin:loop'))
    engines.register(definition('codex', 'sha256:codex-v1'))
    engines.register(definition('claude', 'sha256:claude-v1'))
    const reserve = (session: SessionId, id: 'deepseek' | 'codex' | 'claude', provider: string, model: string) => engines.reserve(id, session, {
      modelId: model,
      routeBindingId: `harness:${provider}:${model}`,
      catalogRevision: 'test',
      capabilityFingerprint: 'test',
    })

    const oldCodex = await reserve(SessionId('codex-old'), 'codex', 'native', 'codex-model')
    const deepseek = await reserve(SessionId('deepseek-live'), 'deepseek', 'deepseek-official', 'deepseek-model')
    const claude = await reserve(SessionId('claude-live'), 'claude', 'native', 'claude-model')
    expect(oldCodex.plan.generation).toBe(1)
    expect(deepseek.plan.generation).toBe(1)
    expect(claude.plan.generation).toBe(1)

    engines.beginDrain('codex')
    engines.register(definition('codex', 'sha256:codex-v2'))
    const newCodex = await reserve(SessionId('codex-new'), 'codex', 'native', 'codex-model')
    expect(newCodex.plan.generation).toBe(2)
    expect(newCodex.plan.artifactDigest).toBe('sha256:codex-v2')
    expect(deepseek.plan.engineId).toBe('deepseek')
    expect(claude.plan.engineId).toBe('claude')
    const resumedOld = await engines.reserveExisting(oldCodex.plan, SessionId('codex-resumed'))
    expect(resumedOld.plan).toEqual(oldCodex.plan)
    oldCodex.release()
    resumedOld.release()
    deepseek.release()
    claude.release()
    newCodex.release()
    expect(engines.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', generation: 2, activeLeaseCount: 0 }),
    ]))
    await ctx.fiber.dispose()
  })

  it('admits one of two concurrent reservations for one session and tracks the winner', async () => {
    const ctx = new Context()
    const engines = new FreeCodeGoAgentEngineRegistry(ctx)
    const gate = deferred()
    engines.register(definition('deepseek', 'builtin:loop', { gate: gate.promise }))
    const session = SessionId('concurrent-session')
    const first = engines.reserve('deepseek', session, planInput('deepseek-official', 'deepseek-model'))
    const second = engines.reserve('deepseek', session, planInput('deepseek-official', 'deepseek-model'))
    gate.resolve()
    const settled = await Promise.allSettled([first, second])
    const won = settled.filter((result): result is PromiseFulfilledResult<AgentEngineLease> => result.status === 'fulfilled')
    const lost = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    const failure: unknown = lost[0]?.reason
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error ? failure.message : '').toMatch(/already has an engine lease/)
    // The winner is the only lease the registry admits, and it stays releasable:
    // the loser must not have replaced it in the entry's lease map.
    expect(engines.snapshot()).toEqual([expect.objectContaining({ id: 'deepseek', activeLeaseCount: 1 })])
    won[0]?.value.release()
    expect(engines.snapshot()).toEqual([expect.objectContaining({ id: 'deepseek', activeLeaseCount: 0 })])
    await ctx.fiber.dispose()
  })

  it('refuses a durable plan once its engine stops admitting sessions, naming the reason', async () => {
    const ctx = new Context()
    const engines = new FreeCodeGoAgentEngineRegistry(ctx)
    engines.register(definition('codex', 'sha256:codex-v1', { reasons: ['CODEX_RUNTIME_NOT_INSTALLED'] }))
    const lease = await engines.reserve('codex', SessionId('codex-live'), planInput('codex', 'codex-auto'))
    engines.setAvailability('codex', 'unavailable')
    await expect(engines.reserveExisting(lease.plan, SessionId('codex-resumed')))
      .rejects.toThrow('agent engine "codex" is unavailable: CODEX_RUNTIME_NOT_INSTALLED')
    // Availability gates admission, not an engine that is already running a
    // session, so the live lease is untouched.
    expect(engines.snapshot()).toEqual([expect.objectContaining({ id: 'codex', activeLeaseCount: 1 })])
    lease.release()
    await ctx.fiber.dispose()
  })

  it('names the field that makes a durable plan incompatible with the installed runtime', async () => {
    const ctx = new Context()
    const engines = new FreeCodeGoAgentEngineRegistry(ctx)
    engines.register(definition('deepseek', 'builtin:loop'))
    const lease = await engines.reserve('deepseek', SessionId('deepseek-plan'), planInput('deepseek-official', 'deepseek-model'))
    await expect(engines.reserveExisting({ ...lease.plan, artifactDigest: 'builtin:replaced' }, SessionId('deepseek-stale')))
      .rejects.toThrow(/incompatible with the installed runtime: artifactDigest/)
    lease.release()
    await ctx.fiber.dispose()
  })

  it('keeps a drained entry out of the snapshot when its disposer runs last', async () => {
    const ctx = new Context()
    const engines = new FreeCodeGoAgentEngineRegistry(ctx)
    const dispose = engines.register(definition('codex', 'sha256:codex-v1'))
    const lease = await engines.reserve('codex', SessionId('codex-drain'), planInput('codex', 'codex-auto'))
    engines.beginDrain('codex')
    lease.release()
    // The disposer runs after the last lease released, so `retire` puts the
    // entry back into `retiring` and the paired `removeWhenDrained` has to take
    // it out again: a row that survived here would be reported forever.
    await dispose()
    expect(engines.snapshot()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('reports live engine ids as a materialized snapshot', async () => {
    const ctx = new Context()
    const engines = new FreeCodeGoAgentEngineRegistry(ctx)
    engines.register(definition('deepseek', 'builtin:loop'))
    engines.register(definition('codex', 'sha256:codex-v1'))
    engines.beginDrain('codex')
    const live = engines.liveIds()
    expect(Array.isArray(live)).toBe(true)
    expect(live).toEqual(['deepseek'])
    await ctx.fiber.dispose()
  })
})
