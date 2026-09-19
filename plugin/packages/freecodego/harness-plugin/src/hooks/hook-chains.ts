/**
 * Declarative hook chains — an event-driven recovery layer for workflow failures.
 *
 * Why a rule engine rather than a hook script
 * -------------------------------------------
 * The Host already owns hook *execution*: `dsh-hooks-claude-code` and
 * `dsh-hooks-codex` run a project's `hooks.json` verbatim, and this plugin does
 * not need a second copy of that. What has no owner is the decision of *what to
 * do when work fails*: a tool call that keeps failing, a task that ended
 * blocked. Those decisions are today either absent or hand-coded per call site.
 *
 * OpenClaude's `src/utils/hookChains.ts` (and `docs/hook-chains.md`) solve that
 * with declarative rules over a small event vocabulary, and its guard design is
 * the part worth copying exactly — a recovery layer that can storm is worse than
 * no recovery layer:
 *
 * - **Depth guard** — a chain dispatch cannot itself dispatch another chain
 *   past `maxChainDepth`. Without it, a `spawn_fallback_agent` action whose
 *   fallback also fails recurses until the process dies. The depth is *counted*
 *   by this runtime rather than asked of the caller: a nested dispatch is issued
 *   from inside a handler, so the runtime is the only party that knows one chain
 *   caused another. `chainDepth` on the input still overrides it, which is what
 *   an out-of-band caller (a timer, a retry scheduled after the handler returned)
 *   uses to declare where it stands. Asking every caller instead — the first
 *   shape of this guard — left the cap inert in production, because the two
 *   dispatch entry points in `automation.ts` pass no depth and no handler
 *   context carried one to pass. Counting it on the instance instead was worse
 *   than inert: concurrent dispatches are not nested, and a counter read by one
 *   in flight is the other's depth.
 * - **Per-rule cooldown** — one rule cannot re-fire for `cooldownMs` after it
 *   fired, so a persistently broken tool does not spawn a fallback agent on
 *   every retry.
 * - **Action dedup window** — identical `(event, rule, action)` tuples are
 *   suppressed for `dedupWindowMs`, so two events in the same instant produce
 *   one side effect.
 * - **Abort safety** — a dispatch that observes an aborted signal performs no
 *   action at all. Recovery must never outlive the operation it was recovering.
 * - **Fail-soft actions** — a handler that throws, or that reports it could not
 *   act, is recorded with a structured reason and the remaining actions still
 *   run. A broken recovery hook must not break the turn that triggered it.
 *
 * Two rules this module imposes on itself:
 *
 * 1. **No handler is required.** A composition without a team, without a bridge,
 *    or without a fallback launcher still evaluates rules and reports them as
 *    skipped with a reason. "Fired nothing because it cannot" is reported, not
 *    silently swallowed.
 * 2. **The guard bookkeeping is bounded.** Cooldown and dedup maps are capped
 *    the same way OpenClaude caps them (5 000 / 20 000), because an unbounded
 *    map keyed by rule id is a slow leak in a long-lived Host process.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hooks/hook-chains
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The depth of the chain being handled, carried along the async context.
 *
 * An async-context store rather than a counter on the runtime, because a counter
 * cannot tell a *nested* dispatch from a *concurrent* one. Two independent tool
 * failures can be in flight at the same time, and a counter read by the second
 * one is the first one's depth: with it, the third failure in a burst of three
 * arrived "too deep" and fired nothing. This tracks causation instead — a
 * dispatch made by a handler, or by a callback that handler scheduled, inherits
 * one level; a dispatch from anywhere else starts at zero.
 */
const chainContext = new AsyncLocalStorage<number>()

/** Outcome of the event that dispatched a chain. */
export type HookChainOutcome = 'success' | 'failed' | 'timeout' | 'unknown'

/** Events this plugin dispatches. Kept narrow on purpose: every member needs a
 * real producer in this plugin or the rule can never fire. */
export type HookChainEventName = 'PostToolUseFailure' | 'TaskCompleted'

/** The remediation actions a rule may declare. */
export type HookChainActionKind = 'spawn_fallback_agent' | 'notify_team' | 'warm_remote_capacity'

export interface HookChainCondition {
  /** Match only these tool names. Absent matches every tool. */
  readonly toolNames?: readonly string[]
  /** Match only these task statuses (for `TaskCompleted`). */
  readonly taskStatuses?: readonly string[]
  /** Match only these outcomes. Absent matches every outcome. */
  readonly outcomes?: readonly HookChainOutcome[]
}

export interface HookChainAction {
  readonly kind: HookChainActionKind
  /** Free-form target: an agent name, a team name, or a capacity hint. */
  readonly target?: string
  readonly message?: string
}

export interface HookChainRule {
  readonly id: string
  /** Per-rule kill switch; absent means enabled. */
  readonly enabled?: boolean
  /** Events this rule listens to. Absent means every event. */
  readonly events?: readonly HookChainEventName[]
  readonly when?: HookChainCondition
  readonly actions: readonly HookChainAction[]
  readonly cooldownMs?: number
  readonly dedupWindowMs?: number
}

export interface HookChainConfig {
  readonly version?: 1
  readonly enabled?: boolean
  readonly maxChainDepth?: number
  readonly defaultCooldownMs?: number
  readonly defaultDedupWindowMs?: number
  readonly rules?: readonly HookChainRule[]
}

/** The normalized config the runtime actually stores. */
export interface NormalizedHookChainConfig {
  readonly version: 1
  readonly enabled: boolean
  readonly maxChainDepth: number
  readonly defaultCooldownMs: number
  readonly defaultDedupWindowMs: number
  readonly rules: readonly HookChainRule[]
}

export const DEFAULT_MAX_CHAIN_DEPTH = 2
export const DEFAULT_COOLDOWN_MS = 30_000
export const DEFAULT_DEDUP_WINDOW_MS = 30_000
export const MAX_CHAIN_DEPTH = 10
/** Ceiling shared with OpenClaude's config doc; a larger guard window is a typo. */
export const MAX_GUARD_WINDOW_MS = 24 * 60 * 60 * 1_000
export const MAX_COOLDOWN_ENTRIES = 5_000
export const MAX_DEDUP_ENTRIES = 20_000

const EVENT_NAMES: ReadonlySet<string> = new Set(['PostToolUseFailure', 'TaskCompleted'])
const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failed', 'timeout', 'unknown'])
const ACTION_KINDS: ReadonlySet<string> = new Set(['spawn_fallback_agent', 'notify_team', 'warm_remote_capacity'])

/** Machine-readable reasons a dispatch did nothing. */
export type HookChainBlockReason = 'disabled' | 'depth' | 'aborted'

export interface HookChainActionRecord {
  readonly ruleId: string
  readonly kind: HookChainActionKind
  readonly status: 'executed' | 'skipped'
  /** Why it was skipped. Present exactly when `status` is `skipped`. */
  readonly reason?: string
}

export interface HookChainDispatchResult {
  readonly enabled: boolean
  /** Rule ids that fired their actions in this dispatch. */
  readonly fired: readonly string[]
  /**
   * Rule ids that did not fire, whatever the reason.
   *
   * The list used to be documented as "suppressed by cooldown or dedup", which is
   * narrower than what it holds: a rule that is switched off, listens to another
   * event, or fails its condition is in here too. That is the more useful answer —
   * a dispatch that fired nothing reports *which* rules it considered — so the
   * documentation follows the behaviour rather than the other way round. Per-action
   * guard refusals are named precisely where they happen, in
   * {@link HookChainActionRecord.reason}.
   */
  readonly suppressed: readonly string[]
  readonly actions: readonly HookChainActionRecord[]
  /** Present exactly when the dispatch never evaluated a rule. */
  readonly blocked?: HookChainBlockReason
  readonly chainDepth: number
}

export interface HookChainDispatchInput {
  readonly event: HookChainEventName
  readonly outcome: HookChainOutcome
  readonly toolName?: string
  readonly taskStatus?: string
  /**
   * Depth of the dispatch that caused this one.
   *
   * Absent means "whatever this runtime is already inside": depth 0 for a call
   * that arrives from outside, and one more than the in-flight chain for a call
   * a handler makes. Pass it explicitly only when neither is true — a retry the
   * handler scheduled after it returned, for instance.
   */
  readonly chainDepth?: number
  readonly signal?: AbortSignal
  /** Injectable clock; the guard windows are relative to it. */
  readonly now?: number
}

/**
 * One action handler. Returning `{ skipped }` records a structured skip;
 * throwing is caught and recorded the same way, so a handler never has to
 * choose between reporting a problem and letting the chain continue.
 */
export type HookChainActionHandler = (
  action: HookChainAction,
  context: {
    readonly event: HookChainEventName
    readonly outcome: HookChainOutcome
    readonly now: number
    /**
     * The depth of the dispatch running this handler.
     *
     * The same value a nested dispatch inherits, which this handler does not have
     * to pass for that to work — offered for the two things that need it in
     * writing: the message a recovery action reports, and a store of its own that
     * outlives the call.
     */
    readonly chainDepth: number
  },
) => Promise<HookChainActionOutcome> | HookChainActionOutcome

/** `undefined` means the handler acted; `{ skipped }` records why it did not. */
export type HookChainActionOutcome = { readonly skipped: string } | undefined

export interface HookChainHandlers {
  readonly spawn_fallback_agent?: HookChainActionHandler
  readonly notify_team?: HookChainActionHandler
  readonly warm_remote_capacity?: HookChainActionHandler
}

export interface HookChainStatus {
  readonly enabled: boolean
  readonly ruleCount: number
  readonly maxChainDepth: number
  readonly cooldownEntries: number
  readonly dedupEntries: number
  readonly dispatched: number
  readonly actionRuns: number
  readonly actionSkips: number
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < min) return fallback
  return floored > max ? max : floored
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`hook chains: ${label} must be an array of strings`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') throw new Error(`hook chains: ${label} must be an array of non-empty strings`)
    out.push(entry)
  }
  return out
}

function normalizeCondition(value: unknown): HookChainCondition | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('hook chains: rule.when must be an object')
  const condition: {
    toolNames?: readonly string[]
    taskStatuses?: readonly string[]
    outcomes?: readonly HookChainOutcome[]
  } = {}
  const toolNames = stringArray(value.toolNames, 'rule.when.toolNames')
  if (toolNames !== undefined) condition.toolNames = toolNames
  const taskStatuses = stringArray(value.taskStatuses, 'rule.when.taskStatuses')
  if (taskStatuses !== undefined) condition.taskStatuses = taskStatuses
  if (value.outcomes !== undefined) {
    if (!Array.isArray(value.outcomes)) throw new Error('hook chains: rule.when.outcomes must be an array')
    const outcomes: HookChainOutcome[] = []
    for (const entry of value.outcomes) {
      if (typeof entry !== 'string' || !OUTCOMES.has(entry)) throw new Error(`hook chains: rule.when.outcomes contains an unknown outcome: ${String(entry)}`)
      outcomes.push(entry as HookChainOutcome)
    }
    condition.outcomes = outcomes
  }
  return Object.keys(condition).length === 0 ? undefined : condition
}

function normalizeAction(value: unknown, ruleId: string): HookChainAction {
  if (!isRecord(value)) throw new Error(`hook chains: rule ${ruleId} has an action that is not an object`)
  if (typeof value.kind !== 'string' || !ACTION_KINDS.has(value.kind)) {
    throw new Error(`hook chains: rule ${ruleId} has an unknown action kind: ${String(value.kind)}`)
  }
  const action: { kind: HookChainActionKind; target?: string; message?: string } = { kind: value.kind as HookChainActionKind }
  if (value.target !== undefined) {
    if (typeof value.target !== 'string') throw new Error(`hook chains: rule ${ruleId} action.target must be a string`)
    action.target = value.target
  }
  if (value.message !== undefined) {
    if (typeof value.message !== 'string') throw new Error(`hook chains: rule ${ruleId} action.message must be a string`)
    action.message = value.message
  }
  return action
}

function normalizeRule(value: unknown, index: number): HookChainRule {
  if (!isRecord(value)) throw new Error(`hook chains: rules[${index}] is not an object`)
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new Error(`hook chains: rules[${index}].id must be a non-empty string`)
  const id = value.id.trim()
  const rule: {
    id: string
    enabled?: boolean
    events?: readonly HookChainEventName[]
    when?: HookChainCondition
    actions: readonly HookChainAction[]
    cooldownMs?: number
    dedupWindowMs?: number
  } = { id, actions: [] }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new Error(`hook chains: rule ${id} enabled must be a boolean`)
    rule.enabled = value.enabled
  }
  if (value.events !== undefined) {
    const events = stringArray(value.events, `rule ${id} events`)
    if (events === undefined || events.length === 0) throw new Error(`hook chains: rule ${id} events must not be empty`)
    for (const event of events) {
      if (!EVENT_NAMES.has(event)) throw new Error(`hook chains: rule ${id} listens to an unknown event: ${event}`)
    }
    rule.events = events as readonly HookChainEventName[]
  }
  const condition = normalizeCondition(value.when)
  if (condition !== undefined) rule.when = condition
  if (value.actions === undefined) throw new Error(`hook chains: rule ${id} declares no actions`)
  if (!Array.isArray(value.actions)) throw new Error(`hook chains: rule ${id} actions must be an array`)
  if (value.actions.length === 0) throw new Error(`hook chains: rule ${id} declares no actions`)
  rule.actions = value.actions.map(action => normalizeAction(action, id))
  if (value.cooldownMs !== undefined) rule.cooldownMs = boundedInteger(value.cooldownMs, DEFAULT_COOLDOWN_MS, 0, MAX_GUARD_WINDOW_MS)
  if (value.dedupWindowMs !== undefined) rule.dedupWindowMs = boundedInteger(value.dedupWindowMs, DEFAULT_DEDUP_WINDOW_MS, 0, MAX_GUARD_WINDOW_MS)
  return rule
}

/**
 * Validate and normalize a carried config file.
 *
 * An empty ruleset is valid and dispatch becomes a no-op: that lets a project
 * check in the hook-chains file, keep the feature switched off, and turn it on
 * later without editing the file.
 */
export function normalizeHookChainConfig(value: unknown): NormalizedHookChainConfig {
  const record = isRecord(value) ? value : {}
  const rawRules = record.rules
  if (rawRules !== undefined && !Array.isArray(rawRules)) throw new Error('hook chains: rules must be an array')
  const rules = (rawRules ?? []).map((rule, index) => normalizeRule(rule, index))
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`hook chains: duplicate rule id: ${rule.id}`)
    seen.add(rule.id)
  }
  const enabled = record.enabled === undefined ? true : record.enabled === true
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new Error('hook chains: enabled must be a boolean')
  return {
    version: 1,
    // A config with no rules is inert regardless of the switch, which is what
    // the file's own documented behaviour promises.
    enabled: enabled && rules.length > 0,
    maxChainDepth: boundedInteger(record.maxChainDepth, DEFAULT_MAX_CHAIN_DEPTH, 0, MAX_CHAIN_DEPTH),
    defaultCooldownMs: boundedInteger(record.defaultCooldownMs, DEFAULT_COOLDOWN_MS, 0, MAX_GUARD_WINDOW_MS),
    defaultDedupWindowMs: boundedInteger(record.defaultDedupWindowMs, DEFAULT_DEDUP_WINDOW_MS, 0, MAX_GUARD_WINDOW_MS),
    rules,
  }
}

/** A config that does nothing, used before the first configure() and on failure. */
export function inertHookChainConfig(): NormalizedHookChainConfig {
  return { version: 1, enabled: false, maxChainDepth: DEFAULT_MAX_CHAIN_DEPTH, defaultCooldownMs: DEFAULT_COOLDOWN_MS, defaultDedupWindowMs: DEFAULT_DEDUP_WINDOW_MS, rules: [] }
}

function conditionMatches(condition: HookChainCondition | undefined, input: HookChainDispatchInput): boolean {
  if (condition === undefined) return true
  if (condition.toolNames !== undefined && !condition.toolNames.includes(input.toolName ?? '')) return false
  if (condition.taskStatuses !== undefined && !condition.taskStatuses.includes(input.taskStatus ?? '')) return false
  if (condition.outcomes !== undefined && !condition.outcomes.includes(input.outcome)) return false
  return true
}

/** Bounded insertion-ordered map: evicts the oldest key once the cap is reached. */
class BoundedClock {
  private readonly entries = new Map<string, number>()
  constructor(private readonly capacity: number) {}

  /** Read one entry. */
  peek(key: string): number | undefined {
    return this.entries.get(key)
  }

  /** Insert or refresh one entry, evicting the oldest when the cap is hit. */
  set(key: string, value: number): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    // A `set` adds exactly one key, so at most one eviction restores the cap;
    // the loop form keeps that true if a caller ever bulk-loads instead.
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!)
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * The chain runtime. One instance per Host: it holds the guard windows, which
 * are process-wide by design because the failure they suppress is process-wide.
 */
export class HookChainRuntime {
  private config: NormalizedHookChainConfig = inertHookChainConfig()
  private readonly cooldowns = new BoundedClock(MAX_COOLDOWN_ENTRIES)
  private readonly dedups = new BoundedClock(MAX_DEDUP_ENTRIES)
  private dispatched = 0
  private actionRuns = 0
  private actionSkips = 0

  constructor(private readonly handlers: HookChainHandlers = {}) {}

  /**
   * Replace the active config. Throws on a malformed document.
   *
   * The replacement is atomic: a document that fails to normalize leaves the
   * runtime inert rather than holding the rules of whatever was configured
   * before. The caller reconfigures once per workspace, so a malformed file in
   * the new one would otherwise keep the previous repository's recovery rules
   * firing here — the cross-repository leak the reload exists to prevent.
   *
   * The guard windows are dropped with the config they were recorded under.
   * They are keyed by rule id, and the same id in two documents is two
   * different rules, so carrying a window across a replacement suppresses a
   * rule that never fired.
   */
  configure(value: unknown): NormalizedHookChainConfig {
    let next: NormalizedHookChainConfig
    try {
      next = normalizeHookChainConfig(value)
    } catch (error) {
      this.config = inertHookChainConfig()
      this.resetGuards()
      throw error
    }
    this.config = next
    this.resetGuards()
    return this.config
  }

  /** Drop guard state; used when the config is replaced so old windows do not leak. */
  resetGuards(): void {
    this.cooldowns.clear()
    this.dedups.clear()
  }

  get configuration(): NormalizedHookChainConfig {
    return this.config
  }

  status(): HookChainStatus {
    return {
      enabled: this.config.enabled,
      ruleCount: this.config.rules.length,
      maxChainDepth: this.config.maxChainDepth,
      cooldownEntries: this.cooldowns.size,
      dedupEntries: this.dedups.size,
      dispatched: this.dispatched,
      actionRuns: this.actionRuns,
      actionSkips: this.actionSkips,
    }
  }

  /**
   * Evaluate the rules for one event and run the actions they select.
   *
   * Never throws: a handler failure is recorded, and the guard checks short
   * circuit before any action so an aborted or too-deep dispatch costs nothing.
   */
  async dispatch(input: HookChainDispatchInput): Promise<HookChainDispatchResult> {
    const now = input.now ?? Date.now()
    // An explicit depth wins, because an out-of-band caller knows something this
    // runtime cannot infer; otherwise this is a chain some handler caused, which
    // the context store already records, or an entry point, which is depth 0.
    const chainDepth = input.chainDepth ?? chainContext.getStore() ?? 0
    const base = { enabled: this.config.enabled, fired: [] as string[], suppressed: [] as string[], actions: [] as HookChainActionRecord[], chainDepth }
    if (!this.config.enabled) return { ...base, blocked: 'disabled' }
    if (chainDepth >= this.config.maxChainDepth) return { ...base, blocked: 'depth' }
    // Checked before evaluation, not between actions: a half-run chain is the
    // one outcome recovery must not produce.
    if (input.signal?.aborted === true) return { ...base, blocked: 'aborted' }

    this.dispatched += 1
    const fired: string[] = []
    const suppressed: string[] = []
    const actions: HookChainActionRecord[] = []
    for (const rule of this.config.rules) {
      if (rule.enabled === false) {
        suppressed.push(rule.id)
        continue
      }
      if (rule.events !== undefined && !rule.events.includes(input.event)) {
        suppressed.push(rule.id)
        continue
      }
      if (!conditionMatches(rule.when, input)) {
        suppressed.push(rule.id)
        continue
      }
      const cooldownMs = rule.cooldownMs ?? this.config.defaultCooldownMs
      const dedupWindowMs = rule.dedupWindowMs ?? this.config.defaultDedupWindowMs
      const lastFired = this.cooldowns.peek(rule.id)
      if (lastFired !== undefined && now - lastFired < cooldownMs) {
        suppressed.push(rule.id)
        continue
      }
      this.cooldowns.set(rule.id, now)
      fired.push(rule.id)
      for (const action of rule.actions) {
        // Dedup is keyed on the tuple, not the rule: two rules with the same
        // action are two real intents, while one rule firing twice in a tick is
        // the duplicate worth suppressing.
        const signature = `${input.event}|${rule.id}|${action.kind}|${action.target ?? ''}`
        const lastSeen = this.dedups.peek(signature)
        if (lastSeen !== undefined && now - lastSeen < dedupWindowMs) {
          this.actionSkips += 1
          actions.push({ ruleId: rule.id, kind: action.kind, status: 'skipped', reason: 'deduplicated' })
          continue
        }
        this.dedups.set(signature, now)
        const handler = this.handlers[action.kind]
        if (handler === undefined) {
          this.actionSkips += 1
          actions.push({ ruleId: rule.id, kind: action.kind, status: 'skipped', reason: 'no handler is registered for this action' })
          continue
        }
        try {
          // The handler runs one level deeper, so anything it dispatches — now, or
          // from a callback it schedules — is recorded as a nested chain. Nothing
          // has to be restored on the way out: the store belongs to this async
          // context and is discarded with it, including when the handler throws.
          const outcome = await chainContext.run(chainDepth + 1, () =>
            handler(action, { event: input.event, outcome: input.outcome, now, chainDepth }))
          if (outcome === undefined) {
            this.actionRuns += 1
            actions.push({ ruleId: rule.id, kind: action.kind, status: 'executed' })
            continue
          }
          this.actionSkips += 1
          actions.push({ ruleId: rule.id, kind: action.kind, status: 'skipped', reason: outcome.skipped })
        } catch (error) {
          this.actionSkips += 1
          actions.push({ ruleId: rule.id, kind: action.kind, status: 'skipped', reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return { enabled: true, fired, suppressed, actions, chainDepth }
  }
}
