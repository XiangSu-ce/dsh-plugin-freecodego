/** Single-package FreeCodeGo Host composition. */
import type { Context } from '@deepseek-ai/cordis'
import FreeCodeGoHarnessPlugin, {
  bootstrapFreeCodeGoHarness,
  registerFreeCodeGoSessionEventTypes,
  type Config as HarnessConfig,
} from '@deepseek-ai/dsh-freecodego-harness-plugin'
import FreeCodeGoAgentEngineRouter from '@deepseek-ai/dsh-freecodego-agent-engine-router'

export const name = 'freecodego'
export const inject: readonly string[] = []

/**
 * What this bundle accepts: the Harness plugin's config, which is what every
 * field here is forwarded to. Named in this package rather than referring to
 * the plugin's type directly, so the bundle declares its own contract while the
 * fields themselves stay in the one place that consumes them.
 */
export type FreeCodeGoBundleConfig = HarnessConfig

/** Mount the bundled Host services and the single AgentFactory. */
export async function apply(ctx: Context, config: FreeCodeGoBundleConfig = {}): Promise<void> {
  await ctx.plugin(FreeCodeGoHarnessPlugin, config)
  await ctx.plugin(FreeCodeGoAgentEngineRouter, {})
}

export { bootstrapFreeCodeGoHarness, registerFreeCodeGoSessionEventTypes }
