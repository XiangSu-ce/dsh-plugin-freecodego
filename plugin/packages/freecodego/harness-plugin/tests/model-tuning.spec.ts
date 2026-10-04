/**
 * The provider/model tuning surface's two halves: the snapshot the settings page
 * renders and the edits it writes back.
 *
 * These cases pin the properties that let one surface stand in for the Harness
 * Models page: every route the `llm` service knows is listed — live routes from
 * their adapter, configured-but-dormant routes from their own declaration — each
 * value carries the layer that answered it, and a write lands in the entry the
 * value already lives in (a `models` entry on a declared route, a
 * `modelOverrides` entry on a catalog route) rather than in a second copy.
 * Because the snapshot is what the page reads next, every write case asserts
 * through `readModelTuning` as well as through the recorded mutation.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_PRESETS, OFFERED_REASONING_LEVELS, readModelTuning, writeModelTuning } from '../src/model-tuning.ts'
import { contextBufferForWindow } from '../src/context-budget.ts'

/** The settings service as the module reads it, with the write recorded for assertions. */
interface SettingsStub {
  readonly describe: () => readonly { ns: string; value: unknown }[]
  readonly mutate: ReturnType<typeof vi.fn>
}

/** A settings service stub whose document is the given `llm-pi-ai` value. */
function settingsStub(value: unknown): SettingsStub {
  return {
    describe: () => [{ ns: 'llm-pi-ai', value }],
    mutate: vi.fn(async () => undefined),
  }
}

/** A context whose `get` answers only for the named services. */
function contextStub(services: Readonly<Record<string, unknown>>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** One route the `llm` stub serves, and what its adapter reports. */
interface StubRoute {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
  /** Resolved context window; absent means the adapter states none. */
  readonly contextWindow?: number
  /** Resolved output cap; absent means the profile named none. */
  readonly defaultMaxTokens?: number
  /** Resolved effort ids; absent means the model does not reason. */
  readonly efforts?: readonly string[]
}

/**
 * An `llm` directory stub.
 *
 * `defaultMaxTokens` is only ever reported for a profile that named its own
 * `maxTokens` — that is what makes the source label in the snapshot the same
 * layer the value came from — so the stub states it per route rather than
 * always, and the routes without one exercise the "unset" branch.
 */
function llmStub(input: {
  readonly routes?: readonly StubRoute[]
  readonly configurable?: readonly { readonly provider: string; readonly displayName: string }[]
}): unknown {
  const routes = input.routes ?? []
  return {
    listProviders: () => routes.map(route => ({ id: route.id, name: route.name })),
    listModels: async (provider: string) => (routes.find(route => route.id === provider)?.models ?? [])
      .map(model => ({ ...model, provider, inputModalities: [] })),
    resolveModelInfo: async (provider: string, model: string) => {
      const route = routes.find(candidate => candidate.id === provider)
      if (route === undefined || !route.models.some(entry => entry.id === model)) throw new Error('NO_ADAPTER')
      return {
        ...route.contextWindow === undefined ? {} : { context: { contextWindow: route.contextWindow } },
        ...route.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: route.defaultMaxTokens },
        ...route.efforts === undefined ? {} : { reasoning: { efforts: route.efforts.map(id => ({ id, name: id })) } },
      }
    },
    ...input.configurable === undefined ? {} : { listConfigurableProviders: () => input.configurable ?? [] },
  }
}

describe('model tuning snapshot', () => {
  it('reports the catalog answer for a live route and names the layer that answered', async () => {
    const settings = settingsStub({ providers: {} })
    const llm = llmStub({ routes: [{
      id: 'anthropic', name: 'Anthropic',
      models: [{ id: 'claude-x', name: 'Claude X' }],
      contextWindow: 200_000, efforts: ['low', 'high'],
    }] })
    const snapshot = await readModelTuning(contextStub({ settings, llm }))
    expect(snapshot.writable).toBe(true)
    expect(snapshot.providers).toEqual([{ provider: 'anthropic', providerName: 'Anthropic', modelCount: 1, live: true }])
    expect(snapshot.models).toEqual([expect.objectContaining({
      provider: 'anthropic',
      providerName: 'Anthropic',
      model: 'claude-x',
      name: 'Claude X',
      declared: false,
      contextWindow: { value: 200_000, source: 'catalog' },
      // The hint is the Host's own budget rule applied to this window, not a
      // number the browser could have derived for itself.
      compactionAt: 200_000 - contextBufferForWindow(200_000),
      // No `maxTokens` was named by the profile, so the adapter reports none:
      // the output cap is genuinely unset rather than defaulted to something.
      maxOutputTokens: { source: 'none' },
      reasoningLevels: ['low', 'high'],
      reasoningSource: 'catalog',
    })])
  })

  it('reports the entry a declared route already carries, and a catalog route override', async () => {
    const settings = settingsStub({ providers: {
      mine: { models: [{ id: 'm1', contextWindow: 270_000, maxTokens: 4_096, reasoningEfforts: { off: null, high: 'high' } }] },
      anthropic: { modelOverrides: { 'claude-x': { contextWindow: 1_000_000 } } },
    } })
    const llm = llmStub({ routes: [
      { id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }], efforts: ['low', 'high', 'max'] },
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }], contextWindow: 200_000 },
    ] })
    const snapshot = await readModelTuning(contextStub({ settings, llm }))
    const [mine, catalog] = snapshot.models
    expect(mine).toEqual(expect.objectContaining({
      declared: true,
      contextWindow: { value: 270_000, source: 'settings' },
      maxOutputTokens: { value: 4_096, source: 'settings' },
      // The entry's own dict wins over the adapter's wider ladder, so the
      // surface never silently widens a route its owner already answered for.
      reasoningLevels: ['off', 'high'],
      reasoningSource: 'settings',
    }))
    expect(catalog).toEqual(expect.objectContaining({
      declared: true,
      contextWindow: { value: 1_000_000, source: 'settings' },
    }))
  })

  it('reports a model its owner declared non-reasoning as reasoning-free', async () => {
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'm1', reasoningEfforts: false }] } } })
    const llm = llmStub({ routes: [{ id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }], efforts: ['low', 'high'] }] })
    const snapshot = await readModelTuning(contextStub({ settings, llm }))
    expect(snapshot.models[0]?.reasoningLevels).toBeUndefined()
    expect(snapshot.models[0]?.reasoningSource).toBe('settings')
  })

  it('lists a configured route no adapter serves yet, from its own declaration', async () => {
    const settings = settingsStub({ providers: {
      'my-gateway': { defaultContextWindow: 512_000, models: [{ id: 'gpt-x', name: 'GPT X' }] },
      dormant: {},
    } })
    const llm = llmStub({ configurable: [
      { provider: 'my-gateway', displayName: 'My Gateway' },
      // Nothing declared: the route still has to appear, because its
      // route-level defaults are settable before it activates.
      { provider: 'dormant', displayName: 'Dormant' },
    ] })
    const snapshot = await readModelTuning(contextStub({ settings, llm }))
    expect(snapshot.providers).toEqual([
      { provider: 'my-gateway', providerName: 'My Gateway', modelCount: 1, live: false, defaultContextWindow: 512_000 },
      { provider: 'dormant', providerName: 'Dormant', modelCount: 0, live: false },
    ])
    expect(snapshot.models).toEqual([expect.objectContaining({
      provider: 'my-gateway',
      model: 'gpt-x',
      declared: true,
      // The adapter cannot size a model it does not serve; the entry states no
      // window of its own, so the value is honestly "unset".
      contextWindow: { source: 'none' },
      reasoningSource: 'none',
    })])
  })

  it('offers the six escalation levels and the context presets the control renders', async () => {
    const settings = settingsStub({ providers: {} })
    const snapshot = await readModelTuning(contextStub({ settings, llm: llmStub({}) }))
    expect(snapshot.reasoningLevels).toEqual(OFFERED_REASONING_LEVELS)
    expect(snapshot.reasoningLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(snapshot.contextPresets).toEqual(CONTEXT_PRESETS)
    expect(snapshot.contextPresets).toContain(270_000)
    expect(snapshot.contextPresets).toContain(1_000_000)
  })

  it('names no compaction point for a model whose window is unknown', async () => {
    // The hint is the reason the control exists (raise the window, compact
    // later), so an unknown window must render as nothing rather than a guess.
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'm1' }] } } })
    const llm = llmStub({ routes: [{ id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }] }] })
    const snapshot = await readModelTuning(contextStub({ settings, llm }))
    expect(snapshot.models[0]?.contextWindow).toEqual({ source: 'none' })
    expect(snapshot.models[0]?.compactionAt).toBeUndefined()
  })

  it('degrades to a read-only, empty snapshot without a settings or llm service', async () => {
    const withoutSettings = await readModelTuning(contextStub({ llm: llmStub({}) }))
    expect(withoutSettings.writable).toBe(false)
    expect(withoutSettings.providers).toEqual([])
    const withoutLlm = await readModelTuning(contextStub({ settings: settingsStub({ providers: {} }) }))
    expect(withoutLlm.writable).toBe(true)
    expect(withoutLlm.models).toEqual([])
  })
})

describe('model tuning writes', () => {
  it('edits the entry a declared route already lives in', async () => {
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'm1' }, { id: 'm2' }] } } })
    const llm = llmStub({ routes: [{ id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }] })
    const ctx = contextStub({ settings, llm })
    await writeModelTuning(ctx, { provider: 'mine', model: 'm2', contextWindow: 512_000, reasoningLevels: ['off', 'low', 'high'] })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '1', 'contextWindow'], value: 512_000 },
      { op: 'set', path: ['providers', 'mine', 'models', '1', 'reasoningEfforts'], value: { off: null, low: 'low', high: 'high' } },
    ])
  })

  it('creates a modelOverrides entry for a catalog route instead of restating its models', async () => {
    const settings = settingsStub({ providers: { anthropic: { models: [{ id: 'hand-written' }] } } })
    const llm = llmStub({ routes: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] }] })
    await writeModelTuning(contextStub({ settings, llm }), { provider: 'anthropic', model: 'claude-x', contextWindow: 1_048_576 })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'anthropic', 'modelOverrides', 'claude-x', 'contextWindow'], value: 1_048_576 },
    ])
  })

  it('clears a field with an unset rather than writing a zero', async () => {
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'm1', contextWindow: 270_000 }] } } })
    const llm = llmStub({ routes: [{ id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }] }] })
    await writeModelTuning(contextStub({ settings, llm }), { provider: 'mine', model: 'm1', contextWindow: null, maxOutputTokens: null })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'unset', path: ['providers', 'mine', 'models', '0', 'contextWindow'] },
      { op: 'unset', path: ['providers', 'mine', 'models', '0', 'maxTokens'] },
    ])
  })

  it('declares a non-reasoning model as false, and a level ladder as its wire spellings', async () => {
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'm1' }, { id: 'm2' }] } } })
    const llm = llmStub({ routes: [{ id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }] })
    const ctx = contextStub({ settings, llm })
    await writeModelTuning(ctx, { provider: 'mine', model: 'm1', reasoningLevels: ['off'] })
    expect(settings.mutate).toHaveBeenLastCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '0', 'reasoningEfforts'], value: false },
    ])
    await writeModelTuning(ctx, { provider: 'mine', model: 'm2', reasoningLevels: null })
    expect(settings.mutate).toHaveBeenLastCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '1', 'reasoningEfforts'], value: false },
    ])
  })

  it('presets every model on a route, and its route-level reasoning default', async () => {
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'm1' }, { id: 'm2' }] } } })
    const llm = llmStub({ routes: [{ id: 'mine', name: 'My API', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }] })
    await writeModelTuning(contextStub({ settings, llm }), { provider: 'mine', applyToModels: true, contextWindow: 200_000, reasoning: 'high' })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '0', 'contextWindow'], value: 200_000 },
      { op: 'set', path: ['providers', 'mine', 'models', '1', 'contextWindow'], value: 200_000 },
      { op: 'set', path: ['providers', 'mine', 'reasoning'], value: 'high' },
    ])
  })

  it('reaches a dormant route’s declared models, so a preset survives activation', async () => {
    const settings = settingsStub({ providers: { 'my-gateway': { models: [{ id: 'gpt-x' }] } } })
    const llm = llmStub({ configurable: [{ provider: 'my-gateway', displayName: 'My Gateway' }] })
    await writeModelTuning(contextStub({ settings, llm }), { provider: 'my-gateway', model: 'gpt-x', contextWindow: 400_000 })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'my-gateway', 'models', '0', 'contextWindow'], value: 400_000 },
    ])
  })

  it('refuses to write without a settings service, and without naming a route', async () => {
    await expect(writeModelTuning(contextStub({}), { provider: 'mine', model: 'm1', contextWindow: 1 }))
      .rejects.toThrow('not writable')
    const settings = settingsStub({ providers: {} })
    await expect(writeModelTuning(contextStub({ settings, llm: llmStub({}) }), { provider: '  ', model: 'm1', contextWindow: 1 }))
      .rejects.toThrow('provider route is required')
    expect(settings.mutate).not.toHaveBeenCalled()
  })
})
