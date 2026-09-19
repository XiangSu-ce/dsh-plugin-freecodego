/**
 * The Advisor must review on its own, off the turn-stopping hook.
 *
 * Every existing Advisor test calls `reviewNow()` directly, so the automatic
 * path — the one a user actually depends on — had no coverage. These drive the
 * real subscription instead.
 *
 * `advisorMode: 'async'` is deliberate: the hook returns immediately and the
 * review settles in the background, bounded by CATCHUP_WAIT_MS. A test that
 * asserts straight after the hook therefore observes nothing and must wait.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoAdvisorRuntime } from '../src/advisor.ts'

interface Harness {
  readonly hooks: Map<string, (payload: never) => unknown>
  readonly events: SessionEvent[]
  readonly steered: () => number
  readonly streamed: () => number
  readonly runtime: FreeCodeGoAdvisorRuntime
  readonly agent: unknown
}

function harness(reply: string): Harness {
  const hooks = new Map<string, (payload: never) => unknown>()
  const events: SessionEvent[] = [
    { type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ship the parser change.' }] }) },
  ]
  let streams = 0
  let steers = 0
  const ctx = {
    on: (name: string, handler: (payload: never) => unknown) => { hooks.set(name, handler); return () => hooks.delete(name) },
    llm: {
      async *stream() {
        streams += 1
        yield { type: 'text-delta' as const, index: 0, text: reply }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    },
  }
  const agent = {
    id: 'auto-agent',
    session: { id: 'auto-session', header: { cwd: process.cwd() }, events, seq: 1, append: (type: string, data: unknown) => { events.push({ type, seq: events.length, time: 1, data } as SessionEvent) } },
    steer: () => { steers += 1 },
    inject: () => undefined,
  }
  return { hooks, events, steered: () => steers, streamed: () => streams, runtime: new FreeCodeGoAdvisorRuntime(ctx as never, undefined, {}), agent }
}

/** Let the background review settle. */
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 400)) }

describe('advisor automatic trigger', () => {
  it('registers the turn-stopping hook on construction', () => {
    const { hooks } = harness('{"severity":"nit","note":""}')
    expect([...hooks.keys()]).toContain('agent/turn-stopping')
  })

  it('reviews and persists a finding when a turn stops, with nobody calling reviewNow', async () => {
    const h = harness('{"severity":"concern","note":"Add a regression test for the changed route."}')
    await h.hooks.get('agent/turn-stopping')!({ agent: h.agent, turn: 1, signal: new AbortController().signal } as never)
    await settle()
    expect(h.streamed(), 'a stopped turn must trigger a review').toBe(1)
    // Durable evidence: the note is what the settings panel counts and what
    // `advisorNotes` replays. Without it the panel shows 0 forever.
    expect(h.events.some(event => event.type === 'advisor/note')).toBe(true)
    expect(h.events.some(event => event.type === 'advisor/delivery')).toBe(true)
    expect(h.runtime.status().noteCount).toBe(1)
    expect(h.steered()).toBe(1)
  })

  it('counts the session as active, which is what the settings panel reports', async () => {
    const h = harness('{"severity":"concern","note":"note"}')
    // Before any review the map is empty — this is the state the panel renders
    // as "0 active sessions" on a freshly started host.
    expect(h.runtime.status().activeSessions).toBe(0)
    await h.hooks.get('agent/turn-stopping')!({ agent: h.agent, turn: 1, signal: new AbortController().signal } as never)
    await settle()
    expect(h.runtime.status().activeSessions).toBe(1)
  })

  it('records no note when the model reports nothing worth saying', async () => {
    const h = harness('{"severity":"nit","note":""}')
    await h.hooks.get('agent/turn-stopping')!({ agent: h.agent, turn: 1, signal: new AbortController().signal } as never)
    await settle()
    expect(h.streamed()).toBe(1)
    expect(h.events.some(event => event.type === 'advisor/note')).toBe(false)
    expect(h.runtime.status().noteCount).toBe(0)
  })
})
