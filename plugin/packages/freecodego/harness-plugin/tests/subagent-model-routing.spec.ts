import { describe, expect, it, vi } from 'vitest'
import { synchronizeSubagentModelRoutes } from '../src/subagent-model-routing.ts'

describe('automatic Subagent model routing', () => {
  it('authorizes live text routes and preserves a temporarily failing provider', async () => {
    let current: unknown = {
      enabled: false,
      allowedModels: [{ provider: 'offline', model: 'last-known' }],
    }
    const settings = {
      get: () => current,
      update: vi.fn(async (_namespace: unknown, patch: unknown) => { current = patch }),
    }
    const llm = {
      listProviders: () => [{ id: 'freecodego' }, { id: 'offline' }],
      listModels: async (provider: string) => {
        if (provider === 'offline') throw new Error('catalog unavailable')
        return [
          { id: 'hy3', inputModalities: ['text'] },
          { id: 'image-only', inputModalities: ['image'] },
          { id: 'needs-login', inputModalities: ['text'], availability: 'unavailable' },
          { id: 'hy3', inputModalities: ['text'] },
        ]
      },
    }

    await expect(synchronizeSubagentModelRoutes(settings as never, llm)).resolves.toEqual([
      { provider: 'freecodego', model: 'hy3' },
      { provider: 'offline', model: 'last-known' },
    ])
    // The catalog is authoritative but the enabled flag belongs to the user:
    // a sync refreshes the routes and must never flip a user's opt-out.
    expect(settings.update).toHaveBeenCalledWith('subagent-model-selection', {
      enabled: false,
      allowedModels: [
        { provider: 'freecodego', model: 'hy3' },
        { provider: 'offline', model: 'last-known' },
      ],
    })
  })

  it('does not rewrite an unchanged enabled catalog', async () => {
    const settings = {
      get: () => ({ enabled: true, allowedModels: [{ provider: 'freecodego', model: 'hy3' }] }),
      update: vi.fn(),
    }
    const llm = {
      listProviders: () => [{ id: 'freecodego' }],
      listModels: async () => [{ id: 'hy3', inputModalities: ['text'] }],
    }

    await synchronizeSubagentModelRoutes(settings, llm)
    expect(settings.update).not.toHaveBeenCalled()
  })
})
