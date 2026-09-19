import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_MAX_CHAIN_DEPTH,
  HookChainRuntime,
  MAX_CHAIN_DEPTH,
  MAX_COOLDOWN_ENTRIES,
  MAX_DEDUP_ENTRIES,
  MAX_GUARD_WINDOW_MS,
  inertHookChainConfig,
  normalizeHookChainConfig,
  type HookChainActionHandler,
} from '../src/hooks/hook-chains.ts'

/** One valid rule, with the fields a case wants to vary. */
function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'r1', actions: [{ kind: 'notify_team' }], ...overrides }
}

describe('hook chain config normalization', () => {
  it('defaults every guard when the document omits them', () => {
    const config = normalizeHookChainConfig({ rules: [rule()] })
    expect(config).toMatchObject({
      version: 1,
      enabled: true,
      maxChainDepth: DEFAULT_MAX_CHAIN_DEPTH,
      defaultCooldownMs: DEFAULT_COOLDOWN_MS,
      defaultDedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
    })
  })

  it('treats a missing document, a missing rules list, and an empty rules list as inert', () => {
    // Non-record input falls back to an empty document rather than throwing.
    expect(normalizeHookChainConfig(null).enabled).toBe(false)
    expect(normalizeHookChainConfig(null).rules).toEqual([])
    expect(normalizeHookChainConfig({ enabled: true }).enabled).toBe(false)
    // An empty ruleset is a valid file that is deliberately switched off, so the
    // feature can be checked in and enabled later without editing it.
    expect(normalizeHookChainConfig({ enabled: true, rules: [] }).enabled).toBe(false)
  })

  it('honours an explicit false and rejects a non-boolean switch', () => {
    expect(normalizeHookChainConfig({ enabled: false, rules: [rule()] }).enabled).toBe(false)
    expect(() => normalizeHookChainConfig({ enabled: 'yes', rules: [rule()] })).toThrow(/enabled must be a boolean/)
  })

  it('rejects a rules value that is not an array', () => {
    expect(() => normalizeHookChainConfig({ rules: 'nope' })).toThrow(/rules must be an array/)
  })

  it('rejects duplicate rule ids', () => {
    expect(() => normalizeHookChainConfig({ rules: [rule(), rule()] })).toThrow(/duplicate rule id: r1/)
  })

  it('clamps a guard window past its ceiling and keeps a valid floor', () => {
    const clamped = normalizeHookChainConfig({ rules: [rule()], maxChainDepth: 99 })
    expect(clamped.maxChainDepth).toBe(MAX_CHAIN_DEPTH)
    expect(normalizeHookChainConfig({ rules: [rule()], defaultCooldownMs: 12_345 }).defaultCooldownMs).toBe(12_345)
  })

  it('falls back for a non-number, a NaN, and a value below the floor', () => {
    expect(normalizeHookChainConfig({ rules: [rule()], maxChainDepth: 'two' }).maxChainDepth).toBe(DEFAULT_MAX_CHAIN_DEPTH)
    expect(normalizeHookChainConfig({ rules: [rule()], maxChainDepth: Number.NaN }).maxChainDepth).toBe(DEFAULT_MAX_CHAIN_DEPTH)
    expect(normalizeHookChainConfig({ rules: [rule()], maxChainDepth: -1 }).maxChainDepth).toBe(DEFAULT_MAX_CHAIN_DEPTH)
    // A fractional value floors rather than rounding, and the ceiling applies to
    // every window, not only the depth.
    expect(normalizeHookChainConfig({ rules: [rule()], maxChainDepth: 3.7 }).maxChainDepth).toBe(3)
    expect(normalizeHookChainConfig({ rules: [rule()], defaultDedupWindowMs: MAX_GUARD_WINDOW_MS * 4 }).defaultDedupWindowMs).toBe(MAX_GUARD_WINDOW_MS)
  })

  it('rejects a rule that is not an object, has no id, or has a blank id', () => {
    expect(() => normalizeHookChainConfig({ rules: ['nope'] })).toThrow(/rules\[0\] is not an object/)
    expect(() => normalizeHookChainConfig({ rules: [{}] })).toThrow(/rules\[0\]\.id must be a non-empty string/)
    expect(() => normalizeHookChainConfig({ rules: [{ id: '   ' }] })).toThrow(/rules\[0\]\.id must be a non-empty string/)
  })

  it('rejects a non-boolean per-rule switch and trims the id', () => {
    expect(() => normalizeHookChainConfig({ rules: [rule({ enabled: 1 })] })).toThrow(/rule r1 enabled must be a boolean/)
    expect(normalizeHookChainConfig({ rules: [rule({ id: '  spaced  ', enabled: true })] }).rules[0]!.id).toBe('spaced')
  })

  it('validates the event list', () => {
    expect(normalizeHookChainConfig({ rules: [rule({ events: ['PostToolUseFailure'] })] }).rules[0]!.events).toEqual(['PostToolUseFailure'])
    expect(() => normalizeHookChainConfig({ rules: [rule({ events: [] })] })).toThrow(/rule r1 events must not be empty/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ events: ['Nope'] })] })).toThrow(/unknown event: Nope/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ events: [7] })] })).toThrow(/events must be an array of non-empty strings/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ events: 'PostToolUseFailure' })] })).toThrow(/events must be an array of strings/)
  })

  it('validates the action list', () => {
    expect(() => normalizeHookChainConfig({ rules: [{ id: 'r1' }] })).toThrow(/rule r1 declares no actions/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: 'nope' })] })).toThrow(/rule r1 actions must be an array/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: [] })] })).toThrow(/rule r1 declares no actions/)
  })

  it('validates one action shape', () => {
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: ['nope'] })] })).toThrow(/has an action that is not an object/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: [{ kind: 'launch_missiles' }] })] })).toThrow(/unknown action kind: launch_missiles/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: [{ kind: 7 }] })] })).toThrow(/unknown action kind: 7/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: [{ kind: 'notify_team', target: 7 }] })] })).toThrow(/action\.target must be a string/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ actions: [{ kind: 'notify_team', message: 7 }] })] })).toThrow(/action\.message must be a string/)
    const kept = normalizeHookChainConfig({ rules: [rule({ actions: [{ kind: 'notify_team', target: '#ops', message: 'help' }] })] })
    expect(kept.rules[0]!.actions[0]).toEqual({ kind: 'notify_team', target: '#ops', message: 'help' })
  })

  it('validates the condition block', () => {
    const full = normalizeHookChainConfig({
      rules: [rule({ when: { toolNames: ['Bash'], taskStatuses: ['blocked'], outcomes: ['failed'] } })],
    })
    expect(full.rules[0]!.when).toEqual({ toolNames: ['Bash'], taskStatuses: ['blocked'], outcomes: ['failed'] })
    // An empty condition is dropped so the matcher short-circuits on undefined.
    expect(normalizeHookChainConfig({ rules: [rule({ when: {} })] }).rules[0]!.when).toBeUndefined()
    expect(() => normalizeHookChainConfig({ rules: [rule({ when: 'nope' })] })).toThrow(/rule\.when must be an object/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ when: { toolNames: 'Bash' } })] })).toThrow(/rule\.when\.toolNames must be an array of strings/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ when: { toolNames: [7] } })] })).toThrow(/rule\.when\.toolNames must be an array of non-empty strings/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ when: { taskStatuses: 'blocked' } })] })).toThrow(/rule\.when\.taskStatuses must be an array of strings/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ when: { outcomes: 'failed' } })] })).toThrow(/rule\.when\.outcomes must be an array/)
    expect(() => normalizeHookChainConfig({ rules: [rule({ when: { outcomes: ['maybe'] } })] })).toThrow(/unknown outcome: maybe/)
  })

  it('normalizes per-rule guard overrides', () => {
    const config = normalizeHookChainConfig({ rules: [rule({ cooldownMs: 5, dedupWindowMs: 7 })] })
    expect(config.rules[0]!.cooldownMs).toBe(5)
    expect(config.rules[0]!.dedupWindowMs).toBe(7)
    // A guard below the floor falls back rather than becoming zero.
    expect(normalizeHookChainConfig({ rules: [rule({ cooldownMs: -5 })] }).rules[0]!.cooldownMs).toBe(DEFAULT_COOLDOWN_MS)
  })

  it('exposes an inert config for the pre-configure state', () => {
    expect(inertHookChainConfig()).toEqual({
      version: 1,
      enabled: false,
      maxChainDepth: DEFAULT_MAX_CHAIN_DEPTH,
      defaultCooldownMs: DEFAULT_COOLDOWN_MS,
      defaultDedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
      rules: [],
    })
  })
})

describe('hook chain dispatch guards', () => {
  it('does nothing before a config is loaded', async () => {
    const runtime = new HookChainRuntime()
    expect(runtime.configuration.enabled).toBe(false)
    const result = await runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' })
    expect(result).toMatchObject({ enabled: false, blocked: 'disabled', chainDepth: 0, fired: [], suppressed: [], actions: [] })
  })

  it('blocks a chain that has already run to its depth cap', async () => {
    const handler = vi.fn<HookChainActionHandler>()
    const runtime = new HookChainRuntime({ notify_team: handler })
    runtime.configure({ rules: [rule()], maxChainDepth: 2 })
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', chainDepth: 2 })
    expect(result.blocked).toBe('depth')
    expect(handler).not.toHaveBeenCalled()
    // One level shallower still dispatches.
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', chainDepth: 1 })).blocked).toBeUndefined()
  })

  it('caps a chain whose own handler dispatches the next one, with no caller supplying a depth', async () => {
    // The production shape, and the reason the cap exists: the recovery action
    // fails the same way the original call did. `automation.ts` dispatches with
    // no `chainDepth` at all — it cannot see the chain it is inside — so a depth
    // that only a caller can supply is a depth that never arrives.
    const depths: number[] = []
    const blocked: (string | undefined)[] = []
    // The handler and the runtime refer to each other — the runtime runs the
    // handler, and the handler dispatches through the runtime — so it is built by
    // a factory that closes over itself. `created` is read only when a handler
    // runs, which is after the constructor has returned.
    const runtime = ((): HookChainRuntime => {
      const created = new HookChainRuntime({
        notify_team: async (_action, context) => {
          depths.push(context.chainDepth)
          // A bail-out, so a regression fails an assertion below instead of
          // recursing until the runner gives up.
          if (depths.length >= 3) return { skipped: 'the chain is not being capped' }
          blocked.push((await created.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' })).blocked)
          return undefined
        },
      })
      return created
    })()
    // Both windows are zeroed so this measures the depth cap and nothing else:
    // a cooldown would suppress the nested dispatch for the wrong reason and
    // make the cap look like it worked.
    runtime.configure({ rules: [rule()], maxChainDepth: 2, defaultCooldownMs: 0, defaultDedupWindowMs: 0 })
    const first = await runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' })
    expect(first.chainDepth).toBe(0)
    // Three levels asked for, two allowed: depth 0 was handled, its nested
    // dispatch arrived at depth 1 and was handled, and that handler's dispatch
    // was refused rather than becoming a third.
    expect(depths).toEqual([0, 1])
    // Innermost first: the handler at depth 1 records the refusal, then the
    // handler at depth 0 records the depth-1 dispatch that completed normally.
    expect(blocked).toEqual(['depth', undefined])
  })

  it('does not let concurrent dispatches inherit one another’s depth', async () => {
    // The reason the depth is carried in an async context rather than counted on
    // this runtime: a burst of independent failures arrives at once, and a counter
    // read by the third one while the second is mid-handler is the second one's
    // level. With a counter, the third was refused as too deep and fired nothing —
    // recovery stopping for the calls that needed it most, with no error anywhere.
    const runtime = new HookChainRuntime({ notify_team: async () => { await Promise.resolve() } })
    runtime.configure({ rules: [rule()], maxChainDepth: 2, defaultCooldownMs: 0, defaultDedupWindowMs: 0 })
    const burst = await Promise.all([
      runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' }),
      runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' }),
      runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' }),
    ])
    expect(burst.map(result => result.fired)).toEqual([['r1'], ['r1'], ['r1']])
    expect(burst.map(result => result.blocked)).toEqual([undefined, undefined, undefined])
    expect(burst.map(result => result.chainDepth)).toEqual([0, 0, 0])
  })

  it('a handler that throws leaves no depth behind for the next dispatch', async () => {
    // A depth left raised by one failed action would refuse later dispatches that
    // are not nested at all.
    const runtime = new HookChainRuntime({
      notify_team: () => { throw new Error('handler is broken') },
    })
    runtime.configure({ rules: [rule()], maxChainDepth: 2, defaultCooldownMs: 0, defaultDedupWindowMs: 0 })
    const failed = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })
    expect(failed.actions[0]).toMatchObject({ status: 'skipped', reason: 'handler is broken' })
    const next = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })
    expect(next.blocked).toBeUndefined()
    expect(next.chainDepth).toBe(0)
  })

  it('performs no action once the signal is aborted', async () => {
    const handler = vi.fn<HookChainActionHandler>()
    const runtime = new HookChainRuntime({ notify_team: handler })
    runtime.configure({ rules: [rule()] })
    const controller = new AbortController()
    controller.abort()
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', signal: controller.signal })
    expect(result.blocked).toBe('aborted')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('hook chain rule selection', () => {
  it('suppresses a disabled rule, a non-matching event, and a non-matching condition', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({
      rules: [
        rule({ id: 'off', enabled: false }),
        rule({ id: 'other-event', events: ['TaskCompleted'] }),
        rule({ id: 'other-tool', when: { toolNames: ['Bash'] } }),
        rule({ id: 'other-status', when: { taskStatuses: ['blocked'] } }),
        rule({ id: 'other-outcome', when: { outcomes: ['timeout'] } }),
      ],
    })
    const result = await runtime.dispatch({
      event: 'PostToolUseFailure',
      outcome: 'failed',
      toolName: 'Edit',
      taskStatus: 'failed',
      now: 1_000,
    })
    expect(result.fired).toEqual([])
    expect(result.suppressed).toEqual(['off', 'other-event', 'other-tool', 'other-status', 'other-outcome'])
  })

  it('treats an absent tool name and task status as the empty string when a condition names them', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({
      rules: [
        rule({ id: 'wants-tool', when: { toolNames: ['Bash'] } }),
        rule({ id: 'wants-status', when: { taskStatuses: ['blocked'] } }),
      ],
    })
    // Neither the tool nor the task status is supplied, so both conditions miss
    // rather than matching on `undefined`.
    const result = await runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed' })
    expect(result.suppressed).toEqual(['wants-tool', 'wants-status'])
  })

  it('fires a rule whose event and condition match', async () => {
    const seen: string[] = []
    const runtime = new HookChainRuntime({
      notify_team: (action) => {
        seen.push(`${action.target ?? 'none'}:${action.message ?? 'none'}`)
        return undefined
      },
    })
    runtime.configure({
      rules: [
        rule({ id: 'match', events: ['PostToolUseFailure'], when: { toolNames: ['Bash'], taskStatuses: ['failed'], outcomes: ['failed'] }, actions: [{ kind: 'notify_team', target: '#ops' }] }),
      ],
    })
    const result = await runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed', toolName: 'Bash', taskStatus: 'failed', now: 1_000 })
    expect(result.fired).toEqual(['match'])
    // An absent target and message reach the handler as absent, not as empty strings.
    expect(seen).toEqual(['#ops:none'])
  })

  it('fires a rule that matches every event and carries no condition', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules: [rule({ actions: [{ kind: 'notify_team' }] })] })
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'success' })
    expect(result.fired).toEqual(['r1'])
    expect(result.actions).toEqual([{ ruleId: 'r1', kind: 'notify_team', status: 'executed' }])
  })

  it('applies a per-rule cooldown and lets the rule fire once it expires', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules: [rule({ cooldownMs: 1_000 })] })
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_000 })).fired).toEqual(['r1'])
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_500 })).suppressed).toEqual(['r1'])
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 11_000 })).fired).toEqual(['r1'])
  })

  it('falls back to the document-level cooldown when a rule omits one', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules: [rule()], defaultCooldownMs: 1_000 })
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_000 })
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_100 })).suppressed).toEqual(['r1'])
    // A zero window never suppresses.
    runtime.configure({ rules: [rule()], defaultCooldownMs: 0 })
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 20_000 })).suppressed).toEqual([])
  })

  it('suppresses an identical action inside the dedup window and re-runs it after', async () => {
    const handler = vi.fn<HookChainActionHandler>(() => undefined)
    const runtime = new HookChainRuntime({ notify_team: handler })
    // Zero cooldown so the same rule reaches the dedup guard on the next dispatch.
    runtime.configure({ rules: [rule({ cooldownMs: 0, dedupWindowMs: 1_000, actions: [{ kind: 'notify_team', target: '#ops' }] })] })
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_000 })
    const duplicate = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_200 })
    expect(duplicate.actions).toEqual([{ ruleId: 'r1', kind: 'notify_team', status: 'skipped', reason: 'deduplicated' }])
    expect(handler).toHaveBeenCalledTimes(1)
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 11_000 })
    expect(handler).toHaveBeenCalledTimes(2)
    // A different event is a different signature and is not deduplicated.
    await runtime.dispatch({ event: 'PostToolUseFailure', outcome: 'failed', now: 11_100 })
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('falls back to the document-level dedup window when a rule omits one', async () => {
    const handler = vi.fn<HookChainActionHandler>(() => undefined)
    const runtime = new HookChainRuntime({ notify_team: handler })
    runtime.configure({ rules: [rule({ cooldownMs: 0 })], defaultDedupWindowMs: 1_000 })
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_000 })
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 10_100 })).actions[0]!.status).toBe('skipped')
    // A zero window never deduplicates.
    runtime.configure({ rules: [rule({ cooldownMs: 0 })], defaultDedupWindowMs: 0 })
    const runs = handler.mock.calls.length
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 20_000 })
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 20_000 })
    expect(handler.mock.calls.length).toBe(runs + 2)
  })
})

describe('hook chain action execution', () => {
  it('records a structured skip when no handler is registered for an action kind', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules: [rule({ actions: [{ kind: 'spawn_fallback_agent' }, { kind: 'warm_remote_capacity' }] })] })
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })
    expect(result.actions).toEqual([
      { ruleId: 'r1', kind: 'spawn_fallback_agent', status: 'skipped', reason: 'no handler is registered for this action' },
      { ruleId: 'r1', kind: 'warm_remote_capacity', status: 'skipped', reason: 'no handler is registered for this action' },
    ])
    expect(runtime.status().actionRuns).toBe(0)
    expect(runtime.status().actionSkips).toBe(2)
  })

  it('records a handler-declared skip with its own reason', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => ({ skipped: 'no team context is available' }) })
    runtime.configure({ rules: [rule()] })
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })
    expect(result.actions).toEqual([{ ruleId: 'r1', kind: 'notify_team', status: 'skipped', reason: 'no team context is available' }])
  })

  it('records a thrown Error as a skip and still runs the remaining actions', async () => {
    const runtime = new HookChainRuntime({
      notify_team: () => {
        throw new Error('mailbox is unavailable')
      },
      warm_remote_capacity: () => undefined,
    })
    runtime.configure({ rules: [rule({ actions: [{ kind: 'notify_team' }, { kind: 'warm_remote_capacity' }] })] })
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })
    expect(result.actions).toEqual([
      { ruleId: 'r1', kind: 'notify_team', status: 'skipped', reason: 'mailbox is unavailable' },
      { ruleId: 'r1', kind: 'warm_remote_capacity', status: 'executed' },
    ])
  })

  it('stringifies a non-Error throw', async () => {
    const runtime = new HookChainRuntime({
      notify_team: () => {
        // A handler that rejects with a bare value is a real failure mode of a
        // third-party hook; it must not take the whole dispatch down.
        throw 'plain failure'
      },
    })
    runtime.configure({ rules: [rule()] })
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })).actions[0]!.reason).toBe('plain failure')
  })

  it('awaits an asynchronous handler', async () => {
    const runtime = new HookChainRuntime({ notify_team: async () => undefined })
    runtime.configure({ rules: [rule()] })
    expect((await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed' })).actions[0]!.status).toBe('executed')
  })
})

describe('hook chain runtime state', () => {
  it('reports counters and guard occupancy through status()', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    expect(runtime.status()).toEqual({
      enabled: false,
      ruleCount: 0,
      maxChainDepth: DEFAULT_MAX_CHAIN_DEPTH,
      cooldownEntries: 0,
      dedupEntries: 0,
      dispatched: 0,
      actionRuns: 0,
      actionSkips: 0,
    })
    runtime.configure({ rules: [rule(), rule({ id: 'r2', actions: [{ kind: 'spawn_fallback_agent' }] })] })
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 1_000 })
    expect(runtime.status()).toMatchObject({ enabled: true, ruleCount: 2, cooldownEntries: 2, dedupEntries: 2, dispatched: 1, actionRuns: 1, actionSkips: 1 })
  })

  it('clears the guard windows on reset', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules: [rule()] })
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 1_000 })
    expect(runtime.status().cooldownEntries).toBe(1)
    runtime.resetGuards()
    expect(runtime.status()).toMatchObject({ cooldownEntries: 0, dedupEntries: 0 })
    // Counters are lifetime totals and survive a guard reset.
    expect(runtime.status().dispatched).toBe(1)
  })

  it('bounds the guard maps so a long-lived Host cannot leak', async () => {
    const rules = Array.from({ length: MAX_DEDUP_ENTRIES + 1 }, (_, index) => ({ id: `r${index}`, actions: [{ kind: 'notify_team' }] }))
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules })
    const result = await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 1_000 })
    expect(result.fired).toHaveLength(MAX_DEDUP_ENTRIES + 1)
    const status = runtime.status()
    expect(status.cooldownEntries).toBe(MAX_COOLDOWN_ENTRIES)
    expect(status.dedupEntries).toBe(MAX_DEDUP_ENTRIES)
  })

  it('replaces the active config and its guard state on reconfigure', async () => {
    const runtime = new HookChainRuntime({ notify_team: () => undefined })
    runtime.configure({ rules: [rule()] })
    expect(runtime.configuration.rules).toHaveLength(1)
    await runtime.dispatch({ event: 'TaskCompleted', outcome: 'failed', now: 1_000 })
    expect(runtime.status().cooldownEntries).toBe(1)
    runtime.configure({ rules: [] })
    expect(runtime.configuration.enabled).toBe(false)
    expect(runtime.status()).toMatchObject({ cooldownEntries: 0, dedupEntries: 0 })
    // A malformed document leaves the runtime inert, not holding the rules that
    // were configured before it: the caller reconfigures per workspace, so
    // keeping them would fire another repository's recovery rules here.
    runtime.configure({ rules: [rule()] })
    expect(() => runtime.configure({ rules: [rule(), rule()] })).toThrow(/duplicate rule id/)
    expect(runtime.configuration.rules).toEqual([])
    expect(runtime.configuration.enabled).toBe(false)
  })
})
