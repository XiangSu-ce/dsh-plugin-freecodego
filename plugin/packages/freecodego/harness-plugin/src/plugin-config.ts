/**
 * Public bundle configuration for the FreeCodeGo Harness plugin.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plugin-config
 */

import z from '@deepseek-ai/schemastery'
import { FREECODEGO_CLOUD_ORIGIN } from './engine-remotes.ts'

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

/**
 * Runtime schema for {@link Config}. Schemastery has no first-class
 * `.optional()`; the public Config type already types these as optional, so
 * the schema carries the same contract at runtime (absent input passes
 * through) without fighting the inferred builder types.
 */
export const FreeCodeGoConfigSchema: z<Config> = z.object({
  gateway: z.object({
    baseUrl: z.string().default(FREECODEGO_CLOUD_ORIGIN),
  }),
  defaultModel: z.string(),
  defaultEngine: z.union([z.const('deepseek'), z.const('codex'), z.const('claude')]).default('deepseek'),
  codexRuntimeDirectory: z.string().default(''),
  codexRuntimeSourceDirectory: z.string().default(''),
  claudeRuntimeDirectory: z.string().default(''),
  autoSubagentModelSelection: z.boolean().default(true),
  autoAdvisorEnabled: z.boolean().default(true),
  updatePackageName: z.string().default(''),
  updateReleaseRepository: z.string().default(''),
  updateReleaseTokenEnv: z.string().default(''),
})
