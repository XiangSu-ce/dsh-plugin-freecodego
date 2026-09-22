/**
 * Public bundle configuration for the FreeCodeGo Harness plugin.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plugin-config
 */

// The runtime schema for `Config` is declared inline at the plugin class
// (`FreeCodeGoHarnessPlugin.Config`) rather than here: a plugin-class schema must
// be statically walkable, and only a local const or a workspace-package import
// is, so a package-relative `const` is invisible to the generated config
// catalog. This module keeps the declared type the schema and every reader
// share.

/** Bundle configuration for declared native runtime artifacts. */
export interface Config {
  /** FreeCodeGo API origin used by Host authentication and managed routes. */
  readonly gateway?: {
    /** Overrides the compiled-in FreeCodeGo cloud origin for this installation. */
    readonly baseUrl?: string
  }
  /** Model a new session starts on when the caller names none. */
  readonly defaultModel?: string
  /** Engine the router selects when the caller expresses no preference. */
  readonly defaultEngine?: 'deepseek' | 'codex' | 'claude'
  /** Directory holding the sealed Codex worker artifacts this Host launches. */
  readonly codexRuntimeDirectory?: string
  /** Read-only directory the Codex worker is refreshed from when updating. */
  readonly codexRuntimeSourceDirectory?: string
  /** Directory holding the sealed Claude worker artifacts this Host launches. */
  readonly claudeRuntimeDirectory?: string
  /** Automatically authorize every live text model for new Subagent sessions. */
  readonly autoSubagentModelSelection?: boolean
  /** Enable the independent Advisor and Agent delivery by default. */
  readonly autoAdvisorEnabled?: boolean
  /** Package and release repository used by the Host-owned update checker. */
  readonly updatePackageName?: string
  /** Repository the update checker queries for the newest published release. */
  readonly updateReleaseRepository?: string
  /** Environment variable holding the token the update checker authenticates with. */
  readonly updateReleaseTokenEnv?: string
}
