/**
 * The declaration `custom-api-reasoning.ts` writes for a user's own third-party
 * API routes.
 *
 * A custom endpoint's models are hand-declared, so nothing in `llm-pi-ai`'s
 * catalog says they can think and the picker offers no effort row. These cases
 * pin the three rules that make the fix safe to run on every settings change:
 * the four declared levels plus the provider default, an entry's own answer
 * wins, and a model the adapter already reports reasoning for is left alone.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { syncCustomApiReasoning } from '../src/custom-api-reasoning.ts'

/** The levels the module is expected to declare, in escalation order. */
const DECLARED = { off: null, low: 'low', medium: 'medium', high: 'high' }

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

describe('custom API reasoning sync', () => {
  it('declares the offered levels for a hand-declared model and a default for its provider', async () => {
    const settings = settingsStub({ providers: { mine: { baseURL: 'https://api.example/v1', models: [{ id: 'my-model', name: 'My Model' }] } } })
    const written = await syncCustomApiReasoning(contextStub({ settings }))
    expect(written).toBe(2)
    expect(settings.mutate).toHaveBeenCalledTimes(1)
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '0', 'reasoningEfforts'], value: DECLARED },
      // The provider default is the level that sends nothing, so a request that
      // picks no effort stays byte-for-byte what it was before the declaration.
      { op: 'set', path: ['providers', 'mine', 'reasoning'], value: 'off' },
    ])
  })

  it('never touches a model that states its own reasoning answer', async () => {
    // `false` is the user saying the model does not reason; a dict is them
    // spelling the levels out. Both are answers, and neither may be overwritten.
    const settings = settingsStub({ providers: { mine: { models: [
      { id: 'declared-false', reasoningEfforts: false },
      { id: 'declared-dict', reasoningEfforts: { off: null, high: 'high' } },
      { id: 'undecided' },
    ] } } })
    expect(await syncCustomApiReasoning(contextStub({ settings }))).toBe(2)
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '2', 'reasoningEfforts'], value: DECLARED },
      { op: 'set', path: ['providers', 'mine', 'reasoning'], value: 'off' },
    ])
  })

  it('leaves a model the adapter already reports reasoning for alone', async () => {
    // A hand-declared id that also exists in the installed catalog already
    // offers its own efforts; redeclaring them would narrow a model that works.
    const settings = settingsStub({ providers: { mine: { models: [{ id: 'catalog-model' }, { id: 'custom-model' }] } } })
    const llm = { resolveModelInfo: async (_provider: string, model: string) => model === 'catalog-model' ? { reasoning: { efforts: [{ id: 'high', name: 'High' }] } } : {} }
    expect(await syncCustomApiReasoning(contextStub({ settings, llm }))).toBe(2)
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '1', 'reasoningEfforts'], value: DECLARED },
      { op: 'set', path: ['providers', 'mine', 'reasoning'], value: 'off' },
    ])
  })

  it('keeps a provider default the user already chose', async () => {
    const settings = settingsStub({ providers: { mine: { reasoning: 'high', models: [{ id: 'my-model' }] } } })
    expect(await syncCustomApiReasoning(contextStub({ settings }))).toBe(1)
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'mine', 'models', '0', 'reasoningEfforts'], value: DECLARED },
    ])
  })

  it('writes nothing when every model has an answer, and nothing when the service is absent', async () => {
    // The no-op pass is what makes running on every settings change safe: the
    // module's own write emits another document update, and the next pass has
    // to find nothing to do rather than write the same ops forever.
    const settled = settingsStub({ providers: { mine: { models: [{ id: 'my-model', reasoningEfforts: false }] } } })
    expect(await syncCustomApiReasoning(contextStub({ settings: settled }))).toBe(0)
    expect(settled.mutate).not.toHaveBeenCalled()
    expect(await syncCustomApiReasoning(contextStub({}))).toBe(0)
    const noModels = settingsStub({ providers: { catalog: { modelOverrides: { 'gpt-4o': { name: 'GPT-4o' } } } } })
    expect(await syncCustomApiReasoning(contextStub({ settings: noModels }))).toBe(0)
    expect(noModels.mutate).not.toHaveBeenCalled()
  })
})
