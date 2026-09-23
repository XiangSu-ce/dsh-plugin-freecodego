import { describe, expect, it, vi } from 'vitest'
import { synchronizeSubagentModelRoutes } from '../src/subagent-model-routing.ts'

/** The entry id the sync reads and writes. */
const ENTRY = 'subagent-model-selection'

/**
 * A settings service shaped like the shipped one: `describe()` to read, a
 * revision-guarded `update()` to write.
 * @param value - the entry's current value.
 * @param revision - the revision `describe()` reports.
 * @returns the structural service, with `update` observable.
 */
function shippedSettings(value: unknown, revision = 1) {
  return {
    describe: () => [{ ns: ENTRY, value, revision }],
    update: vi.fn(async (_ns: string, patch: unknown) => { void patch }),
  }
}

describe('automatic Subagent model routing', () => {
  it('authorizes live text routes and preserves a temporarily failing provider', async () => {
    let current: unknown = {
      enabled: false,
      allowedModels: [{ provider: 'offline', model: 'last-known' }],
    }
    const settings = {
      describe: () => [{ ns: ENTRY, value: current, revision: 7 }],
      update: vi.fn(async (_namespace: string, patch: unknown) => { current = patch }),
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

    await expect(synchronizeSubagentModelRoutes(settings, llm)).resolves.toEqual([
      { provider: 'freecodego', model: 'hy3' },
      { provider: 'offline', model: 'last-known' },
    ])
    // The catalog is authoritative but the enabled flag belongs to the user:
    // a sync refreshes the routes and must never flip a user's opt-out. The
    // write carries the revision it read, so a concurrent settings edit loses
    // the race loudly instead of being clobbered.
    expect(settings.update).toHaveBeenCalledWith(ENTRY, {
      enabled: false,
      allowedModels: [
        { provider: 'freecodego', model: 'hy3' },
        { provider: 'offline', model: 'last-known' },
      ],
    }, 7)
  })

  it('does not rewrite an unchanged enabled catalog', async () => {
    const settings = shippedSettings({ enabled: true, allowedModels: [{ provider: 'freecodego', model: 'hy3' }] })
    const llm = {
      listProviders: () => [{ id: 'freecodego' }],
      listModels: async () => [{ id: 'hy3', inputModalities: ['text'] }],
    }

    await synchronizeSubagentModelRoutes(settings, llm)
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('reads the entry through describe(), never the removed get(ns)', async () => {
    // Harness 0.1.7 deleted `settings.get(ns)`. This module used to call it, the
    // call threw, and the caller's catch swallowed the throw, so no route was
    // ever authorized and nothing reported it. A service exposing only the old
    // method must therefore answer "no entry" without being asked for the value
    // through it — the throw below is what a regression would hit.
    const settings = {
      describe: () => [],
      update: vi.fn(),
      get: () => { throw new Error('settings.get is not a function') },
    }
    const llm = { listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm' }] }

    await expect(synchronizeSubagentModelRoutes(settings as never, llm)).resolves.toEqual([])
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('surfaces a rejected write so the caller can re-read and retry', async () => {
    // The revision guard rejects a write whose entry moved under it. Swallowing
    // that here would leave the routes stale until the next catalog event, which
    // is the silent-failure shape this module is being fixed out of.
    const settings = {
      describe: () => [{ ns: ENTRY, value: { enabled: true, allowedModels: [] }, revision: 1 }],
      update: vi.fn(async () => { throw new Error(`settings namespace "${ENTRY}" changed since it was read`) }),
    }
    const llm = { listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm', inputModalities: ['text'] }] }

    await expect(synchronizeSubagentModelRoutes(settings, llm)).rejects.toThrow('changed since it was read')
  })
})
