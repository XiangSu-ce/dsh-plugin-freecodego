/**
 * Where FreeCodeGo's own data lives.
 *
 * Why one resolver
 * ----------------
 * The plugin keeps its private state — engineering memory, checkpoints, the
 * code-graph and graphify runtimes, jobs, and plan-mode — under
 * `<home>/freecodego/**`, where `<home>` is the harness home: `$DSH_HOME` when
 * the Host sets it, `~/.dsh` otherwise. Seven modules used to re-derive that
 * path by hand, so one rule lived in seven places and could drift in seven
 * ways. This module is that rule.
 *
 * It is a *delegation*, not an implementation. The harness already owns this
 * resolution in `@deepseek-ai/dsh-home-paths`, whose `resolveDshHome` also
 * expands a `~` prefix and normalizes the result — two properties none of the
 * hand-rolled copies had, so `DSH_HOME=~/harness` used to send this plugin's
 * paths to a literal `~` directory while the Host resolved it correctly. The
 * plugin keeps this module as the single seam its own code calls; the rule
 * itself stays in one place across the whole harness.
 *
 * `FREECODEGO_HOME` overrides the `<home>` segment for exactly those
 * plugin-private directories, so a build can be aimed at a dedicated data root
 * (a test sandbox, a branded install, a second account on one machine) without
 * touching the harness home. It is opt-in: unset, every path resolves precisely
 * as it did before.
 *
 * What it deliberately does NOT override
 * --------------------------------------
 * Host-owned paths keep resolving against the harness home, because the Host —
 * not this plugin — writes and reads them: `settings.yaml`,
 * `.credentials.yaml`, `profiles/`, `runtimes/`, `state/`, `.agent-presets/`,
 * `skills/`. Pointing those at an override is the failure where the settings
 * surface and the credentials service disagree about which file is the truth,
 * so callers of those paths read `$DSH_HOME` directly.
 */

import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * The harness home as this plugin sees it: `$DSH_HOME` when set, else `~/.dsh`.
 *
 * Delegates to the harness's own resolver so a configured home is expanded and
 * normalized identically on both sides of the plugin boundary.
 * @returns the resolved harness home directory.
 */
export function harnessHomeDirectory(): string {
  return resolveDshHome()
}

/**
 * Root of the plugin-private data tree: `$FREECODEGO_HOME` when it is set to a
 * non-empty value, otherwise the harness home.
 *
 * The override gets the harness's own tilde treatment before it is returned.
 * Handing back the raw value reintroduced exactly the defect this module exists
 * to remove: `FREECODEGO_HOME=~/data` would name a literal `~` directory *under
 * the process's current working directory*, so memory, checkpoints and plan
 * state landed in different trees depending on where the harness was launched —
 * and nowhere near the user's home. Relative overrides are left as configured,
 * which is how they already behaved for every caller.
 * @returns the plugin-private data root.
 */
export function freeCodeGoDataHome(): string {
  const override = process.env.FREECODEGO_HOME?.trim()
  if (override !== undefined && override !== '') return expandHomePath(override)
  return harnessHomeDirectory()
}
