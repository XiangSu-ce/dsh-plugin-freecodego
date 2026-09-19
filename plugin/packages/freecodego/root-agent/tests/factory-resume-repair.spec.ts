import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
// The bare specifier, like every other FreeCodeGo suite: the package's public
// face is what the plugin actually ships.
import { FreeCodeGoNativeAgent } from '@deepseek-ai/dsh-freecodego-root-agent'
import { FreeCodeGoNativeAgentFactory } from '../src/factory.ts'
import type { NativeAgentOpenOptions, NativeAgentSession } from '../src/factory.ts'
import type { AgentEnginePlan } from '../src/engine-plan.ts'

const plan: AgentEnginePlan = {
  engineId: 'codex',
  generation: 1,
  artifactDigest: 'sha256:codex-v1',
  protocolAbi: 'freecodego-agent/1',
  modelId: 'codex-auto',
  routeBindingId: 'harness:codex:codex-auto',
  catalogRevision: 'harness-local',
  capabilityFingerprint: 'freecodego-codex-native',
}

/** One in-memory stored session: the log this double serves and records. */
class MemorySessionHandle implements SessionHandle {
  readonly access = 'write' as const
  readonly inheritedEventCount = SessionLogOffset(0)
  readonly log: SessionEvent[]

  constructor(
    readonly id: SessionId,
    readonly header: SessionHeader,
    initial: readonly SessionEvent[],
  ) {
    this.log = [...initial]
  }

  read(): Promise<SessionHandleReadResult> {
    return Promise.resolve({ eventState: 'detached', events: [...this.log] })
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    this.log.push(...events)
    return Promise.resolve()
  }

  flush(): Promise<void> { return Promise.resolve() }

  close(): Promise<void> { return Promise.resolve() }

  [Symbol.asyncDispose](): Promise<void> { return this.close() }
}

/** A tail a crash left open: the turn and its step started, nothing closed them. */
function interruptedTail(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
  ]
}

/** A native session whose every prompt reports exactly one completed turn. */
function completedTurnSession(options: NativeAgentOpenOptions, runtimeSessionId: string): NativeAgentSession {
  const identity = {
    engine: 'codex' as const,
    runtimeSessionId,
    harnessSessionId: options.harnessSessionId,
    modelId: options.modelId,
    provider: options.provider,
    artifactDigest: options.artifactDigest,
    protocolAbi: options.protocolAbi,
  }
  return {
    identity,
    prompt: async () => {
      queueMicrotask(() => {
        options.onEvent({
          method: 'assistant/final',
          params: { runtimeSessionId, harnessSessionId: options.harnessSessionId, sequence: 1, text: 'continued' },
          binding: identity,
        })
        options.onEvent({
          method: 'session/completed',
          params: { runtimeSessionId, harnessSessionId: options.harnessSessionId, sequence: 2, status: 'completed' },
          binding: identity,
        })
      })
    },
    cancel: async () => {},
    respond: async () => {},
    dispose: async () => {},
  }
}

describe('FreeCodeGo native resume repair', () => {
  it('closes a turn the crash left open, then continues its numbering', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const sessionId = SessionId('native-resume-interrupted')
    const handle = new MemorySessionHandle(sessionId, ctx.sessions.prepare(sessionId).header, interruptedTail())
    ctx.provide('sessionPersistence', { open: async () => handle } as never)
    const factory = new FreeCodeGoNativeAgentFactory(ctx, {
      openers: { codex: async options => completedTurnSession(options, 'thread-1') },
    })

    const resumed = await factory.resume(ctx, { resumeSessionId: sessionId, enginePlan: plan })

    // The closers are written through the SAME handle this resume holds, so the
    // repaired tail is what the next process opening this session reads — a
    // crash-recovered session must not leave the next reader an open turn. They
    // land before this session's own pre-live events.
    expect(handle.log.slice(0, 4).map(event => event.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(handle.log[3]?.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
    // Repaired once: the seed already carries them, so a suffix that re-appended
    // them would double every closer in the stored log.
    expect(handle.log.filter(event => event.type === 'turn/end')).toHaveLength(1)
    // The seed carries them too: the live log and the stored log cannot disagree
    // about whether turn 1 ended.
    expect(resumed.agent.session.snapshotEvents().slice(0, 4).map(event => event.type))
      .toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])

    const agent = resumed.agent as unknown as FreeCodeGoNativeAgent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    // Turn 1 was consumed by the crash, so the replacement turn is 2: reopening
    // turn 1 would either collide with the seed or hand the model a transcript
    // in which one turn ended twice.
    expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('turn/end')

    await resumed.dispose()
    await ctx.fiber.dispose()
  })
})
