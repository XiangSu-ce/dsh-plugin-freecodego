import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AdvisorEvidenceCache, FreeCodeGoAdvisorRuntime } from '../src/advisor.ts'

describe('FreeCodeGoAdvisorRuntime', () => {
  it('turns an explicit model review into a durable note and Agent steering', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Review the implementation.' }],
      }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Add a regression test for the changed route."}' }
          yield { type: 'usage' as const, usage: { inputTokens: 12, outputTokens: 9 } }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const steer = vi.fn()
    const inject = vi.fn()
    const agent = {
      id: 'advisor-agent',
      session: { id: 'advisor-session', header: {}, events, append },
      steer,
      inject,
    }

    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined)
    const finding = await runtime.reviewNow(agent as never)

    expect(finding).toMatchObject({ severity: 'concern', note: 'Add a regression test for the changed route.', turn: 1 })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'advisor/delivery',
      data: expect.objectContaining({ id: finding?.id, channel: 'steer' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'advisor/usage',
      // The legacy pinned `hy3` profile is aliased to the rotating-roster
      // `auto` route, which resolves to the current best free model.
      data: { provider: 'opencode', model: 'auto', inputTokens: 12, outputTokens: 9 },
    }))
    expect(steer).toHaveBeenCalledOnce()
    expect(inject).not.toHaveBeenCalled()
    expect(runtime.notes(agent as never)).toEqual([
      { ...finding, delivery: 'steer' },
    ])
  })

  it('keeps a finding when the review mentions another object afterwards', async () => {
    // The Advisor reads a review input it did not write and may quote from it. A
    // greedy brace span ran to the last `}` in the answer, so a quoted object
    // after the finding made the whole extraction unparseable and the finding was
    // dropped — the one failure mode that looks exactly like "the model had
    // nothing to say".
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Review the implementation.' }],
      }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Cover the empty-config branch."}\n\nThe diff also touched {"file":"config.ts"}.' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const agent = {
      id: 'advisor-agent-quoted',
      session: { id: 'advisor-session-quoted', header: {}, events, append: (type: SessionEvent['type'], data: unknown): void => { events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent) } },
      steer: vi.fn(),
      inject: vi.fn(),
    }

    const finding = await new FreeCodeGoAdvisorRuntime(ctx, undefined).reviewNow(agent as never)
    expect(finding).toMatchObject({ severity: 'concern', note: 'Cover the empty-config branch.' })
  })

  it('treats a severity with no note behind it as no finding at all', async () => {
    // The rule is the note, not the severity: an empty `blocker` is a claim the
    // model never actually made, and delivering it would steer the Agent on
    // nothing. Whitespace counts as empty.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Check this.' }],
      }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"blocker","note":"   "}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const steer = vi.fn()
    const inject = vi.fn()
    const agent = {
      id: 'advisor-agent',
      session: { id: 'advisor-session', header: {}, events, append },
      steer,
      inject,
    }

    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined)
    await expect(runtime.reviewNow(agent as never)).resolves.toBeUndefined()
    expect(events.some(event => event.type === 'advisor/note')).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  it('drops a late model finding after Advisor is disabled and keeps queue counts non-negative', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check this.' }] }) },
    ]
    // `undefined`, not `void`: `no-invalid-void-type` rejects `void` as a call-site
    // type argument, and the resolved value is never read.
    const release = Promise.withResolvers<undefined>()
    let turnStopping: ((input: { agent: unknown; turn: number; signal: AbortSignal }) => Promise<void>) | undefined
    let stored = {
      defaultModel: '', defaultEngine: '', advisorEnabled: true, advisorMode: 'async' as const,
      advisorProvider: 'freecodego', advisorModel: 'hy3', advisorAllowAgentControl: true,
      advisorInterruptCooldownTurns: 3,
    }
    const ctx = {
      on: (name: string, handler: unknown) => {
        if (name === 'agent/turn-stopping') turnStopping = handler as typeof turnStopping
      },
      llm: {
        async *stream() {
          await release.promise
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"blocker","note":"This result arrived too late."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const settings = {
      get: () => stored,
      update: async (patch: Partial<typeof stored>) => { stored = { ...stored, ...patch } },
    }
    const agent = {
      id: 'advisor-cancelled',
      session: {
        id: 'advisor-cancelled-session', header: {}, events,
        append: (type: SessionEvent['type'], data: unknown) => { events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent) },
      },
      steer: vi.fn(), inject: vi.fn(),
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, settings as never)

    await turnStopping?.({ agent, turn: 1, signal: new AbortController().signal })
    expect(runtime.status().queuedReviews).toBe(1)
    await runtime.update({ advisorEnabled: false })
    release.resolve(undefined)
    await vi.waitFor(() => { expect(runtime.status().queuedReviews).toBe(0) })

    expect(events.some(event => event.type === 'advisor/note')).toBe(false)
    expect(runtime.status().queuedReviews).toBeGreaterThanOrEqual(0)
  })

  it('feeds a delivered finding into project memory as a pending draft', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Check the route.' }],
      }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"blocker","note":"The login route drops the return URL."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const drafts: Array<{ readonly cwd: string; readonly severity: string; readonly note: string }> = []
    const agent = {
      id: 'advisor-memory',
      session: { id: 'advisor-memory-session', header: { cwd: '/work/project' }, events, append },
      steer: vi.fn(), inject: vi.fn(),
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined, {
      saveMemoryDraft: (cwd, advice) => { drafts.push({ cwd, ...advice }) },
    })
    const finding = await runtime.reviewNow(agent as never)
    expect(finding).toMatchObject({ severity: 'blocker' })
    expect(drafts).toEqual([{ cwd: '/work/project', severity: 'blocker', note: 'The login route drops the return URL.' }])
  })

  it('keeps steering working when the memory bridge throws', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check.' }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Cover the empty-config branch."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const agent = {
      id: 'advisor-memory-failure',
      session: { id: 'advisor-memory-failure-session', header: { cwd: '/work/project' }, events, append },
      steer: vi.fn(), inject: vi.fn(),
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined, {
      saveMemoryDraft: () => { throw new Error('memory store closed') },
    })
    const finding = await runtime.reviewNow(agent as never)
    expect(finding).toMatchObject({ severity: 'concern' })
    expect(events.some(event => event.type === 'advisor/delivery')).toBe(true)
  })

  it('isolates Advisor evidence to the latest turn and rejects tools outside the read-only review allowlist', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prior private token: secret-not-for-review.' }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: SessionSeq(3), time: 4, data: { turn: 2 } },
      { type: 'user/message', seq: SessionSeq(4), time: 5, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the current route only.' }] }) },
      { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const requests: any[] = []
    let calls = 0
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream(options: unknown) {
          requests.push(options)
          calls += 1
          if (calls === 1) {
            yield { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const }
            yield { type: 'tool-call-delta' as const, index: 0, id: 'advisor-evil' as never, name: 'bash', argumentsDelta: '{"command":"echo unsafe"}' }
            yield { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: 'advisor-evil' as never, name: 'bash', arguments: '{"command":"echo unsafe"}' } }
            yield { type: 'finish' as const, reason: { kind: 'tool-calls' as const } }
            return
          }
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Use a safe reviewer tool."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const agent = {
      id: 'advisor-isolated',
      session: {
        id: 'advisor-isolated-session', header: { cwd: process.cwd() }, events,
        append: (type: SessionEvent['type'], data: unknown) => { events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent) },
      },
      steer: vi.fn(), inject: vi.fn(),
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined)

    await expect(runtime.reviewNow(agent as never)).resolves.toMatchObject({ severity: 'concern', turn: 2 })
    expect(requests).toHaveLength(2)
    expect(requests[0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      'freecodego_advisor_read', 'freecodego_advisor_glob', 'freecodego_advisor_grep',
    ])
    expect(requests[0].system).toContain('Never use shell commands')
    expect(JSON.stringify(requests[0].messages)).toContain('Inspect the current route only.')
    expect(JSON.stringify(requests[0].messages)).not.toContain('secret-not-for-review')
    expect(JSON.stringify(requests[1].messages)).toContain('Unknown Advisor review tool: bash')
  })

  it('caps steering at five findings per session and injects afterwards', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ship it.' }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"blocker","note":"Blocker note."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const steer = vi.fn()
    const inject = vi.fn()
    const agent = {
      id: 'advisor-cooldown',
      session: { id: 'advisor-cooldown-session', header: {}, events, append },
      steer,
      inject,
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined)

    // Repeated blocker findings across fresh turns: steering stops at the cap.
    for (let turn = 2; turn <= 8; turn += 1) {
      await runtime.reviewNow(agent as never)
      events.push({ type: 'turn/start', seq: events.length, time: events.length, data: { turn } } as SessionEvent)
      events.push({ type: 'user/message', seq: events.length, time: events.length, data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Turn ${turn}.` }] }) } as SessionEvent)
      events.push({ type: 'turn/end', seq: events.length, time: events.length, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
    }

    expect(steer).toHaveBeenCalledTimes(5)
    const delivered = events.filter(event => event.type === 'advisor/delivery').map(event => event.data.channel)
    expect(delivered.filter(channel => channel === 'steer')).toHaveLength(5)
    expect(delivered.filter(channel => channel === 'inject')).toHaveLength(2)
    expect(events.filter(event => event.type === 'advisor/note')).toHaveLength(7)
  })

  it('steers a concern only after the interrupt cooldown elapses', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ship it.' }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Concern note."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const steer = vi.fn()
    const inject = vi.fn()
    const agent = {
      id: 'advisor-concern-cooldown',
      session: { id: 'advisor-concern-cooldown-session', header: {}, events, append },
      steer,
      inject,
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined)

    // Default cooldown of 3: reviewing turns 1-7 steers on 1, 4, and 7; the rest inject.
    for (let turn = 2; turn <= 8; turn += 1) {
      await runtime.reviewNow(agent as never)
      events.push({ type: 'turn/start', seq: events.length, time: events.length, data: { turn } } as SessionEvent)
      events.push({ type: 'user/message', seq: events.length, time: events.length, data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Turn ${turn}.` }] }) } as SessionEvent)
      events.push({ type: 'turn/end', seq: events.length, time: events.length, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
    }

    expect(steer).toHaveBeenCalledTimes(3)
    expect(inject).toHaveBeenCalledTimes(4)
    expect(steer.mock.calls.length).toBeLessThan(inject.mock.calls.length)
  })

  it('does not advance the reviewed position when a review fails', async () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Watch this.' }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const append = (type: SessionEvent['type'], data: unknown): void => {
      events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent)
    }
    let calls = 0
    const ctx = {
      on: vi.fn(),
      llm: {
        async *stream() {
          calls += 1
          if (calls === 1) throw new Error('reviewer route offline')
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Retry reached a finding."}' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const steer = vi.fn()
    const inject = vi.fn()
    const agent = {
      id: 'advisor-failure',
      session: { id: 'advisor-failure-session', header: {}, events, append },
      steer,
      inject,
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined)

    await expect(runtime.reviewNow(agent as never)).resolves.toBeUndefined()
    expect(events.some(event => event.type === 'advisor/state' && event.data.state === 'error')).toBe(true)

    // The failed delta is still unreviewed, so the retry observes the same turn.
    await expect(runtime.reviewNow(agent as never)).resolves.toMatchObject({ severity: 'concern' })
    expect(calls).toBe(2)
  })
})

describe('AdvisorEvidenceCache', () => {
  const call = (name: string, args: string): never => ({ type: 'tool-call', id: `c-${name}`, name, arguments: args }) as never

  it('reports an unreadable path as a tool error instead of rejecting the review', async () => {
    const cache = new AdvisorEvidenceCache()
    const missing = call('freecodego_advisor_read', JSON.stringify({ path: 'does-not-exist.ts' }))
    const result = await cache.execute(process.cwd(), missing, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Read-only review tool failed')
    // A failure is never cached: a peer retrying a transient error is correct.
    expect(cache.size).toBe(0)
  })

  it('treats the same request from a different perspective as the same evidence', async () => {
    const cache = new AdvisorEvidenceCache()
    const target = call('freecodego_advisor_read', JSON.stringify({ path: 'package.json' }))
    const a = await cache.execute(process.cwd(), target, new AbortController().signal)
    const b = await cache.execute(process.cwd(), target, new AbortController().signal)
    expect(b.text).toBe(a.text)
    expect(cache.size).toBe(1)
  })

  it('keeps two workspaces apart, because a relative path is relative to one of them', async () => {
    // The key used to be the request alone, which is only complete once the root it
    // resolves against is in it: `read("package.json")` is a different question in a
    // different checkout, and the answer is rendered relative to that root as well.
    const cache = new AdvisorEvidenceCache()
    const left = await mkdtemp(join(tmpdir(), 'freecodego-advisor-left-'))
    const right = await mkdtemp(join(tmpdir(), 'freecodego-advisor-right-'))
    try {
      await writeFile(join(left, 'package.json'), '{"name":"left"}\n', 'utf8')
      await writeFile(join(right, 'package.json'), '{"name":"right"}\n', 'utf8')
      const target = call('freecodego_advisor_read', JSON.stringify({ path: 'package.json' }))
      const signal = new AbortController().signal
      const fromLeft = await cache.execute(left, target, signal)
      const fromRight = await cache.execute(right, target, signal)
      expect(fromLeft.text).toContain('"left"')
      expect(fromRight.text).toContain('"right"')
      // Two questions, two entries — not one answer served to both.
      expect(cache.size).toBe(2)
      // And a repeat inside one workspace is still one execution, which is what the
      // cache exists for.
      expect(await cache.execute(left, target, signal)).toBe(fromLeft)
    } finally {
      await rm(left, { recursive: true, force: true })
      await rm(right, { recursive: true, force: true })
    }
  })

  it('collapses two perspectives that ask the same question at the same moment', async () => {
    // The perspectives are launched together, so their first identical read is
    // concurrent. Identity of the returned record is what proves one execution:
    // two runs would produce two distinct objects with equal text.
    const cache = new AdvisorEvidenceCache()
    const target = call('freecodego_advisor_read', JSON.stringify({ path: 'package.json' }))
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([cache.execute(process.cwd(), target, signal), cache.execute(process.cwd(), target, signal)])
    expect(a).toBe(b)
    expect(cache.size).toBe(1)
    // A settled entry is still served by key, and the in-flight slot is released.
    const again = await cache.execute(process.cwd(), target, signal)
    expect(again).toBe(a)
  })

  it('refuses a credential file a workspace path would otherwise reach', async () => {
    // The review tools run inside this plugin, not through the guarded tool
    // registry, so the credential shield has to be here or not at all. Without
    // it `.env` is the one file the whole guard suite blocks by name — `read`,
    // the native engine's file tools, and `read_document` all refuse it — and
    // the Advisor would hand its contents back in a review transcript.
    const cache = new AdvisorEvidenceCache()
    const root = await mkdtemp(join(tmpdir(), 'freecodego-advisor-credentials-'))
    try {
      await writeFile(join(root, '.env'), 'SERVICE_TOKEN=sk-live-abcdefghijklmnopqrstuvwxyz\n', 'utf8')
      await writeFile(join(root, 'app.ts'), 'export const answer = 42\n', 'utf8')
      const signal = new AbortController().signal

      const read = await cache.execute(root, call('freecodego_advisor_read', JSON.stringify({ path: '.env' })), signal)
      expect(read.ok).toBe(false)
      expect(read.text).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz')
      expect(read.text).toContain('credential')

      // A grep is the same leak one layer out: it returns the matching lines.
      const grep = await cache.execute(root, call('freecodego_advisor_grep', JSON.stringify({ query: 'SERVICE_TOKEN' })), signal)
      expect(grep.text).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz')

      // The shield is about content, not about pretending the file is absent:
      // ordinary files stay readable, and naming the file in a listing is not a
      // credential read anywhere else in this plugin either.
      const ordinary = await cache.execute(root, call('freecodego_advisor_read', JSON.stringify({ path: 'app.ts' })), signal)
      expect(ordinary.ok).toBe(true)
      expect(ordinary.text).toContain('answer = 42')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keys on the arguments, so a different query is a different entry', async () => {
    const cache = new AdvisorEvidenceCache()
    const signal = new AbortController().signal
    await cache.execute(process.cwd(), call('freecodego_advisor_glob', JSON.stringify({ pattern: 'package.json' })), signal)
    await cache.execute(process.cwd(), call('freecodego_advisor_glob', JSON.stringify({ pattern: 'tsconfig.json' })), signal)
    expect(cache.size).toBe(2)
  })

  it('short-circuits when no workspace is associated', async () => {
    const cache = new AdvisorEvidenceCache()
    const result = await cache.execute(undefined, call('freecodego_advisor_read', JSON.stringify({ path: 'a.ts' })), new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('No workspace')
  })
})

describe('side-channel budget invariant', () => {
  const scenario = (threshold?: number): { readonly warn: ReturnType<typeof vi.fn>; readonly runtime: FreeCodeGoAdvisorRuntime; readonly agent: unknown } => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      // A long turn, so the reviewer's prompt is genuinely large relative to a
      // modest threshold rather than the test relying on a tiny number.
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the implementation. '.repeat(500) }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const warn = vi.fn()
    const ctx = {
      on: vi.fn(),
      logger: { warn },
      llm: {
        async *stream() {
          yield { type: 'text-delta' as const, index: 0, text: '{"severity":"nit","note":""}' }
          yield { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 2 } }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const agent = {
      id: 'budget-agent',
      session: { id: 'budget-session', header: {}, events, append: () => undefined },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    const runtime = new FreeCodeGoAdvisorRuntime(ctx, undefined, {
      ...(threshold === undefined ? {} : { sideChannelBudget: () => ({ mainLoopTokens: 1_000, compactionThresholdTokens: threshold }) }),
    })
    return { warn, runtime, agent }
  }

  it('warns and records when the reviewer prompt outgrows the conversation', async () => {
    // A threshold far below any real reviewer prompt, which is the point: the
    // failure is invisible from the conversation side, where the main loop is
    // still small while the reviewer's own prompt is already past the line.
    const { warn, runtime, agent } = scenario(2_000)
    await runtime.reviewNow(agent as never)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('side channel grew past the conversation')
    expect(runtime.sideChannelWarnings()[0]?.channel).toBe('advisor')
  })

  it('reports nothing when no threshold can be named', async () => {
    const { warn, runtime, agent } = scenario()
    await runtime.reviewNow(agent as never)
    expect(warn).not.toHaveBeenCalled()
    // An unmeasured channel is not evidence of a problem, and a channel judged
    // against an unknown line would be reported safe by default.
    expect(runtime.sideChannelWarnings()).toEqual([])
  })

  /**
   * A runtime whose `ctx.on` is recorded rather than ignored, so the disposal
   * handlers can be invoked directly. `agents.list()` is a mutable roster, which
   * is what makes the "agent id differs from session id" case reachable at all.
   */
  const disposableScenario = async (options: { readonly withWatchdog: boolean } = { withWatchdog: false }): Promise<{
    readonly handlers: Map<string, (payload: unknown) => void>
    readonly agents: unknown[]
    readonly runtime: FreeCodeGoAdvisorRuntime
    readonly agent: { readonly id: string; readonly session: { readonly id: string; header: Record<string, unknown>; readonly events: SessionEvent[]; append: (type: SessionEvent['type'], data: unknown) => void } }
    readonly workspace: string | undefined
  }> => {
    const workspace = options.withWatchdog ? await mkdtemp(join(tmpdir(), 'freecodego-advisor-dispose-')) : undefined
    if (workspace !== undefined) await writeFile(join(workspace, 'WATCHDOG.md'), 'Review for security regressions.', 'utf8')
    const handlers = new Map<string, (payload: unknown) => void>()
    const agents: unknown[] = []
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review this.' }] }) },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const ctx = {
      on: (name: string, handler: (payload: unknown) => void) => { handlers.set(name, handler) },
      agents: { list: () => agents },
      llm: {
        async *stream() {
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      },
    } as unknown as Context
    const agent = {
      id: 'dispose-agent',
      session: {
        id: 'dispose-session',
        header: workspace === undefined ? {} : { cwd: workspace },
        events,
        append: (type: SessionEvent['type'], data: unknown) => { events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent) },
      },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    return { handlers, agents, runtime: new FreeCodeGoAdvisorRuntime(ctx, undefined), agent, workspace }
  }

  it('retires per-agent state on session disposal even when the agent id differs from the session id', async () => {
    const { handlers, agents, runtime, agent, workspace } = await disposableScenario({ withWatchdog: true })
    // Keys are agent ids ('dispose-agent'); the disposal event carries the
    // session id ('dispose-session'), which never matches. Only the roster can
    // bridge the two, and without it the entry — and a stale `reviewedSeq` that
    // suppresses every later review — survives the conversation.
    await runtime.reviewNow(agent as never)
    expect(runtime.status().activeSessions).toBe(1)
    expect(runtime.status().watchdogFiles).toEqual([join(workspace!, 'WATCHDOG.md')])

    agents.push(agent)
    handlers.get('session/disposed')?.({ id: 'dispose-session' })
    expect(runtime.status().activeSessions).toBe(0)
    // The watchdog discovery is keyed by the agent id too, so it is released by
    // the same retirement rather than accumulating one entry per agent.
    expect(runtime.status().watchdogFiles).toEqual([])

    await rm(workspace!, { recursive: true, force: true })
  })

  it('retires per-agent state on agent disposal, naming the id outright', async () => {
    const { handlers, runtime, agent } = await disposableScenario()
    await runtime.reviewNow(agent as never)
    expect(runtime.status().activeSessions).toBe(1)
    // No roster is needed here: the agent event carries the key itself, so this
    // path works even when the roster has already been emptied.
    handlers.get('agent/disposed')?.({ agent })
    expect(runtime.status().activeSessions).toBe(0)
  })

  it('ignores a disposal payload with no usable id', async () => {
    const { handlers, runtime, agent } = await disposableScenario()
    await runtime.reviewNow(agent as never)
    expect(runtime.status().activeSessions).toBe(1)
    // An empty id must not retire the whole map: one malformed payload from the
    // Host would otherwise drop every live conversation's review state.
    handlers.get('agent/disposed')?.({ agent: { id: '' } })
    handlers.get('session/disposed')?.({ id: '' })
    expect(runtime.status().activeSessions).toBe(1)
  })
})
