/**
 * Group-pinned picker rows.
 *
 * The dialog's model list must show one row per (model, backend group) with
 * that group's own name and rate — and selecting a row must serve THAT group,
 * not the Host's cheapest pick. The pin travels inside the model id
 * (`id@group:N`); these tests pin down parsing, routing precedence, and the
 * picker-row expansion.
 */

import { describe, expect, it } from 'vitest'
import {
  GROUP_LOCKED_REASON,
  GROUP_PIN_PARAM,
  GROUP_UNAVAILABLE_REASON,
  expandGroupPinnedModels,
  isGroupRowSelectable,
  modelRowGroupBlock,
  parseGroupPin,
  withGroupPin,
} from '../src/model-catalog.ts'
import { routeForModelDetail, selectModelOptionChoice } from '../src/engine-remotes.ts'
import type { EngineRemotesHost } from '../src/engine-remotes.ts'

type Choice = {
  readonly enabled: boolean
  readonly routeKey: string
  readonly protocol?: string
  readonly zeroPrice?: boolean
  readonly rateMultiplier?: number
  readonly unlockRequired?: boolean
  readonly access?: string
  readonly locked?: boolean
  readonly groupId?: number
}

const choice = (over: Partial<Choice> & { readonly routeKey: string }): Choice => ({ enabled: true, ...over })

describe('group pin codec', () => {
  it('round-trips a model id with its group pin', () => {
    const pinned = withGroupPin('gpt-5.6', 42)
    expect(pinned).toBe('gpt-5.6@group:42')
    expect(parseGroupPin(pinned)).toEqual({ modelId: 'gpt-5.6', groupId: 42 })
  })

  it('leaves a plain model id unpinned', () => {
    expect(parseGroupPin('gpt-5.6')).toEqual({ modelId: 'gpt-5.6' })
    expect(parseGroupPin('gpt-5.6')).not.toHaveProperty('groupId')
  })

  it('does not confuse a model id that merely contains the marker', () => {
    // `@group:` must be the LAST segment; a display name with an @ keeps its id.
    expect(parseGroupPin('team@group:x')).toEqual({ modelId: 'team@group:x' })
    expect(parseGroupPin('a@group:1@group:2')).toEqual({ modelId: 'a@group:1', groupId: 2 })
  })

  it('exposes the marker so callers cannot diverge on the spelling', () => {
    expect(GROUP_PIN_PARAM).toBe('@group')
  })
})

describe('routeForModelDetail with a group pin', () => {
  const optionsHost = (options: readonly Choice[]): EngineRemotesHost => ({
    api: { getModelOptions: async () => [{ model: 'gpt-5.6', options }] },
  }) as unknown as EngineRemotesHost

  it('serves the pinned group instead of the cheapest one', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'free', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'paid', rateMultiplier: 2, groupId: 2 }),
    ]), withGroupPin('gpt-5.6', 2), 'token')).resolves.toEqual({ routeKey: 'paid', protocol: undefined })
  })

  it('serves the pinned group even when a free sibling exists', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'free', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'std', rateMultiplier: 1, groupId: 2 }),
    ]), withGroupPin('gpt-5.6', 2), 'token')).resolves.toEqual({ routeKey: 'std', protocol: undefined })
  })

  it('still prefers the speakable protocol inside the pinned group', async () => {
    // The pin names a group, not a wire: within that group, a protocol the
    // adapter can actually speak still wins over one it cannot.
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'gemini-only', protocol: 'gemini', rateMultiplier: 3, groupId: 2 }),
      choice({ routeKey: 'openai', protocol: 'openai_responses', rateMultiplier: 4, groupId: 2 }),
    ]), withGroupPin('gpt-5.6', 2), 'token')).resolves.toEqual({ routeKey: 'openai', protocol: 'openai_responses' })
  })

  it('fails loudly when the pinned group no longer exists', async () => {
    // Silently serving a cheaper group would bill the request at a rate the
    // user never selected; the picker should re-list usable groups instead.
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'free', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'paid', rateMultiplier: 2, groupId: 2 }),
    ]), withGroupPin('gpt-5.6', 99), 'token')).rejects.toThrow(/no enabled route/u)
  })

  it('fails loudly when the pinned group became locked', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'gone', unlockRequired: true, groupId: 1 }),
      choice({ routeKey: 'open', rateMultiplier: 1, groupId: 2 }),
    ]), withGroupPin('gpt-5.6', 1), 'token')).rejects.toThrow(/no enabled route/u)
  })

  it('fails loudly when the pinned group has no protocol the adapter can send', async () => {
    // The picker refuses this row for the same reason. Returning it here would
    // label a Gemini request as OpenAI and send a body the selected route cannot
    // decode.
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'gemini-only', protocol: 'gemini', groupId: 2 }),
      choice({ routeKey: 'openai-other-group', protocol: 'openai_responses', groupId: 3 }),
    ]), withGroupPin('gpt-5.6', 2), 'token')).rejects.toThrow(/no enabled route/u)
  })

  it('reports the bare model id in errors for a pinned selection', async () => {
    await expect(routeForModelDetail(optionsHost([]), withGroupPin('gpt-5.6', 3), 'token'))
      .rejects.toThrow(/gpt-5\.6(?!@group)/u)
  })

  it('keeps plain ids on the automatic pick', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'free', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'paid', rateMultiplier: 2, groupId: 2 }),
    ]), 'gpt-5.6', 'token')).resolves.toEqual({ routeKey: 'free', protocol: undefined })
  })
})

describe('routeForModelDetail and the backend default group', () => {
  const snapshotHost = (
    groups: readonly { readonly id: number; readonly default?: boolean }[],
    options: readonly Choice[],
  ): EngineRemotesHost => ({
    api: { getModelOptionsSnapshot: async () => ({ groups, models: [{ model: 'gpt-5.6', options }] }) },
  }) as unknown as EngineRemotesHost

  it('serves the group the backend declares as the account default', async () => {
    await expect(routeForModelDetail(snapshotHost(
      [{ id: 1 }, { id: 7, default: true }],
      [choice({ routeKey: 'first', rateMultiplier: 0.1, groupId: 1 }), choice({ routeKey: 'declared', rateMultiplier: 1, groupId: 7 })],
    ), 'gpt-5.6', 'token')).resolves.toEqual({ routeKey: 'declared', protocol: undefined })
  })

  it('lets a pin outrank the backend default', async () => {
    await expect(routeForModelDetail(snapshotHost(
      [{ id: 7, default: true }],
      [choice({ routeKey: 'declared', groupId: 7 }), choice({ routeKey: 'picked', groupId: 3 })],
    ), withGroupPin('gpt-5.6', 3), 'token')).resolves.toEqual({ routeKey: 'picked', protocol: undefined })
  })

  it('routes from the model list alone when the Host has no snapshot method', async () => {
    // Older Host builds expose only `getModelOptions`; the default marker is
    // simply not available to them, and routing must not fail over that.
    const legacyHost = {
      api: { getModelOptions: async () => [{ model: 'gpt-5.6', options: [choice({ routeKey: 'only', groupId: 3 })] }] },
    } as unknown as EngineRemotesHost
    await expect(routeForModelDetail(legacyHost, 'gpt-5.6', 'token')).resolves.toEqual({ routeKey: 'only', protocol: undefined })
  })
})

describe('selectModelOptionChoice preferredGroupId', () => {
  it('returns nothing when the pin names no choice at all', () => {
    // No choice carries group 7, so the pin is unsatisfiable — and unlike a
    // stale route-key pin, it must not fall back to an automatic pick.
    expect(selectModelOptionChoice([
      choice({ routeKey: 'a', groupId: 1 }),
    ], undefined, undefined, 7)).toBeUndefined()
  })

  it('resolves a pin that names an enabled choice in any input order', () => {
    const choices = [
      choice({ routeKey: 'b', rateMultiplier: 2, groupId: 2 }),
      choice({ routeKey: 'a', zeroPrice: true, groupId: 1 }),
    ]
    expect(selectModelOptionChoice(choices, undefined, undefined, 2)?.routeKey).toBe('b')
    expect(selectModelOptionChoice([...choices].reverse(), undefined, undefined, 2)?.routeKey).toBe('b')
  })
})

describe('isGroupRowSelectable', () => {
  it('accepts each supported protocol spelling', () => {
    for (const protocol of ['openai_responses', 'openai_chat_completions', 'anthropic', 'openai', 'responses', 'chat', 'chat-completions', '']) {
      expect(isGroupRowSelectable({ protocol }), JSON.stringify(protocol)).toBe(true)
    }
  })

  it('rejects disabled, locked, and unwired rows', () => {
    expect(isGroupRowSelectable({ enabled: false })).toBe(false)
    expect(isGroupRowSelectable({ locked: true })).toBe(false)
    expect(isGroupRowSelectable({ protocol: 'gemini' })).toBe(false)
  })
})

describe('expandGroupPinnedModels', () => {
  const base = {
    displayName: 'GPT 5.6',
    availability: 'available' as const,
    inputModalities: ['text'] as const,
  }

  it('emits one pinned row per usable group with that group label and rate', () => {
    const rows = expandGroupPinnedModels(
      [{ ...base, id: 'gpt-5.6' }],
      [{
        model: 'gpt-5.6',
        options: [
          { groupId: 1, routeKey: 'free', enabled: true, zeroPrice: true, locked: false, groupName: '后端分组甲' },
          { groupId: 2, routeKey: 'paid', enabled: true, zeroPrice: false, locked: false, rateMultiplier: 0.5, groupName: '后端分组乙' },
        ],
      }],
    )
    expect(rows.map(row => row.id)).toEqual([withGroupPin('gpt-5.6', 1), withGroupPin('gpt-5.6', 2)])
    expect(rows[0]).toMatchObject({ __groupPin: 1, __groupLabel: '后端分组甲', __groupRate: 0 })
    expect(rows[1]).toMatchObject({ __groupPin: 2, __groupLabel: '后端分组乙', __groupRate: 0.5 })
  })

  it('lists every published group, marking the ones the account cannot use', () => {
    const rows = expandGroupPinnedModels(
      [{ ...base, id: 'gpt-5.6' }],
      [{
        model: 'gpt-5.6',
        options: [
          { groupId: 1, routeKey: 'locked', enabled: true, zeroPrice: true, locked: true, groupName: '后端分组·受限' },
          { groupId: 2, routeKey: 'wire', enabled: true, zeroPrice: false, locked: false, protocol: 'gemini', groupName: '无线路' },
          { groupId: 3, routeKey: 'open', enabled: true, zeroPrice: false, locked: false, rateMultiplier: 1, groupName: '后端分组丙' },
        ],
      }],
    )
    // A group that silently disappears is indistinguishable from one the
    // backend never sold, so the row stays and carries the reason instead.
    expect(rows.map(row => row.__groupPin)).toEqual([1, 2, 3])
    expect(rows[0]).toMatchObject({ id: withGroupPin('gpt-5.6', 1), __groupUnavailable: GROUP_LOCKED_REASON })
    expect(rows[1]).toMatchObject({ id: withGroupPin('gpt-5.6', 2), __groupUnavailable: GROUP_UNAVAILABLE_REASON })
    expect(rows[2]).not.toHaveProperty('__groupUnavailable')
  })

  it('keeps the group structure visible for a signed-out account', () => {
    const rows = expandGroupPinnedModels(
      [{ ...base, id: 'gpt-5.6', availability: 'unavailable', unavailableReason: 'FREECODEGO_LOGIN_REQUIRED' }],
      [{
        model: 'gpt-5.6',
        options: [{ groupId: 1, routeKey: 'locked', enabled: true, zeroPrice: true, locked: true, groupName: '后端分组·受限' }],
      }],
    )
    // The row still names its group (the structure is what the picker is for),
    // and the reason stays the model's own: signing in comes before any group.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(withGroupPin('gpt-5.6', 1))
    expect(rows[0]!.unavailableReason).toBe('FREECODEGO_LOGIN_REQUIRED')
    expect(modelRowGroupBlock(rows[0]!)).toBeUndefined()
  })

  it('reports the group reason only while the model itself is usable', () => {
    expect(modelRowGroupBlock({ ...base, id: 'gpt-5.6', __groupPin: 1, __groupUnavailable: GROUP_LOCKED_REASON })).toBe(GROUP_LOCKED_REASON)
    expect(modelRowGroupBlock({ ...base, id: 'gpt-5.6', __groupPin: 1 })).toBeUndefined()
    expect(modelRowGroupBlock({ ...base, id: 'gpt-5.6', availability: 'unavailable', unavailableReason: 'FREECODEGO_LOGIN_REQUIRED', __groupPin: 1, __groupUnavailable: GROUP_LOCKED_REASON })).toBeUndefined()
  })

  it('keeps the unpinned row for a model the backend never grouped', () => {
    const rows = expandGroupPinnedModels([{ ...base, id: 'legacy-model' }], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('legacy-model')
    expect(rows[0]).not.toHaveProperty('__groupPin')
  })

  it('deduplicates repeated group options for the same model', () => {
    const rows = expandGroupPinnedModels(
      [{ ...base, id: 'gpt-5.6' }],
      [{
        model: 'gpt-5.6',
        options: [
          { groupId: 1, routeKey: 'free', enabled: true, zeroPrice: true, locked: false, groupName: '后端分组甲' },
          { groupId: 1, routeKey: 'free', enabled: true, zeroPrice: true, locked: false, groupName: '后端分组甲' },
        ],
      }],
    )
    expect(rows).toHaveLength(1)
  })
})
