/**
 * Manual context control: the four claims that decide whether it works at all.
 *
 * 1. **The engine is found where the deployment mounts it.** The Web app disables
 *    the host-plane `compaction-basic` row and lets each session's preset mount one
 *    again behind an `isolate` realm — invisible to the Host. A lookup that only
 *    asks the Host answers "no engine is mounted" while `/compact` works in the
 *    same session, so the preset tier is the one this feature stands on.
 * 2. **The span the caller named is the span that gets replaced.** A boundary the
 *    caller half-specified is completed, never widened: reading an endpoint as
 *    unknown-unless-both-are-given discards what the caller asked for and takes
 *    more history than it named, which is the one direction of error that is not
 *    recoverable.
 * 3. **Nothing is reported as changed that the engine did not change.** A `null`
 *    from the engine, a refusal, and an absent engine are three different answers,
 *    and each is reported as itself.
 * 4. **The engine's expected refusals are answers; anything else is a failure.**
 *    `busy`/`changed`/`summary` are codes a caller can relay; an unrecognized throw
 *    is a bug, and a tool answer that swallowed it would hide it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/context-control
 */

import type { Context } from '@deepseek-ai/cordis'

import { describe, expect, test } from 'vitest'

import {
  ContextControl,
  contextControlToolDefinitions,
  keepRecentBoundary,
  type ContextControlAgent,
} from '../src/context-control.ts'

/** A host context holding exactly the services a test hands it. */
function hostContext(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** An agent whose scope holds exactly the services a test hands it. */
function agentWith(input: { readonly events?: readonly { readonly seq: number; readonly type: string }[]; readonly scope?: Record<string, unknown> } = {}): ContextControlAgent {
  const scope = input.scope ?? {}
  return {
    ctx: { get: (name: string) => scope[name] },
    session: { seq: 42, snapshotEvents: () => input.events ?? [] },
  }
}

/** A compaction engine that records what it was asked to replace. */
function engine(
  result: unknown = { compactionId: 'cmp_1' },
  options: { readonly fail?: unknown } = {},
): { readonly service: Record<string, unknown>; readonly calls: readonly { readonly method: string; readonly start?: number; readonly end?: number }[] } {
  const calls: { method: string; start?: number; end?: number }[] = []
  const throwIfAsked = (): void => {
    if (options.fail !== undefined) throw options.fail
  }
  return {
    calls,
    service: {
      compactNow: async (): Promise<unknown> => { calls.push({ method: 'compactNow' }); throwIfAsked(); return result },
      // The engine's arity is (start, end, agent, signal); only the span matters here.
      compactRegion: async (start: number, end: number): Promise<unknown> => { calls.push({ method: 'compactRegion', start, end }); throwIfAsked(); return result },
    },
  }
}

/** An agent whose preset realm holds this engine, as the Web app's sessions do. */
function presetHost(presetEngine: unknown, hostServices: Record<string, unknown> = {}): Context {
  return hostContext({ ...hostServices, agentPresets: { serviceFor: (_agent: unknown, name: string) => name === 'compaction' ? presetEngine : undefined } })
}

describe('finding the engine', () => {
  test('the session preset answers first, which is the tier the Web app needs', () => {
    const preset = engine()
    // The host composition has no engine of its own: its row is disabled, exactly
    // as the Web app's patch leaves it.
    const control = new ContextControl(presetHost(preset.service))
    expect(control.available(agentWith())).toStrictEqual({ ok: true, scope: 'preset' })
  })

  test('an agent-scoped engine answers next', () => {
    const scoped = engine()
    const control = new ContextControl(hostContext({}))
    expect(control.available(agentWith({ scope: { compaction: scoped.service } }))).toStrictEqual({ ok: true, scope: 'agent' })
  })

  test('a host-mounted engine answers last, for a composition the Web app does not build', () => {
    const mounted = engine()
    const control = new ContextControl(hostContext({ compaction: mounted.service }))
    expect(control.available(agentWith())).toStrictEqual({ ok: true, scope: 'host' })
  })

  test('the preset roster is only asked for an agent that has a scope of its own', () => {
    const preset = engine()
    const control = new ContextControl(presetHost(preset.service))
    const scopeLess: ContextControlAgent = { session: { snapshotEvents: () => [] } }
    const answer = control.available(scopeLess)
    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('no compaction engine is mounted')
  })

  test('a service that cannot both compact and snip is not an engine', () => {
    const control = new ContextControl(hostContext({ compaction: { compactNow: async () => ({}) } }))
    expect(control.available(agentWith()).ok).toBe(false)
  })

  test('a scope whose lookup throws is skipped rather than failing the call', () => {
    const mounted = engine()
    const control = new ContextControl(hostContext({ compaction: mounted.service }))
    const agent: ContextControlAgent = { ctx: { get: () => { throw new Error('this realm refused the read') } }, session: { snapshotEvents: () => [] } }
    expect(control.available(agent)).toStrictEqual({ ok: true, scope: 'host' })
  });

  test('no engine at all is an answer, and both calls give it instead of throwing', async () => {
    const control = new ContextControl(hostContext({}))
    const agent = agentWith()
    const reason = control.available(agent).reason ?? ''
    expect(reason).toContain('no compaction engine is mounted')
    await expect(control.compactNow(agent, new AbortController().signal)).resolves.toMatchObject({ action: 'compact', changed: false, detail: reason })
    await expect(control.snip(agent, {}, new AbortController().signal)).resolves.toMatchObject({ action: 'snip', changed: false, detail: reason })
  })
})

describe('compacting on request', () => {
  test('a compaction is reported with what it replaced', async () => {
    const preset = engine({ compactionId: 'cmp_7', shadowedRange: { start: 3, end: 9 }, shadowedSeqs: [3, 4, 5], shadowedTokenCount: 1200 })
    const control = new ContextControl(presetHost(preset.service))
    const result = await control.compactNow(agentWith(), new AbortController().signal)
    expect(result).toMatchObject({ action: 'compact', changed: true, scope: 'preset', compactionId: 'cmp_7', shadowedRange: { start: 3, end: 9 }, shadowedNodes: 3, shadowedTokens: 1200 })
    expect(result.detail).toContain('3 items')
    expect(result.detail).toContain('~1200 tokens')
    expect(preset.calls).toStrictEqual([{ method: 'compactNow' }])
  })

  test('an engine that replaced nothing is not reported as a change', async () => {
    const preset = engine(null)
    const control = new ContextControl(presetHost(preset.service))
    const result = await control.compactNow(agentWith(), new AbortController().signal)
    expect(result.changed).toBe(false)
    expect(result.detail).toContain('no span it could safely replace')
  })

  test('the engine\'s own refusal becomes the answer', async () => {
    const preset = engine({}, { fail: { code: 'busy' } })
    const control = new ContextControl(presetHost(preset.service))
    const result = await control.compactNow(agentWith(), new AbortController().signal)
    expect(result.changed).toBe(false)
    expect(result.detail).toContain('active compaction')
  })

  test('a cancellation is named as one before the engine is blamed', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const preset = engine({}, { fail: { code: 'cancelled' } })
    const control = new ContextControl(presetHost(preset.service))
    const result = await control.compactNow(agentWith(), cancelled.signal)
    expect(result.detail).toBe('the compact request was cancelled')
  })

  test('an error the engine did not name is a failure, not a sentence', async () => {
    const preset = engine({}, { fail: new Error('the engine broke') })
    const control = new ContextControl(presetHost(preset.service))
    await expect(control.compactNow(agentWith(), new AbortController().signal)).rejects.toThrow('the engine broke')
  })
})

describe('snipping a span', () => {
  test('an explicit span reaches the engine exactly as the caller gave it', async () => {
    const preset = engine({ compactionId: 'cmp_2', shadowedRange: { start: 4, end: 6 } })
    const control = new ContextControl(presetHost(preset.service))
    const result = await control.snip(agentWith(), { start: 4, end: 6 }, new AbortController().signal)
    expect(preset.calls).toStrictEqual([{ method: 'compactRegion', start: 4, end: 6 }])
    expect(result).toMatchObject({ action: 'snip', changed: true, scope: 'preset' })
  })

  test('a half-named span keeps the caller\'s end and derives only the other one', async () => {
    const preset = engine()
    const control = new ContextControl(presetHost(preset.service))
    // Surface positions 1..8: assistant messages at 2, 4, 6, 8. Keeping the newest
    // turn alone leaves 1..7 as the span the boundary derives.
    const agent = agentWith({
      events: [1, 2, 3, 4, 5, 6, 7, 8].map(seq => ({ seq, type: seq % 2 === 0 ? 'assistant/message' : 'tool/result' })),
    })
    await control.snip(agent, { start: 5 }, new AbortController().signal)
    expect(preset.calls).toStrictEqual([{ method: 'compactRegion', start: 5, end: 7 }])
    await control.snip(agent, { end: 3 }, new AbortController().signal)
    expect(preset.calls[1]).toStrictEqual({ method: 'compactRegion', start: 1, end: 3 })
  })

  test('keep_recent_turns moves the boundary and reaches the engine', async () => {
    const preset = engine()
    const control = new ContextControl(presetHost(preset.service))
    const agent = agentWith({
      events: [1, 2, 3, 4, 5, 6, 7, 8].map(seq => ({ seq, type: seq % 2 === 0 ? 'assistant/message' : 'tool/result' })),
    })
    await control.snip(agent, { keepRecentTurns: 3 }, new AbortController().signal)
    expect(preset.calls).toStrictEqual([{ method: 'compactRegion', start: 1, end: 3 }])
  })

  test('a tail with nothing before it is an answer, not a guess', async () => {
    const preset = engine()
    const control = new ContextControl(presetHost(preset.service))
    const agent = agentWith({ events: [{ seq: 1, type: 'assistant/message' }] })
    const result = await control.snip(agent, { keepRecentTurns: 1 }, new AbortController().signal)
    expect(result.changed).toBe(false)
    expect(result.detail).toBe('there is no earlier span to snip yet')
    expect(preset.calls).toStrictEqual([])
  })
})

describe('the boundary arithmetic', () => {
  test('tool results do not advance a kept turn', () => {
    const agent = agentWith({
      events: [
        { seq: 1, type: 'user/message' },
        { seq: 2, type: 'assistant/message' },
        { seq: 3, type: 'tool/result' },
        { seq: 4, type: 'tool/result' },
        { seq: 5, type: 'assistant/message' },
      ],
    })
    // One assistant turn kept: the span stops at the surface item before it, which
    // is the second tool result — not at the user message four items back.
    expect(keepRecentBoundary(agent, 1)).toStrictEqual({ start: 1, end: 4 })
  })

  test('a log with no assistant message has no boundary', () => {
    expect(keepRecentBoundary(agentWith({ events: [{ seq: 1, type: 'tool/result' }] }), 1)).toBeUndefined()
    expect(keepRecentBoundary(agentWith(), 1)).toBeUndefined()
  })
})

describe('the tool definitions', () => {
  test('both names are declared with an output schema the registry accepts', () => {
    const definitions = contextControlToolDefinitions(new ContextControl(hostContext({})))
    expect(definitions.map(definition => definition.name)).toStrictEqual(['engineering_context_compact', 'engineering_context_snip'])
    for (const definition of definitions) expect(definition.output.schema?.type).toBe('object')
    expect(definitions[0]?.parameters).toMatchObject({ type: 'object', additionalProperties: false })
  })

  test('a call with no agent is refused by name instead of doing nothing', async () => {
    const control = new ContextControl(hostContext({}))
    const [compact] = contextControlToolDefinitions(control)
    await expect((compact as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }).execute({}, {})).rejects.toThrow('needs an active agent')
    await expect((compact as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }).execute({}, { agent: { id: 'a1' } })).rejects.toThrow('needs an active agent')
  })

  test('a call drives the runtime with the agent and signal it was given', async () => {
    const preset = engine()
    const control = new ContextControl(presetHost(preset.service))
    const definitions = contextControlToolDefinitions(control)
    const snip = definitions[1] as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }
    const controller = new AbortController()
    const agent = agentWith({ events: [{ seq: 1, type: 'assistant/message' }, { seq: 2, type: 'assistant/message' }] })
    const result = await snip.execute({ keep_recent_turns: 1 }, { agent, signal: controller.signal })
    expect(result).toMatchObject({ action: 'snip', changed: true })
    expect(preset.calls).toStrictEqual([{ method: 'compactRegion', start: 1, end: 1 }])
  })
})
