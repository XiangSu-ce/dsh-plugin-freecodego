/**
 * The recovery runtime's reload path, and the guard windows it must not re-arm.
 *
 * `FreeCodeGoAutomationRuntime` installs a workspace's recovery rules through
 * `loadHookChains`, and three callers reach it: the failing-tool path, the
 * turn-ended path, and — as a *read* — the `freecodego_recovery_status` tool,
 * which re-reads so the report is fresh. Re-reading is what makes a fixed
 * `hook-chains.json` take effect without a restart, so it has to stay.
 *
 * What must not follow from it is a guard reset. `HookChainRuntime.configure`
 * drops the per-rule cooldown and the action dedup windows, because those windows
 * belong to the ruleset they were recorded under. That is right for a *new*
 * ruleset and wrong for a repeated read of the same one: the cooldown exists so
 * "a persistently broken tool does not spawn a fallback agent on every retry",
 * and a model that inspects recovery state between two failing calls would clear
 * it and let the action fire again on the next identical failure.
 *
 * These cases drive the runtime directly (its constructor takes the settings
 * scope, the clock, and the collaborators), so the file on disk is the only input
 * either side of the comparison comes from.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FreeCodeGoAutomationRuntime, HOOK_CHAINS_RELATIVE_PATH } from '../src/automation.ts'

const COOLDOWN_MS = 30_000

interface Fixture {
  readonly root: string
  readonly runtime: FreeCodeGoAutomationRuntime
  readonly notifications: readonly string[]
  readonly clock: { now: number }
  /** Write a recovery document with one `notify_team` rule. */
  readonly writeRules: (workspace: string, ruleId: string) => void
  readonly dispose: () => void
}

function fixture(settings: Record<string, unknown> = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'freecodego-recovery-'))
  const notifications: string[] = []
  const clock = { now: 1_000_000 }
  const runtime = new FreeCodeGoAutomationRuntime(
    undefined,
    { get: () => ({ hookChainsEnabled: true, hookChainsCooldownMs: COOLDOWN_MS, hookChainsMaxDepth: 2, scheduledTasksEnabled: true, ...settings }) },
    { get: () => undefined },
    { now: () => clock.now, collaborators: { notifyTeam: (message) => { notifications.push(message) } } },
  )
  const writeRules = (workspace: string, ruleId: string): void => {
    mkdirSync(join(workspace, '.freecodego'), { recursive: true })
    writeFileSync(join(workspace, HOOK_CHAINS_RELATIVE_PATH), JSON.stringify({
      version: 1,
      rules: [{ id: ruleId, events: ['PostToolUseFailure'], actions: [{ kind: 'notify_team', message: `${ruleId} fired` }] }],
    }), 'utf8')
  }
  return {
    root: home,
    runtime,
    notifications,
    clock,
    writeRules,
    dispose: () => { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) },
  }
}

describe('recovery rules are re-read without re-arming the guards', () => {
  let current: Fixture | undefined
  afterEach(() => { current?.dispose(); current = undefined })

  function workspace(fix: Fixture, name: string): string {
    const path = join(fix.root, name)
    mkdirSync(path, { recursive: true })
    return path
  }

  it('fires once and then suppresses a second identical failure', async () => {
    current = fixture()
    const root = workspace(current, 'repo')
    current.writeRules(root, 'r1')
    await current.runtime.loadHookChains(root)
    expect((await current.runtime.dispatchToolFailure('bash', root)).fired).toEqual(['r1'])
    expect(current.notifications).toHaveLength(1)
    // Same rule, same action, same instant: the cooldown window holds it off.
    expect((await current.runtime.dispatchToolFailure('bash', root)).fired).toEqual([])
    expect(current.notifications).toHaveLength(1)
  })

  it('keeps the cooldown across a re-read of an unchanged file', async () => {
    current = fixture()
    const root = workspace(current, 'repo')
    current.writeRules(root, 'r1')
    await current.runtime.loadHookChains(root)
    await current.runtime.dispatchToolFailure('bash', root)
    expect(current.runtime.status().hookChains.cooldownEntries).toBe(1)
    // The inspection path (`freecodego_recovery_status`) re-reads the file.
    await current.runtime.loadHookChains(root)
    expect((await current.runtime.dispatchToolFailure('bash', root)).fired).toEqual([])
    expect(current.notifications).toHaveLength(1)
  })

  it('still installs a changed file, and derives its guards from the new ruleset', async () => {
    current = fixture()
    const root = workspace(current, 'repo')
    current.writeRules(root, 'r1')
    await current.runtime.loadHookChains(root)
    await current.runtime.dispatchToolFailure('bash', root)
    current.writeRules(root, 'r2')
    await current.runtime.loadHookChains(root)
    expect((await current.runtime.dispatchToolFailure('bash', root)).fired).toEqual(['r2'])
    expect(current.notifications).toEqual(['r1 fired', 'r2 fired'])
  })

  it('reinstalls when the workspace changes, even for the same rule id', async () => {
    current = fixture()
    const first = workspace(current, 'one')
    const second = workspace(current, 'two')
    current.writeRules(first, 'r1')
    current.writeRules(second, 'r1')
    await current.runtime.loadHookChains(first)
    await current.runtime.dispatchToolFailure('bash', first)
    await current.runtime.loadHookChains(second)
    // The second repository's own ruleset is installed, so its cooldown is its
    // own: a window recorded in `first` must not suppress a rule in `second`.
    expect((await current.runtime.dispatchToolFailure('bad-tool', second)).fired).toEqual(['r1'])
  })

  it('reinstalls when the settings that bound the guards change', async () => {
    current = fixture()
    const root = workspace(current, 'repo')
    current.writeRules(root, 'r1')
    const mutable = { hookChainsEnabled: true, hookChainsCooldownMs: COOLDOWN_MS, hookChainsMaxDepth: 2, scheduledTasksEnabled: true }
    const runtime = new FreeCodeGoAutomationRuntime(
      undefined,
      { get: () => mutable },
      { get: () => undefined },
      { now: () => current!.clock.now, collaborators: { notifyTeam: () => undefined } },
    )
    await runtime.loadHookChains(root)
    // A widened depth ceiling is part of what was installed, so the re-read has to
    // go through `configure` rather than short-circuit on an unchanged file.
    mutable.hookChainsMaxDepth = 4
    await runtime.loadHookChains(root)
    expect(runtime.status().hookChains.maxChainDepth).toBe(4)
  })
})
