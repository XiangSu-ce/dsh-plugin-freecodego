/** Single-package FreeCodeGo Host composition. */
import type { Context } from '@deepseek-ai/cordis'
import FreeCodeGoHarnessPlugin, {
  registerFreeCodeGoSessionEventTypes,
  type FreeCodeGoConfigInput as HarnessConfigInput,
} from '@deepseek-ai/dsh-freecodego-harness-plugin'
import FreeCodeGoAgentEngineRouter from '@deepseek-ai/dsh-freecodego-agent-engine-router'

export const name = 'freecodego'
export const inject: readonly string[] = []

/**
 * What this bundle accepts: the Harness plugin's config, which is what every
 * field here is forwarded to. Named in this package rather than referring to
 * the plugin's type directly, so the bundle declares its own contract while the
 * fields themselves stay in the one place that consumes them.
 *
 * It is the plugin's *input* type, not its `Config`: what arrives here is a
 * profile patch — every setting a plain value — and the plugin's schema is what
 * turns that into the live references its `Config` holds. Declaring the resolved
 * `Config` here would say a caller must supply references, which is the one thing
 * a profile patch cannot do.
 *
 * Since the plugin became its own entry this type describes an input nobody
 * reads any more: the settings document is the `freecodego-harness-plugin` row's
 * `config`, and this row's `config` is only tolerated so a profile patch that
 * still carries one composes instead of failing validation. Kept rather than
 * deleted so the reason it is inert is stated here rather than rediscovered.
 */
export type FreeCodeGoBundleConfig = HarnessConfigInput

/**
 * Mount the harness-independent AgentFactory router.
 *
 * The Harness plugin is deliberately **not** mounted here. It is a row of this
 * bundle's own patch (`./cordis.patch.yml`, `id: freecodego-harness-plugin`),
 * because the settings service can only configure a plugin that is a Loader
 * entry: it addresses a plugin by its entry id and validates writes against that
 * entry's `Config`, and a plugin mounted with `ctx.plugin()` from an entry's
 * `apply` inherits that entry instead of getting one of its own. That patch row's
 * comment records the failure that came of mounting it here.
 *
 * `_config` is kept in the signature because the profile declares a `config:` key
 * for this row; with no `Config` on this module the Loader passes it through
 * unvalidated and nothing consumes it.
 * @param ctx - the entry's context.
 * @param _config - the row's config, retained as an accepted-but-inert input.
 */
export async function apply(ctx: Context, _config: FreeCodeGoBundleConfig = {}): Promise<void> {
  await ctx.plugin(FreeCodeGoAgentEngineRouter, {})
}

// `FreeCodeGoHarnessPlugin` is re-exported so `dist/harness-plugin.js` — the
// module the `freecodego-harness-plugin` row loads — can default-export the
// class without a second copy of the plugin in the published artifact.
// `registerFreeCodeGoSessionEventTypes` is what `./session-events.ts` imports to
// install the session event vocabulary as its own Loader prerequisite.
//
// This package used to also declare a `bootstrapFreeCodeGoHarness` pre-Loader seam
// under `dsh.bootstrap`. That field is not part of the Harness manifest contract:
// `DshManifest` declares `bundle`, `profile` and `client` and nothing else, and no
// reader anywhere — upstream, host or vendor — resolves it. Both effects that seam
// performed are supplied by composition rows instead, so it is gone rather than
// kept as a declared entry point with no loader behind it.
export { FreeCodeGoHarnessPlugin, registerFreeCodeGoSessionEventTypes }
