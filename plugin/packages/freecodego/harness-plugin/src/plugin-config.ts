/**
 * The FreeCodeGo Harness plugin's configuration.
 *
 * One document, two halves
 * ------------------------
 * A plugin's `Config` **is** its settings document in the current core: the settings
 * service no longer registers a namespace per plugin, and the form it serves is a
 * projection of the entry's own Config. So the deployment input an installation writes
 * into its profile patch and the switches a user flips in `harness-ui` land in the same
 * place, and this module is where both are declared.
 *
 * - {@link FreeCodeGoCompositionConfig} is deployment input: where the native runtimes
 *   live, which update coordinates to poll, which origin the Host authenticates against.
 *   Ordinary fields — a change to one remounts the plugin, which is right for something
 *   only an installation sets.
 * - {@link FreeCodeGoEngineSettings} is the settings document. Every field is marked
 *   `volatile()` in the schema ({@link Config}), so a user's change is committed into the
 *   running references instead of remounting a plugin that is mid-session.
 *
 * Why the document is composed rather than restated
 * -------------------------------------------------
 * Most of the document is already declared: `FreeCodeGoCapabilitySettings`,
 * `FreeCodeGoEngineeringSettings`, and their siblings are the contract this package, the
 * Web client, and the agent runtimes share. Composing from them keeps **one** declaration
 * per field. The alternative — a hand-maintained list of every setting beside the schema,
 * which is what this file replaced — had a failure mode that was only visible in one
 * direction: a field the schema offered and the list did not declare was a toggle a user
 * could set and nothing read, and no assertion could see it, because an object with extra
 * properties is assignable to a narrower type. {@link Config}'s `z<Config>` assertion now
 * covers both directions: the schema and the document type must agree field for field.
 *
 * The fields declared here directly are the ones no other module owns yet: the headroom
 * shaper's own settings, the deferred tool-schema switch, the guard and trust toggles
 * (only their *status* and *update* shapes exist in `types.ts`), and the handful of
 * pipeline switches whose schema block lives in `index.ts`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plugin-config
 */

import type { Live } from './types.ts'
import type {
  FreeCodeGoAdvisorSettings,
  FreeCodeGoAutomationSettings,
  FreeCodeGoCapabilitySettings,
  FreeCodeGoEngineeringSettings,
  FreeCodeGoPluginConflictSettings,
  FreeCodeGoPluginUpdateSettings,
  FreeCodeGoReviewSettings,
  FreeCodeGoWebSearchSettings,
} from './types.ts'

// The runtime schema for `Config` is declared inline at the plugin class
// (`FreeCodeGoHarnessPlugin.Config`) rather than here: the generated config catalog
// walks a schema expression statically, and only an inline `z.object({...})` or a
// workspace-package import is walkable — a package-relative `const` is invisible to it.
// It rejects what it cannot walk, so a schema it cannot see is a build failure rather
// than a thinner catalog. This module keeps the declared type the schema and every
// reader share.

/**
 * Deployment input: what an installation sets, not what a user toggles.
 *
 * These are ordinary (non-volatile) fields on purpose. A deployment writes them into a
 * profile patch before the plugin loads, and changing one is a composition change — the
 * remount that follows is the correct lifecycle for it.
 */
export interface FreeCodeGoCompositionConfig {
  /** FreeCodeGo API origin used by Host authentication and managed routes. */
  readonly gateway?: {
    /** Overrides the compiled-in FreeCodeGo cloud origin for this installation. */
    readonly baseUrl?: string
  }
  /** Directory holding the sealed Codex worker artifacts this Host launches. */
  readonly codexRuntimeDirectory?: string
  /** Read-only directory the Codex worker is refreshed from when updating. */
  readonly codexRuntimeSourceDirectory?: string
  /** Directory holding the sealed Claude worker artifacts this Host launches. */
  readonly claudeRuntimeDirectory?: string
  /** Automatically authorize every live text model for new Subagent sessions. */
  readonly autoSubagentModelSelection?: boolean
  /** Package and release repository used by the Host-owned update checker. */
  readonly updatePackageName?: string
  /** Repository the update checker queries for the newest published release. */
  readonly updateReleaseRepository?: string
  /** Environment variable holding the token the update checker authenticates with. */
  readonly updateReleaseTokenEnv?: string
}

/**
 * The settings this package owns directly, beyond the shared group types.
 *
 * Every field here is a plain value: this is what behaviour reads. The volatile
 * projection the Config actually holds is {@link Config}.
 */
export interface FreeCodeGoInlineSettings {
  /**
   * Model a new session starts on when the caller names none.
   *
   * One field, not two: this used to be a composition default beside a settings field
   * that fell back to it, so a deployment and a user could each believe they had chosen
   * the default model. The settings field is the single answer now, and a deployment that
   * wants to pin it sets it like any other value of this document.
   */
  defaultModel: string
  /** Engine the router selects when the caller expresses no preference. */
  defaultEngine: 'deepseek' | 'codex' | 'claude'
  /** Per-category model the media tools use when the caller names none. */
  mediaDefaults: {
    /** Model the image-generation tool runs on when the caller names none. */
    image: string
    /** Model the video-generation tool runs on when the caller names none. */
    video: string
    /** Model the audio-generation tool runs on when the caller names none. */
    audio: string
  }
  /**
   * Master switch for the image and video generation tools (`media-generation.ts`).
   *
   * It governs exactly those two, and the legacy `agnes_generate_image` /
   * `agnes_generate_video` aliases with them. Audio generation and transcription are
   * deliberately outside it: one writes a file into the active workspace and the other
   * reads one out of it, so they are not what a user switching image and video off is
   * asking to lose. On by default — the tools cost nothing until a route is called, and
   * they are the only way the capability is reachable.
   */
  mediaGenerationEnabled: boolean
  /**
   * Sandbox profile deny globs, enforced in the plugin policy layer.
   *
   * A direct list rather than a profile *name*: the named-profile documents live in
   * `sandbox-profiles.json`, and resolving a name to its globs at read time would put
   * a filesystem read behind a settings lookup. `sandbox/profiles.ts` owns the
   * spelling rules, and only its normalization is applied here.
   */
  sandboxDenyPatterns: string[]
  /** Post-compaction rehydration of todo list and durable memory (rehydration.ts). */
  rehydrationEnabled: boolean
  /** Opt-in conversation-arc section in the rehydrated context (rehydration.ts). */
  rehydrationArcEnabled: boolean
  /** Offer tool schemas on demand instead of inline in every request. */
  deferredToolSchemasEnabled: boolean
  /** Tool names that stay inline even when deferred schemas are on. */
  deferredToolNames: string[]
  /**
   * Memory consolidation rollout (memory/rollout.ts).
   *
   * A string stage rather than a boolean, because consolidation has two intermediate
   * positions that matter: `record_only` captures without calling a model, and `shadow`
   * calls the model without committing. Typed as `string` rather than as the four-value
   * union because this document is the shape of the user's own file, and a value the
   * schema would have rejected must still be readable so `resolveMemoryRollout` can
   * report it instead of failing at load.
   */
  memoryRollout: string
  /** Master switch for the request-side prompt shaper (headroom). */
  headroomEnabled: boolean
  /** Prompt size, in characters, above which the shaper considers a request. */
  headroomThresholdChars: number
  /** Fraction of the prompt that must be reclaimable before the shaper acts. */
  headroomMinSavingsRatio: number
  /** Collapse repeated identical tool output before shaping. */
  headroomDedupEnabled: boolean
  /** Tools whose output the shaper never rewrites. */
  headroomExcludeTools: string[]
  /** Fold a file read into the edit that follows it when they agree. */
  headroomFoldReads: boolean
  /** Replace long code bodies with signatures where the prompt allows it. */
  headroomCodeSkeletonEnabled: boolean
  /** How aggressively folded content may be dropped (`reversible` keeps a pointer). */
  headroomFoldPolicy: 'reversible' | 'max'
  /** Shape the model's own output rather than only its input. */
  headroomOutputShaper: boolean
  /** Verbosity the output shaper targets, from terse to explanatory. */
  headroomVerbosityLevel: number
  /** Credential-file read protection toggle (tool-guards). */
  envReadGuardEnabled: boolean
  /** Doom-loop detection toggle for the native engines' own tools (tool-guards). */
  doomLoopGuardEnabled: boolean
  /** Probe-based LSP stack toggle (lsp-mount). */
  lspEnabled: boolean
  /** Declarative command policy with load-time example validation (command-policy.ts). */
  commandPolicyEnabled: boolean
  /** Plan Mode: structural refusal of workspace mutation (plan-mode.ts). */
  planModeEnabled: boolean
  /** Model-visible context budget, injected at band granularity (context-budget.ts). */
  contextBudgetEnabled: boolean
  /** Shrink the prompt when the cache is provably expired (cache-cold.ts). */
  cacheColdClearEnabled: boolean
  /** Pre-call request-shape fingerprinting for cache-break attribution (request-shape.ts). */
  cacheBreakAttributionEnabled: boolean
  /** Streaming repetition guard for the model's own output (assistant-loop-guard.ts). */
  assistantLoopGuardEnabled: boolean
  /** Paged byte-exact recall of parked tool results (spill-recall.ts). */
  spillRecallEnabled: boolean
  /** Compaction-summary fidelity audit against the replaced history (compaction-fidelity.ts). */
  compactionFidelityEnabled: boolean
  /** Model-visible prompt-composition breakdown and usage tree (prompt-composition.ts). */
  promptCompositionEnabled: boolean
  /**
   * Folder-trust gate for project-scoped surfaces (trust.ts).
   *
   * Declared here rather than composed from a `FreeCodeGoTrustSettings`: only the status
   * and update shapes exist, and the gate is one field.
   */
  folderTrustEnabled: boolean
}

/**
 * The user-editable settings document, as behaviour reads it.
 *
 * Composed from the group types the Web client and the runtimes already share, plus the
 * fields this package owns alone. A value read from {@link FreeCodeGoPolicy.get} is a
 * plain value from this type.
 */
export type FreeCodeGoEngineSettings =
  & FreeCodeGoInlineSettings
  & FreeCodeGoCapabilitySettings
  & FreeCodeGoWebSearchSettings
  & FreeCodeGoEngineeringSettings
  & FreeCodeGoPluginConflictSettings
  & FreeCodeGoPluginUpdateSettings
  & FreeCodeGoAutomationSettings
  & FreeCodeGoReviewSettings
  & FreeCodeGoAdvisorSettings

/**
 * What a composition may supply: the same document with every setting a plain value.
 *
 * This is the schema's *input* type, and it is a separate name because a volatile field
 * has two shapes and only one of them is {@link Config}. A profile patch, a deployment
 * overlay, or a test written by hand states `mcpEnabled: true`; what the plugin instance
 * holds is a live reference, `config.mcpEnabled.get()`. Schemastery's `z<Input, Output>`
 * is where a plugin says both — its first type argument is what a writer may supply and
 * its second is what the instance receives — and naming both keeps the writer's side
 * typed instead of falling back to `any`.
 */
export type FreeCodeGoConfigInput = FreeCodeGoCompositionConfig & Partial<FreeCodeGoEngineSettings>

/**
 * The plugin's configuration: deployment input plus every user-editable setting.
 *
 * The settings half is {@link Live}-wrapped because the schema marks every one of its
 * fields `volatile()`, so the Config holds a live reference per setting and a read is
 * `.get()`. Deployment input stays an ordinary value.
 */
export type Config = FreeCodeGoCompositionConfig & Live<FreeCodeGoEngineSettings>
