import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_SETTINGS_DEFAULTS,
  DEFAULT_SCHEDULE_PLAN_COUNT,
  FreeCodeGoAutomationRuntime,
  HOOK_CHAINS_RELATIVE_PATH,
  MAX_SCHEDULE_PLAN_COUNT,
  automationSettingsPatch,
  normalizeAutomationSettings,
  outcomeOfTurnEnd,
  type AutomationEventHost,
} from '../src/automation.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-automation-'))
  directories.push(directory)
  return directory
}

type ToolRecord = { name: string; execute: (args: unknown, exec: unknown) => unknown; presentCall: () => unknown; output: { render: (args: unknown, value: unknown) => unknown } }

/** A minimal `ctx.get` host double that also records registered tools. */
function hostDouble(tools: ToolRecord[] | undefined): { get: (name: string) => unknown; on: ReturnType<typeof vi.fn> } {
  const on = vi.fn()
  return {
    on,
    get: (name: string) => {
      if (name !== 'tools') return undefined
      if (tools === undefined) return undefined
      return { register: (tool: unknown) => { tools.push(tool as ToolRecord); return { dispose: () => undefined } } }
    },
  }
}

function scope(values: Record<string, unknown> | undefined) {
  return { get: () => values }
}

const exec = { agent: { session: { header: { cwd: '/tmp/workspace' } } } }

describe('automation settings normalization', () => {
  it('falls back to every default for a missing or non-object document', () => {
    expect(normalizeAutomationSettings(undefined)).toEqual(AUTOMATION_SETTINGS_DEFAULTS)
    expect(normalizeAutomationSettings(null)).toEqual(AUTOMATION_SETTINGS_DEFAULTS)
    expect(normalizeAutomationSettings('nope')).toEqual(AUTOMATION_SETTINGS_DEFAULTS)
  })

  it('keeps supplied values and falls back per field', () => {
    const settings = normalizeAutomationSettings({
      hookChainsEnabled: false,
      hookChainsMaxDepth: 5,
      scheduledTasksEnabled: false,
      hookChainsCooldownMs: 'soon',
    })
    expect(settings.hookChainsEnabled).toBe(false)
    expect(settings.hookChainsMaxDepth).toBe(5)
    expect(settings.scheduledTasksEnabled).toBe(false)
    // A wrong-typed value falls back on its own, leaving the rest of the
    // document in force.
    expect(settings.hookChainsCooldownMs).toBe(AUTOMATION_SETTINGS_DEFAULTS.hookChainsCooldownMs)
  })
})

describe('automation settings patch', () => {
  it('keeps only the switches the caller supplied', () => {
    // The whole point of a patch: normalizing instead would fill the other three
    // from the defaults and turn them back on behind the caller's back.
    expect(automationSettingsPatch({ scheduledTasksEnabled: false })).toEqual({ scheduledTasksEnabled: false })
    expect(automationSettingsPatch({ hookChainsMaxDepth: 5 })).toEqual({ hookChainsMaxDepth: 5 })
    expect(automationSettingsPatch({ hookChainsEnabled: false, hookChainsCooldownMs: 0 })).toEqual({ hookChainsEnabled: false, hookChainsCooldownMs: 0 })
  })

  it('drops a field with an unusable type and keeps the rest', () => {
    expect(automationSettingsPatch({ hookChainsEnabled: 'yes', scheduledTasksEnabled: true })).toEqual({ scheduledTasksEnabled: true })
    expect(automationSettingsPatch({ hookChainsMaxDepth: '5', hookChainsCooldownMs: 60_000 })).toEqual({ hookChainsCooldownMs: 60_000 })
  })

  it('drops values JSON can carry but the reader would not honor', () => {
    // `NaN`/`Infinity` are impossible on the wire, but a Host caller is not; the
    // reader would fall back on them, so the writer must not store them either.
    expect(automationSettingsPatch({ hookChainsMaxDepth: Number.NaN, hookChainsCooldownMs: Number.POSITIVE_INFINITY })).toEqual({})
    expect(automationSettingsPatch(null)).toEqual({})
    expect(automationSettingsPatch('nope')).toEqual({})
    expect(automationSettingsPatch([])).toEqual({})
  })

  it('passes an out-of-range value through to the schema that owns the bounds', () => {
    // Not clamped here: a second copy of `min`/`max` would be a number that can
    // drift from the schema. The settings service rejects it with its own message.
    expect(automationSettingsPatch({ hookChainsMaxDepth: 99 })).toEqual({ hookChainsMaxDepth: 99 })
  })
})

describe('automation hook chains', () => {
  it('registers nothing when the switch is off', async () => {
    const runtime = new FreeCodeGoAutomationRuntime(undefined, scope({ hookChainsEnabled: false }), hostDouble(undefined), { now: () => 1_000 })
    expect(await runtime.loadHookChains('/tmp/workspace')).toEqual({ configured: false })
    expect(runtime.status().hookChains.enabled).toBe(false)
    expect(runtime.status().hookChains.enabledBySettings).toBe(false)
  })

  it('installs an empty ruleset when the workspace has no rules file', async () => {
    const directory = await workspace()
    const runtime = new FreeCodeGoAutomationRuntime(undefined, scope(undefined), hostDouble(undefined), { now: () => 1_000 })
    expect(await runtime.loadHookChains(directory)).toEqual({ configured: true })
    // The settings scope is absent, so every switch falls back to its default.
    expect(runtime.status().hookChains.enabledBySettings).toBe(true)
    expect(runtime.status().hookChains.ruleCount).toBe(0)
  })

  it('loads a project rules file and lets the settings guards override it', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      // The file tries to widen both guards; settings must win.
      maxChainDepth: 9,
      defaultCooldownMs: 1,
      rules: [{ id: 'retry', actions: [{ kind: 'notify_team', message: 'tool failed' }] }],
    }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, scope({ hookChainsMaxDepth: 3, hookChainsCooldownMs: 2_000 }), hostDouble(undefined), { now: () => 5_000 })
    expect(await runtime.loadHookChains(directory)).toEqual({ configured: true })
    const status = runtime.status().hookChains
    expect(status.ruleCount).toBe(1)
    expect(status.maxChainDepth).toBe(3)
    const dispatched = await runtime.dispatchToolFailure('Edit', directory)
    expect(dispatched.fired).toEqual(['retry'])
    // No team channel is mounted in this composition, so the action is skipped
    // with a reason rather than reported as done.
    expect(dispatched.actions[0]).toMatchObject({ status: 'skipped', reason: 'no team channel is mounted in this composition' })
  })

  it('treats an array rules document as an empty ruleset', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify([1, 2]), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    expect(await runtime.loadHookChains(directory)).toEqual({ configured: true })
    expect(runtime.status().hookChains.ruleCount).toBe(0)
  })

  it('treats a scalar rules document as an empty ruleset', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    // Valid JSON that is not an object at all: the spread would throw on the
    // null case and silently do nothing sensible on a string.
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify('not a document'), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    expect(await runtime.loadHookChains(directory)).toEqual({ configured: true })
    expect(runtime.status().hookChains.ruleCount).toBe(0)
  })

  it('skips a fallback-agent action when no launcher is mounted', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({ rules: [{ id: 'r', actions: [{ kind: 'spawn_fallback_agent' }] }] }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    await runtime.loadHookChains(directory)
    expect((await runtime.dispatchToolFailure('Edit', directory)).actions[0]).toMatchObject({
      status: 'skipped',
      reason: 'no fallback agent launcher is mounted in this composition',
    })
  })

  it('reports a malformed rules file instead of throwing', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), '{ not json', 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    const result = await runtime.loadHookChains(directory)
    expect(result.configured).toBe(false)
    expect(result.error).toMatch(/JSON/)
    expect(runtime.status().hookChains.configError).toMatch(/JSON/)
  })

  it('reports a schema-invalid rules file instead of throwing', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({ rules: [{ id: 'x' }] }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    const result = await runtime.loadHookChains(directory)
    expect(result.configured).toBe(false)
    expect(runtime.status().hookChains.configError).toMatch(/declares no actions/)
  })

  it('reloads when a dispatch names a different workspace', async () => {
    const first = await workspace()
    const second = await workspace()
    await mkdir(join(second, '.freecodego'), { recursive: true })
    await writeFile(join(second, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({ rules: [{ id: 'second-only', actions: [{ kind: 'notify_team' }] }] }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    // First call installs the first workspace's (empty) ruleset.
    expect((await runtime.dispatchToolFailure('Edit', first)).fired).toEqual([])
    // A later call for another workspace picks up that workspace's rules.
    expect((await runtime.dispatchToolFailure('Edit', second)).fired).toEqual(['second-only'])
    // Returning to the first workspace reloads again rather than keeping the second's.
    expect((await runtime.dispatchToolFailure('Edit', first)).fired).toEqual([])
  })

  it('makes a burst of failures for one workspace wait for that workspace rules', async () => {
    const first = await workspace()
    const second = await workspace()
    await mkdir(join(second, '.freecodego'), { recursive: true })
    // Zero guard windows: the point here is which ruleset each dispatch sees, not
    // the cooldown that would legitimately suppress the rest of a burst.
    await writeFile(join(second, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [{ id: 'second-only', cooldownMs: 0, dedupWindowMs: 0, actions: [{ kind: 'notify_team' }] }],
    }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    await runtime.dispatchToolFailure('Edit', first)
    // Failing tool calls are reported one event per call, so several disciplines
    // land in the same tick. The first one claims the workspace before its file
    // read finishes; the rest must wait for that read rather than dispatch
    // against the rules that happened to be installed already.
    const burst = await Promise.all([
      runtime.dispatchToolFailure('Edit', second),
      runtime.dispatchToolFailure('Edit', second),
      runtime.dispatchToolFailure('Edit', second),
    ])
    expect(burst.map(result => result.fired)).toEqual([['second-only'], ['second-only'], ['second-only']])
  })

  it('runs a collaborator when the composition supplies one', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{
        id: 'recover',
        actions: [
          { kind: 'notify_team', message: 'notify', target: '#ops' },
          { kind: 'spawn_fallback_agent', message: 'retry', target: 'fallback' },
          { kind: 'warm_remote_capacity', target: 'capacity' },
        ],
      }],
    }), 'utf8')
    const notifyTeam = vi.fn(async () => undefined)
    const spawnFallbackAgent = vi.fn(() => undefined)
    const warmRemoteCapacity = vi.fn(async () => undefined)
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), {
      now: () => 1_000,
      collaborators: { notifyTeam, spawnFallbackAgent, warmRemoteCapacity },
    })
    await runtime.loadHookChains(directory)
    const result = await runtime.dispatchToolFailure('Edit', directory)
    expect(result.actions.every(action => action.status === 'executed')).toBe(true)
    expect(notifyTeam).toHaveBeenCalledWith('notify', '#ops')
    expect(spawnFallbackAgent).toHaveBeenCalledWith('retry', 'fallback')
    expect(warmRemoteCapacity).toHaveBeenCalledWith('capacity')
  })

  it('falls back to a default message and skip reason when an action supplies neither', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{ id: 'bare', actions: [{ kind: 'spawn_fallback_agent' }, { kind: 'warm_remote_capacity' }] }],
    }), 'utf8')
    const spawnFallbackAgent = vi.fn(async () => undefined)
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000, collaborators: { spawnFallbackAgent } })
    await runtime.loadHookChains(directory)
    const result = await runtime.dispatchToolFailure('Edit', directory)
    expect(spawnFallbackAgent).toHaveBeenCalledWith('retry with a fallback agent', undefined)
    expect(result.actions[1]).toMatchObject({ status: 'skipped', reason: 'no remote capacity hook is mounted in this composition' })
  })

  it('records a collaborator failure as a skip', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({ rules: [{ id: 'bad', actions: [{ kind: 'notify_team' }] }] }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), {
      now: () => 1_000,
      collaborators: {
        notifyTeam: () => {
          throw new Error('mailbox unavailable')
        },
      },
    })
    await runtime.loadHookChains(directory)
    expect((await runtime.dispatchToolFailure('Edit', directory)).actions[0]).toMatchObject({ status: 'skipped', reason: 'mailbox unavailable' })
  })

  it('dispatches a task-completion chain with the task status attached', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{ id: 'on-complete', events: ['TaskCompleted'], when: { taskStatuses: ['failed'] }, actions: [{ kind: 'notify_team' }] }],
    }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    await runtime.loadHookChains(directory)
    expect((await runtime.dispatchTaskCompleted('success')).fired).toEqual([])
    expect((await runtime.dispatchTaskCompleted('failed')).fired).toEqual(['on-complete'])
  })

  it('reads every turn-end reason as the outcome a rule condition can match', () => {
    expect(outcomeOfTurnEnd({ kind: 'completed' })).toBe('success')
    expect(outcomeOfTurnEnd({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })).toBe('failed')
    // A budget that ran out is not the work concluding, and not the work
    // breaking either — `timeout` is the one member that means "stopped by a limit".
    expect(outcomeOfTurnEnd({ kind: 'max-tokens' })).toBe('timeout')
    // The three reasons that carry no verdict on the work. An abort read as a
    // failure would fire recovery at a user who pressed stop.
    expect(outcomeOfTurnEnd({ kind: 'aborted', reason: { kind: 'user' } })).toBe('unknown')
    expect(outcomeOfTurnEnd({ kind: 'blocked' })).toBe('unknown')
    expect(outcomeOfTurnEnd({ kind: 'interrupted' })).toBe('unknown')
    // A reason a later Harness adds, and a malformed one, must degrade rather
    // than throw: this runs on the session append path.
    expect(outcomeOfTurnEnd({ kind: 'something-new' })).toBe('unknown')
    expect(outcomeOfTurnEnd(undefined)).toBe('unknown')
    expect(outcomeOfTurnEnd(null)).toBe('unknown')
    expect(outcomeOfTurnEnd('completed')).toBe('unknown')
  })

  it('installs a workspace\'s rules before dispatching a turn that ended there', async () => {
    // Deliberately never calls `loadHookChains`: a turn can end in a workspace
    // that has never had a failing tool call, so this is the first read of that
    // project's rules. Dispatching without the load runs against no ruleset at
    // all, and the user's rule becomes a silent no-op.
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{ id: 'on-failure', events: ['TaskCompleted'], when: { outcomes: ['failed'] }, actions: [{ kind: 'notify_team' }] }],
    }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    const result = await runtime.dispatchTurnEnd({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, directory)
    expect(result.fired).toEqual(['on-failure'])
  })

  it('fires a TaskCompleted rule when the session records a turn ending', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{ id: 'on-failure', events: ['TaskCompleted'], when: { taskStatuses: ['failed'] }, actions: [{ kind: 'notify_team', message: 'a turn broke' }] }],
    }), 'utf8')
    const notified = vi.fn()
    const host = hostDouble(undefined)
    const runtime = new FreeCodeGoAutomationRuntime(host as unknown as AutomationEventHost, undefined, host, {
      now: () => 1_000,
      collaborators: { notifyTeam: notified },
    })
    runtime.start()
    const handler = host.on.mock.calls.find(([event]) => event === 'session/event')?.[1] as ((session: unknown, event: unknown) => void) | undefined
    expect(handler).toBeTypeOf('function')
    handler!({ header: { cwd: directory } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } } })
    await vi.waitFor(() => { expect(notified).toHaveBeenCalledWith('a turn broke', undefined) })
  })

  it('dispatches once for one turn, and only for a turn that ended', async () => {
    // The rule matches every dispatch, so the call count *is* the dispatch
    // count: three session events arrive and exactly one of them is a turn end.
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{ id: 'any', events: ['TaskCompleted'], actions: [{ kind: 'notify_team' }] }],
    }), 'utf8')
    const notified = vi.fn()
    const host = hostDouble(undefined)
    const runtime = new FreeCodeGoAutomationRuntime(host as unknown as AutomationEventHost, undefined, host, {
      now: () => 1_000,
      collaborators: { notifyTeam: notified },
    })
    runtime.start()
    const handler = host.on.mock.calls.find(([event]) => event === 'session/event')?.[1] as (session: unknown, event: unknown) => void
    const session = { header: { cwd: directory } }
    handler(session, { type: 'turn/start', data: { turn: 1 } })
    handler(session, { type: 'assistant/message', data: { turn: 1 } })
    handler(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => { expect(notified).toHaveBeenCalled() })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('does not fire a failure rule for a turn that completed', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      rules: [{ id: 'on-failure', events: ['TaskCompleted'], when: { outcomes: ['failed'] }, actions: [{ kind: 'notify_team' }] }],
    }), 'utf8')
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    expect((await runtime.dispatchTurnEnd({ kind: 'completed' }, directory)).fired).toEqual([])
    expect((await runtime.dispatchTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }, directory)).fired).toEqual([])
    expect((await runtime.dispatchTurnEnd({ kind: 'max-tokens' }, directory)).fired).toEqual([])
  })

  it('subscribes to Host tool outcomes and dispatches only on failure', async () => {
    const directory = await workspace()
    await mkdir(join(directory, '.freecodego'), { recursive: true })
    await writeFile(join(directory, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({ rules: [{ id: 'any', actions: [{ kind: 'notify_team' }] }] }), 'utf8')
    const host = hostDouble(undefined)
    const runtime = new FreeCodeGoAutomationRuntime(host as unknown as AutomationEventHost, undefined, host, { now: () => 1_000 })
    runtime.start()
    expect(host.on).toHaveBeenCalledWith('tools/result', expect.any(Function))
    const handler = host.on.mock.calls[0]![1] as (exec: { name: string; agent?: unknown }, result: { isError: boolean }) => void
    const inWorkspace = { name: 'Edit', agent: { session: { header: { cwd: directory } } } }
    handler(inWorkspace, { isError: false })
    expect(runtime.status().hookChains.dispatched).toBe(0)
    handler(inWorkspace, { isError: true })
    // The dispatch payload carries no workspace, so the handler resolves the
    // session's cwd and loads that repository's rules before firing.
    await vi.waitFor(() => { expect(runtime.status().hookChains.dispatched).toBe(1) })
    expect(runtime.status().hookChains.configError).toBeUndefined()
  })

  it('falls back to the process workspace when the outcome names no agent', async () => {
    const host = hostDouble(undefined)
    const runtime = new FreeCodeGoAutomationRuntime(host as unknown as AutomationEventHost, undefined, host, { now: () => 1_000 })
    runtime.start()
    const handler = host.on.mock.calls[0]![1] as (exec: { name: string }, result: { isError: boolean }) => void
    handler({ name: 'Edit' }, { isError: true })
    // The plugin's own checkout has no recovery rules, so the chain is inert
    // rather than an error.
    await vi.waitFor(() => { expect(runtime.status().hookChains.enabled).toBe(false) })
  })

  it('starts without a Host event surface', () => {
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined), { now: () => 1_000 })
    expect(() => { runtime.start() }).not.toThrow()
  })

  it('contains a rejection from the failure dispatch instead of surfacing it', async () => {
    const host = hostDouble(undefined)
    const runtime = new FreeCodeGoAutomationRuntime(host as unknown as AutomationEventHost, undefined, host, {
      // A clock failure is the cheapest stand-in for any throw on the dispatch
      // path, which is the case the handler's catch exists for.
      now: () => {
        throw new Error('clock failed')
      },
    })
    runtime.start()
    const handler = host.on.mock.calls[0]![1] as (exec: { name: string }, result: { isError: boolean }) => void
    handler({ name: 'Edit' }, { isError: true })
    // Give the rejected promise a turn; an unhandled rejection would fail the run.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtime.status().hookChains.dispatched).toBe(0)
  })

  it('defaults the clock and the collaborator set when no options are given', () => {
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, hostDouble(undefined))
    const before = Date.now()
    const plan = runtime.schedulePlan({ cron: '* * * * *' })
    expect(plan.occurrences[0]!.atMs).toBeGreaterThanOrEqual(before)
  })
})

/** A Tuesday, so a weekday rule and a daily rule are distinguishable. */
const TUESDAY = new Date(2026, 2, 10, 8, 0, 0, 0).getTime()

describe('automation calendar planning', () => {
  const runtime = (settings?: Record<string, unknown>, now = TUESDAY): FreeCodeGoAutomationRuntime =>
    new FreeCodeGoAutomationRuntime(undefined, scope(settings), hostDouble(undefined), { now: () => now })

  it('refuses to plan while the schedule switch is off', () => {
    expect(() => runtime({ scheduledTasksEnabled: false }).schedulePlan({ cron: '* * * * *' }))
      .toThrow(/disabled in the FreeCodeGo automation settings/)
  })

  it('hands a genuinely fixed-rate rule over as one interval', () => {
    // The Harness's `every_seconds` carries this shape, so a chain would be a
    // second answer to a question the Harness already answers.
    const plan = runtime().schedulePlan({ cron: '*/5 * * * *' })
    expect(plan.fixedRateSeconds).toBe(300)
    expect(plan.guidance).toContain('every_seconds 300')
  })

  it('does not call a rule fixed-rate when its step does not divide the hour', () => {
    // `*/7` fires at :00, :07 ... :56 and then at the next :00, so one gap in
    // every hour is four minutes. A caller that trusted an interval would
    // schedule a rule that drifts.
    const plan = runtime().schedulePlan({ cron: '*/7 * * * *' })
    expect(plan.fixedRateSeconds).toBeUndefined()
    expect(plan.guidance).toContain('chain of one-shots')
  })

  it('says there is nothing to schedule when no calendar day satisfies the rule', () => {
    // Both of the sentences above instruct the caller to hand the *first* occurrence
    // over. A rule that never falls has none: `0 0 30 2 *` is a legal expression
    // whose day never arrives, so the plan used to carry an instruction the caller
    // could not follow beside the empty list that said so.
    //
    // Mutation: without the empty-list branch this plan carries the
    // chain-of-one-shots sentence and `occurrences: []` next to each other.
    const plan = runtime().schedulePlan({ cron: '0 0 30 2 *' })
    expect(plan.occurrences).toEqual([])
    expect(plan.fixedRateSeconds).toBeUndefined()
    expect(plan.guidance).toContain('Nothing to schedule')
    expect(plan.guidance).not.toContain('Hand the first occurrence')
    // And the label beside it does not name a schedule either (see the cron pins).
    expect(plan.rule.description).toBe('cron 0 0 30 2 *')
    // A rule that does fire keeps the sentence it had.
    expect(runtime().schedulePlan({ cron: '*/7 * * * *' }).guidance).toContain('chain of one-shots')
  })

  it('reports the weekday occurrences of a calendar rule as selectors', () => {
    // The case the Harness cannot express at all: `after`/`at`/`every` has no
    // calendar day, so "weekdays at 09:00" is five one-shots, not one reminder.
    const plan = runtime().schedulePlan({ cron: '0 9 * * 1-5', count: 5 })
    expect(plan.fixedRateSeconds).toBeUndefined()
    expect(plan.rule).toEqual({ source: '0 9 * * 1-5', description: 'weekdays at 09:00' })
    expect(plan.occurrences.map(occurrence => new Date(occurrence.atMs).getDay())).toEqual([2, 3, 4, 5, 1])
    expect(plan.occurrences.map(occurrence => new Date(occurrence.atMs).getDate())).toEqual([10, 11, 12, 13, 16])
  })

  it('renders each occurrence in both selector forms from one instant', () => {
    const [first] = runtime().schedulePlan({ cron: '0 9 * * *' }).occurrences
    expect(first).toBeDefined()
    // Two independently derived values could name two different moments; both
    // forms come off the same epoch millisecond.
    expect(new Date(first!.rfc3339).getTime()).toBe(first!.atMs)
    expect(first!.local.date).toBe('2026-03-10')
    expect(first!.local.time).toBe('09:00:00')
    expect(first!.local.time_zone).not.toBe('')
  })

  it('caps how many occurrences one call will hand over', () => {
    // Each selector the caller uses becomes a durable session event, so the
    // ceiling is what keeps an argument from turning into an unbounded chain.
    expect(runtime().schedulePlan({ cron: '* * * * *', count: 10_000 }).occurrences).toHaveLength(MAX_SCHEDULE_PLAN_COUNT)
    expect(runtime().schedulePlan({ cron: '* * * * *', count: 0 }).occurrences).toHaveLength(1)
    expect(runtime().schedulePlan({ cron: '* * * * *' }).occurrences).toHaveLength(DEFAULT_SCHEDULE_PLAN_COUNT)
  })

  it('reports who owns a reminder in status()', () => {
    expect(runtime({ scheduledTasksEnabled: false }).status().schedule).toEqual({ enabled: false, authority: 'harness' })
    expect(runtime().status().schedule).toEqual({ enabled: true, authority: 'harness' })
  })
})

describe('automation tool registration', () => {
  it('registers nothing when the composition has no tool service', () => {
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, { get: () => undefined }, { now: () => 1_000 })
    expect(() => { runtime.start() }).not.toThrow()
  })

  it('registers the calendar planner and recovery tools and answers every call', async () => {
    const tools: ToolRecord[] = []
    const host = hostDouble(tools)
    const runtime = new FreeCodeGoAutomationRuntime(undefined, undefined, host, { now: () => TUESDAY })
    runtime.start()
    expect(tools.map(tool => tool.name)).toEqual([
      'freecodego_schedule_plan',
      'freecodego_recovery_status',
    ])
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const plan = await byName.get('freecodego_schedule_plan')!.execute({ cron: '0 9 * * 1-5', count: 2 }, exec) as { occurrences: readonly unknown[]; fixedRateSeconds?: number }
    expect(plan.occurrences).toHaveLength(2)
    expect(plan.fixedRateSeconds).toBeUndefined()
    const status = await byName.get('freecodego_recovery_status')!.execute({}, exec)
    expect(status).toMatchObject({ hookChains: { ruleCount: 0 }, schedule: { enabled: true, authority: 'harness' } })
    for (const tool of tools) {
      expect(tool.presentCall()).toMatchObject({ card: 'generic' })
      expect(tool.output.render({}, { ok: true })).toEqual([{ type: 'text', text: '{"ok":true}' }])
    }
  })

  it('disposes every registration, whichever shape it has', () => {
    const disposers = [vi.fn(), vi.fn()]
    let index = 0
    const host = {
      on: vi.fn(),
      get: (name: string) => (name === 'tools'
        ? { register: () => (index++ === 0 ? disposers[0]! : { dispose: disposers[1]! }) }
        : undefined),
    }
    const runtime = new FreeCodeGoAutomationRuntime(host, undefined, host, { now: () => 1_000 })
    runtime.start()
    runtime.dispose()
    // Two registrations: the calendar planner, which returned a callable, and the
    // recovery status tool, which returned an object. Every shape is released.
    expect(disposers[0]).toHaveBeenCalledTimes(1)
    expect(disposers[1]).toHaveBeenCalledTimes(1)
    // A second dispose is a no-op rather than a double release.
    expect(() => { runtime.dispose() }).not.toThrow()
  })
})
