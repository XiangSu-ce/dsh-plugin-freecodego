/**
 * Session automation: declarative failure recovery, and calendar arithmetic for
 * the Harness's own scheduler.
 *
 * This module is the wiring layer for two subsystems that are otherwise pure:
 * `HookChainRuntime` decides what a failure should trigger, and `scheduler/cron`
 * decides when a calendar rule next falls. Neither knows about the Host, and
 * this is the one place that does.
 *
 * Where scheduling lives, and why it is not here
 * ----------------------------------------------
 * The Harness owns scheduling: `@deepseek-ai/dsh-schedule` stores reminders in
 * the session log, folds them through the `schedule` projection, registers
 * `schedule_create` / `schedule_list` / `schedule_delete`, and delivers a due
 * reminder into its owning session. This plugin used to own a second scheduler
 * beside it — a workspace-local cron store, a fire loop over that store, and
 * three tools with the same three verbs. That was two answers to one question,
 * and the plugin's was the weaker one: its store was written and read but its
 * due-list had no caller at all, so a rule could be created and then never fire,
 * while the schedule surface and the settings page both implied it would.
 *
 * What is left here is the part the Harness's rule set cannot express. Its three
 * shapes are `after_seconds`, `at`, and `every_seconds`, so "weekdays at 09:00"
 * is not one of them and never will be. Answering *when* such a rule falls is
 * arithmetic, not scheduling, so this module answers it and hands the instants to
 * the Harness: one `every_seconds` reminder when the rule is genuinely fixed-rate,
 * and otherwise a chain of `at` selectors. There is exactly one owner of a
 * reminder — the Harness — and exactly one thing this plugin adds, which is the
 * calendar reading of a cron expression.
 *
 * What is deliberately *not* here
 * -------------------------------
 * The runtime does **not** invent capabilities to make an action look like it
 * ran. Every recovery action goes through a collaborator the composition
 * supplied; with no collaborator the action is recorded as skipped with a
 * reason. A recovery layer that reports success while doing nothing is worse
 * than one that reports it cannot act, because the user stops looking.
 *
 * Hook chains are read from a file the project owns
 * (`<workspace>/.freecodego/hook-chains.json`) rather than from plugin settings,
 * for the same reason the schedule file is workspace-local: a recovery rule is a
 * statement about this repository and belongs where it can be reviewed in a
 * diff. The settings switch is the gate; the file is the content.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/automation
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { HookChainRuntime, type HookChainDispatchResult, type HookChainOutcome, type HookChainStatus } from './hooks/hook-chains.ts'
import { toolDefinition as rawTool, type ToolDefinitionShape } from './tool-definition.ts'
import { CRON_SEARCH_HORIZON_YEARS, describeCronExpression, parseCronExpression, cronFixedRateSeconds, nextCronOccurrences, type CronOccurrence } from './scheduler/cron.ts'
import type { FreeCodeGoAutomationSettings, FreeCodeGoAutomationSettingsUpdate } from './types.ts'

/** Settings schema for the automation switches: hook chains and calendar planning. */
export const FreeCodeGoAutomationSettingsSchema = z.object({
  /** Master switch for declarative failure recovery. */
  hookChainsEnabled: z.boolean().default(true),
  hookChainsMaxDepth: z.number().step(1).min(0).max(10).default(2),
  hookChainsCooldownMs: z.number().step(1_000).min(0).max(24 * 60 * 60 * 1_000).default(30_000),
  /** Master switch for the calendar planner. */
  scheduledTasksEnabled: z.boolean().default(true),
})

// The two shapes this runtime reads and writes are declared in `./types.ts`,
// because a Remote boundary type has to live on the package's public type
// subpath. Re-exported here so callers keep one import source for the schema,
// the projection, and the shapes they act on.
export type { FreeCodeGoAutomationSettings, FreeCodeGoAutomationSettingsUpdate } from './types.ts'

/** What the automation runtime currently has in force and has done. */
export interface FreeCodeGoAutomationStatus {
  readonly hookChains: HookChainStatus & { readonly enabledBySettings: boolean; readonly configError?: string }
  readonly schedule: {
    readonly enabled: boolean
    /**
     * Who owns a reminder once it exists.
     *
     * Always `harness`. It is reported rather than assumed because the value is
     * the settlement of the duplication this module used to carry: a reader of
     * the status surface can see that this plugin stores no reminders of its
     * own, instead of having to trust that it does not.
     */
    readonly authority: 'harness'
  }
}

/** One rule's upcoming occurrences, as the Harness's `schedule_create` accepts them. */
export interface FreeCodeGoSchedulePlan {
  /** Canonical expression text and its human reading. */
  readonly rule: { readonly source: string; readonly description: string }
  /**
   * Seconds between firings when the rule is genuinely fixed-rate, so one
   * `every_seconds` reminder carries it. Absent when it is not.
   */
  readonly fixedRateSeconds?: number
  /** Occurrences to hand the Harness as `at` selectors, earliest first. */
  readonly occurrences: readonly CronOccurrence[]
  /** What the caller is expected to do with the answer, in one sentence. */
  readonly guidance: string
}

/** Where a project's recovery rules live, relative to its root. */
export const HOOK_CHAINS_RELATIVE_PATH = join('.freecodego', 'hook-chains.json')

/** Occurrences reported when the caller does not say how many it wants. */
export const DEFAULT_SCHEDULE_PLAN_COUNT = 5

/**
 * Ceiling on reported occurrences.
 *
 * Each one is a candidate `at` selector, and every selector the caller uses
 * becomes a durable session event, so the ceiling bounds one call's blast radius
 * at twenty reminders rather than trusting an argument.
 */
export const MAX_SCHEDULE_PLAN_COUNT = 20

/** Collaborators a composition may supply; each absent one turns into a skip. */
export interface AutomationCollaborators {
  readonly notifyTeam?: (message: string, target?: string) => Promise<void> | void
  readonly spawnFallbackAgent?: (message: string, target?: string) => Promise<void> | void
  readonly warmRemoteCapacity?: (target?: string) => Promise<void> | void
}

/** Structural settings scope, matching the other plugin registries. */
export interface AutomationSettingsScope {
  get(): unknown
}

type ToolRegistration = (() => void) | { dispose?: () => void }
type ToolService = { register(tool: ToolDefinitionShape): ToolRegistration }

/** One tool outcome, as far as this runtime cares about it. */
export interface AutomationToolOutcome {
  readonly name: string
  /** Present for an agent-driven call; absent for a transport sub-dispatch. */
  readonly agent?: { readonly session: { readonly header: { readonly cwd?: string } } }
}

/** The session behind a `session/event` payload, as far as this runtime reads it. */
export interface AutomationSessionLike {
  readonly header: { readonly cwd?: string }
}

/** The one session event this runtime consumes, as far as it reads it. */
export interface AutomationSessionEventLike {
  readonly type: string
  readonly data: { readonly reason?: unknown }
}

/** Structural view of the Host events this runtime consumes. */
export interface AutomationEventHost {
  on(event: 'tools/result', handler: (exec: AutomationToolOutcome, result: { readonly isError: boolean }) => void): unknown
  on(event: 'session/event', handler: (session: AutomationSessionLike, event: AutomationSessionEventLike) => void): unknown
}

/**
 * The outcome a `turn/end` reason means to a hook chain.
 *
 * A judgement, not a rename — the four outcomes a rule condition can match
 * (`success`, `failed`, `timeout`, `unknown`) are coarser than the six reasons
 * the Harness records, so each reason has to be read for what it says about the
 * work rather than for what it is called:
 *
 * - `completed` is the only reason that means the turn finished on its own
 *   terms, so it is the only `success`.
 * - `error` is the only reason that means the turn broke, so it is the only
 *   `failed`. A recovery rule must not fire on a deliberate cancel.
 * - `max-tokens` means a step reached its output ceiling, so the turn ended
 *   because a budget ran out rather than because the work concluded; `timeout`
 *   is the one member that means "stopped by a limit".
 * - `aborted`, `blocked` and `interrupted` all say the turn stopped for a
 *   reason that carries no verdict on the work, so they are `unknown`. Calling
 *   an abort `failed` would fire failure recovery at a user who just pressed
 *   stop, which is the one outcome recovery must not produce.
 *
 * Anything unrecognised is `unknown` rather than a throw: this runs on the
 * session append path, and a reason a future Harness adds must not turn a turn
 * ending into a turn that cannot end.
 * @param reason - the `turn/end` reason the Harness recorded.
 * @returns the hook Chain Outcome.
 */
export function outcomeOfTurnEnd(reason: unknown): HookChainOutcome {
  const kind = typeof reason === 'object' && reason !== null ? (reason as { readonly kind?: unknown }).kind : undefined
  switch (kind) {
    case 'completed': return 'success'
    case 'error': return 'failed'
    case 'max-tokens': return 'timeout'
    default: return 'unknown'
  }
}


/** Optional collaborators and clock the automation runtime is constructed with. */
export interface AutomationRuntimeOptions {
  readonly collaborators?: AutomationCollaborators
  readonly now?: () => number
}

/** Default values for the automation switches, matching the schema's own defaults. */
export const AUTOMATION_SETTINGS_DEFAULTS: FreeCodeGoAutomationSettings = {
  hookChainsEnabled: true,
  hookChainsMaxDepth: 2,
  hookChainsCooldownMs: 30_000,
  scheduledTasksEnabled: true,
}

const BOOLEAN_KEYS = ['hookChainsEnabled', 'scheduledTasksEnabled'] as const
const NUMBER_KEYS = ['hookChainsMaxDepth', 'hookChainsCooldownMs'] as const

/**
 * Narrow an arbitrary settings read onto the switches this runtime owns.
 *
 * Every field falls back independently, so a settings document written by an
 * older version (or hand-edited) still yields a usable policy instead of
 * poisoning all seven switches at once.
 * @returns the automation Settings.
 * @param value - the value to interpret, of unknown shape.
 */
export function normalizeAutomationSettings(value: unknown): FreeCodeGoAutomationSettings {
  if (typeof value !== 'object' || value === null) return AUTOMATION_SETTINGS_DEFAULTS
  const record = value as Record<string, unknown>
  const settings: {
    -readonly [K in keyof FreeCodeGoAutomationSettings]: FreeCodeGoAutomationSettings[K]
  } = { ...AUTOMATION_SETTINGS_DEFAULTS }
  for (const key of BOOLEAN_KEYS) {
    const entry = record[key]
    if (typeof entry === 'boolean') settings[key] = entry
  }
  for (const key of NUMBER_KEYS) {
    const entry = record[key]
    if (typeof entry === 'number' && Number.isFinite(entry)) settings[key] = entry
  }
  return settings
}

/**
 * Project an arbitrary patch onto the switches this runtime owns.
 *
 * This exists because those four switches had no writer at all: they were
 * declared in the schema, read by this runtime, reported through
 * `freecodego_recovery_status`, and named by `freecodego_schedule_plan`'s
 * refusal — while nothing could change them. A schema that advertises a switch
 * nobody can turn is a control that does not exist.
 *
 * Deliberately not {@link normalizeAutomationSettings}, for two properties:
 *
 * - Only keys the caller supplied survive. Normalizing fills every field from
 *   the defaults, so writing its result would silently reset the switches the
 *   caller did not mention — a one-switch update that turns the others back on.
 * - Bounds are not re-imposed here. The settings schema owns them (`min`, `max`,
 *   `step`) and the settings service validates every patch against it, so an
 *   out-of-range value is refused with the schema's own message instead of being
 *   quietly clamped by a second copy of the same numbers.
 *
 * The type test is the same one the reader applies, so a value this accepts is a
 * value that read would honor.
 * @returns the automation Settings Update.
 * @param value - the value to interpret, of unknown shape.
 */
export function automationSettingsPatch(value: unknown): FreeCodeGoAutomationSettingsUpdate {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const patch: { -readonly [K in keyof FreeCodeGoAutomationSettingsUpdate]: FreeCodeGoAutomationSettingsUpdate[K] } = {}
  for (const key of BOOLEAN_KEYS) {
    const entry = record[key]
    if (typeof entry === 'boolean') patch[key] = entry
  }
  for (const key of NUMBER_KEYS) {
    const entry = record[key]
    if (typeof entry === 'number' && Number.isFinite(entry)) patch[key] = entry
  }
  return patch
}

/** Declarative failure recovery (hook chains) plus the calendar planner for one Host. */
export class FreeCodeGoAutomationRuntime {
  private readonly tools: ToolService | undefined
  private readonly registrations: ToolRegistration[] = []
  private readonly chains: HookChainRuntime
  private readonly now: () => number
  private configError: string | undefined
  /** Workspace whose recovery rules are currently installed, so a session that
   * switches workspace reloads rather than inheriting another repo's rules. */
  private loadedFor: string | undefined
  /** Rule loads still reading, by workspace root. A burst of failing tool calls
   * arrives one event per call inside a single tick, and `loadedFor` is claimed
   * before the read finishes; the awaiting side needs the promise, not the
   * claim, or the rest of the burst dispatches against the previous rules. */
  private readonly pendingLoads = new Map<string, Promise<{ readonly configured: boolean; readonly error?: string }>>()
  /**
   * Identity of the ruleset actually installed, and the workspace it belongs to.
   *
   * Separate from {@link loadedFor}, which is the *claim* that the read for that
   * workspace has started. The identity is what lets a re-read of an unchanged
   * ruleset pass through without calling `configure`: that call drops the per-rule
   * cooldown and the action dedup windows, and those windows belong to the ruleset
   * they were recorded under — reinstalling the same one would clear a cooldown
   * that is still in force. The inspection tool re-reads on purpose (it is how a
   * fixed file takes effect without a restart), so this is not a rare path.
   */
  private installedRoot: string | undefined
  private installedFingerprint: string | undefined

  constructor(
    private readonly host: AutomationEventHost | undefined,
    private readonly settings: AutomationSettingsScope | undefined,
    ctx: { get(name: string): unknown },
    options: AutomationRuntimeOptions = {},
  ) {
    this.tools = ctx.get('tools') as ToolService | undefined
    this.now = options.now ?? Date.now
    const collaborators = options.collaborators ?? {}
    this.chains = new HookChainRuntime({
      notify_team: (action) => {
        if (collaborators.notifyTeam === undefined) return { skipped: 'no team channel is mounted in this composition' }
        return Promise.resolve(collaborators.notifyTeam(action.message ?? 'recovery action fired', action.target)).then(() => undefined)
      },
      spawn_fallback_agent: (action) => {
        if (collaborators.spawnFallbackAgent === undefined) return { skipped: 'no fallback agent launcher is mounted in this composition' }
        return Promise.resolve(collaborators.spawnFallbackAgent(action.message ?? 'retry with a fallback agent', action.target)).then(() => undefined)
      },
      warm_remote_capacity: (action) => {
        if (collaborators.warmRemoteCapacity === undefined) return { skipped: 'no remote capacity hook is mounted in this composition' }
        return Promise.resolve(collaborators.warmRemoteCapacity(action.target)).then(() => undefined)
      },
    })
  }

  private configuration(): FreeCodeGoAutomationSettings {
    return normalizeAutomationSettings(this.settings?.get())
  }

  /**
   * Read the project's recovery rules and install them, if the gate is open.
   *
   * A malformed recovery file must not stop the plugin loading, so the parse
   * failure is reported through `status()` rather than thrown; a rule that fires
   * in a loop is the one outcome worth refusing outright, which is why the
   * depth and cooldown guards come from settings and are re-applied here even
   * when the file tries to widen them.
   * @param cwd - working directory the command runs in.
   * @returns whether a ruleset is configured, and the load error when there was one.
   */
  async loadHookChains(cwd: string): Promise<{ readonly configured: boolean; readonly error?: string }> {
    this.configError = undefined
    const root = resolve(cwd)
    this.loadedFor = root
    const settings = this.configuration()
    if (!settings.hookChainsEnabled) {
      this.install(root, 'disabled', { enabled: false, rules: [] })
      return { configured: false }
    }
    const file = join(root, HOOK_CHAINS_RELATIVE_PATH)
    if (!existsSync(file)) {
      this.install(root, this.fingerprintOf(undefined, settings), { maxChainDepth: settings.hookChainsMaxDepth, defaultCooldownMs: settings.hookChainsCooldownMs, rules: [] })
      return { configured: true }
    }
    try {
      const text = await readFile(file, 'utf8')
      const document = JSON.parse(text) as unknown
      const record = typeof document === 'object' && document !== null ? document as Record<string, unknown> : {}
      this.install(root, this.fingerprintOf(text, settings), { ...record, maxChainDepth: settings.hookChainsMaxDepth, defaultCooldownMs: settings.hookChainsCooldownMs })
      return { configured: true }
    } catch (error) {
      // `JSON.parse` throws a `SyntaxError` and `configure` throws an `Error` on
      // every path that can reach here, so the message is always available.
      this.configError = (error as Error).message
      // Nothing is installed for this read, and a half-applied attempt leaves the
      // runtime inert (`configure` is atomic), so the identity is dropped rather
      // than left describing a ruleset the runtime no longer holds: the next read
      // then re-attempts and reports the same error instead of claiming this one.
      this.installedRoot = undefined
      this.installedFingerprint = undefined
      return { configured: false, error: this.configError }
    }
  }

  /**
   * Install a ruleset unless exactly this one is already installed for this root.
   *
   * The comparison is the whole point: `configure` is what makes a changed file
   * take effect, and it is also what drops the guard windows, so the two have to
   * be told apart. A file that reads the same as the one already installed, under
   * the same guard bounds, is the case where reinstalling costs the cooldown and
   * buys nothing.
   */
  private install(root: string, fingerprint: string, document: unknown): void {
    if (this.installedRoot === root && this.installedFingerprint === fingerprint) return
    this.chains.configure(document)
    this.installedRoot = root
    this.installedFingerprint = fingerprint
  }

  /**
   * Identity of one load: the file's bytes plus the settings that bound its guards.
   *
   * The settings are part of it because they are written *into* the installed
   * ruleset (`maxChainDepth` and `defaultCooldownMs` are re-applied over the file's
   * own values), so changing a switch has to reinstall even when the file did not
   * change. A missing file is a distinct identity from an empty one, because the
   * two install different rulesets.
   */
  private fingerprintOf(text: string | undefined, settings: FreeCodeGoAutomationSettings): string {
    return createHash('sha256')
      .update(text === undefined ? 'absent' : `file:${text}`)
      .update(`|depth:${settings.hookChainsMaxDepth}`)
      .update(`|cooldown:${settings.hookChainsCooldownMs}`)
      .digest('hex')
  }

  /**
   * Dispatch a chain because a tool call failed. Never throws: a failure inside
   * recovery must not turn one broken call into two.
   *
   * The first call for a workspace installs that workspace's rules; a call for a
   * different workspace reloads, so a session that changed directories does not
   * keep firing the previous repository's recovery rules.
   * @param toolName - name of the tool call being answered.
   * @returns the hook Chain Dispatch Result.
   * @param cwd - working directory the command runs in.
   */
  async dispatchToolFailure(toolName: string, cwd: string = process.cwd()): Promise<HookChainDispatchResult> {
    await this.ensureChainsFor(cwd)
    return this.chains.dispatch({ event: 'PostToolUseFailure', outcome: 'failed', toolName, now: this.now() })
  }

  /**
   * Install `cwd`'s recovery rules, single-flight per workspace, and only then
   * let the caller dispatch.
   *
   * The load must be awaited even when the workspace is already claimed:
   * `loadHookChains` marks `loadedFor` synchronously so two callers cannot read
   * the same file twice, which means a concurrent caller arriving while the read
   * is still in flight would otherwise dispatch against whatever ruleset was
   * installed before — the cross-repository recovery the reload exists to
   * prevent, and a silent no-op when the previous workspace had no rules.
   */
  private async ensureChainsFor(cwd: string): Promise<void> {
    const root = resolve(cwd)
    if (this.loadedFor !== root) this.startLoad(root)
    await this.pendingLoads.get(root)
  }

  private startLoad(root: string): void {
    if (this.pendingLoads.has(root)) return
    const pending = this.loadHookChains(root)
    this.pendingLoads.set(root, pending)
    void pending
      .catch(() => undefined)
      .then(() => { if (this.pendingLoads.get(root) === pending) this.pendingLoads.delete(root) })
  }

  /** Dispatch a chain because a task reached a terminal status.
   * @param status - the terminal outcome to dispatch for.
   * @returns the hook Chain Dispatch Result.
   */
  async dispatchTaskCompleted(status: HookChainOutcome): Promise<HookChainDispatchResult> {
    return this.chains.dispatch({ event: 'TaskCompleted', outcome: status, taskStatus: status, now: this.now() })
  }

  /**
   * Dispatch `TaskCompleted` for a turn that just ended, in `cwd`'s workspace.
   *
   * The load is awaited before the dispatch for the reason
   * {@link ensureChainsFor} gives, and it matters more here than on the tool
   * path: a turn can end in a workspace that has never had a failing tool call,
   * so this is often the *first* thing to read that project's rules. Dispatching
   * first would run against whatever ruleset was installed before — no rules, on
   * a fresh process — and the user's rule would be a silent no-op that looks
   * exactly like a rule that matched nothing.
   *
   * Never throws, for the same reason `dispatchToolFailure` does not: this is
   * called from a session observer, and a failure inside recovery must not turn
   * one ended turn into a rejected append.
   * @param reason - the `turn/end` reason that just fired.
   * @returns the hook Chain Dispatch Result.
   * @param cwd - working directory the command runs in.
   */
  async dispatchTurnEnd(reason: unknown, cwd: string = process.cwd()): Promise<HookChainDispatchResult> {
    await this.ensureChainsFor(cwd)
    return this.dispatchTaskCompleted(outcomeOfTurnEnd(reason))
  }

  /**
   * Subscribe to Host events, so a failure or a finished turn dispatches a chain.
   *
   * Two triggers, and the `TaskCompleted` one is here because it had none:
   * {@link dispatchTaskCompleted} was the only dispatcher of that event and
   * nothing called it, so a rule that named `TaskCompleted` was loaded,
   * validated, and then never fired — a switch the user could write and not
   * turn on.
   *
   * The trigger is the session log's `turn/end` rather than the `agent/status`
   * flip, for three reasons. It carries the reason that decides the outcome,
   * where the only terminal status is `idle` and says nothing about how the turn
   * ended. It is appended exactly once per turn, so a rule cannot fire twice for
   * one turn. And it is the durable record — the status flip is emitted
   * synchronously alongside it, and the loop emits an `idle` for turns that
   * never reached a step, which is a turn ending with nothing to report.
   *
   * It fires for every session, subagent sessions included, which is what the
   * tool-failure trigger already does: a rule that recovers from failure is
   * written about the work, and a child agent's turn is work.
   */
  start(): void {
    this.host?.on('tools/result', (exec, result) => {
      if (!result.isError) return
      const cwd = exec.agent?.session.header.cwd
      void this.dispatchToolFailure(exec.name, cwd === undefined ? process.cwd() : cwd).catch(() => undefined)
    })
    this.host?.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const cwd = session.header.cwd
      void this.dispatchTurnEnd(event.data.reason, cwd === undefined ? process.cwd() : cwd).catch(() => undefined)
    })
    void this.registerTools()
  }

  /** Release the runtime's tool registrations and reset the chain guards. */
  dispose(): void {
    for (const registration of this.registrations.splice(0)) {
      if (typeof registration === 'function') registration()
      else registration.dispose?.()
    }
    this.chains.resetGuards()
  }

  /**
   * The switches currently in effect, as this runtime read them.
   *
   * Separate from {@link status} because they answer different questions: this
   * one says what policy is in force (so a caller that just wrote a switch can
   * read back what landed, including the values `status` does not report), while
   * `status` says what the runtime has done with it.
   * @returns the automation Settings.
   */
  effectiveSettings(): FreeCodeGoAutomationSettings {
    return this.configuration()
  }

  /** What the runtime has done with the current policy, for the status surface.
   * @returns the automation status.
   */
  status(): FreeCodeGoAutomationStatus {
    const settings = this.configuration()
    return {
      hookChains: {
        ...this.chains.status(),
        enabledBySettings: settings.hookChainsEnabled,
        ...(this.configError === undefined ? {} : { configError: this.configError }),
      },
      schedule: { enabled: settings.scheduledTasksEnabled, authority: 'harness' },
    }
  }

  /**
   * Read a calendar rule and answer when it next falls.
   *
   * Stateless on purpose, and the only thing this plugin still does about
   * scheduling. Every part of it belongs to a different owner: the expression is
   * parsed here because the Harness has no cron reader, the instants are handed
   * over as selectors the Harness already accepts, and creating the reminder is
   * the Harness's `schedule_create`. Nothing is stored, so there is no second
   * copy of a reminder to fall out of step with the first.
   *
   * `count` is capped rather than trusted: a caller asking for a thousand
   * `at` selectors is building the chain one reminder at a time, and the cap is
   * what keeps a typo in an argument from becoming a thousand durable events.
   * @param input - the cron expression and the number of occurrences wanted.
   * @returns the schedule Plan.
   */
  schedulePlan(input: { readonly cron: string; readonly count?: number }): FreeCodeGoSchedulePlan {
    if (!this.configuration().scheduledTasksEnabled) throw new Error('calendar scheduling is disabled in the FreeCodeGo automation settings')
    const expression = parseCronExpression(input.cron)
    const requested = input.count === undefined ? DEFAULT_SCHEDULE_PLAN_COUNT : Math.floor(input.count)
    const count = Math.max(1, Math.min(MAX_SCHEDULE_PLAN_COUNT, Number.isFinite(requested) ? requested : DEFAULT_SCHEDULE_PLAN_COUNT))
    const fixedRateSeconds = cronFixedRateSeconds(expression)
    const occurrences = nextCronOccurrences(expression, this.now(), count)
    return {
      rule: { source: expression.source, description: describeCronExpression(expression) },
      ...(fixedRateSeconds === undefined ? {} : { fixedRateSeconds }),
      occurrences,
      // An empty occurrence list is a fact about the rule rather than an error in
      // the call, and the guidance is where that fact becomes actionable: both
      // sentences below instruct the caller to hand the *first* occurrence over, and
      // a rule that never falls — `0 0 30 2 *`, a legal expression whose day never
      // arrives — has none to hand over.
      guidance: occurrences.length === 0
        // The horizon is interpolated rather than written out: this sentence is what
        // a reader — model or user — takes as the bound on "this rule never fires",
        // and a number spelled beside the search is how it came to say four after the
        // search had left that behind.
        ? `Nothing to schedule: no calendar day satisfies this rule inside the next ${CRON_SEARCH_HORIZON_YEARS} years, so there is no occurrence to hand the Harness. Check the day, month, and weekday fields against one another rather than re-arming a reminder.`
        : fixedRateSeconds === undefined
          ? 'Hand the first occurrence to the Harness schedule tool as an `at` selector, and re-arm it from the same rule when the reminder arrives: the Harness\'s rule set has no calendar day, so a rule like this one is a chain of one-shots rather than a single recurring reminder.'
          : `Create one Harness schedule with every_seconds ${fixedRateSeconds}: the rule is fixed-rate, so a single recurring reminder carries it and no chain is needed.`,
    }
  }

  private async registerTools(): Promise<void> {
    if (this.tools === undefined) return
    type Exec = { readonly agent?: { readonly session: { readonly header: { readonly cwd?: string } } } }
    const cwdOf = (exec: Exec): string => exec.agent?.session.header.cwd ?? process.cwd()
    // Annotated rather than inferred: without it `type: 'object'` widens to
    // `string`, which no longer satisfies the registry's JSON-schema node.
    const output: ToolDefinitionShape['output'] = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
    this.registrations.push(this.tools.register(rawTool({
      name: 'freecodego_schedule_plan',
      description: 'Read a calendar rule and answer when it next falls, so the Harness can be told to schedule it. Give a five-field cron expression (minute hour day-of-month month day-of-week) or an alias such as @daily, and use the returned selectors with the Harness schedule tool: a fixed-rate rule reports fixedRateSeconds and needs one every_seconds reminder, while any other rule reports its occurrences as at selectors because the Harness has no calendar day. Creating, listing, and deleting a reminder is the Harness schedule tool\'s job, not this one\'s.',
      parameters: { type: 'object', additionalProperties: false, required: ['cron'], properties: { cron: { type: 'string' }, count: { type: 'number', description: `How many upcoming occurrences to report, at most ${MAX_SCHEDULE_PLAN_COUNT}.` } } },
      output,
      execute: async (args: { readonly cron: string; readonly count?: number }) => this.schedulePlan(args),
      presentCall: (args: { readonly cron?: string }) => ({ card: 'generic', title: `Schedule plan: ${args?.cron ?? 'cron'}` }),
    })))
    this.registrations.push(this.tools.register(rawTool({
      name: 'freecodego_recovery_status',
      description: 'Report the declarative failure-recovery rules loaded for this workspace, the guard windows in force, and how many actions have run or been skipped.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      execute: async (_args: unknown, exec: Exec) => {
        await this.loadHookChains(cwdOf(exec))
        return this.status()
      },
      presentCall: () => ({ card: 'generic', title: 'Inspect failure-recovery rules' }),
    })))
  }
}
