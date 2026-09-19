/**
 * Compile-time guard for the plugin's own tool definition literals.
 *
 * Why
 * ---
 * The plugin registers ~200 tools through the `ctx.get('tools')` seam, hand
 * typing that seam structurally so the registrations stay independent of the
 * tools package's runtime graph. The cost is that nothing compares a definition
 * literal against the registry's real contract: a renamed schema field, a moved
 * `output`, or a `parameters` change would surface only when the registry
 * silently refuses the entry at activation.
 *
 * What this checks
 * ----------------
 * Exactly the model-visible surface — `name`, `description`, `parameters`, and
 * the mandatory `output` declaration — which is the part upstream can change
 * without any runtime error the plugin would notice. The call-signature members
 * (`execute`, `finalizeContent`, `isConcurrencySafe`, `presentCall`,
 * `presentResult`) are deliberately excluded: every `execute` here types its own
 * arguments narrowly, and a narrower parameter cannot satisfy the registry's
 * `unknown` under the assignability rules a generic constraint uses — checking
 * them would force `execute(args: unknown, …)` plus a cast in ~200 definitions
 * for no drift protection the schema check does not already give.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tool-definition
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * The registry contract as far as a definition *literal* is concerned.
 *
 * The index signature is load-bearing, not a loosening: a fresh object literal
 * passed straight to a typed parameter is excess-property-checked against a
 * closed object type, so member-checking these four fields without it would
 * reject every definition that also declares `execute`/`presentCall`. The
 * members above stay fully checked (each must satisfy both the registry's
 * declaration and `unknown`); everything else is accepted as-is.
 */
export type ToolDefinitionShape = Pick<ToolDefinition, 'name' | 'description' | 'parameters' | 'output'>
  & Record<string, unknown>

/**
 * Identity helper that keeps a tool literal's inferred type.
 *
 * Replaces the four identical local `rawTool` identities the tool registries
 * each carried (`engineering.ts`, `automation.ts`, `deferred-tools.ts`,
 * `media-generation.ts`), so the constraint lives in one place.
 * @param tool - the definition literal, checked against {@link ToolDefinitionShape}.
 * @returns the same literal, inference preserved.
 */
export function toolDefinition<T extends ToolDefinitionShape>(tool: T): T {
  return tool
}
