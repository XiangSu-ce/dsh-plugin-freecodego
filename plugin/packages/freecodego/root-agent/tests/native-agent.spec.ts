import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
// The bare specifier, not `/src/index.ts`: a non-relative specifier carrying a
// `.ts` extension is exactly what `rewriteRelativeImportExtensions` warns about
// (TS2877), and every other FreeCodeGo suite already imports this way.
import { FreeCodeGoNativeAgent, appendNativeSessionBinding, nativeSessionBinding } from '@deepseek-ai/dsh-freecodego-root-agent'

/**
 * Append an event whose type another package declares.
 *
 * `model/selection` belongs to the optional `dsh-api-session-controller`
 * package, and root-agent deliberately does not depend on it —
 * `selectedNativeRoute` reads the event as a validated extension record at the
 * boundary, which is the only reason a Host without that package still works.
 * A fixture that imported the owner just to type this one append would assert
 * the opposite of the design, so it writes the event the same way the source
 * reads it: through the raw append signature.
 */
function appendExtensionEvent(session: Session, type: string, data: unknown): void {
  const append = session.append.bind(session) as unknown as (type: string, data: unknown) => unknown
  append(type, data)
}

describe('FreeCodeGoNativeAgent', () => {
  it('projects one native stream into balanced Harness session events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-agent'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    agent.attachNative({
      identity: { engine: 'codex', runtimeSessionId: 'native', harnessSessionId: 'native-agent', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' },
      prompt: async () => {
        queueMicrotask(() => {
          const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-agent', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
          agent.onNativeEvent({ method: 'assistant/delta', params: { runtimeSessionId: 'native', harnessSessionId: 'native-agent', sequence: 1, text: 'hello' }, binding })
          agent.onNativeEvent({ method: 'assistant/final', params: { runtimeSessionId: 'native', harnessSessionId: 'native-agent', sequence: 2, text: 'hello' }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { runtimeSessionId: 'native', harnessSessionId: 'native-agent', sequence: 3, status: 'completed' }, binding })
        })
      },
      cancel: async () => {}, respond: async () => {}, dispose: async () => {},
    } as never)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    await ctx.fiber.dispose()
  })

  it('preserves a native Thinking source without duplicating the final reasoning frame', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-thinking'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native-thinking', harnessSessionId: 'native-thinking', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({ method: 'assistant/reasoning/delta', params: { ...binding, sequence: 1, text: 'streamed reasoning', source: 'codex-app-server', sourceLabel: 'Codex App Server' }, binding })
          agent.onNativeEvent({ method: 'assistant/reasoning/final', params: { ...binding, sequence: 2, text: 'streamed reasoning', source: 'codex-app-server', sourceLabel: 'Codex App Server' }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 3, status: 'completed' }, binding })
        })
      },
      cancel: async () => {}, respond: async () => {}, dispose: async () => {},
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'think' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // `assistant/chunk` is the pre-v0.1 streaming record and is deliberately not
    // in `SessionEventMap`; comparing through `String(...)` is how this asserts
    // its absence without re-declaring a type the Harness no longer has.
    // The widening is required: `event.type` is the known session-event union and
    // `assistant/chunk` is not a member, so the comparison needs the `String(...)`.
    expect(session.snapshotEvents().filter(event => String(event.type) === 'assistant/chunk')).toHaveLength(0)
    expect(session.snapshotEvents().findLast(event => event.type === 'assistant/message')).toMatchObject({
      data: { message: { content: [{ type: 'reasoning', text: 'streamed reasoning', source: 'codex-app-server', sourceLabel: 'Codex App Server' }] } },
    })
    await ctx.fiber.dispose()
  })

  it('forwards the latest session model selection to the next native turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-model-switch'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'freecodego', model: 'initial' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native-model-switch', harnessSessionId: 'native-model-switch', modelId: 'initial', provider: 'freecodego', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const prompt = vi.fn(async () => {
      queueMicrotask(() => {
        agent.onNativeEvent({ method: 'assistant/final', params: { ...binding, sequence: 1, text: 'switched route reply' }, binding })
        agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2, status: 'completed' }, binding })
      })
    })
    agent.attachNative({
      identity: binding, prompt, cancel: async () => {}, respond: async () => {}, dispose: async () => {},
    })
    appendExtensionEvent(session, 'model/selection', { provider: 'agnes', model: 'agnes-3.0-flash', reasoningEffort: 'low' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the selected model' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompt).toHaveBeenCalledWith('use the selected model', { provider: 'agnes', modelId: 'agnes-3.0-flash', reasoningEffort: 'low' })
    expect(session.snapshotEvents().findLast(event => event.type === 'assistant/message')).toMatchObject({
      data: { message: { source: { provider: 'agnes', model: 'agnes-3.0-flash' } } },
    })
    await ctx.fiber.dispose()
  })

  it('forwards only a trimmed, bounded reasoning effort from the session selection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-effort-route'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'freecodego', model: 'initial' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native-effort-route', harnessSessionId: 'native-effort-route', modelId: 'initial', provider: 'freecodego', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const prompt = vi.fn(async () => {
      queueMicrotask(() => {
        agent.onNativeEvent({ method: 'assistant/final', params: { ...binding, sequence: 1, text: 'reply' }, binding })
        agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2, status: 'completed' }, binding })
      })
    })
    agent.attachNative({ identity: binding, prompt, cancel: async () => {}, respond: async () => {}, dispose: async () => {} })
    // Both workers drop a level they do not recognise, so a value the reader
    // forwards verbatim but never validated is a user choice that silently does
    // not take effect.
    appendExtensionEvent(session, 'model/selection', { provider: 'agnes', model: 'agnes-3.0-flash', reasoningEffort: ' high ' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(prompt).toHaveBeenNthCalledWith(1, 'first', { provider: 'agnes', modelId: 'agnes-3.0-flash', reasoningEffort: 'high' })

    appendExtensionEvent(session, 'model/selection', { provider: 'agnes', model: 'agnes-3.0-flash', reasoningEffort: 'high\ninjected' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(prompt).toHaveBeenNthCalledWith(2, 'second', { provider: 'agnes', modelId: 'agnes-3.0-flash' })
    await ctx.fiber.dispose()
  })

  it('rejects resume when a durable native binding selects another artifact', () => {
    const session = Session.create(SessionId('binding'))
    appendNativeSessionBinding(session, { engine: 'codex', runtimeSessionId: 'thread-1', artifactDigest: 'sha256:a', protocolAbi: 'abi/1' })
    expect(nativeSessionBinding(session, 'codex', 'sha256:a', 'abi/1')).toBe('thread-1')
    expect(() => nativeSessionBinding(session, 'codex', 'sha256:b', 'abi/1')).toThrow('does not match')
  })

  it('reopens a failed native runtime for the next user turn without replaying the failed turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-recovery'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const firstBinding = { engine: 'codex' as const, runtimeSessionId: 'native-first', harnessSessionId: 'native-recovery', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const secondBinding = { ...firstBinding, runtimeSessionId: 'native-second' }
    const firstDispose = vi.fn(async () => {})
    const recovered = vi.fn(async () => ({
      identity: secondBinding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({ method: 'assistant/final', params: { ...secondBinding, sequence: 1, text: 'recovered reply' }, binding: secondBinding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...secondBinding, sequence: 2, status: 'completed' }, binding: secondBinding })
        })
      },
      cancel: async () => {}, respond: async () => {}, dispose: async () => {},
    }))
    agent.attachNative({
      identity: firstBinding,
      prompt: async () => {
        queueMicrotask(() => { agent.onNativeEvent({ method: 'session/failed', params: { ...firstBinding, sequence: 1, message: 'worker exited' }, binding: firstBinding }) })
      },
      cancel: async () => {}, respond: async () => {}, dispose: firstDispose,
    })
    agent.setNativeRecovery(recovered)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first request' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { turn: 1, reason: { kind: 'error' } } })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second request' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(recovered).toHaveBeenCalledOnce()
    expect(session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { turn: 2, reason: { kind: 'completed' } } })
    expect(session.snapshotEvents().findLast(event => event.type === 'assistant/message')).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'recovered reply' }] } } })
    await ctx.fiber.dispose()
  })

  it('routes native permission and question events through Harness interaction services', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ApprovalService)
    await ctx.plugin(UserQuestionService)
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    const session = ctx.sessions.create(SessionId('native-interaction'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    agent.ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: 'choice', selected: ['yes'] }] }))
    const responses: Array<{ method: string; id: string; response: unknown }> = []
    const binding = { engine: 'claude' as const, runtimeSessionId: 'native', harnessSessionId: 'native-interaction', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({ method: 'permission/requested', params: { ...binding, sequence: 1, requestId: 'perm-1', request: { toolName: 'shell', reason: 'run command' } }, binding })
          agent.onNativeEvent({ method: 'question/requested', params: { ...binding, sequence: 2, requestId: 'question-1', request: { questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'yes' }] }] } }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 3 }, binding })
        })
      },
      cancel: async () => {},
      respond: async (method: 'permission/respond' | 'question/respond', id: string, response: unknown) => { responses.push({ method, id, response }) },
      dispose: async () => {},
    })
    const unregister = ctx.agents.register(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    expect(agent.status).toBe('running')
    await agent.whenIdle()
    await vi.waitFor(() => { expect(responses).toHaveLength(2) })
    expect(responses).toEqual(expect.arrayContaining([
      { method: 'permission/respond', id: 'perm-1', response: { type: 'approved' } },
      { method: 'question/respond', id: 'question-1', response: { answers: [{ id: 'choice', selected: ['yes'] }] } },
    ]))
    expect(session.snapshotEvents().filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
    void unregister()
    await ctx.fiber.dispose()
  })

  it('refuses a native call the plugin guards forbid, without prompting the user', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ApprovalService)
    let prompts = 0
    ctx.on('approval/request', () => { prompts += 1; return Promise.resolve('allowed-once') })
    // The plugin owns the settings, the compiled command policy and the Plan Mode
    // store, so it answers; the root agent only relays the question and carries
    // the refusal back to the engine. The guard's own rules are pinned by
    // `native-tool-guard.spec.ts` in the plugin package.
    const seen: unknown[] = []
    ctx.provide('freeCodeGoHarness', {
      nativeToolGuard: async (request: unknown) => {
        seen.push(request)
        return 'Blocked by the FreeCodeGo command policy: "rm -rf build" is forbidden.'
      },
    })
    const session = ctx.sessions.create(SessionId('native-guard-deny'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const responses: Array<{ method: string; id: string; response: unknown }> = []
    const binding = { engine: 'claude' as const, runtimeSessionId: 'native', harnessSessionId: 'native-guard-deny', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({
            method: 'permission/requested',
            params: {
              ...binding,
              sequence: 1,
              requestId: 'perm-guard',
              method: 'permission/requested',
              detail: { toolName: 'Bash', input: { command: 'rm -rf build' } },
            },
            binding,
          })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2 }, binding })
        })
      },
      cancel: async () => {},
      respond: async (method: 'permission/respond' | 'question/respond', id: string, response: unknown) => { responses.push({ method, id, response }) },
      dispose: async () => {},
    })
    const unregister = ctx.agents.register(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(responses).toHaveLength(1) })
    // The engine learns why, so the model can change approach instead of retrying.
    expect(responses[0]).toMatchObject({ method: 'permission/respond', id: 'perm-guard', response: { type: 'rejected' } })
    expect(String((responses[0]?.response as { readonly message?: unknown }).message)).toContain('command policy')
    // The engine's arguments reached the guard, and the user was never asked.
    expect(seen).toEqual([{ toolName: 'Bash', method: 'permission/requested', detail: { toolName: 'Bash', input: { command: 'rm -rf build' } }, agent }])
    expect(prompts).toBe(0)
    expect(session.snapshotEvents().filter(event => event.type === 'approval/asked')).toHaveLength(0)
    void unregister()
    await ctx.fiber.dispose()
  })

  it('names the pending operation in the approval prompt', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ApprovalService)
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    const session = ctx.sessions.create(SessionId('native-guard-prompt'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'claude' as const, runtimeSessionId: 'native', harnessSessionId: 'native-guard-prompt', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({
            method: 'permission/requested',
            params: { ...binding, sequence: 1, requestId: 'perm-reason', detail: { toolName: 'Bash', input: { command: 'npm run build' } } },
            binding,
          })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2 }, binding })
        })
      },
      cancel: async () => {},
      respond: async () => {},
      dispose: async () => {},
    })
    const unregister = ctx.agents.register(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // A native engine's arguments are visible nowhere else before they run, so
    // the prompt headline is the only place the user can see what they approve.
    await vi.waitFor(() => { expect(session.snapshotEvents().some(event => event.type === 'approval/decided')).toBe(true) })
    expect(session.snapshotEvents().find(event => event.type === 'approval/asked'))
      .toMatchObject({ data: { toolName: 'Bash', reason: 'Bash: npm run build' } })
    void unregister()
    await ctx.fiber.dispose()
  })

  it('names the access a native permission escalation is asking to grant', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ApprovalService)
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    const session = ctx.sessions.create(SessionId('native-permission-profile'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-permission-profile', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({
            method: 'permission/requested',
            params: {
              ...binding,
              sequence: 1,
              approvalId: 'approval-9301',
              method: 'item/permissions/requestApproval',
              detail: {
                cwd: '/work',
                permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/work/out' } }] }, network: { enabled: true } },
              },
            },
            binding,
          })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2 }, binding })
        })
      },
      cancel: async () => {},
      respond: async () => {},
      dispose: async () => {},
    })
    const unregister = ctx.agents.register(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // The granted profile is echoed to the engine unchanged, so this headline is
    // the user's only account of what they are handing over.
    await vi.waitFor(() => { expect(session.snapshotEvents().some(event => event.type === 'approval/decided')).toBe(true) })
    const asked = session.snapshotEvents().find(event => event.type === 'approval/asked')
    expect(asked?.data).toMatchObject({ toolName: 'native' })
    expect(String((asked?.data as { readonly reason?: unknown } | undefined)?.reason))
      .toContain('write /work/out')
    expect(String((asked?.data as { readonly reason?: unknown } | undefined)?.reason))
      .toContain('network access')
    void unregister()
    await ctx.fiber.dispose()
  })

  it('projects Codex/Claude native tool progress into durable call and result events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-tools'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-tools', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({ method: 'tool/progress', params: { ...binding, sequence: 1, method: 'item/started', detail: { item: { id: 'call-1', type: 'commandExecution', command: 'echo hi' } } }, binding })
          agent.onNativeEvent({ method: 'tool/progress', params: { ...binding, sequence: 2, method: 'item/completed', detail: { item: { id: 'call-1', type: 'commandExecution', aggregatedOutput: 'hi\n', exitCode: 0 } } }, binding })
          agent.onNativeEvent({ method: 'assistant/final', params: { ...binding, sequence: 3, text: 'finished' }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 4, status: 'completed' }, binding })
        })
      }, cancel: async () => {}, respond: async () => {}, dispose: async () => {},
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const calls = session.snapshotEvents().filter(event => event.type === 'tool/call')
    const results = session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ data: { name: 'bash', arguments: '{"command":"echo hi"}' } })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ data: { message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: 'hi\n' }] }] } } })
    await ctx.fiber.dispose()
  })

  it('never records a tool result that has no tool call before it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-tool-attribution'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-tool-attribution', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          // A Codex App Server item that is not tool activity (a plan/todo
          // update, say) reaches `tool/progress` through the worker's catch-all
          // and is read as a RESULT because its method says `completed`.
          agent.onNativeEvent({ method: 'tool/progress', params: { ...binding, sequence: 1, method: 'item/completed', detail: { item: { id: 'item-9', type: 'todoList', items: [{ text: 'step' }] } } }, binding })
          // A result whose call frame never arrived: it names no tool, so there
          // is nothing to attach it to.
          agent.onNativeEvent({ method: 'tool/progress', params: { ...binding, sequence: 2, method: 'tool.completed', detail: { type: 'tool_result', id: 'toolu-1', content: 'output', isError: false } }, binding })
          // The self-contained case still projects: one completed item that
          // carries its own call shape needs no earlier `item/started`.
          agent.onNativeEvent({ method: 'tool/progress', params: { ...binding, sequence: 3, method: 'item/completed', detail: { item: { id: 'call-9', type: 'commandExecution', command: 'echo hi', aggregatedOutput: 'hi', exitCode: 0 } } }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 4, status: 'completed' }, binding })
        })
      }, cancel: async () => {}, respond: async () => {}, dispose: async () => {},
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const calls = session.snapshotEvents().filter(event => event.type === 'tool/call')
    const results = session.snapshotEvents().filter(event => event.type === 'tool/result')
    // The Harness session invariant rejects a `tool/result` with no `tool/call`
    // before it in the same step, so neither an unattributable result nor a
    // call invented for one may reach the transcript.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ data: { callId: 'call-9', name: 'bash' } })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ data: { message: { source: { callId: 'call-9' } } } })
    await ctx.fiber.dispose()
  })

  it('answers a permission request that arrives with no running turn instead of leaving the engine blocked', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-late-approval'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-late-approval', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const respond = vi.fn(async () => {})
    agent.attachNative({ identity: binding, prompt: async () => {}, cancel: async () => {}, respond, dispose: async () => {} })
    // No turn is running, so there is no signal to prompt on and no user left to
    // ask — but the engine is *blocked* on this response: the Claude SDK awaits
    // `canUseTool`, and Codex holds the turn until the watchdog fires. Leaving it
    // unanswered took the whole turn down with a message that explained nothing.
    agent.onNativeEvent({ method: 'permission/requested', params: { ...binding, sequence: 1, requestId: 'perm-late', detail: { toolName: 'Bash', input: { command: 'ls' } } }, binding })
    await vi.waitFor(() => { expect(respond).toHaveBeenCalledTimes(1) })
    expect(respond).toHaveBeenCalledWith('permission/respond', 'perm-late', { type: 'rejected' })
    await ctx.fiber.dispose()
  })

  it('fails a bridge call during disposal instead of opening a replacement runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const session = ctx.sessions.create(SessionId('native-disposed'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-disposed', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const responded = vi.fn(async () => {})
    agent.attachNative({ identity: binding, prompt: async () => {}, cancel: async () => {}, respond: responded, dispose: async () => {} })
    const recoveries = vi.fn(async () => ({
      identity: binding, prompt: async () => {}, cancel: async () => {}, respond: responded, dispose: async () => {},
    }))
    agent.setNativeRecovery(recoveries)
    // The worker died while the agent was idle, so no runtime session is left
    // for a late bridge call to travel through.
    agent.onNativeEvent({ method: 'session/failed', params: { ...binding, sequence: 1, message: 'worker exited' }, binding })
    const disposing = agent.disposeNative()
    await expect(agent.respondPermission('perm-1', 'rejected')).rejects.toThrow(/is disposed/)
    await disposing
    // Recovering here would open a worker this agent is already tearing down.
    expect(recoveries).not.toHaveBeenCalled()
    expect(responded).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('turns a Host-withheld tool result into a visible bridge error', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    // A tool that echoes a config file: the payload is ordinary tool output that
    // happens to carry a credential-shaped value.
    ctx.provide('freeCodeGoHarness', {
      claudeBridgeHandle: async () => ({ api_key: 'sk-live-0123456789abcdef' }),
    } as never)
    const session = ctx.sessions.create(SessionId('native-withheld-result'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-withheld-result', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const sent: unknown[] = []
    // The Host's own refusal, verbatim: the frame is never written.
    const respond = vi.fn(async (_method: string, _id: string, response: unknown) => {
      sent.push(response)
      if (sent.length === 1) throw new Error('native runtime message contains a credential-shaped field at $.result.api_key')
    })
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({ method: 'bridge/requested', params: { ...binding, sequence: 1, requestId: 'bridge-1', bridge: 'tool', op: 'execute', input: {} }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2, status: 'completed' }, binding })
        })
      },
      cancel: async () => {}, respond, dispose: async () => {},
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read it' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(respond).toHaveBeenCalledTimes(2) })
    expect(sent[0]).toMatchObject({ result: { api_key: 'sk-live-0123456789abcdef' } })
    // The bridge is answered rather than abandoned, and the answer names no value.
    expect(sent[1]).toEqual({ error: 'the tool result was withheld: it contained credential-shaped fields' })
    await ctx.fiber.dispose()
  })

  it('masks a credential before a failed Host tool hands its error text to the engine', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    // A Host tool that failed while quoting the request that failed, which is the
    // ordinary way a credential ends up inside an error message.
    ctx.provide('freeCodeGoHarness', {
      claudeBridgeHandle: async () => { throw new Error('curl failed: Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuv') },
    } as never)
    const session = ctx.sessions.create(SessionId('native-bridge-error-masked'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'codex' as const, runtimeSessionId: 'native', harnessSessionId: 'native-bridge-error-masked', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const sent: unknown[] = []
    const respond = vi.fn(async (_method: string, _id: string, response: unknown) => { sent.push(response) })
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          agent.onNativeEvent({ method: 'bridge/requested', params: { ...binding, sequence: 1, requestId: 'bridge-error', bridge: 'tool', op: 'execute', input: {} }, binding })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 2, status: 'completed' }, binding })
        })
      },
      cancel: async () => {}, respond, dispose: async () => {},
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // The transport screens `bridge/respond` by key name only — `error` is not a
    // credential key — so a credential inside the message is this side's to remove.
    await vi.waitFor(() => { expect(respond).toHaveBeenCalledTimes(1) })
    expect(sent[0]).toEqual({ error: 'curl failed: Authorization: Bearer <redacted>' })
    await ctx.fiber.dispose()
  })

  it('asks the user once when a worker repeats one permission request id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ApprovalService)
    let prompts = 0
    ctx.on('approval/request', () => { prompts += 1; return Promise.resolve('allowed-once') })
    const session = ctx.sessions.create(SessionId('native-repeat-permission'))
    const agent = new FreeCodeGoNativeAgent(ctx, session.id, { provider: 'native', model: 'test' }, session)
    const binding = { engine: 'claude' as const, runtimeSessionId: 'native', harnessSessionId: 'native-repeat-permission', modelId: 'test', provider: 'native', artifactDigest: 'sha256:test', protocolAbi: 'test/1' }
    const responses: Array<{ id: string; response: unknown }> = []
    agent.attachNative({
      identity: binding,
      prompt: async () => {
        queueMicrotask(() => {
          const frame = { method: 'permission/requested' as const, params: { ...binding, sequence: 1, requestId: 'perm-dup', request: { toolName: 'shell', reason: 'run command' } }, binding }
          agent.onNativeEvent(frame)
          agent.onNativeEvent({ ...frame, params: { ...frame.params, sequence: 2 } })
          agent.onNativeEvent({ method: 'session/completed', params: { ...binding, sequence: 3, status: 'completed' }, binding })
        })
      },
      cancel: async () => {},
      respond: async (_method, id: string, response: unknown) => { responses.push({ id, response }) },
      dispose: async () => {},
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(responses).toHaveLength(1) })
    expect(prompts).toBe(1)
    expect(responses[0]).toEqual({ id: 'perm-dup', response: { type: 'approved' } })
    await ctx.fiber.dispose()
  })
})
