/**
 * The engineering loop's terminal-phase listener, driven through the real plugin.
 *
 * `index.ts` listens on `goal/changed` and owns the termination half of the
 * autonomous loop: when a goal leaves the active phase it runs the declared
 * verification, and when an unattended goal stops `blocked` it tells the session
 * why — the one stopping condition a user cannot see for themselves, because the
 * driver simply went idle.
 *
 * That second report is the reason this file exists. A goal that blocks, is
 * resumed with 继续, and blocks again is *not* the first block repeated: more
 * rounds ran, more budget was spent, and the user already proved they wanted it
 * continued. The dedup key used to be `(goalId, phase)` for the life of the
 * process, so the second block matched the first and the listener returned before
 * doing anything at all — no re-verification, no report — which is exactly the
 * silent idle the report exists to prevent.
 *
 * Mutation probe: restore `|| phase === 'active') return` in the `goal/changed`
 * listener and the "second block" case stops producing its report.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { agentValue, provideHostService, provideHostServiceAs, registrationHandle, sessionValue, settingsValue, type AgentEnginesFace, type CommandsFace, type GoalsFace } from './support/host-services.ts'

const CWD = '/workspace'
const GOAL_ID = 'goal_0123456789abcdef'
const AGENT_ID = 'agent-1'

interface GoalHarness {
  /** Every message the plugin injected into the session, in order. */
  readonly injects: readonly string[]
  /** Publish a `goal/changed` for one phase, as the goal service does. */
  readonly change: (phase: string) => void
  readonly dispose: () => Promise<void>
}

/**
 * The real plugin, booted against a stub goal service whose phase a case drives.
 *
 * The settings are the minimum the listener reads: `engineeringEnabled` for the
 * plugin, `engineeringLoopAutoContinue` for the unattended-stop report. The
 * verification half stays off (`engineeringLoopVerifyOnComplete` absent), so
 * these cases observe the reporting behaviour without launching a build.
 */
async function goalHarness(): Promise<GoalHarness> {
  const home = mkdtempSync(join(tmpdir(), 'freecodego-goal-stop-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const injects: string[] = []
  let phase = 'blocked'
  const agent = {
    id: AGENT_ID,
    session: { header: { cwd: CWD } },
    inject: (message: unknown) => { injects.push(JSON.stringify(message)) },
  }
  const goal = (): Record<string, unknown> => ({
    id: GOAL_ID,
    revision: 1,
    phase,
    activation: 'armed',
    roundsStarted: 3,
    maxGoalRounds: 3,
    objective: 'Implement the approved plan',
    createdAt: 0,
    updatedAt: 0,
    blockedReason: { code: 'GOAL_ROUNDS_EXHAUSTED', message: 'the goal used every round it was granted' },
  })
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { get: () => agentValue(agent), list: () => [agentValue(agent)] })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => sessionValue({ id: AGENT_ID, header: { cwd: CWD } }), list: () => [] })
    provideHostService(scope, 'settings', {
      register: () => ({
        get: () => settingsValue({ engineeringEnabled: true, engineeringLoopAutoContinue: true }),
        watch: () => () => undefined,
        update: async () => undefined,
        replace: async () => undefined,
      }),
    })
    provideHostService(scope, 'llm', {
      registerAdapter: () => registrationHandle(),
      stream() { return (async function* empty(): AsyncGenerator<never> { /* boot makes no request */ })() },
    })
    provideHostService(scope, 'tools', {
      register: () => () => undefined,
      guard: () => () => undefined,
      schemas: () => [],
    })
    provideHostServiceAs<CommandsFace>(scope, 'commands', { register: () => () => undefined })
    provideHostService(scope, 'systemPrompt', { section: () => () => undefined })
    // The goal service, whose phase this file drives by hand: `resume` publishes
    // an `active` phase exactly like this, and the next block follows it.
    provideHostServiceAs<GoalsFace>(scope, 'goals', { get: () => goal() })
  })
  new FreeCodeGoHarnessPlugin(ctx, {})
  // The event is declared by `@deepseek-ai/dsh-goal`, which this package does not
  // depend on for types (see the listener's own structural view in `index.ts`),
  // so the emitter is reached through the same narrow shape.
  const goalEvents = ctx as unknown as { emit(event: 'goal/changed', payload: unknown): void }
  return {
    injects,
    change: (nextPhase) => {
      phase = nextPhase
      goalEvents.emit('goal/changed', {
        agent,
        change: { operation: nextPhase === 'active' ? 'resume' : 'block', ref: { id: GOAL_ID, revision: 1 }, goal: goal() },
      } as never)
    },
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

/** The unattended-stop reports among everything the plugin injected. */
function reports(injects: readonly string[]): readonly string[] {
  return injects.filter(message => message.includes('stopped unattended'))
}

describe('an unattended goal that stops blocked is reported to the session', () => {
  let harness: GoalHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('reports the block, the budget it burned, and the control that continues', async () => {
    harness = await goalHarness()
    harness.change('blocked')
    const lines = reports(harness.injects)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(GOAL_ID)
    expect(lines[0]).toContain('3/3 goal rounds')
    expect(lines[0]).toContain('the goal used every round it was granted')
  })

  it('says nothing twice about one unchanged block', async () => {
    harness = await goalHarness()
    harness.change('blocked')
    harness.change('blocked')
    expect(reports(harness.injects)).toHaveLength(1)
  })

  it('reports the block again after the goal was resumed and blocked a second time', async () => {
    harness = await goalHarness()
    harness.change('blocked')
    // The user presses 继续: the service resumes the goal, which publishes an
    // `active` phase before the driver runs another round.
    harness.change('active')
    harness.change('blocked')
    expect(reports(harness.injects)).toHaveLength(2)
  })
})
