/**
 * Turning a persona into the four things a spawn actually needs.
 *
 * Resolution order, most specific first: the spawn call's explicit override, the
 * persona's own field, then the agent type's default. Stated once, here, because
 * the alternative — each of the three deciding for itself — is how a model
 * override ends up applied in one engine and ignored in another.
 *
 * `default_isolation` is the reason this module exists rather than the value
 * being read at the call site: it is what connects a persona to the worktree
 * machinery (G5, whose session worktrees `worktree/tools.ts` provides).
 *
 * A correction, recorded rather than quietly applied
 * ------------------------------------------------
 * The design for this module stated that a child with its own worktree is
 * **not** subject to the parent's plan fence. This deployment does the opposite,
 * and does it deliberately: `planModeSessionKey` keys the mode on the *root*
 * conversation, so a child's calls are judged by its parent's mode.
 * {@link ResolvedPersonaRuntime.exemptFromPlanFence} therefore resolves to
 * `false` for every child, worktree or not, and says so.
 *
 * Why the deployment wins: plan mode's claim is that nothing the model can call
 * writes to the workspace. An exemption for children turns that into a naming
 * convention — the fenced parent cannot write, but it can ask a child to, and the
 * child is the escape hatch. Keeping the fence is the safer reading, and it is
 * asserted in both test files so a future reversal is a visible edit.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/persona/resolve
 */

import type { PersonaDefinition, PersonaIsolation } from './contract.ts'

/** What the caller told the spawn to use, if anything. */
export interface SpawnOverrides {
  readonly model?: string
  readonly reasoningEffort?: string
  readonly isolation?: PersonaIsolation
}

/** What the agent type was configured with, if anything. */
export interface AgentTypeDefaults {
  readonly model?: string
  readonly reasoningEffort?: string
  readonly isolation?: PersonaIsolation
}

/** The resolved runtime for one child. */
export interface ResolvedPersonaRuntime {
  readonly persona: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** `worktree` means the child runs in its own checkout, not the parent's. */
  readonly isolation: PersonaIsolation
  /**
   * True when the child is exempt from the parent's plan fence.
   *
   * Always `false` in this deployment — see the module header. It stays in the
   * resolved shape because `engineering_doctor` reads it, and a caller that
   * needs the exemption (isolating a child so it *can* implement) has to make
   * that call at the level where the mode is not in force, rather than assume
   * the child inherits the right to write.
   */
  readonly exemptFromPlanFence: boolean
  /** Where the isolation decision came from, for `engineering_doctor`. */
  readonly isolationSource: 'override' | 'persona' | 'agent-type' | 'default'
}

/** The isolation this build uses when nothing declares one. */
export const DEFAULT_PERSONA_ISOLATION: PersonaIsolation = 'none'

/**
 * Resolve the effective runtime for one child.
 * @param persona - the persona being spawned.
 * @param overrides - what the caller asked for.
 * @param defaults - what the agent type declares.
 * @returns the resolved runtime, with the source of the isolation decision.
 */
export function resolvePersonaRuntime(
  persona: PersonaDefinition,
  overrides: SpawnOverrides = {},
  defaults: AgentTypeDefaults = {},
): ResolvedPersonaRuntime {
  const isolation = pickIsolation(overrides, persona, defaults)
  const model = overrides.model ?? persona.model ?? defaults.model
  const reasoningEffort = overrides.reasoningEffort ?? persona.reasoningEffort ?? defaults.reasoningEffort
  return {
    persona: persona.name,
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    isolation: isolation.value,
    // Not `isolation.value === 'worktree'`: plan mode is keyed on the root
    // conversation, so a child is judged by its parent's mode whatever
    // isolation it runs in. Reporting the exemption would be reporting a rule
    // this deployment does not implement (see the module header).
    exemptFromPlanFence: false,
    isolationSource: isolation.source,
  }
}

/** Pick the isolation value and remember which tier supplied it. */
function pickIsolation(
  overrides: SpawnOverrides,
  persona: PersonaDefinition,
  defaults: AgentTypeDefaults,
): { readonly value: PersonaIsolation; readonly source: ResolvedPersonaRuntime['isolationSource'] } {
  if (overrides.isolation !== undefined) return { value: overrides.isolation, source: 'override' }
  if (persona.defaultIsolation !== undefined) return { value: persona.defaultIsolation, source: 'persona' }
  if (defaults.isolation !== undefined) return { value: defaults.isolation, source: 'agent-type' }
  return { value: DEFAULT_PERSONA_ISOLATION, source: 'default' }
}
