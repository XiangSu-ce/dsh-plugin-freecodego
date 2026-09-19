/**
 * The council's two-field verdict, and where a participant's model comes from.
 *
 * Two defects are pinned here. First, `riskGate` and `state` were computed from
 * separate predicates and disagreed in one cell: a review that missed quorum
 * without emitting any blocker was `state: 'blocked'` while claiming
 * `riskGate: 'clear'`, and the only reader of the gate sat behind a state guard
 * that had already refused every report the gate could have caught. Second, the
 * DeepSeek participant fell back to a hardcoded `deepseek-v4-flash` (and Claude
 * to a hardcoded id) whenever the selected model did not belong to that engine,
 * so the council reviewed the plan on a model the user never selected and said
 * nothing about it.
 *
 * The runs below are real: `run()` drives the whole state machine against a fake
 * `ctx.agents.create`, so a participant's model is asserted on the AgentOptions
 * the council actually passed to the child, not on a helper re-implementing the
 * resolution. A non-git workspace keeps `workspaceRevisionFor` returning nothing,
 * which is what the seeded reports assume.
 *
 * Third, both the caller's cancellation and the council's own deadline abort the
 * one combined signal the run reads, and the run reported any abort as
 * 'cancelled': a council that ran out of time was durable-reported, handed to the
 * model, and shown in the job as a cancellation the user never made. The two are
 * now told apart by the abort reason (`AbortSignal.timeout` aborts with a
 * `TimeoutError`), and the deadline names itself in the report.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FreeCodeGoEngineCouncil } from '../src/engine-council.ts'
import type { FreeCodeGoEngineeringCouncilDecision, FreeCodeGoEngineeringCouncilEngine, FreeCodeGoEngineeringCouncilReport } from '../src/types.ts'

interface SessionEventLike { readonly type: string; readonly data: unknown }

/** One child Agent the council asked the Host to create. */
interface CreatedChild {
  readonly engine: string
  readonly provider: string
  readonly model: string | undefined
  /** Whether the options carried a `model` key at all; an omitted key is how the
   * council delegates to the engine's own default. */
  readonly hasModel: boolean
}

type Defaults = {
  readonly engine: FreeCodeGoEngineeringCouncilEngine
  readonly provider: string
  readonly model?: string
  readonly models?: Partial<Record<FreeCodeGoEngineeringCouncilEngine, string>>
}

const directories: string[] = []
const objectives = { objective: 'Ship the reviewed change', plan: 'Edit app.ts to bump the version.' }

let workspace = ''
let events: SessionEventLike[] = []
let created: CreatedChild[] = []
let outputs = new Map<string, string>()
let uncreatable = new Set<string>()
let onChildCreated: ((engine: string) => void) | undefined
let counter = 0
let council: FreeCodeGoEngineCouncil

function makeCouncil(options: { readonly quorum?: number; readonly defaults?: () => Defaults } = {}): FreeCodeGoEngineCouncil {
  const quorum = options.quorum ?? 2
  return new FreeCodeGoEngineCouncil(
    { get: () => ({ engineeringEnabled: true, engineeringCouncilEnabled: true, engineeringCouncilQuorum: quorum, engineeringCouncilMaxConcurrent: 4, engineeringCouncilTimeoutMs: 30_000 }) },
    // Every engine gets a model, so the state matrix below is decided by the
    // participants and not by the model resolution under test further down.
    options.defaults ?? (() => ({ engine: 'deepseek', provider: 'freecodego', model: 'deepseek-v4-pro', models: { codex: 'gpt-5-codex', claude: 'claude-opus-4-6' } })),
  )
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-council-gate-'))
  directories.push(root)
  workspace = root
  events = []
  created = []
  outputs = new Map()
  uncreatable = new Set()
  onChildCreated = undefined
  counter = 0
  council = makeCouncil()
})

afterEach(async () => {
  vi.restoreAllMocks()
  council.dispose()
  // The revision probe's git children release their handle on the workspace a
  // moment after they exit, so the first rmdir can come back EBUSY on Windows.
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

/** Minimal parent Agent: the council reads durable events, appends new ones, and
 * creates its children through `ctx.agents`. */
function parent(): Agent {
  return {
    id: 'parent-agent',
    session: {
      id: 'session-1',
      header: { cwd: workspace, parentSession: undefined },
      seq: events.length,
      snapshotEvents: () => events,
      append: (type: string, data: unknown) => {
        const event = { type, data }
        events.push(event)
        return event
      },
    },
    ctx: {
      agents: {
        create: async (request: { readonly agentOptions?: { readonly freeCodeGoEngine?: string; readonly provider?: string; readonly model?: string } }) => {
          const agentOptions = request.agentOptions ?? {}
          const engine = agentOptions.freeCodeGoEngine ?? ''
          onChildCreated?.(engine)
          if (uncreatable.has(engine)) throw new Error(`${engine} runtime is not installed`)
          created.push({ engine, provider: agentOptions.provider ?? '', model: agentOptions.model, hasModel: 'model' in agentOptions })
          const text = outputs.get(engine) ?? 'Verdict: approve\nNo findings.'
          return {
            agent: {
              followup: () => undefined,
              whenIdle: async () => undefined,
              cancel: () => undefined,
              session: { snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }] },
            },
            dispose: async () => undefined,
          }
        },
      },
    },
    inject: () => undefined,
  } as unknown as Agent
}

function childFor(engine: string): CreatedChild | undefined {
  return created.find(child => child.engine === engine)
}

function participantFor(report: FreeCodeGoEngineeringCouncilReport, engine: FreeCodeGoEngineeringCouncilEngine) {
  return report.participants.find(participant => participant.engine === engine)
}

/** Seed a durable report into the session log, as a restored session would. The
 * id is handed to the patch so a decision can reference the report it belongs to;
 * `omitRiskGate` seeds a report written before the gate existed. */
function seedReport(patch: (id: string) => Partial<FreeCodeGoEngineeringCouncilReport> = () => ({}), options: { readonly omitRiskGate?: boolean } = {}): string {
  counter += 1
  const id = `council_${counter.toString(16).padStart(32, '0')}`
  const report: FreeCodeGoEngineeringCouncilReport = {
    id,
    sessionId: 'session-1',
    projectId: 'project-1',
    state: 'completed',
    createdAt: Date.now() - 60_000,
    completedAt: Date.now() - 30_000,
    objective: objectives.objective,
    plan: objectives.plan,
    rounds: 1,
    quorum: 2,
    participants: [],
    consensus: 'Two reviewers completed.',
    dissent: 'No participant failure was recorded.',
    finalRecommendation: 'Implement after user approval.',
    reportVersion: 2,
    findings: [],
    ...(options.omitRiskGate === true ? {} : { riskGate: 'clear' as const }),
    ...patch(id),
  }
  events.push({ type: 'freecodego/council', data: report })
  return id
}

/** An approved decision for a seeded report, valid for another ten minutes. */
function approval(id: string): FreeCodeGoEngineeringCouncilDecision {
  return { id, state: 'approved', decidedAt: Date.now() - 1_000, expiresAt: Date.now() + 600_000 }
}

async function refusal(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('council state and risk gate agree', () => {
  it('reports a cleared review as completed with a clear gate', async () => {
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex'], maxRounds: 1 })
    expect(report.state).toBe('completed')
    expect(report.riskGate).toBe('clear')
  })

  it('reports a quorum-reaching review with a failed engine as partial and clear', async () => {
    uncreatable.add('claude')
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex', 'claude'], maxRounds: 1 })
    expect(report.state).toBe('partial')
    expect(report.riskGate).toBe('clear')
  })

  it('reports a blocker as blocked with a blocked gate', async () => {
    outputs.set('codex', 'Verdict: block\nFINDING: blocker | Unscoped update | src/api.ts:42 accepts an unscoped update')
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex'], maxRounds: 1 })
    expect(report.state).toBe('blocked')
    expect(report.riskGate).toBe('blocked')
    expect(report.blockingFindings?.length).toBeGreaterThan(0)
  })

  it('does not clear the gate for a review that missed quorum without any blocker', async () => {
    // The disagreement this pins: one participant completed, none emitted a
    // blocker, quorum was 2. The review is blocked, so its risk verdict must be
    // blocked too — the old writer derived the gate from the blockers alone and
    // stamped 'clear' on a report it had just refused to let anyone act on.
    uncreatable.add('codex')
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex'], maxRounds: 1 })
    expect(report.blockingFindings).toBeUndefined()
    expect(report.participants.filter(participant => participant.state === 'completed')).toHaveLength(1)
    expect(report.state).toBe('blocked')
    expect(report.riskGate).toBe('blocked')
  })

  it('does not clear the gate for a cancelled review', async () => {
    const controller = new AbortController()
    onChildCreated = engine => { if (engine === 'codex') controller.abort('cancelled by user') }
    uncreatable.add('codex')
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex'], maxRounds: 1 }, controller.signal)
    expect(report.state).toBe('cancelled')
    expect(report.riskGate).toBe('blocked')
    // The reason is named and it is the caller's own: a stopped review must not
    // hand the model the generic "resolve the blocking findings" advice.
    expect(report.finalRecommendation).toMatch(/cancelled before the review completed/u)
  })

  it('reports an expired deadline as a failure, not as a cancellation the user never made', async () => {
    // The old reader was `signal.aborted`, which is true for both reasons: the
    // deadline expiring was reported as 'cancelled' wherever the report is read —
    // the durable report, the handoff injected for the model, and the job the UI
    // renders — so a council that ran out of time blamed the user for stopping it.
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => deadline.signal)
    onChildCreated = (engine) => {
      if (engine === 'codex') deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex'], maxRounds: 1 })
    expect(deadline.signal.aborted).toBe(true)
    expect(report.state).toBe('failed')
    expect(report.riskGate).toBe('blocked')
    expect(participantFor(report, 'deepseek')?.state).toBe('failed')
    // The reason travels with the verdict: a failed review that does not say why
    // reads as an engine problem, and the deadline is the council's own doing.
    expect(report.blockingFindings?.some(finding => /timed out after 30s/u.test(finding))).toBe(true)
    expect(report.finalRecommendation).toMatch(/timed out after 30s/u)
    expect(report.finalRecommendation).toMatch(/rerun the council/u)
  })
})

describe('the approval gate consumes the risk verdict', () => {
  it('approves a review whose gate is clear', async () => {
    const id = seedReport(() => ({ riskGate: 'clear' }))
    expect(await refusal(() => council.recordDecision(parent(), id, 'approved'))).toBe('accepted')
  })

  it('refuses to approve a blocked review', async () => {
    const id = seedReport(() => ({ state: 'blocked', riskGate: 'blocked', blockingFindings: ['codex: Unscoped update (src/api.ts:42)'] }))
    expect(await refusal(() => council.recordDecision(parent(), id, 'approved'))).toMatch(/cannot be decided from state "blocked"/u)
    expect(council.report(parent(), id).decision).toBeUndefined()
  })

  it('refuses to approve a report whose gate is blocked even when its state claims completion', async () => {
    // The gate is read from durable state, not inferred from the state field: a
    // report restored from a session log can claim a terminal state and still
    // carry an uncleared verdict, and approving it is the hole this reader closes.
    const id = seedReport(() => ({ state: 'completed', riskGate: 'blocked' }))
    expect(await refusal(() => council.recordDecision(parent(), id, 'approved'))).toMatch(/did not clear its risk gate/u)
    expect(council.report(parent(), id).decision).toBeUndefined()
  })

  it('refuses to approve a report that records no gate at all', async () => {
    const id = seedReport(() => ({ state: 'completed' }), { omitRiskGate: true })
    expect(await refusal(() => council.recordDecision(parent(), id, 'approved'))).toMatch(/did not clear its risk gate/u)
  })

  it('refuses to implement or verify on an approval that carries a blocked gate', async () => {
    const id = seedReport(id => ({ state: 'completed', riskGate: 'blocked', decision: approval(id) }))
    expect(await refusal(() => council.recordImplementation(parent(), id, 'implemented'))).toMatch(/did not clear its risk gate/u)
    // The implementation marker verification would otherwise demand, so the
    // refusal below is the gate's and not the missing-marker check's.
    const marked = seedReport(id => ({
      state: 'completed',
      riskGate: 'blocked',
      decision: approval(id),
      implementation: { id, completedAt: Date.now() - 500, summary: 'implemented' },
    }))
    expect(await refusal(() => council.beginVerification(parent(), marked))).toMatch(/did not clear its risk gate/u)
  })
})

describe('participant models come from the selection', () => {
  it('runs the participant on the selected model instead of a built-in constant', async () => {
    council = makeCouncil({ quorum: 1, defaults: () => ({ engine: 'deepseek', provider: 'freecodego', model: 'deepseek-v4-pro' }) })
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek'], maxRounds: 1 })
    expect(childFor('deepseek')?.model).toBe('deepseek-v4-pro')
    expect(childFor('deepseek')?.model).not.toBe('deepseek-v4-flash')
    expect(participantFor(report, 'deepseek')?.model).toBe('deepseek-v4-pro')
  })

  it('prefers an explicit per-engine model over the selected engine\'s own', async () => {
    council = makeCouncil({
      defaults: () => ({ engine: 'claude', provider: 'freecodego', model: 'claude-opus-4-6', models: { deepseek: 'deepseek-v4-pro' } }),
    })
    await council.run(parent(), { ...objectives, engines: ['deepseek', 'claude'], maxRounds: 1 })
    expect(childFor('deepseek')?.model).toBe('deepseek-v4-pro')
    expect(childFor('claude')?.model).toBe('claude-opus-4-6')
  })

  it('marks an engine with no selected model unavailable instead of substituting one', async () => {
    // The selection names a Claude model, so there is no DeepSeek model to run
    // on. Passing none would let the Host merge the Claude id into a DeepSeek
    // session, so the participant is refused and the reason is in the report.
    council = makeCouncil({ defaults: () => ({ engine: 'claude', provider: 'freecodego', model: 'claude-opus-4-6' }) })
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'claude'], maxRounds: 1 })
    expect(childFor('deepseek')).toBeUndefined()
    expect(participantFor(report, 'deepseek')?.state).toBe('unavailable')
    expect(participantFor(report, 'deepseek')?.error).toMatch(/no deepseek model was selected/u)
    expect(participantFor(report, 'deepseek')?.model).toBe('')
    // Losing a participant to a missing selection cannot clear the gate either.
    expect(report.state).toBe('blocked')
    expect(report.riskGate).toBe('blocked')
  })

  it('omits the model when nothing was selected, leaving the engine its own default', async () => {
    council = makeCouncil({ defaults: () => ({ engine: 'deepseek', provider: 'freecodego' }) })
    const report = await council.run(parent(), { ...objectives, engines: ['deepseek', 'codex'], maxRounds: 1 })
    expect(childFor('deepseek')?.hasModel).toBe(false)
    // Codex is the one engine whose "no explicit model" state has a Host-defined
    // marker; passing it delegates to the runtime's own configuration instead of
    // naming a model here.
    expect(childFor('codex')?.model).toBe('codex-auto')
    expect(participantFor(report, 'deepseek')?.model).toBe('')
    expect(report.state).toBe('completed')
    expect(report.riskGate).toBe('clear')
  })
})
