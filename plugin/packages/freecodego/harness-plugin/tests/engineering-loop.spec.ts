import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'
import { agentValue, provideHostService, provideHostServiceAs, type GoalsFace } from './support/host-services.ts'

/**
 * The verification jobs double: `run` records the cwd instead of spawning the
 * real stage runner, so a test asserts *whether* verification was sought, not
 * how a stage executes. Swapped in through the same property the registry
 * assigns in its constructor — `private` is compile-time only.
 */
const ranRuns: string[] = []
const JOIN_ROOT = '/ws/root'
function pausedAgent(): { readonly session: { readonly header: { readonly cwd: string } } } {
  return { session: { header: { cwd: JOIN_ROOT } } }
}
function stubVerificationJobs(registry: FreeCodeGoEngineeringRegistry): void {
  (registry as unknown as { verificationJobs: { run: (cwd: string) => Promise<undefined> } }).verificationJobs = {
    run: async (cwd: string) => { ranRuns.push(cwd); return undefined },
  }
}

/**
 * A goal service double that records mutations instead of applying them, so a
 * test can assert *which* service call the policy chose rather than only the
 * resulting phase. The transition rules themselves (active → paused, resume
 * refuses a spent budget) belong to `dsh-goal` and are tested there.
 */
function goalService(goal: Record<string, unknown> | undefined) {
  const calls: string[] = []
  let current = goal
  // Every mutation bumps the revision, like the real service's optimistic
  // concurrency guard. A double that left the revision alone would hide the bug
  // where a caller resumes with a pre-edit view the service rejects.
  const rewrite = (change: Record<string, unknown>): void => {
    current = { ...current, ...change, revision: Number(current?.['revision'] ?? 0) + 1 }
  }
  return {
    calls,
    service: {
      get: () => current,
      create: () => ({ id: 'goal-1' }),
      resume: () => { calls.push('resume'); rewrite({ phase: 'active', activation: 'armed' }) },
      pause: () => { calls.push('pause'); rewrite({ phase: 'paused', activation: 'disarmed' }) },
      disarm: () => { calls.push('disarm'); rewrite({ activation: 'disarmed' }) },
      edit: (_agent: unknown, _ref: unknown, request: { readonly maxGoalRounds?: number }) => {
        calls.push(`edit:${request.maxGoalRounds}`)
        rewrite(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds })
      },
    },
  }
}

const GOAL = {
  id: 'goal-7',
  revision: 3,
  objective: 'Ship the approved plan\nand a second line that the excerpt drops',
  phase: 'active',
  activation: 'armed',
  maxGoalRounds: 24,
  roundsStarted: 4,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
} as const

function registryWith(goal: Record<string, unknown> | undefined, settings: Record<string, unknown> = {}, agents: readonly Record<string, unknown>[] = []) {
  const ctx = new Context()
  const fake = goalService(goal)
  provideHostServiceAs<GoalsFace>(ctx, 'goals', fake.service)
  // The disarm path has to reach goals it was never handed, so the double exposes
  // the same `agents` registry the Host does.
  provideHostService(ctx, 'agents', {
    list: () => agents.map(agent => agentValue(agent)),
    get: (id: string) => {
      const found = agents.find(agent => agent['id'] === id)
      return found === undefined ? undefined : agentValue(found)
    },
  })
  const stored: Record<string, unknown> = { engineeringEnabled: true, ...settings }
  const registry = new FreeCodeGoEngineeringRegistry(ctx, {
    get: () => stored,
    update: async (value: unknown) => { Object.assign(stored, value as Record<string, unknown>) },
  })
  return { ctx, registry, calls: fake.calls }
}

describe('verification on goal endings', () => {
  it('refuses a paused goal: a user stop must not launch the verification scripts', async () => {
    // `paused` is the durable stop the user presses. The listener forwards every
    // non-active phase, so the gate has to live here: running the project's
    // build/test scripts on the way to a pause is a stop that punishes the user,
    // and the dedup key would then also hide the real verification when the
    // goal is later driven to `blocked` or `complete`.
    const { registry } = registryWith({ ...GOAL, phase: 'paused' }, { engineeringLoopVerifyOnComplete: true })
    stubVerificationJobs(registry)
    await expect(registry.verifyCompletedGoal(pausedAgent() as never, 'paused')).resolves.toBeUndefined()
    expect(ranRuns).toEqual([])
  })

  it('verifies the driver endings: blocked and complete', async () => {
    const { registry } = registryWith({ ...GOAL }, { engineeringLoopVerifyOnComplete: true })
    stubVerificationJobs(registry)
    const agent = pausedAgent() as never
    // Both endings reach the verification jobs service; the double records the
    // workspace cwd they were pointed at.
    await registry.verifyCompletedGoal(agent, 'blocked')
    await registry.verifyCompletedGoal(agent, 'complete')
    expect(ranRuns).toEqual([JOIN_ROOT, JOIN_ROOT])
  })
})

describe('autonomous engineering loop', () => {
  it('reports the switch even when the composition mounts no goal service', () => {
    const ctx = new Context()
    const registry = new FreeCodeGoEngineeringRegistry(ctx, undefined)
    // No service, no settings scope: the panel still has to render a truthful
    // line rather than throwing while reading state it does not own.
    expect(registry.goalLoopStatus({} as never)).toStrictEqual({ available: false, autoContinueEnabled: false })
  })

  it('separates "no goal yet" from "unavailable", and reports the switch in both', () => {
    const { registry } = registryWith(undefined, { engineeringLoopAutoContinue: true })
    expect(registry.goalLoopStatus({} as never)).toStrictEqual({ available: true, autoContinueEnabled: true })
  })

  it('projects the goal: phase, process-local activation, round budget and a one-line excerpt', () => {
    const { registry } = registryWith({ ...GOAL }, { engineeringLoopAutoContinue: true })
    expect(registry.goalLoopStatus({} as never)).toStrictEqual({
      available: true,
      autoContinueEnabled: true,
      goalId: 'goal-7',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 4,
      maxGoalRounds: 24,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_060_000,
      objectiveExcerpt: 'Ship the approved plan',
    })
  })

  it('surfaces a blocker as the reason the loop stopped', () => {
    const { registry } = registryWith({
      ...GOAL,
      phase: 'blocked',
      activation: 'disarmed',
      blockedReason: { code: 'round-budget-exhausted', message: '24/24 goal rounds used' },
    })
    const status = registry.goalLoopStatus({} as never)
    expect(status.phase).toBe('blocked')
    expect(status.blockedCode).toBe('round-budget-exhausted')
    expect(status.blockedMessage).toBe('24/24 goal rounds used')
  })

  it('arms a stopped goal and leaves an already-armed one alone', () => {
    const authorized = { engineeringLoopAutoContinue: true }
    const paused = registryWith({ ...GOAL, phase: 'paused', activation: 'disarmed' }, authorized)
    expect(paused.registry.goalLoopArm({} as never).activation).toBe('armed')
    expect(paused.calls).toStrictEqual(['resume'])

    const armed = registryWith({ ...GOAL }, authorized)
    expect(armed.registry.goalLoopArm({} as never).activation).toBe('armed')
    expect(armed.calls).toStrictEqual([])
  })

  it('refuses to arm without a goal, without a service, or past the round budget', () => {
    const authorized = { engineeringLoopAutoContinue: true }
    const none = registryWith(undefined, authorized)
    expect(() => none.registry.goalLoopArm({} as never)).toThrow(/has no goal yet/u)

    // The configured cap stays at its 24 default, so there is nothing to raise:
    // the refusal has to name the setting the user has to change.
    const spent = registryWith({ ...GOAL, activation: 'disarmed', roundsStarted: 24, maxGoalRounds: 24 }, authorized)
    expect(() => spent.registry.goalLoopArm({} as never)).toThrow(/used all 24 goal rounds/u)
    expect(spent.calls).toStrictEqual([])

    const disabled = registryWith({ ...GOAL }, { engineeringEnabled: false, ...authorized })
    expect(() => disabled.registry.goalLoopArm({} as never)).toThrow(/disabled/u)
  })

  it('stops an active goal by pausing it, and a stopped one by dropping leftover authority', () => {
    const active = registryWith({ ...GOAL })
    expect(active.registry.goalLoopStop({} as never).phase).toBe('paused')
    expect(active.calls).toStrictEqual(['pause'])

    // An active goal that is already disarmed needs no durable change, so the
    // second press of the same control must not fail.
    const disarmed = registryWith({ ...GOAL, activation: 'disarmed' })
    expect(disarmed.registry.goalLoopStop({} as never).phase).toBe('active')
    expect(disarmed.calls).toStrictEqual([])

    const paused = registryWith({ ...GOAL, phase: 'paused', activation: 'armed' })
    expect(paused.registry.goalLoopStop({} as never).phase).toBe('paused')
    expect(paused.calls).toStrictEqual(['disarm'])
  })

  it('refuses to arm while the switch that authorizes unattended work is off', () => {
    // The switch and the button are one authorization, not two. The button used
    // to arm whatever goal it found, so a panel reading 自动继续已关 could still
    // start working without a user turn.
    const off = registryWith({ ...GOAL, phase: 'paused', activation: 'disarmed' })
    expect(() => off.registry.goalLoopArm({} as never)).toThrow(/unattended continuation is switched off/u)
    expect(off.calls).toStrictEqual([])
  })

  it('raises a spent goal cap to the configured one instead of refusing to continue', () => {
    // "Raise the round cap before continuing" was unfollowable: the goal carries
    // the cap it was created with, so raising the setting changed nothing.
    const { registry, calls } = registryWith(
      { ...GOAL, activation: 'disarmed', roundsStarted: 24, maxGoalRounds: 24 },
      { engineeringLoopAutoContinue: true, engineeringLoopMaxGoalRounds: 50 },
    )
    const status = registry.goalLoopArm({} as never)
    expect(calls).toStrictEqual(['edit:50', 'resume'])
    expect(status.maxGoalRounds).toBe(50)
    expect(status.activation).toBe('armed')
  })

  it('never lowers a goal cap below the budget it was created with', () => {
    const { registry, calls } = registryWith(
      { ...GOAL, activation: 'disarmed', roundsStarted: 10, maxGoalRounds: 50 },
      { engineeringLoopAutoContinue: true, engineeringLoopMaxGoalRounds: 24 },
    )
    expect(registry.goalLoopArm({} as never).maxGoalRounds).toBe(50)
    expect(calls).toStrictEqual(['resume'])
  })

  it('disarms only the goals that are still armed, and only their continuation', () => {
    const armed = registryWith({ ...GOAL }, { engineeringLoopAutoContinue: true }, [{ id: 'session-a' }])
    expect(armed.registry.disarmUnattendedGoals()).toBe(1)
    // Disarm, never pause: the goal stays active and resumable, exactly like the
    // service's own disarm on a user turn.
    expect(armed.calls).toStrictEqual(['disarm'])
    expect(armed.registry.goalLoopStatus({} as never).phase).toBe('active')

    const disarmed = registryWith({ ...GOAL, activation: 'disarmed' }, { engineeringLoopAutoContinue: false }, [{ id: 'session-a' }])
    expect(disarmed.registry.disarmUnattendedGoals()).toBe(0)
    expect(disarmed.calls).toStrictEqual([])

    const noRegistry = registryWith({ ...GOAL })
    expect(noRegistry.registry.disarmUnattendedGoals()).toBe(0)
  })

  it('withdraws unattended authorization when either switch that granted it is turned off', async () => {
    // The panel promises 「随时关掉这个开关即可停下」, so the switch has to reach
    // work that was armed before it was turned off — both for the loop's own
    // switch and for the switch that owns the whole engineering package.
    const home = await mkdtemp(join(tmpdir(), 'freecodego-loop-home-'))
    const previous = process.env['FREECODEGO_HOME']
    process.env['FREECODEGO_HOME'] = home
    try {
      const loopOff = registryWith({ ...GOAL }, { engineeringLoopAutoContinue: true }, [{ id: 'session-a' }])
      await loopOff.registry.update({ engineeringLoopAutoContinue: false })
      expect(loopOff.calls).toStrictEqual(['disarm'])
      await loopOff.registry.dispose()

      const packageOff = registryWith({ ...GOAL }, { engineeringLoopAutoContinue: true }, [{ id: 'session-a' }])
      await packageOff.registry.update({ engineeringEnabled: false })
      expect(packageOff.calls).toStrictEqual(['disarm'])
      await packageOff.registry.dispose()

      // An unrelated setting patch must not touch a running goal.
      const unrelated = registryWith({ ...GOAL }, { engineeringLoopAutoContinue: true }, [{ id: 'session-a' }])
      await unrelated.registry.update({ engineeringLoopMaxGoalRounds: 30 })
      expect(unrelated.calls).toStrictEqual([])
      await unrelated.registry.dispose()
    } finally {
      if (previous === undefined) delete process.env['FREECODEGO_HOME']
      else process.env['FREECODEGO_HOME'] = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})
