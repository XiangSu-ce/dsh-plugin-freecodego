/**
 * The Advisor reviews through the Harness's own read-only tools.
 *
 * What this replaced
 * ------------------
 * The plugin used to ship three tools of its own — `freecodego_advisor_read`,
 * `_glob`, and `_grep` — implemented over `node:fs`: a 7-level walk, a
 * literal-text scan, its own read cap, and its own credential check, because the
 * reviewer's calls did not go through the tool registry. Every one of those was a
 * second answer to a question the Harness already answers better: its `read`,
 * `glob`, and `grep` run on the mounted filesystem seam (so a sandboxed or remote
 * workspace works), through `tools/pre-execute` (where this plugin's own
 * credential-path guard already sits, symlink resolution included), and with
 * their own output paging.
 *
 * So the reviewer is now offered the Harness's schemas and its calls are
 * dispatched through `ctx.tools.execute`. These tests drive the real review loop
 * (`reviewNow`) with a fake registry, and assert the three things that survive
 * from the old design: the tools offered are the Harness's, the call is dispatched
 * with the calling agent and the parsed arguments, and an answer that was cut is
 * *named* as cut — a reviewer told "Do not claim facts without evidence" cannot
 * weigh a prefix it was not told about.
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { FreeCodeGoAdvisorRuntime } from '../src/advisor.ts'

interface Bench {
  readonly requests: any[]
  readonly executed: Array<{ readonly name: string; readonly arguments: unknown; readonly agent: unknown }>
  readonly review: () => Promise<unknown>
}

const HARSH_TEXT = `${'A sentence of ordinary prose that the reviewer reads as evidence. '.repeat(200)}SENTINEL PAST THE REVIEW CUT`

/**
 * One explicit review whose first request calls `call`, and whose second request
 * answers with a finding.
 * @param options - the tool call the reviewer makes, the registry to answer it (or none), and its answer text.
 * @returns the captured requests, the dispatched calls, and the review promise.
 */
function bench(options: {
  readonly call?: { readonly name: string; readonly arguments: Record<string, unknown> }
  readonly registry?: 'mounted' | 'absent'
  readonly answer?: string
  readonly answerIsError?: boolean
} = {}): Bench {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ship the parser change.' }] }) },
    { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const requests: any[] = []
  const executed: Bench['executed'] = []
  let streams = 0
  const schemas = ['read', 'glob', 'grep', 'bash'].map(name => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } }))
  const execute = vi.fn(async (input: { name: string; arguments: unknown; agent: unknown }) => {
    executed.push({ name: input.name, arguments: input.arguments, agent: input.agent })
    const content: ContentBlock[] = [{ type: 'text', text: options.answer ?? 'ok' }]
    return { isError: options.answerIsError ?? false, content }
  })
  const registry = { schemas: () => schemas, execute }
  const ctx = {
    on: vi.fn(),
    get: (key: string) => key === 'tools' && options.registry !== 'absent' ? registry : undefined,
    llm: {
      async *stream(request: unknown) {
        requests.push(request)
        streams += 1
        if (streams === 1 && options.call !== undefined) {
          const name = options.call.name
          const argumentsText = JSON.stringify(options.call.arguments)
          yield { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const }
          yield { type: 'tool-call-delta' as const, index: 0, id: 'c-1' as never, name, argumentsDelta: argumentsText }
          yield { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: 'c-1' as never, name, arguments: argumentsText } }
          yield { type: 'finish' as const, reason: { kind: 'tool-calls' as const } }
          return
        }
        yield { type: 'text-delta' as const, index: 0, text: '{"severity":"concern","note":"Check the retry path."}' }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    },
  }
  const agent = {
    id: 'advisor-tools',
    session: {
      id: 'advisor-tools-session', header: { cwd: process.cwd() }, events, seq: 2,
      append: (type: SessionEvent['type'], data: unknown) => { events.push({ type, seq: events.length, time: events.length + 1, data } as SessionEvent) },
    },
    steer: vi.fn(), inject: vi.fn(),
  }
  const runtime = new FreeCodeGoAdvisorRuntime(ctx as never, undefined)
  return { requests, executed, review: () => runtime.reviewNow(agent as never) }
}

describe('advisor review tools are the Harness\'s', () => {
  it('offers the mounted read-only schemas, dispatches the call with its agent, and names a cut answer', async () => {
    const b = bench({ call: { name: 'read', arguments: { path: 'notes.md' } }, answer: HARSH_TEXT })

    await expect(b.review()).resolves.toMatchObject({ severity: 'concern' })

    // The Harness's schemas, not the plugin's own three: `bash` is mounted but
    // never offered, and the reviewer's own list is exactly the read-only trio.
    expect(b.requests[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['read', 'glob', 'grep'])
    // Dispatched through the registry, with the calling agent and the caller's
    // arguments — the workspace is the session's, which the tool resolves itself.
    expect(b.executed).toHaveLength(1)
    expect(b.executed[0]).toMatchObject({ name: 'read', arguments: { path: 'notes.md' } })
    expect((b.executed[0]!.agent as { id: string }).id).toBe('advisor-tools')
    // And the cut is in the text the reviewer is handed, because a prefix it was
    // not told about is a prefix it will reason about as if it were whole.
    const second = JSON.stringify(b.requests[1].messages)
    expect(second).toContain('truncated: showing the first 8000 of')
    // The sentinel sits past the cut, so its absence is the assertion: the
    // reviewer is handed a prefix and told it is one.
    expect(second).not.toContain('SENTINEL PAST THE REVIEW CUT')
  })

  it('runs the review without evidence when no registry is mounted, and says so in the prompt', async () => {
    const b = bench({ call: { name: 'read', arguments: { path: 'notes.md' } }, registry: 'absent' })

    await expect(b.review()).resolves.toMatchObject({ severity: 'concern' })
    expect(b.requests[0].tools).toEqual([])
    expect(b.requests[0].system).toContain('No read-only review tools are mounted')
    // The call is refused with a reason the reviewer can act on rather than a
    // crash: the transcript still carries the finding.
    expect(JSON.stringify(b.requests[1].messages)).toContain('No tool registry is mounted in this deployment')
    expect(b.executed).toEqual([])
  })

  it('refuses a tool outside the read-only trio without dispatching it', async () => {
    const b = bench({ call: { name: 'bash', arguments: { command: 'rm -rf /' } } })

    await expect(b.review()).resolves.toMatchObject({ severity: 'concern' })
    expect(b.executed).toEqual([])
    expect(JSON.stringify(b.requests[1].messages)).toContain('Unknown Advisor review tool: bash')
  })

  it('reports a failed tool call back to the reviewer instead of failing the review', async () => {
    const b = bench({ call: { name: 'read', arguments: { path: '.env' } }, answer: 'Blocked by the FreeCodeGo credential guard', answerIsError: true })

    await expect(b.review()).resolves.toMatchObject({ severity: 'concern' })
    // The guard's own refusal text (the registry's pre-execute pipeline is where
    // it lives now) reaches the reviewer, which is the point: it learns the file
    // is unavailable rather than receiving its contents.
    expect(JSON.stringify(b.requests[1].messages)).toContain('Blocked by the FreeCodeGo credential guard')
    expect(JSON.stringify(b.requests[1].messages)).not.toContain('sk-live')
  })
})
