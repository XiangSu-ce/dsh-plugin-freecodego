/**
 * Coverage for the two shapes the Harness's own Auto review gate leaves open.
 *
 * Two halves, and the first is the one that keeps the second honest: the
 * vocabulary this module reads off another package — the refusal code, the
 * failure prefix, and the exact call shape the gate excludes — is pinned against
 * that package's source. A rename upstream then fails a test here, rather than
 * quietly turning this coverage into a no-op that still reports green.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  FREECODEGO_DENIAL_CODE,
  HARNESS_AUTO_DENIAL_CODE,
  HARNESS_AUTO_FAILURE_PREFIX,
  OUTER_SCRIPT_TOOL,
  installReviewCoverage,
  isReviewerFailure,
  isReviewerVerdict,
  isUnreviewedOuterScript,
  needsUserDetail,
  type PendingToolCallLike,
  type PreToolDecisionLike,
} from '../src/review-coverage.ts'
import { ActionReviewState } from '../src/action-review.ts'
import type { ActionReviewAgentLike, ActionReviewerLlm } from '../src/action-reviewer.ts'

const SESSION = 'session-auto-1' as SessionId
const ROUTE = { provider: 'opencode', model: 'auto' } as const

/** The Harness's own Auto review module, read as text: the vocabulary this module shares. */
const UPSTREAM_SOURCE = new URL('../../../experimental/auto-review/src/index.ts', import.meta.url)

/** One session event, as the reviewer's transcript resolver reads it. */
function event(type: string, data: unknown): { readonly type: string; readonly data: unknown } {
  return { type, data }
}

/** A session carrying one `run_code` call, which is what the reviewer has to resolve. */
function sessionWithScript(callId: string, script: string): ActionReviewAgentLike['session'] {
  return {
    id: SESSION,
    snapshotEvents: () => [
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'run the migration' }] }),
      event('tool/call', { id: callId, name: OUTER_SCRIPT_TOOL, arguments: JSON.stringify({ code: script }) }),
    ],
  }
}

/** The agent view a pending call carries. */
function agentFor(callId: string, script = 'print(1)'): ActionReviewAgentLike {
  return { id: 'agent-1', session: sessionWithScript(callId, script) }
}

function recordingLlm(produce: () => readonly StreamChunk[]): { llm: ActionReviewerLlm; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  return {
    requests,
    llm: {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const chunks = produce()
        return (async function* generate(): AsyncGenerator<StreamChunk> {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

function completed(text: string, reason: FinishReason = { kind: 'stop' }): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason },
  ]
}

/** A host that keeps the listeners, plus a driver that runs them as one waterfall. */
function capturingHost(): {
  install: (deps: Parameters<typeof installReviewCoverage>[1], state?: ActionReviewState) => void;
  run: (exec: PendingToolCallLike, downstream: PreToolDecisionLike | (() => Promise<PreToolDecisionLike>)) => Promise<PreToolDecisionLike>;
} {
  const handlers: ((exec: PendingToolCallLike, next: () => Promise<PreToolDecisionLike>) => Promise<PreToolDecisionLike>)[] = []
  return {
    install: (deps, state) => {
      installReviewCoverage({
        on: (_event, handler) => {
          handlers.push(handler)
          return () => undefined
        },
      }, deps, state)
    },
    run: async (exec, downstream) => {
      const terminal = async (): Promise<PreToolDecisionLike> =>
        (typeof downstream === 'function' ? await downstream() : downstream)
      const dispatch = async (index: number): Promise<PreToolDecisionLike> => {
        const handler = handlers[index]
        if (handler === undefined) return await terminal()
        return await handler(exec, () => dispatch(index + 1))
      }
      return await dispatch(0)
    },
  }
}

/** A refusal exactly as the Harness gate's `failed()` builds one: no `info` at all. */
function harnessFailure(tool: string): PreToolDecisionLike {
  return {
    kind: 'deny',
    reason: `${HARNESS_AUTO_FAILURE_PREFIX} "${tool}" failed; its body was not executed: socket hang up`,
  }
}

/** A refusal exactly as the Harness gate's `denied()` builds one. */
function harnessDenial(tool: string): PreToolDecisionLike {
  return {
    kind: 'deny',
    reason: `Auto review rejected tool "${tool}"; its body was not executed`,
    info: { name: 'AutoReviewDeniedError', code: HARNESS_AUTO_DENIAL_CODE },
  }
}

const OWNED = { harnessOwnsSession: (): boolean => true }

describe('the vocabulary shared with the Harness Auto review gate', () => {
  it('is still the vocabulary that module declares', async () => {
    const source = await readFile(UPSTREAM_SOURCE, 'utf8')
    // The refusal code: what separates a judged refusal from a failed reviewer.
    expect(source).toContain(`AUTO_REVIEW_DENIED_CODE = '${HARNESS_AUTO_DENIAL_CODE}'`)
    // The failure message: the only other thing a failure carries.
    expect(source).toContain('`Auto review of tool "${exec.name}" failed; its body was not executed: ${message}`')
    // A considered refusal, which must not carry that prefix.
    expect(source).toContain('`Auto review rejected tool "${exec.name}"; its body was not executed`')
    // The excluded shape, as that module's own first branch spells it.
    expect(source).toContain('exec.parent === undefined && exec.name === RUN_CODE_NAME')
  })
})

describe('isUnreviewedOuterScript', () => {
  it('is true only for the root script call the gate excludes', () => {
    expect(isUnreviewedOuterScript({ name: OUTER_SCRIPT_TOOL })).toBe(true)
    // A nested PTC dispatch is a call the gate *does* review.
    expect(isUnreviewedOuterScript({ name: OUTER_SCRIPT_TOOL, parent: {} })).toBe(false)
    expect(isUnreviewedOuterScript({ name: 'bash' })).toBe(false)
  })
})

describe('reading a refusal', () => {
  it('tells a reviewer verdict from a reviewer failure', () => {
    expect(isReviewerVerdict(harnessDenial('bash'))).toBe(true)
    expect(isReviewerVerdict(harnessFailure('bash'))).toBe(false)
    expect(isReviewerFailure(harnessFailure('bash'))).toBe(true)
    expect(isReviewerFailure(harnessDenial('bash'))).toBe(false)
  })

  it('does not read another gate\'s refusal as a reviewer failure', () => {
    expect(isReviewerFailure({ kind: 'deny', reason: 'Refused by Plan Mode: "bash" changes files.' })).toBe(false)
  })

  it('is not fooled by a failure message that gained an info field', () => {
    // A denial carrying a code is a verdict whatever its reason says, so the two
    // facts have to be read together rather than by the message alone.
    expect(isReviewerFailure({
      kind: 'deny',
      reason: `${HARNESS_AUTO_FAILURE_PREFIX} "bash" failed; its body was not executed: x`,
      info: { code: 'SOMETHING_ELSE' },
    })).toBe(false)
  })
})

describe('installReviewCoverage: a reviewer failure becomes the user\'s decision', () => {
  const deps = {
    enabled: (): boolean => true,
    route: (): { readonly provider: string; readonly model: string } => ROUTE,
    llm: recordingLlm(() => completed('{"verdict":"allow"}')).llm,
    ...OWNED,
  }

  it('rewrites a failure refusal into an ask, keeping the cause', async () => {
    const host = capturingHost()
    const audited: string[] = []
    host.install({ ...deps, audit: line => audited.push(line) })
    const decision = await host.run({ name: 'bash', agent: agentFor('call-1') }, harnessFailure('bash'))
    expect(decision.kind).toBe('ask')
    expect(String(decision.kind === 'ask' ? decision.reason : '')).toContain('failed; its body was not executed')
    expect(decision.kind === 'ask' ? decision.displayReason?.zh : '').toContain('需要你来决定')
    expect(audited.join('\n')).toContain('could not judge bash')
  })

  it('leaves a considered refusal exactly as the gate produced it', async () => {
    const host = capturingHost()
    host.install(deps)
    const decision = await host.run({ name: 'bash', agent: agentFor('call-1') }, harnessDenial('bash'))
    expect(decision).toEqual(harnessDenial('bash'))
  })

  it('leaves every decision alone when the gate does not own the session', async () => {
    const host = capturingHost()
    host.install({ ...deps, harnessOwnsSession: () => false })
    const decision = await host.run({ name: 'bash', agent: agentFor('call-1') }, harnessFailure('bash'))
    expect(decision.kind).toBe('deny')
  })

  it('leaves every decision alone when the reviewer is switched off', async () => {
    const host = capturingHost()
    host.install({ ...deps, enabled: () => false })
    const decision = await host.run({ name: 'bash', agent: agentFor('call-1') }, harnessFailure('bash'))
    expect(decision.kind).toBe('deny')
  })

  it('never rewrites a decision another gate made for its own reasons', async () => {
    const host = capturingHost()
    host.install(deps)
    const decision = await host.run({ name: 'bash', agent: agentFor('call-1') }, { kind: 'deny', reason: 'the command policy forbids this' })
    expect(decision.kind).toBe('deny')
  })
})

describe('installReviewCoverage: the outer script the Harness gate declines', () => {
  function depsFor(produce: () => readonly StreamChunk[]): Parameters<typeof installReviewCoverage>[1] {
    return {
      enabled: () => true,
      route: () => ROUTE,
      llm: recordingLlm(produce).llm,
      ...OWNED,
    }
  }

  it('reviews that call and returns the reviewer\'s verdict', async () => {
    const host = capturingHost()
    const audited: string[] = []
    host.install({ ...depsFor(() => completed('{"verdict":"allow","rationale":"reads the workspace"}')), audit: line => audited.push(line) })
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'call-9' }, { kind: 'allow' })
    expect(decision).toEqual({ kind: 'allow' })
    expect(audited.join('\n')).toContain('was allowed by')
  })

  it('marks its own refusal with a code, so it is not read as a failure', async () => {
    const host = capturingHost()
    host.install(depsFor(() => completed('{"verdict":"deny","rationale":"publishes to the network"}')))
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'call-9' }, { kind: 'allow' })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' ? decision.info?.code : undefined).toBe(FREECODEGO_DENIAL_CODE)
    expect(isReviewerVerdict(decision)).toBe(true)
  })

  it('asks the user when the reviewer itself fails', async () => {
    const host = capturingHost()
    host.install(depsFor(() => completed('', { kind: 'error', failure: { code: 'E', message: 'socket hang up' } })))
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'call-9' }, { kind: 'allow' })
    expect(decision.kind).toBe('ask')
  })

  it('leaves the call to the Host when no reviewer is configured, and says so', async () => {
    const host = capturingHost()
    const audited: string[] = []
    host.install({ ...depsFor(() => completed('{"verdict":"allow"}')), llm: undefined, audit: line => audited.push(line) })
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'call-9' }, { kind: 'allow' })
    expect(decision).toEqual({ kind: 'allow' })
    expect(audited.join('\n')).toContain('no reviewer configured')
  })

  it('leaves every other call untouched', async () => {
    const host = capturingHost()
    const requests = recordingLlm(() => completed('{"verdict":"deny","rationale":"should not be read"}'))
    host.install({ enabled: () => true, route: () => ROUTE, llm: requests.llm, ...OWNED })
    const decision = await host.run({ name: 'bash', agent: agentFor('call-1') }, { kind: 'allow' })
    expect(decision).toEqual({ kind: 'allow' })
    expect(requests.requests).toEqual([])
  })

  it('leaves the script alone when its call cannot be resolved', async () => {
    const host = capturingHost()
    const audited: string[] = []
    host.install({ ...depsFor(() => completed('{"verdict":"allow"}')), audit: line => audited.push(line) })
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'not-the-call' }, { kind: 'allow' })
    expect(decision).toEqual({ kind: 'allow' })
    expect(audited.join('\n')).toContain('could not be resolved')
  })

  it('does not answer for a session the Harness gate does not own', async () => {
    const host = capturingHost()
    host.install({ ...depsFor(() => completed('{"verdict":"deny","rationale":"x"}')), harnessOwnsSession: () => false })
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'call-9' }, { kind: 'allow' })
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('bounds its own spending with the shared per-session budget', async () => {
    const host = capturingHost()
    host.install({
      ...depsFor(() => completed('{"verdict":"allow","rationale":"fine"}')),
      // A budget of zero: every review is exhausted before it runs, which is the
      // same path an unconfigured reviewer takes — the user's decision.
    }, new ActionReviewState(0))
    const decision = await host.run({ name: OUTER_SCRIPT_TOOL, agent: agentFor('call-9'), callId: 'call-9' }, { kind: 'allow' })
    expect(decision.kind).toBe('ask')
  })
})

describe('needsUserDetail', () => {
  it('localises the same sentence the gate localises', () => {
    expect(Object.keys(needsUserDetail('x')).sort()).toEqual(['en', 'zh'])
  })
})
