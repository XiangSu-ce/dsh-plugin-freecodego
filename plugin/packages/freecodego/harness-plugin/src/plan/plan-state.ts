/**
 * Plan Mode's four states.
 *
 * Why our state is a *function* of upstream's
 * -------------------------------------------
 * The harness already owns Plan Mode: `ctx.planMode` writes `plan/mode`, the `plan`
 * projection folds those events, and `EXIT_PLAN_MODE` ends it. A second, independent
 * flag here would be a copy of that truth, and a copy can disagree — which surfaces
 * as the UI showing plan mode while the model is not in it, or the reverse, with
 * neither side obviously wrong. So `active` is read from the projection and nothing
 * in this module ever writes it. What this module adds is the part upstream does not
 * have: the two *transient* phases, which exist only because an interaction is in
 * flight.
 *
 * The transients, and why they cannot be persisted
 * ------------------------------------------------
 * `pending` means "plan mode was asked for and the first prompt has not been
 * accepted yet"; `exit-pending` means "the user asked to leave while a turn was
 * still running". Both are waiting on something only a live process can finish.
 * Persisted, they would survive into a process waiting for nothing — a stuck state
 * the user cannot clear. They are therefore memory-only, and the collapse on restart
 * is a consequence of that rather than a rule someone has to remember.
 *
 * Where the edit fence actually lives
 * -----------------------------------
 * Not here. The containment Plan Mode needs — "in plan mode, nothing the model can
 * call writes to the workspace" — is already implemented, and implemented more
 * strongly than the design this module was written from. `planModeRefusal`
 * (`plan-mode.ts`) refuses every mutating tool by name, and refuses every
 * *unclassified* plugin tool rather than assuming it harmless. The plan document
 * itself is written by `engineering_plan_mode`, which is on that module's allowed
 * list, so the model never needs a writing tool at all — the fence is "no writes",
 * not "one file is writable".
 *
 * A path-based fence was written for this module and withdrawn. It judged a call by
 * whether the path it named was the plan file, and that judgment cannot tell a write
 * from a read: `read` names a `path` too. Wired in, it would have refused the
 * searching and checking that Plan Mode exists to allow. It was not shipped, because
 * a rule that cannot make the distinction it needs is not a stricter rule — it is a
 * broken one.
 *
 * The gap that is left, recorded rather than quietly closed
 * ---------------------------------------------------------
 * `planModeRefusal`'s mutation rule is a *name list*. A tool that is neither on it,
 * nor prefixed by this plugin, nor the shell — an MCP server's own `write_file`
 * through `mcp__*`, for instance — is allowed, and MCP servers can certainly write
 * files. Closing it means extending the existing "unclassified is refused" rule to
 * third-party tools, which is a tightening that also removes read-only MCP tools
 * from what a planning session may call. That is a product decision about what
 * planning is allowed to do, so it is recorded here and in the plan document instead
 * of being taken silently.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plan/plan-state
 */

import type { PlanMode } from '../plan-mode.ts'

/** Where Plan Mode stands. */
export type PlanModeState = 'inactive' | 'pending' | 'active' | 'exit-pending'

/** The phases that exist only while an interaction is in flight. */
export type TransientPlanPhase = 'pending' | 'exit-pending'

/**
 * The phases a persisted record may hold; the transients are deliberately absent.
 *
 * These are *this module's* names, and they are not what is on disk. The one
 * durable record of this fact is `PlanModeStore` (`plan-mode.ts`), which writes
 * `mode: 'plan' | 'execute'`, and the two functions below are the mapping. That
 * distinction is worth stating because getting it wrong is not a display bug: a
 * store read through the wrong vocabulary is a store that fails to parse, and a
 * store that fails to parse degrades to `execute` — Plan Mode silently off, on
 * exactly the restarts the store exists to survive.
 */
export const PERSISTED_PLAN_PHASES = ['inactive', 'active'] as const

export type PersistedPlanPhase = (typeof PERSISTED_PLAN_PHASES)[number]

/**
 * The durable store's spelling of a persisted phase.
 * @param state - this module's persisted phase.
 * @returns the mode `PlanModeStore` holds for it.
 */
export function storedPlanModeFor(state: PersistedPlanPhase): PlanMode {
  return state === 'active' ? 'plan' : 'execute'
}

/**
 * This module's phase, from the durable store's spelling.
 *
 * Total over the store's own vocabulary by construction, and an inverse of
 * {@link storedPlanModeFor} — the spec checks both directions, so a store that
 * ever grew a third mode cannot be read as "not active".
 * @param mode - the mode `PlanModeStore` holds.
 * @returns the persisted phase for it.
 */
export function persistedPlanPhaseFor(mode: PlanMode): PersistedPlanPhase {
  return mode === 'plan' ? 'active' : 'inactive'
}

/**
 * Derive the state from the upstream truth and our own transient.
 *
 * Upstream wins whenever it is active, and it is the only thing that can make the
 * state `active`. When it is not, a live transient is what the user is waiting on,
 * and otherwise Plan Mode is simply off.
 * @param input - the projection's answer and the in-memory phase, if any.
 * @returns the state to show.
 */
export function derivePlanModeState(input: {
  /** `PlanProjection.active`, read fresh; never cached, never copied. */
  readonly projectionActive: boolean
  /** The in-memory phase, which a restart cannot carry. */
  readonly transient?: TransientPlanPhase | undefined
}): PlanModeState {
  if (input.projectionActive) return 'active'
  return input.transient ?? 'inactive'
}

/**
 * The state a restart leaves behind.
 *
 * Written as a function over the state *before* the restart rather than as a
 * constant, so the rule is stated and tested instead of being an emergent property
 * of where the field happens to live.
 * @param before - the state the previous process reported.
 * @returns the state with both transients collapsed.
 */
export function planModeStateAfterRestart(before: PlanModeState): PlanModeState {
  // A transient is waiting on an interaction a restart has already ended: the prompt
  // that would have been accepted, or the turn that would have finished.
  return before === 'pending' || before === 'exit-pending' ? 'inactive' : before
}

/**
 * Whether a state means the workspace is frozen.
 *
 * `exit-pending` is deliberately not frozen: the user has already said the plan is
 * over, and holding the workspace until a turn drains would be containment nobody
 * asked for by then.
 * @param state - the state to read.
 * @returns whether writes must be refused.
 */
export function planModeFreezesWorkspace(state: PlanModeState): boolean {
  return state === 'active'
}
