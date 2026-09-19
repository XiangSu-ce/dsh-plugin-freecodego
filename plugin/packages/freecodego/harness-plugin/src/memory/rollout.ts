/**
 * The memory pipeline's rollout, and the rule that disabling it fails closed.
 *
 * Memory consolidation runs a model over a session's successful turns and writes
 * curated topics. That is powerful enough to need a staged rollout, so this
 * module has four stages rather than a switch: `off`, `record_only`, `shadow`
 * and `active`. `shadow` is the one that makes the feature safe to turn on — it
 * runs the whole consolidation, including the model call, and commits nothing,
 * so an operator can read what the model *would* have written before letting it
 * write.
 *
 * One source for the stage
 * ------------------------
 * The stage comes from the settings document and from nowhere else. There used to
 * be a second, deployment-issued layer clamped against it — a managed `shadow`
 * could hold a user's `active` back — and it is gone: nothing could produce such a
 * document, so the clamp was the identity on every install. If a second layer is
 * ever reintroduced, it belongs in `policy.ts`'s one read (see that module), not
 * here, because a rollout that clamps on its own is a rollout that disagrees with
 * every other consumer of the same setting.
 *
 * Fail-closed, and what that rules out
 * ----------------------------------
 * When the pipeline is disabled it is disabled — there is no fall back to the
 * legacy search path, and no fall back to the legacy store. A "disabled" feature
 * that quietly keeps the old behaviour is not disabled; it is renamed, and the
 * operator who disabled it now has a privacy claim they cannot make. So
 * `resolveMemoryRollout` returns a stage and the pipeline's entry points read
 * it, rather than each site deciding what `off` means.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/rollout
 */

import { ROLLOUT_STAGES, type RolloutStage } from '../policy.ts'

/** The four consolidation stages, re-exported under the name this feature uses. */
export type MemoryRolloutStage = RolloutStage

/** The stage this build uses when nothing declares one. */
export const DEFAULT_MEMORY_ROLLOUT: MemoryRolloutStage = 'off'

/** What the pipeline is allowed to do at each stage. */
export interface MemoryStageBehaviour {
  /** Capture successful turns as observations. */
  readonly capture: boolean
  /** Run the consolidating model call. */
  readonly consolidate: boolean
  /** Commit curated topic updates to disk. */
  readonly commit: boolean
  /** Let consolidated topics reach the model's recall surface. */
  readonly recall: boolean
}

/**
 * What each stage permits.
 *
 * Written as a total table rather than derived, because the alternative — "stage
 * is at least `shadow`, so commit" — would make inserting a stage silently
 * change what earlier stages do. A missing entry is a compile error here, which
 * is the point.
 */
const STAGE_BEHAVIOUR: Readonly<Record<MemoryRolloutStage, MemoryStageBehaviour>> = {
  off: { capture: false, consolidate: false, commit: false, recall: false },
  record_only: { capture: true, consolidate: false, commit: false, recall: false },
  shadow: { capture: true, consolidate: true, commit: false, recall: false },
  active: { capture: true, consolidate: true, commit: true, recall: true },
}

/**
 * The behaviour of one stage.
 * @param stage - the resolved stage.
 * @returns what that stage permits.
 */
export function memoryStageBehaviour(stage: MemoryRolloutStage): MemoryStageBehaviour {
  return STAGE_BEHAVIOUR[stage]
}

/** The decision the pipeline acts on. */
export interface MemoryRolloutDecision {
  readonly stage: MemoryRolloutStage
  readonly behaviour: MemoryStageBehaviour
  /** Set when the value had to be ignored, so a bad setting is visible. */
  readonly note?: string
}

/**
 * Resolve the declared stage into the decision the pipeline acts on.
 * @param input - the declared stage, as the settings document holds it.
 * @returns the effective decision, and a note when the value was ignored.
 */
export function resolveMemoryRollout(input: {
  readonly user: string | undefined
}): MemoryRolloutDecision {
  // Not `userStage ?? <something>`: an undeclared stage and an unrecognised one
  // both resolve to the build default, which is `off`, and defaulting here rather
  // than at each entry point is what makes the gate impossible to skip.
  const stage = parseStage(input.user) ?? DEFAULT_MEMORY_ROLLOUT
  const note = describeIgnored(input.user, parseStage(input.user))
  return {
    stage,
    behaviour: STAGE_BEHAVIOUR[stage],
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * Read a declared stage, treating anything unrecognised as `off`.
 *
 * An unrecognised stage does not fall through to a permissive default and it
 * does not crash the plugin at load: it disables the pipeline, which is the
 * answer that cannot surprise anyone, and the caller reports it.
 * @param value - the declared stage, if any.
 * @returns the parsed stage.
 */
export function parseStage(value: string | undefined): MemoryRolloutStage | undefined {
  if (value === undefined) return undefined
  const match = ROLLOUT_STAGES.find(stage => stage === value)
  return match
}

/** Build the note that explains an unrecognised stage, when there is one. */
function describeIgnored(
  userRaw: string | undefined,
  user: MemoryRolloutStage | undefined,
): string | undefined {
  if (userRaw === undefined || user !== undefined) return undefined
  return `"${userRaw}" is not a memory rollout stage; the pipeline was left off rather than falling back to a default`
}
