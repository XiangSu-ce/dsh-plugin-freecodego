import { cwd, execPath } from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { FreeCodeGoNativeAgent, NativeRootAgentSession } from '@deepseek-ai/dsh-freecodego-root-agent'
import type { NativeRootAgentCreateOptions, NativeRootAgentEvent } from '@deepseek-ai/dsh-freecodego-root-agent'

// Answers `session/create` with the file-policy fields it received, so the
// assertion reads what the Host actually put on the wire: a field that never
// crossed reads back as null here. The whole `params` object comes back too, so
// a field that rode along uninvited is visible rather than assumed absent.
const sandboxEchoWorker = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    const result = m.method === 'initialize'
      ? { protocolAbi: 'freecodego-agent/1', engines: ['codex'], runtimeVersion: 'test' }
      : m.method === 'session/create'
        ? { runtimeSessionId: JSON.stringify({ params: m.params, sandboxMode: m.params.sandboxMode === undefined ? null : m.params.sandboxMode, readOnly: m.params.readOnly === undefined ? null : m.params.readOnly }) }
        : null
    out({ id: m.id, result })
  }
})
`

const worker = [
  '-e',
  "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const r=m.method==='initialize'?{protocolAbi:'freecodego-agent/1',engines:['codex'],runtimeVersion:'test'}:m.method==='session/create'?{runtimeSessionId:'native-1'}:null;process.stdout.write(JSON.stringify({id:m.id,result:r})+'\\n')}})",
]

// Answers the handshake, acknowledges a prompt, then exits.
//
// The acknowledgement is the point: `session/prompt` resolves as soon as the
// turn starts, so a worker that dies here leaves no in-flight request to
// reject, and the open turn has nothing but an event to settle it with.
const dyingWorker = `
const out = (x, done) => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10), done)
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'session/prompt') { out({ id: m.id, result: null }, () => process.exit(0)); continue }
    const result = m.method === 'initialize'
      ? { protocolAbi: 'freecodego-agent/1', engines: ['codex'], runtimeVersion: 'test' }
      : m.method === 'session/create'
        ? { runtimeSessionId: 'native-death' }
        : null
    out({ id: m.id, result })
  }
})
`

describe('NativeRootAgentSession', () => {
  it('initializes, creates, prompts, cancels, and disposes one runtime session', async () => {
    const session = await NativeRootAgentSession.open({ command: execPath, args: worker }, {
      engine: 'codex', harnessSessionId: 'harness-1', modelId: 'model-1', provider: 'provider-1', workspace: cwd(), artifactDigest: 'sha256:test', protocolAbi: 'freecodego-agent/1',
    })
    expect(session.identity.runtimeSessionId).toBe('native-1')
    await expect(session.prompt('hello')).resolves.toBeUndefined()
    await expect(session.cancel()).resolves.toBeUndefined()
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it.each([
    ['a resolved session mode', { sandboxMode: 'read-only' as const }, { sandboxMode: 'read-only' }],
    ['a wider session mode', { sandboxMode: 'danger-full-access' as const }, { sandboxMode: 'danger-full-access' }],
    ['the council floor beside its own mode', { readOnly: true, sandboxMode: 'workspace-write' as const }, { readOnly: true, sandboxMode: 'workspace-write' }],
    ['no policy at all', {}, {}],
    ['a field that is explicitly absent', { sandboxMode: undefined }, {}],
  ])('carries %s on session/create', async (_label, policy, expected) => {
    const session = await NativeRootAgentSession.open({ command: execPath, args: ['-e', sandboxEchoWorker] }, {
      engine: 'codex', harnessSessionId: 'harness-policy', modelId: 'model-1', provider: 'provider-1', workspace: cwd(), artifactDigest: 'sha256:test', protocolAbi: 'freecodego-agent/1',
      ...policy,
      // One row hands an explicit `undefined` for an optional field — the one
      // shape `exactOptionalPropertyTypes` exists to stop a *typed* caller from
      // writing, and therefore the only way to build the case at all. That is
      // the point: a JavaScript caller or a spread can still produce the key,
      // and the wire must not grow it.
      //
      // The assertion is what lets the row exist at all: the type system refuses
      // to write that key, which is exactly why the case has to be built past it.
    } as NativeRootAgentCreateOptions)
    const carried = JSON.parse(session.identity.runtimeSessionId) as { readonly params: Record<string, unknown> }
    // The exact object, not a subset: the policy fields have to arrive with the
    // right values and nothing else may ride along on a wire both runtimes read.
    expect(carried.params).toEqual({
      harnessSessionId: 'harness-policy', modelId: 'model-1', provider: 'provider-1', workspace: cwd(), ...expected,
    })
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it('reports a worker that dies mid-turn as the failure a turn is settled with', async () => {
    const events: NativeRootAgentEvent[] = []
    const session = await NativeRootAgentSession.open({ command: execPath, args: ['-e', dyingWorker] }, {
      engine: 'codex', harnessSessionId: 'harness-death', modelId: 'model-1', provider: 'provider-1', workspace: cwd(), artifactDigest: 'sha256:test', protocolAbi: 'freecodego-agent/1',
      onEvent: event => events.push(event),
    })
    // The prompt is answered before the worker exits, which is the whole problem:
    // the turn is open and no request is left in flight to reject.
    await expect(session.prompt('hello')).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(events.map(event => event.method)).toContain('session/failed') }, { timeout: 5_000 })
    const failure = events.find(event => event.method === 'session/failed')
    // The binding has to be the live one, or the agent discards the event as
    // belonging to another session and the turn stays open.
    expect(failure?.binding).toMatchObject({ runtimeSessionId: 'native-death', harnessSessionId: 'harness-death', provider: 'provider-1' })
    expect(String(failure?.params.message)).toContain('exited')
    await session.dispose()
  })

  it('settles an open Harness turn when the worker dies under it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const harness = ctx.sessions.create(SessionId('native-death-turn'))
    // The session is opened first because the agent needs it to attach; the
    // holder is what lets the failure callback reach an agent that does not
    // exist yet. Nothing can arrive before the prompt, and the agent is built
    // long before that.
    const holder: { agent?: FreeCodeGoNativeAgent } = {}
    const session = await NativeRootAgentSession.open({ command: execPath, args: ['-e', dyingWorker] }, {
      engine: 'codex', harnessSessionId: String(harness.id), modelId: 'model-1', provider: 'provider-1', workspace: cwd(), artifactDigest: 'sha256:test', protocolAbi: 'freecodego-agent/1',
      onEvent: (event) => { holder.agent?.onNativeEvent(event) },
    })
    const running = new FreeCodeGoNativeAgent(ctx, harness.id, { provider: 'native', model: 'test' }, harness)
    holder.agent = running
    running.attachNative(session)
    running.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    // Before the death was reported this never became idle: the turn waited on a
    // completion only an event could deliver, and the worker that owed it was
    // gone. The bounded wait is the assertion — an unbounded `whenIdle()` would
    // hang the suite instead of failing it.
    await vi.waitFor(() => { expect(running.status).toBe('idle') }, { timeout: 10_000 })
    // Read through the agent's own session, which is the same record `harness`
    // holds: the assertion is about the log this agent wrote its turn/end into.
    // Read as `filter` + last index rather than `findLast`: the type-aware pass
    // resolves that method to an error type here, which cascades into the
    // callback and turns the `event.type` read into an unsafe member access.
    const turnEnds = running.session.snapshotEvents().filter(event => event.type === 'turn/end')
    expect(turnEnds[turnEnds.length - 1]).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'NATIVE_RUNTIME' } } },
    })
    await ctx.fiber.dispose()
  })

  it('does not leave an unhandled rejection when a turn is cancelled before its prompt answers', async () => {
    // The window this pins: `cancel()` settles the turn's completion promise
    // while `await native.prompt(...)` is still in flight. That await is an
    // entire turn for the in-process Claude runtime, so a user pressing Stop
    // mid-turn lands in it every time — and a rejection on a promise nobody has
    // attached a handler to yet is an unhandled rejection, which Node treats as
    // fatal. The assertion is the count, because a rejection nobody reads is the
    // bug: the turn still ends, so every other observable is unchanged.
    const harnessId = 'native-slow-turn'
    // Answers the handshake, announces that the prompt arrived, and answers it
    // only later: the delay is what holds the turn inside `native.prompt` while
    // the cancel arrives.
    const slowPromptWorker = `
const out = (x) => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'session/prompt') {
      out({ method: 'assistant/delta', params: { runtimeSessionId: 'native-slow', harnessSessionId: '${harnessId}', sequence: 1, text: 'started' } })
      setTimeout(() => out({ id: m.id, result: null }), 500)
      continue
    }
    const result = m.method === 'initialize'
      ? { protocolAbi: 'freecodego-agent/1', engines: ['codex'], runtimeVersion: 'test' }
      : m.method === 'session/create'
        ? { runtimeSessionId: 'native-slow' }
        : null
    out({ id: m.id, result })
  }
})
`
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const ctx = new Context()
    let session: NativeRootAgentSession | undefined
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt, { personaPrefix: '' })
      const harness = ctx.sessions.create(SessionId(harnessId))
      const holder: { agent?: FreeCodeGoNativeAgent } = {}
      const events: NativeRootAgentEvent[] = []
      session = await NativeRootAgentSession.open({ command: execPath, args: ['-e', slowPromptWorker] }, {
        engine: 'codex', harnessSessionId: String(harness.id), modelId: 'model-1', provider: 'provider-1', workspace: cwd(), artifactDigest: 'sha256:test', protocolAbi: 'freecodego-agent/1',
        onEvent: (event) => { events.push(event); holder.agent?.onNativeEvent(event) },
      })
      const running = new FreeCodeGoNativeAgent(ctx, harness.id, { provider: 'native', model: 'test' }, harness)
      holder.agent = running
      running.attachNative(session)
      running.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      // The delta is the proof that the turn is inside `native.prompt`: it is
      // emitted by the worker on receipt of the request, before its reply, and
      // `runTurn` has no handler on the completion promise until that reply
      // resolves.
      await vi.waitFor(() => { expect(events.some(event => event.method === 'assistant/delta')).toBe(true) }, { timeout: 10_000 })
      running.cancel({ kind: 'user' })
      await vi.waitFor(() => { expect(running.status).toBe('idle') }, { timeout: 10_000 })
      // The rejection is reported on the macrotask after it is raised, so the
      // wait is what gives a missing observer the chance to show up.
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      expect(rejections).toEqual([])
      const turnEnds = running.session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(turnEnds[turnEnds.length - 1]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    } finally {
      await session?.dispose().catch(() => undefined)
      await ctx.fiber.dispose()
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
