/**
 * The fifteen seams, wired.
 *
 * Two classes of assertion live here, and they are different in kind.
 *
 * The first is **coverage**: every hook event the contract defines has a seam on
 * the host, and the two lists are compared rather than eyeballed. A hook event
 * that parses, matches, and is never dispatched is the failure this catches, and
 * nothing else would: the config loads, no error is raised, and the hook simply
 * never runs.
 *
 * The second is **what a seam is allowed to do**, asserted as the decision it
 * returns: the two seams that can refuse must refuse, and the thirteen that
 * cannot must pass the host's own decision through untouched.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { FreeCodeGoHookRuntime, type HookRecord } from '../src/hooks/runtime.ts'
import { installHookSeams, sessionStartSource, type HookSeamHost } from '../src/hooks/seams.ts'
import { HOOK_EVENTS, type HookDocument, type HookInvocation } from '../src/hooks/surface.ts'

/** A host that keeps its listeners, so a test can call the one it means. */
function host(): { host: HookSeamHost; listeners: Map<string, readonly ((...args: never[]) => unknown)[]> } {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  return {
    listeners,
    host: {
      on(event, handler) {
        const bucket = listeners.get(event) ?? []
        bucket.push(handler)
        listeners.set(event, bucket)
        return () => undefined
      },
    },
  }
}

/** A document declaring one command hook for an event. */
function document(event: string, body: Record<string, unknown>): HookDocument {
  return { source: 'project', path: '/w/.claude/settings.json', value: { hooks: { [event]: [{ hooks: [{ type: 'command', command: 'check', ...body }] }] } } }
}

/** A runtime whose handlers all answer with the same JSON blob. */
function runtime(outputs: Record<string, string>, documents: readonly HookDocument[], records: HookRecord[] = []): FreeCodeGoHookRuntime {
  let index = 0
  return new FreeCodeGoHookRuntime({
    documents: async () => documents,
    run: async (handler): Promise<HookInvocation> => {
      const scripted = outputs[handler.command]
      if (scripted === undefined) return { exitCode: 0, stdout: '', stderr: '' }
      index += 1
      return { exitCode: 0, stdout: scripted, stderr: '' }
    },
    record: (entry) => { if (entry.phase === 'result') records.push(entry) },
  })
}

describe('coverage: every event has a seam', () => {
  test('the installed seams are exactly the events the contract defines', () => {
    const { host: h, listeners } = host()
    const installed = installHookSeams(h, { runtime: runtime({}, []), record: () => undefined })
    expect([...installed]).toEqual([...HOOK_EVENTS])
    // And the host really got a listener for each mapped host event, so the list
    // is not just a constant being returned.
    const hostEvents = new Set(listeners.keys())
    for (const event of ['agent/created', 'agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'approval/request', 'agent/turn-stopping', 'agent/request-error', 'agent/status', 'subagent/start', 'subagent/end', 'session/event', 'session/disposed']) {
      expect(hostEvents.has(event), `${event} must have a listener`).toBe(true)
    }
  })

  test('the contract has fifteen events', () => {
    expect(HOOK_EVENTS).toHaveLength(15)
  })
})

describe('PreToolUse: the one tool seam that can refuse', () => {
  const setup = (stdout: string): { listeners: Map<string, readonly ((...args: never[]) => unknown)[]>; records: HookRecord[] } => {
    const { host: h, listeners } = host()
    const records: HookRecord[] = []
    installHookSeams(h, {
      runtime: runtime({ check: stdout }, [document('PreToolUse', { matcher: 'Bash' })]),
      record: entry => records.push(entry.phase === 'result' ? entry : entry),
    })
    return { listeners, records }
  }

  const preTool = (listeners: Map<string, readonly ((...args: never[]) => unknown)[]>, exec: unknown, next: () => Promise<unknown>): Promise<unknown> =>
    (listeners.get('tools/pre-execute')![0] as unknown as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(exec, next)

  test('a deny becomes a refusal, with the hook\'s own reason', async () => {
    const { listeners, records } = setup('{"decision":"deny","reason":"do not touch prod"}')
    const decision = await preTool(listeners, { name: 'bash', arguments: { command: 'rm -rf /' } }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'deny', reason: 'do not touch prod' })
    // The record names the tool and the reason, so the user can find out why.
    expect(records.at(-1)).toMatchObject({ event: 'PreToolUse', status: 'denied', message: 'do not touch prod' })
  })

  test('an ask is routed to the host approval path rather than answered here', async () => {
    const { listeners } = setup('{"permissionDecision":"ask","reason":"confirm"}')
    const decision = await preTool(listeners, { name: 'bash', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'ask', reason: 'confirm' })
  })

  test('the alias table matches a Claude-style tool name', async () => {
    // The matcher says `Bash`; the host calls the tool `bash`. Matching only the
    // exact spelling is how a migrated hook silently stops firing.
    const { listeners } = setup('{"decision":"deny","reason":"no"}')
    const decision = await preTool(listeners, { name: 'bash', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'deny', reason: 'no' })
  })

  test('no decision at all passes the host\'s own decision through', async () => {
    const { listeners } = setup('{}')
    const decision = await preTool(listeners, { name: 'bash', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  test('a hook that is not selected costs nothing and changes nothing', async () => {
    const { host: h, listeners } = host()
    installHookSeams(h, { runtime: runtime({ check: '{"decision":"deny"}' }, [document('PreToolUse', { matcher: 'Read' })]), record: () => undefined })
    const decision = await preTool(listeners, { name: 'bash', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  test('a hook that hangs does not block the call', async () => {
    // fail open, at the seam: a timeout is a status, not a refusal.
    const { host: h, listeners } = host()
    installHookSeams(h, {
      runtime: new FreeCodeGoHookRuntime({
        documents: async () => [document('PreToolUse', {})],
        run: async () => { throw Object.assign(new Error('timed out'), { name: 'AbortError' }) },
      }),
      record: () => undefined,
    })
    const decision = await preTool(listeners, { name: 'bash', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  test('a hook that asks to rewrite the input is refused loudly, not ignored', async () => {
    const { host: h, listeners } = host()
    installHookSeams(h, {
      runtime: runtime({ check: '{"updatedInput":{"command":"masked"}}' }, [document('PreToolUse', {})]),
      record: () => undefined,
    })
    const decision = await preTool(listeners, { name: 'bash', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(String((decision as { reason?: string }).reason)).toContain('does not support PreToolUse input rewriting')
  })
})

describe('PostToolUse: after the seam\'s other listeners, by design', () => {
  test('the host result is asked for first, then the hook may replace it', async () => {
    const { host: h, listeners } = host()
    const order: string[] = []
    installHookSeams(h, {
      runtime: runtime({ check: '{"replacement":"shaped by the hook"}' }, [document('PostToolUse', {})]),
      record: () => undefined,
    })
    const post = listeners.get('tools/post-execute')![0] as unknown as (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>
    const decision = await post({ name: 'bash', arguments: {} }, { value: 'raw' }, async () => {
      order.push('next')
      return { kind: 'accept' }
    })
    expect(order).toEqual(['next'])
    expect(decision).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'shaped by the hook' }] })
  })

  test('a failure result is dispatched as PostToolUseFailure and never replaces content', async () => {
    const { host: h, listeners } = host()
    const seen: string[] = []
    const runtime = new FreeCodeGoHookRuntime({
      documents: async () => [document('PostToolUseFailure', {}), document('PostToolUse', {})],
      run: async (handler) => {
        seen.push(handler.event)
        return { exitCode: 0, stdout: '{"replacement":"nope"}', stderr: '' }
      },
    })
    installHookSeams(h, { runtime, record: () => undefined })
    const post = listeners.get('tools/post-execute')![0] as unknown as (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>
    const decision = await post({ name: 'bash', arguments: {} }, { isError: true }, async () => ({ kind: 'accept' }))
    expect(seen).toEqual(['PostToolUseFailure'])
    // The failure's own output is what the model must see; a hook may not replace
    // the evidence that something broke.
    expect(decision).toEqual({ kind: 'accept' })
  })

  test('the hook seam is registered before the compressor it composes with', () => {
    // The property "the user's rule wins" is a registration order, not a line of
    // code in either module: cordis composes a waterfall first-registered-outermost
    // and the outermost listener's return value is the result, so the seam that
    // awaits `next()` and then merges is only the decider while it is registered
    // first. Both calls sit in one constructor, 700 lines apart, and the isolated
    // host above cannot see the real composition — moving `headroom.start()` above
    // `registerHookRuntime` would hand the last word to the compressor with every
    // behavioural test still green. Read from the source, the way
    // `plan-mode-coverage.spec.ts` reads its own.
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    const hooks = source.indexOf('this.registerHookRuntime(ctx)')
    const headroom = source.indexOf('this.headroom.start()')
    expect(hooks, 'registerHookRuntime(ctx) is missing from index.ts').toBeGreaterThan(-1)
    expect(headroom, 'this.headroom.start() is missing from index.ts').toBeGreaterThan(-1)
    expect(hooks, 'the hook seam must be registered before the compressor, or the compressor decides what the model sees').toBeLessThan(headroom)
  })

  test('an unselected hook leaves the host decision exactly as it was', async () => {
    const { host: h, listeners } = host()
    installHookSeams(h, { runtime: runtime({}, []), record: () => undefined })
    const post = listeners.get('tools/post-execute')![0] as unknown as (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>
    const base = { kind: 'accept', content: [{ type: 'text', text: 'compressed by headroom' }] }
    const decision = await post({ name: 'read', arguments: {} }, { value: 'x' }, async () => base)
    expect(decision).toBe(base)
  })
})

describe('UserPromptSubmit: observed, and responsible only for its own refusal', () => {
  const submit = (listeners: Map<string, readonly ((...args: never[]) => unknown)[]>, payload: unknown, next: () => Promise<unknown>): Promise<unknown> =>
    (listeners.get('agent/pre-step')![0] as unknown as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>)(payload, next)

  test('a denial rejects the prompt, so it never enters the history', async () => {
    const { host: h, listeners } = host()
    installHookSeams(h, { runtime: runtime({ check: '{"decision":"deny","reason":"off topic"}' }, [document('UserPromptSubmit', {})]), record: () => undefined })
    expect(await submit(listeners, { messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, async () => ({ kind: 'enter' }))).toEqual({ kind: 'reject' })
  })

  test('no hook leaves the host\'s own decision untouched', async () => {
    // The seam is shared: a plugin that returned `enter` here would be overriding
    // whatever else decided the step.
    const { host: h, listeners } = host()
    installHookSeams(h, { runtime: runtime({}, []), record: () => undefined })
    const base = { kind: 'enter', messages: [] }
    expect(await submit(listeners, {}, async () => base)).toBe(base)
  })
})

describe('Stop: the one seam that continues a turn', () => {
  test('a blocking Stop hook steers the agent with the hook\'s words', async () => {
    const { host: h, listeners } = host()
    const steered: unknown[] = []
    installHookSeams(h, { runtime: runtime({ check: '{"decision":"deny","reason":"tests have not run"}' }, [document('Stop', {})]), record: () => undefined })
    const stopping = listeners.get('agent/turn-stopping')![0] as unknown as (p: unknown) => Promise<void>
    await stopping({ agent: { steer: (message: unknown) => { steered.push(message) } }, turn: 3 })
    expect(steered).toHaveLength(1)
    type Steered = {
      readonly id?: unknown
      readonly role?: unknown
      readonly source?: { readonly kind?: unknown }
      readonly content: readonly { readonly text: string }[]
    }
    const message = steered[0] as Steered
    expect(message.content[0]?.text).toBe('tests have not run')
    // A real inbox message, not a bare object: `steer` splices what it is given
    // straight into the inbox, so an object without an id or a source would be
    // a shape nothing else in the process produces.
    expect(typeof message.id).toBe('string')
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'freecodego-hooks' })
  })

  test('steers through the agent as the receiver, not as a bare function', async () => {
    // The real `Agent.steer` is a prototype method whose body is
    // `this.send(input, 'next-step', true)`
    // (packages/core/agent-loop/src/agent.ts). Reading it off the payload and
    // calling it bare therefore threw `Cannot read properties of undefined
    // (reading 'send')`, and the `catch` around the call — whose job is to
    // tolerate an agent that was disposed between the event and the call —
    // swallowed it. Nothing in the record said so, and the one event whose whole
    // purpose is to continue a turn could never continue one.
    //
    // The test above could not see it: its `steer` is an object-literal arrow,
    // which needs no receiver, so the fake agreed with the broken call. The
    // double has to carry the real shape — a method on a prototype — or it
    // tests the fake's contract instead of the agent's.
    class SteeringAgent {
      readonly sent: unknown[] = []
      steer(message: unknown): void { this.sent.push(message) }
    }
    const agent = new SteeringAgent()
    const { host: h, listeners } = host()
    installHookSeams(h, { runtime: runtime({ check: '{"decision":"deny","reason":"keep going"}' }, [document('Stop', {})]), record: () => undefined })
    await (listeners.get('agent/turn-stopping')![0] as unknown as (p: unknown) => Promise<void>)({ agent, turn: 1 })
    expect(agent.sent).toHaveLength(1)
  })

  test('a Stop hook with nothing to say leaves the turn to close', async () => {
    const { host: h, listeners } = host()
    const steered: unknown[] = []
    installHookSeams(h, { runtime: runtime({}, []), record: () => undefined })
    await (listeners.get('agent/turn-stopping')![0] as unknown as (p: unknown) => Promise<void>)({ agent: { steer: (m: unknown) => steered.push(m) }, turn: 1 })
    expect(steered).toHaveLength(0)
  })
})

describe('the observing seams', () => {
  test('SessionStart tells a fresh session from a resumed, cleared or compacted one', () => {
    // The source lives on the payload, which is where `agent/created` declares
    // it: reading it off the session header reported every one of these as a
    // fresh start, and a hook matching `resume` could never fire.
    expect(sessionStartSource({ agent: {}, source: 'startup' })).toBe('startup')
    expect(sessionStartSource({ agent: {}, source: 'resume' })).toBe('resume')
    expect(sessionStartSource({ agent: {}, source: 'clear' })).toBe('clear')
    expect(sessionStartSource({ agent: {}, source: 'compact' })).toBe('compact')
    // A payload that names no source still has to produce a subject a matcher
    // can be tested against, and the only honest default is the fresh start.
    expect(sessionStartSource({ agent: {} })).toBe('startup')
    expect(sessionStartSource({ agent: {}, source: 'something-new' })).toBe('startup')
  })

  test('the SessionStart payload carries the source the matcher tests', async () => {
    const { host: h, listeners } = host()
    const payloads: unknown[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SessionStart', {})],
      run: async (_handler, payload) => { payloads.push(payload); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const created = listeners.get('agent/created')![0] as unknown as (p: unknown) => Promise<void>
    await created({ agent: { session: { id: 's1', header: { cwd: '/w' } } }, source: 'resume' })
    await hooks.settled()
    expect(payloads).toHaveLength(1)
    expect((payloads[0] as { readonly subject?: unknown }).subject).toBe('resume')
  })

  test('the compaction seams fire on their own session events and not on others', async () => {
    const { host: h, listeners } = host()
    const seen: string[] = []
    const subjects: unknown[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('PreCompact', {}), document('PostCompact', {})],
      run: async (handler, payload) => { seen.push(handler.event); subjects.push((payload as { readonly subject?: unknown }).subject); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const onSessionEvent = listeners.get('session/event')!
    const call = async (type: string, data: unknown = {}): Promise<void> => {
      for (const listener of onSessionEvent) await (listener as unknown as (s: unknown, e: unknown) => Promise<void>)({ id: 's1' }, { type, data })
    }
    await call('plan/mode')
    expect(seen).toEqual([])
    await call('compaction/start', { compactionId: 'c1', sourceCommandId: 'cmd-1', turn: 3 })
    await call('compaction/end', { compactionId: 'c1', turn: 3 })
    // The observing seams do not hold the host open, so the test waits for them
    // the way the disposal path does.
    await hooks.settled()
    expect(seen).toEqual(['PreCompact', 'PostCompact'])
    // The subject is the distinction the host payload carries — `sourceCommandId`,
    // present when a command asked for the compaction — and not the `reason` /
    // `trigger` fields that event has never had. Reading those produced `'auto'` for
    // every compaction, so a `manual` matcher parsed, matched nothing, and left
    // nothing in the record to say why.
    expect(subjects).toEqual(['manual', 'auto'])
  })

  test('SessionEnd names the disposal the host can report, not a field it never writes', async () => {
    // `session/disposed` carries the session object itself and no reason at all, so
    // the read of `disposedReason` was a constant wearing the shape of a read: a
    // matcher written against any other reason looked supported and could never
    // fire. The payload below carries that field on purpose, to show it is ignored.
    const { host: h, listeners } = host()
    const payloads: unknown[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SessionEnd', {})],
      run: async (_handler, payload) => { payloads.push(payload); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    await (listeners.get('session/disposed')![0] as unknown as (s: unknown) => Promise<void>)({ id: 's9', disposedReason: 'ignored' })
    await hooks.settled()
    expect(payloads).toHaveLength(1)
    expect((payloads[0] as { readonly subject?: unknown }).subject).toBe('disposed')
  })

  test('the session-shaped seams ask for the session workspace, so project hooks load', async () => {
    // The module header states the rule this test exists to hold: a seam that
    // omits the workspace "silently serves a *different file set* than its
    // siblings", and "a hook that is never selected raises nothing". `cwdOf`
    // read `agent.session.header.cwd` and `session.header.cwd`, but these seams
    // are handed the session object itself, whose own `header.cwd` is the value
    // both arms were reaching through — so they asked with `undefined` and every
    // project-tier PreCompact / PostCompact / SessionEnd handler was dropped
    // without a warning. The session below carries a real header for the same
    // reason: the compaction test above passes `{ id: 's1' }`, a double with no
    // header at all, so it could not have caught this.
    const asked: (string | undefined)[] = []
    const { host: h, listeners } = host()
    const hooks = new FreeCodeGoHookRuntime({
      documents: async (workspaceRoot) => { asked.push(workspaceRoot); return [] },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const session = { id: 's1', header: { cwd: '/w' } }
    await (listeners.get('session/disposed')![0] as unknown as (s: unknown) => Promise<void>)(session)
    for (const listener of listeners.get('session/event')!) {
      await (listener as unknown as (s: unknown, e: unknown) => Promise<void>)(session, { type: 'compaction/start', data: {} })
    }
    await hooks.settled()
    expect(asked).toEqual(['/w', '/w'])
  })

  test('the subagent seams ask for the child session workspace, so project hooks load', async () => {
    // `SubagentRunInfo` and `SubagentRunEndInfo` carry no workspace and no parent
    // (the emitter hands the delegating parent to the scoped dispatcher, not to
    // listeners), so `cwdOf(info)` answered `undefined` for both seams and every
    // project-tier SubagentStart / SubagentStop handler was dropped silently —
    // the same failure the session-shaped seams above were fixed for, one payload
    // shape further out. The child's own session header is the source: the host
    // copies the parent's `cwd` into it when it starts the child.
    const asked: (string | undefined)[] = []
    const { host: h, listeners } = host()
    const hooks = new FreeCodeGoHookRuntime({
      documents: async (workspaceRoot) => { asked.push(workspaceRoot); return [] },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined, sessionCwd: id => id === 'child-1' ? '/w' : undefined })
    const info = { agentType: 'reviewer', provider: 'codex', runId: 'r1', id: 'child-1', local: true }
    await (listeners.get('subagent/start')![0] as unknown as (i: unknown) => Promise<void>)(info)
    await (listeners.get('subagent/end')![0] as unknown as (i: unknown) => Promise<void>)({ ...info, stopReason: 'end_turn' })
    await hooks.settled()
    expect(asked).toEqual(['/w', '/w'])
  })

  test('a subagent run whose session cannot be resolved still dispatches', async () => {
    // The arm is a resolver, not a requirement: an unresolvable id leaves the
    // workspace `undefined`, which is exactly what these seams had before — the
    // observer must not start refusing runs because a lookup failed.
    const seen: string[] = []
    const { host: h, listeners } = host()
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SubagentStart', {})],
      run: async (handler) => { seen.push(handler.event); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined, sessionCwd: () => undefined })
    await (listeners.get('subagent/start')![0] as unknown as (i: unknown) => Promise<void>)({ agentType: 'reviewer', runId: 'r1', id: 'child-1' })
    await hooks.settled()
    expect(seen).toEqual(['SubagentStart'])
  })

  test('SubagentStart and SubagentStop dispatch on their own events', async () => {
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SubagentStart', {}), document('SubagentStop', {})],
      run: async (handler) => { seen.push(handler.event); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    await (listeners.get('subagent/start')![0] as unknown as (i: unknown) => Promise<void>)({ agentType: 'reviewer', runId: 'r1' })
    await (listeners.get('subagent/end')![0] as unknown as (i: unknown) => Promise<void>)({ agentType: 'reviewer', runId: 'r1' })
    await hooks.settled()
    expect(seen).toEqual(['SubagentStart', 'SubagentStop'])
  })

  test('SubagentStop also reports the child to the plugin, which owns the contract check', async () => {
    const { host: h, listeners } = host()
    const ended: unknown[] = []
    installHookSeams(h, {
      runtime: runtime({}, []),
      record: () => undefined,
      subagentEnd: info => ended.push(info),
    })
    await (listeners.get('subagent/end')![0] as unknown as (i: unknown) => Promise<void>)({ id: 'child-1', provider: 'p' })
    expect(ended).toEqual([{ id: 'child-1', provider: 'p' }])
  })

  test('a throwing contract check does not stop the hook observers', async () => {
    // The plugin's check is called from the seam, so a bug in it must not take
    // the SubagentStop hooks down with it.
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SubagentStop', {})],
      run: async () => { seen.push('SubagentStop'); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined, subagentEnd: () => { throw new Error('contract check exploded') } })
    await (listeners.get('subagent/end')![0] as unknown as (i: unknown) => Promise<void>)({ id: 'child-1' })
    await hooks.settled()
    expect(seen).toEqual(['SubagentStop'])
  })

  test('a SubagentStop matcher naming the child fires on the way out as well as in', async () => {
    // `SubagentRunEndInfo.provider` is documented as "the same provider name
    // carried by the paired start event", and the start seam reads it. The end
    // seam's chain stopped one arm early, so it matched the constant
    // `'subagent'`: one matcher, two answers, and the stop hook never ran. The
    // pair is dispatched together here because the defect was only visible as a
    // disagreement between them.
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SubagentStart', { matcher: 'codex' }), document('SubagentStop', { matcher: 'codex' })],
      run: async (handler) => { seen.push(handler.event); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    await (listeners.get('subagent/start')![0] as unknown as (i: unknown) => Promise<void>)({ provider: 'codex', runId: 'r1' })
    await (listeners.get('subagent/end')![0] as unknown as (i: unknown) => Promise<void>)({ provider: 'codex', runId: 'r1' })
    await hooks.settled()
    expect(seen).toEqual(['SubagentStart', 'SubagentStop'])
  })

  test('a StopFailure matcher naming the failure code fires', async () => {
    // `LlmFailure` names its routing field `code` and has no `kind` at all, so
    // the seam's read of `kind` made the subject the constant `'error'` for
    // every failure — a matcher written against the code could never run. The
    // payload here is the real shape, not the `{ kind: 'x' }` double the
    // waterfall test above uses: a double that invents a field agrees with
    // whatever the implementation happens to read.
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('StopFailure', { matcher: 'RATE_LIMITED' })],
      run: async (handler) => { seen.push(handler.event); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const payload = { session: { id: 's1' }, failure: { code: 'RATE_LIMITED', message: 'slow down' } }
    await (listeners.get('agent/request-error')![0] as unknown as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>)(payload, async () => undefined)
    await hooks.settled()
    expect(seen).toEqual(['StopFailure'])
  })

  test('SessionEnd fires when a session is disposed', async () => {
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('SessionEnd', {})],
      run: async () => { seen.push('SessionEnd'); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    await (listeners.get('session/disposed')![0] as unknown as (s: unknown) => Promise<void>)({ id: 's9' })
    await hooks.settled()
    expect(seen).toEqual(['SessionEnd'])
  })

  test('an idle status is both a cancellation signal and a notification', async () => {
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('StopCancelled', {}), document('Notification', {})],
      run: async (handler) => { seen.push(handler.event); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    await (listeners.get('agent/status')![0] as unknown as (p: unknown) => Promise<void>)({ status: 'idle', agent: { id: 'a' } })
    await (listeners.get('agent/status')![0] as unknown as (p: unknown) => Promise<void>)({ status: 'running', agent: { id: 'a' } })
    await hooks.settled()
    // Only `idle` is a cancellation; `running` is not.
    expect(seen).toEqual(['StopCancelled', 'Notification'])
  })

  test('a pending approval is observed, and the chain still answers it', async () => {
    const { host: h, listeners } = host()
    const seen: string[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('PermissionDenied', {}), document('Notification', {})],
      run: async (handler) => { seen.push(handler.event); return { exitCode: 0, stdout: '{"decision":"deny"}', stderr: '' } },
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    // Two listeners on `approval/request`: PermissionDenied and Notification.
    expect(listeners.get('approval/request')!.length).toBe(2)
    // Both are called the way the host's waterfall calls them: with the request
    // and with `next`.
    const returned: unknown[] = []
    const next = async (): Promise<string> => 'allowed-once'
    for (const listener of listeners.get('approval/request')!) {
      returned.push(await (listener as unknown as (r: unknown, n: () => Promise<unknown>) => Promise<unknown>)({ toolName: 'bash' }, next))
    }
    // Each hands back the chain's own answer. Returning early is not neutrality:
    // a waterfall's result is the outermost listener's value, so a listener that
    // returns without calling `next()` vetoes everything behind it — including
    // the prompt the user was about to be asked.
    expect(returned).toEqual(['allowed-once', 'allowed-once'])
    await hooks.settled()
    // And a `deny` from either hook still cannot decide the approval: what came
    // back is the chain's answer, not the hook's.
    expect(seen).toEqual(['PermissionDenied', 'Notification'])
  })

  test('both listeners on one host event resolve the same workspace', async () => {
    // `loadHookDocuments` reads the project tier only when it is handed a
    // workspace, and the user tier regardless. The two listeners on
    // `approval/request` read the same file set, so they have to ask with the same
    // workspace: `PermissionDenied` passed none, which silently dropped
    // `.freecodego/hooks.json` and `.claude/settings.json` for that event alone.
    // The hook parses, matches, and never runs — the failure the coverage test
    // above cannot see, because a hook that is never selected raises nothing.
    const { host: h, listeners } = host()
    const asked: (string | undefined)[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async (workspaceRoot) => {
        asked.push(workspaceRoot)
        return [document('PermissionDenied', {}), document('Notification', {})]
      },
      run: async (): Promise<HookInvocation> => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const request = { toolName: 'bash', session: { header: { cwd: '/w' } } }
    for (const listener of listeners.get('approval/request')!) {
      await (listener as unknown as (r: unknown, n: () => Promise<unknown>) => Promise<unknown>)(request, async () => 'allowed')
    }
    await hooks.settled()
    // PermissionDenied is installed first, so it asks first.
    expect(asked).toEqual(['/w', '/w'])
  })

  test('an observing listener on a waterfall still passes the chain on', async () => {
    // The regression this exists for: a listener that returns without calling
    // `next()` does not stay neutral, it answers. Every waterfall seam is checked
    // by counting the calls, which is the only thing both the host's contract and
    // this module's listeners can be held to at once.
    const waterfall: readonly (readonly [string, readonly unknown[]])[] = [
      ['agent/pre-step', [{ messages: [] }]],
      ['tools/pre-execute', [{ name: 'read', arguments: {} }]],
      ['tools/post-execute', [{ name: 'read', arguments: {} }, { value: 'x' }]],
      ['agent/request-error', [{ failure: { kind: 'x' } }]],
      ['approval/request', [{ toolName: 'bash' }]],
    ]
    for (const [event, args] of waterfall) {
      const { host: h, listeners } = host()
      installHookSeams(h, { runtime: runtime({}, []), record: () => undefined })
      let answered = 0
      const next = async (): Promise<string> => { answered += 1; return 'chain-answer' }
      for (const listener of listeners.get(event)!) {
        await (listener as unknown as (...a: unknown[]) => Promise<unknown>)(...args, next)
      }
      expect(answered, `${event} must pass the chain on`).toBe(listeners.get(event)!.length)
    }
  })

  test('a PostToolUse hook\'s context rides the decision it did not decide', async () => {
    const { host: h, listeners } = host()
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document('PostToolUse', {})],
      run: async () => ({ exitCode: 0, stdout: '{"additionalContext":"the linter wanted tabs"}', stderr: '' }),
    })
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    type PostSeam = (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>
    const post = listeners.get('tools/post-execute')![0] as unknown as PostSeam
    const base = { kind: 'accept', content: [{ type: 'text', text: 'compressed by headroom' }] }
    const decision = await post({ name: 'read', arguments: {} }, { value: 'x' }, async () => base) as {
      readonly kind: unknown
      readonly content: unknown
      readonly additionalContexts?: readonly { readonly source?: unknown; readonly content: readonly { readonly text: string }[] }[]
    }
    // The decision someone else made survives: a hook that only adds context must
    // not become the listener that overrode the compressor in front of it.
    expect(decision.kind).toBe('accept')
    expect(decision.content).toBe(base.content)
    expect(decision.additionalContexts?.[0]?.content[0]?.text).toBe('the linter wanted tabs')
    expect(decision.additionalContexts?.[0]?.source).toEqual({ kind: 'plugin', plugin: 'freecodego-hooks' })
  })
})

describe('a tool seam hands the call\'s own cancellation to the runtime', () => {
  /**
   * A runtime that records what each handler was invoked with.
   *
   * No process: these cases are about the wiring — whether the signal a tool
   * call carries ever reaches the layer that can act on it — and a real spawn
   * would only add a way for them to be slow.
   */
  function recordingRuntime(event: string): { hooks: FreeCodeGoHookRuntime; ran: string[]; signals: (AbortSignal | undefined)[] } {
    const ran: string[] = []
    const signals: (AbortSignal | undefined)[] = []
    const hooks = new FreeCodeGoHookRuntime({
      documents: async () => [document(event, {})],
      run: async (handler, _payload, _timeoutMs, signal) => {
        ran.push(handler.command)
        signals.push(signal)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    return { hooks, ran, signals }
  }

  test('PreToolUse passes exec.signal down, and starts no hook for a call already cancelled', async () => {
    const { host: h, listeners } = host()
    const { hooks, ran, signals } = recordingRuntime('PreToolUse')
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const pre = listeners.get('tools/pre-execute')![0] as unknown as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>

    // A call with no signal still runs its hooks: the forwarding must not become
    // a precondition for hooks in general.
    await pre({ name: 'bash', arguments: {} }, async () => 'allowed')
    expect(ran).toEqual(['check'])
    expect(signals).toEqual([undefined])

    const live = new AbortController()
    await pre({ name: 'bash', arguments: {}, signal: live.signal }, async () => 'allowed')
    // The exact signal, not a copy: the runner listens to this one.
    expect(signals[1]).toBe(live.signal)

    const stopped = new AbortController()
    stopped.abort()
    await pre({ name: 'bash', arguments: {}, signal: stopped.signal }, async () => 'allowed')
    // Nothing new ran: a hook guarding a call nobody is waiting for has nothing
    // left to guard, and spawning it would only produce a process to kill.
    expect(ran).toEqual(['check', 'check'])
  })

  test('PostToolUse passes it down too, because it is on the same critical path', async () => {
    const { host: h, listeners } = host()
    const { hooks, ran, signals } = recordingRuntime('PostToolUse')
    installHookSeams(h, { runtime: hooks, record: () => undefined })
    const post = listeners.get('tools/post-execute')![0] as unknown as (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>
    const live = new AbortController()
    await post({ name: 'bash', arguments: {}, signal: live.signal }, { value: 'x' }, async () => 'accepted')
    expect(signals).toEqual([live.signal])
    // And this seam runs after the rest of the chain, so it also has to hand that
    // chain's answer back untouched.
    const stopped = new AbortController()
    stopped.abort()
    const decision = await post({ name: 'bash', arguments: {}, signal: stopped.signal }, { value: 'x' }, async () => 'accepted')
    expect(ran).toEqual(['check'])
    expect(decision).toBe('accepted')
  })
})
