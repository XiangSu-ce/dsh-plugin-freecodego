/**
 * FreeCodeGo root-engine inventory. It declares available engine generations;
 * a future router remains the sole AgentFactory and owns actual session creation.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin
 */

import { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinitionShape } from './tool-definition.ts'
// `toolDefinition` is used below under this name; see the `spill_recall`
// registration for why the identity wrapper is worth calling.
import { JSON_TOOL_OUTPUT, toolDefinition as rawTool } from './tool-definition.ts'
import { readDocumentToolDefinition } from './read-document.ts'
import { createWorktree, realCreatorDeps, type WorktreeCreation } from './worktree/creator.ts'
import { loadPersonaRoster } from './persona/files.ts'
import { claudeHookDialectOf, loadHookDocuments, type ClaudeHookDialectOwner } from './hooks/files.ts'
import { PlanFileStore, planFilePath } from './plan/plan-file.ts'
import { composePlanReworkMessage, planReviewSurface } from './plan/plan-review.ts'
import { inspectPlanSections } from './plan/plan-sections.ts'
import { FreeCodeGoHookRuntime } from './hooks/runtime.ts'
import { installHookSeams } from './hooks/seams.ts'
import type { HookDocument } from './hooks/surface.ts'
import { PersonaRuns, loadPersonaInstructions, namedOutputsIn, personaToolDefinitions } from './persona/tools.ts'
import { randomUUID, createHash } from 'node:crypto'
import { SessionWorktrees, worktreeToolDefinitions } from './worktree/tools.ts'
import { WorktreeRegistry } from './worktree/registry.ts'
import { ContextControl, contextControlToolDefinitions } from './context-control.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { FreeCodeGoAccountCoordinator, FreeCodeGoApiClient, FreeCodeGoManagedRuntime, FreeCodeGoReceiptDocument } from '@deepseek-ai/dsh-freecodego-api'
import type { FreeCodeGoEngineId, FreeCodeGoEngineSnapshot, FreeCodeGoAccountSnapshot, FreeCodeGoLoginRequest, FreeCodeGoRegistrationRequest, FreeCodeGoBackendSnapshot, FreeCodeGoDeviceSessions, FreeCodeGoManagedCatalog, FreeCodeGoModelAvailability, TraeModel, TraeStatus, FreeCodeGoCheckinReport, JsonValue, FreeCodeGoPaymentPlan, FreeCodeGoPaymentOrder, FreeCodeGoPaymentChannel, FreeCodeGoPaymentConfig, FreeCodeGoGatewayModelPrice, FreeCodeGoCodexRuntimeStatus, FreeCodeGoClaudeRuntimeStatus, FreeCodeGoRuntimePackage, AgnesStatus, FreeCodeGoSenseNovaStatus, FreeCodeGoVyceStatus, FreeCodeGoLogfareStatus, FreeCodeGoLogfareRegistrationRequest, FreeCodeGoAdvisorCouncilReport, FreeCodeGoAdvisorStatus, FreeCodeGoAdvisorUpdate, FreeCodeGoAdvisorModel, FreeCodeGoAdvisorNote, FreeCodeGoCapabilitySnapshot, FreeCodeGoCapabilityMarketplacePage, FreeCodeGoCapabilityMarketplaceRequest, FreeCodeGoMcpServer, FreeCodeGoModelCategory, FreeCodeGoSkillDetail, FreeCodeGoSkillDetailRequest, FreeCodeGoSkillRoot, FreeCodeGoSkillPlacement, FreeCodeGoSkillPlacements, FreeCodeGoPluginConflictStatus, FreeCodeGoEngineeringSettings, FreeCodeGoEngineeringStatus, FreeCodeGoEngineeringCheckpoint, FreeCodeGoEngineeringCheckpointRestoreResult, FreeCodeGoEngineeringCheckpointDiff, FreeCodeGoNvidiaStatus, WorkBuddyInternationalStatus, WorkBuddyBrowserLogin, WorkBuddyLoginPoll, QoderStatus, QoderBrowserLogin, QoderLoginPoll, ClineDeviceLogin, ClineLoginPoll, ClineStatus, FreeCodeGoReviewStatus, FreeCodeGoReviewStartRequest, FreeCodeGoReviewUpdate } from './types.ts'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { createUserMessage, type LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { CodexRuntimeManager, ClaudeRuntimeManager } from '@deepseek-ai/dsh-freecodego-native-runtime-host'
import type { FreeCodeGoAgentOptions, NativeAgentRuntimeOpeners } from '@deepseek-ai/dsh-freecodego-root-agent'
import { AgnesClient } from './agnes.ts'
import { ClineClient } from './cline.ts'
import type { WorkBuddyIntlClient } from './workbuddy-intl.ts'
import type { WorkBuddyPoolService } from './workbuddy-pool.ts'
import type { QoderClient } from './qoder-intl.ts'
import type { TraeClient } from './trae-intl.ts'
import { ClaudeProtocolBridge } from './claude-protocol-bridge.ts'
import { FreeCodeGoCapabilityRegistry, FreeCodeGoCapabilitySettingsSchema } from './capabilities.ts'
import { FreeCodeGoPluginConflictSettingsSchema, installFreeCodeGoPluginConflictGuard } from './plugin-conflicts.ts'
import { FreeCodeGoPluginUpdateService, FreeCodeGoPluginUpdateSettingsSchema } from './plugin-update.ts'
import { FreeCodeGoAdvisorRuntime } from './advisor.ts'
import { FreeCodeGoAgentProgressRuntime } from './agent-progress.ts'
import { FreeCodeGoEngineCouncil } from './engine-council.ts'
import { FreeCodeGoSubagentModelRouting } from './subagent-model-routing.ts'
import { FreeCodeGoEngineeringRegistry, FreeCodeGoEngineeringSettingsSchema } from './engineering.ts'
import {
  FreeCodeGoAutomationRuntime,
  FreeCodeGoAutomationSettingsSchema,
  automationSettingsPatch,
  type AutomationEventHost,
  type FreeCodeGoAutomationSettings,
  type FreeCodeGoAutomationSettingsUpdate,
} from './automation.ts'
import { freeCodeGoSessionEventTypes, registerFreeCodeGoSessionEventTypes } from './session-events.ts'
import type { CommunityCatalogPayload, GatewayUsageSnapshot, LocalTokenUsageQuery, LocalTokenUsageSnapshot, FreeCodeGoEngineeringCanvasGraph, FreeCodeGoEngineeringCouncilDecision, FreeCodeGoEngineeringCouncilImplementation, FreeCodeGoEngineeringCouncilJob, FreeCodeGoEngineeringCouncilReport, FreeCodeGoEngineeringCouncilRequest, FreeCodeGoEngineeringCodeGraphProjectStatus, FreeCodeGoEngineeringCodeGraphRuntimePackage, FreeCodeGoEngineeringCodeGraphRuntimeStatus, FreeCodeGoEngineeringGraphProjectStatus, FreeCodeGoEngineeringGraphRuntimePackage, FreeCodeGoEngineeringGraphRuntimeStatus, FreeCodeGoEngineeringMemoryBackup, FreeCodeGoEngineeringMemoryDetail, FreeCodeGoEngineeringMemoryIndex, FreeCodeGoEngineeringMemoryPage, FreeCodeGoEngineeringMemoryRecall, FreeCodeGoEngineeringMemoryRetentionResult, FreeCodeGoEngineeringMemoryReviewDecision, FreeCodeGoEngineeringMemoryTimeline, FreeCodeGoEngineeringMemoryTrust, FreeCodeGoEngineeringVerificationResult, FreeCodeGoEngineeringVerificationStage, FreeCodeGoGuardSettingsStatus, FreeCodeGoGuardSettingsUpdate } from './types.ts'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { runtimePackageView, setEngineAvailability } from './account-utils.ts'
import type { MediaRoute, MediaVideoArgs } from './media-utils.ts'
import { generateAudioWithFallback, generateImageWithFallback, generateVideoWithFallback, gatewayMediaJson, mediaRoute, registerMediaTools, type ImageGenerationArgs, type MediaGenerationHost, type MediaRequestOptions } from './media-generation.ts'
import { registerAdvisorTools, registerAgnesTools, type AgentToolsDeps } from './agent-tools.ts'
import { capabilityMarketplace, communityCatalog, communityCatalogIcons, communityEnvironment, communityInstalled, communityInstall, communityUninstall, mcpPresetInstall, skillPlacements, skillPresetInstall, skillPresetRemove, type CommunityRemotesHost, type CommunityRemotesState } from './community-remotes.ts'
import type { PlacementContext } from './skills/placement.ts'
import { freeCodeGoDataHome, harnessHomeDirectory } from './data-home.ts'
import { ensureDesktopDshShim, requireClaudeEngineManifestPath } from './runtime-assets.ts'
import { ensureFreeCodeGoAgentPreset } from './agent-preset-install.ts'
import { PendingWriteDrain } from './abort-drain.ts'
import { FreeCodeGoHeadroomRuntime, type HeadroomStats } from './headroom/runtime.ts'
import { FreeCodeGoDeferredTools, type DeferredToolStatus } from './deferred-tools.ts'
import { DoomLoopGuard, FreeCodeGoGuardSettingsSchema, credentialRealpathDenial, freeCodeGoToolGuard, isCredentialPath } from './tool-guards.ts'
import { workflowScriptRefusal } from './workflow-static-check.ts'
import { FolderTrustStore, FreeCodeGoTrustSettingsSchema, defaultTrustRecordPath, folderTrustEnabled, repositoryRoot, resolveFolderTrust, seedTrustRecordOnce } from './trust.ts'
import { startSuspendWatch, type SuspendEvidence } from './system-power.ts'
import { nativeCallsFromPermission, nativeToolDenial } from './native-tool-guard.ts'
import { AssistantLoopGuard } from './assistant-loop-guard.ts'
import { ContextBudgetStore, contextBudgetReport, describeContextBudget, type ContextBudgetReport } from './context-budget.ts'
import { compactionEconomicsView, type CompactionEconomicsView } from './compaction-economics.ts'
import { archiveTextFrom, auditCompactionFidelity, type CompactionFidelityVerdict } from './compaction-fidelity.ts'
import {
  characterStartIndex, completeByteLength, DEFAULT_RECALL_MAX_BYTES, DEFAULT_RECALL_MAX_LINES, MAX_RECALL_BYTES, readSpillPageBytes,
} from './spill-recall.ts'
import { CacheColdView, describeCacheColdRefusal } from './cache-cold.ts'
import { spillClearedResults, type SpillWriter } from './result-spill.ts'
import { registerEditAndRunTool, type EditAndRunRegistry } from './edit-and-run.ts'
import { RequestShapeLog, describeShapeChange, fingerprintRequest, type ShapeChange } from './request-shape.ts'
import { buildPromptComposition, buildPromptUsageTree, countCategoryChars, describePromptComposition, refreshPromptCompositionAfterCompaction, type PromptCompositionSnapshot } from './prompt-composition.ts'
import { collectPromptCompositionSources, collectPromptUsageItems, type PromptEventLike, type PromptHeaderLike as PromptRequestHeaderLike } from './prompt-composition-collect.ts'
import { installRehydration } from './rehydration.ts'
import { memorySelectorFor } from './memory/memory-selector.ts'
import { MEMORY_TOPICS_DIRECTORY, MemoryPipeline, memoryConsolidationCaveat, type MemoryConsolidation } from './memory/memory-pipeline.ts'
import { memoryDreamPlannerFor } from './memory/memory-dream-model.ts'
import type { DreamIo, MemoryObservation } from './memory/dream.ts'
import type { ForgetRefusal } from './memory/forget.ts'
import type { MemoryManifest } from './memory/manifest.ts'
import { buildMemoryTelemetry, type MemoryTelemetryRecord } from './memory/telemetry.ts'
// A `JSON.parse` failure quotes the text it failed on, so every catch that wraps
// one and reports the error masks it first — the guard in
// `tests/upstream-text-masking.spec.ts` fails the build otherwise.
import { redactCredentialShapes } from './secret-scan.ts'
import { HARNESS_AUTO_PRESET, installActionReview } from './action-reviewer.ts'
import { ActionReviewState, describeReviewOutcome } from './action-review.ts'
import { installFreeCodeGoLspMount } from './lsp-mount.ts'
import { routeEffort, steeringText, classifyTurnFromTail, ERROR_OUTPUT_EVENT_KIND } from './headroom/output-shaper.ts'
import {
  COUNCIL_MAX_PLAN_CHARS, autoCouncilSkipReason, councilCanReviewPlan,
  councilPeersFor, latestApprovedPlan, latestSessionEngine,
} from './engineering-remote-utils.ts'
import { advisorNotesFromSession, hostSessionEvents, type HostSessionEvents } from './managed-catalog-utils.ts'
import { FreeCodeGoManagedCatalogs, type FreeCodeGoEngineSettingsScope } from './managed-catalogs.ts'
import { FreeCodeGoVerifyOnStop } from './verify-on-stop.ts'
import { loadProjectConfig, PROJECT_CONFIG_RELATIVE_PATH, PROJECT_CONFIG_WHITELIST, type ProjectConfigReport } from './project-config.ts'
import { projectTierFrom, type ProjectTier } from './project-tier.ts'
import { readWorkspaceChangeScope, readWorkspaceRevision } from './engineering-quality.ts'
import { denyRealpathRefusal, denyRefusal, describeDenyEnforcement, normalizeDenyPatterns } from './sandbox/profiles.ts'
import { FreeCodeGoPolicy } from './policy.ts'
import { collectInspectReport, inspectReportToJson, renderInspectReport, type InspectCollector, type InspectReport } from './inspect/collect.ts'
import { buildInspectCollectors } from './inspect/host.ts'
import { createReviewInstall, type ReviewInstall } from './review/install.ts'
import { reviewToolDefinitions } from './review/tool.ts'
import { createSubagentFileReviewer, type ReviewSubagentOptions } from './review/subagent-reviewer.ts'
import { reviewStart, reviewStatus, reviewUpdate, type ReviewRemotesHost } from './review/remotes.ts'
import type { ReviewFilePort } from './review/reviewer.ts'
import { DEFAULT_REVIEW_GATE_SETTINGS, FreeCodeGoReviewGate, reviewGateRecord, type ReviewGateSettings } from './review/gate.ts'
import { narrowTurnScope, turnChangePaths, type TurnScopeEvent, type TurnScopeSummary } from './review/turn-scope.ts'
import {
  accountDetail, accountStatus, backendBootstrap, backendCatalog, backendQuota, backendRuntimeHealth, backendUsage, completeMfa, deviceSessions, groqWhisperTranscribe, vyceSetKey, vyceStatus,
  revokeAllSessions, revokeDeviceSession,
  logfareRegister, logfareSetKey, logfareSetTrainingOptIn, logfareStatus, login, logout, refreshAccount, register,
  readRememberedPassword, sendVerifyCode, sensenovaSetKey, sensenovaStatus, nvidiaSetKey, nvidiaStatus, restoreAccount as restoreDurableAccount, accountOAuthLogin,
  accountOAuthPendingStatus, accountOAuthPendingSendVerifyCode, accountOAuthPendingBind, accountOAuthPendingCreate,
  type AccountRemotesHost, type AccountRemotesState,
  workbuddyImportDesktopLogin, workbuddyLogout, workbuddyOpenSignIn, workbuddyPollBrowserLogin, workbuddyRefreshToken, workbuddyRefreshCredits, workbuddyRemoveAccount, workbuddySetActiveAccount, workbuddyStartBrowserLogin, workbuddyStatus,
  clineAddAccount, clineLogout, clinePollLogin, clineRefresh, clineRemoveAccount, clineStartLogin, clineStatus,
  qoderStatus, qoderStartBrowserLogin, qoderPollBrowserLogin, qoderLogout, qoderRemoveAccount, qoderSetActiveAccount, qoderRefreshQuota, qoderCheckin,
  traeStatus, traeStartBrowserLogin, traePollBrowserLogin, traeSubmitCallback, traeCancelBrowserLogin, traeModels, traeLogout, traeRemoveAccount, traeSetActiveAccount, traeCheckin,
} from './account-remotes.ts'
import {
  accountGatewayModelPrices, gatewayModelPrices, localGatewayModelPrices, paymentCancel, paymentChannels, paymentCheckout, paymentConfig, paymentOrder, paymentOrders, paymentPlans,
  paymentReceiptDocument, paymentReceiptEmail, paymentStripeReceiptDocument, paymentVerify, tokenUsageCurrentSession, tokenUsageGateway, tokenUsageLocal, type PaymentRemotesHost,
} from './payment-remotes.ts'
import {
  advisorModels, advisorReviewNow, engineeringCouncilReview, engineeringCouncilReports, engineeringTeamStart, engineeringTeamJob, engineeringTeamReports, engineeringTeamDecision,
  engineeringTeamVerify, engineeringTeamImplementation, engineeringStatus, engineeringSetEnabled, engineeringSettingsUpdate,
  engineeringLoopStatus, engineeringLoopArm, engineeringLoopStop,
  engineeringMemoryList, engineeringMemorySearch,
  engineeringMemoryRecall, engineeringMemoryTimeline, engineeringMemoryGet, engineeringMemoryReview, engineeringMemoryDelete, engineeringMemoryPurgeProject,
  engineeringMemoryExport, engineeringMemoryBackup, engineeringMemoryRetentionSweep,
  engineeringCheckpointCapture, engineeringCheckpointList, engineeringCheckpointRestore, engineeringCheckpointRemove,
  engineeringCheckpointDiff, engineeringCheckpointSetPinned,
  engineeringGraphRuntimeStatus, engineeringGraphRuntimePackages, engineeringGraphRuntimeInstall, engineeringGraphRuntimeRemove,
  engineeringGraphProjectStatus, engineeringGraphBuild, engineeringGraphUpdate, engineeringGraphCancel, engineeringGraphCanvas, engineeringGraphClearProject, engineeringSpecExport, engineeringMemoryCwd, type EngineeringRemotesHost,
  engineeringCodeGraphRuntimeStatus, engineeringCodeGraphRuntimePackages, engineeringCodeGraphRuntimeInstall, engineeringCodeGraphRuntimeRemove,
  engineeringCodeGraphProjectStatus, engineeringCodeGraphBuild, engineeringCodeGraphSync, engineeringCodeGraphCancel, engineeringCodeGraphClearProject,
} from './engineering-remotes.ts'
import {
  setDefaultEngine, setDefaultModel, catalog, modelAvailability, sessionEngineStatus, sessionDelete, codexRuntimeInstall, codexRuntimeRemove, claudeRuntimeInstall,
  claudeRuntimeRemove, capabilitiesSnapshot, capabilitiesSetEnabled, modelCategorySet, pluginConflictStatus, pluginConflictSetEnabled, mcpSave, mcpRemove, skillRootSave,
  skillRootRemove, skillInvocationSet, skillDetail, nativeRuntimeOpeners, configureGateway, directConnection, managedRuntime, managedCatalog, routeForModel, configuredProviderRoute, defaultAgentOptions,
  nativeAgentOptionsAlpha, claudeBridgeHandle, FREECODEGO_CLOUD_ORIGIN, type EngineRemotesHost,
} from './engine-remotes.ts'
import { runEngineeringEval } from './engineering-eval.ts'
import { COMPILED_BUILT_IN_COMMAND_POLICY, describePolicyDiagnostics, type CompiledCommandPolicy } from './command-policy.ts'
import { ContextFragmentLog, renderFragments, type ContextSection, type SectionInput } from './context-fragments.ts'
import { PLAN_MODE_GUIDANCE, PlanModeStore, findUpstreamPlanMode, planModeGuidanceText, planModeSessionKey, type PlanMode, type UpstreamPlanMode } from './plan-mode.ts'
import { collectPluginSurfaces, describeSurfaceLockDiff, diffSurfaceLock, measureSurfaces, type SurfaceLockDocument } from './surface-lock.ts'
import type { Config } from './plugin-config.ts'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { FreeCodeGoEngineeringEvalReport, FreeCodeGoEngineeringLoopStatus, FreeCodeGoEngineeringSkillDraftResult, FreeCodeGoEngineeringSpecBundle,  FreeCodeGoInspectReport,
  FreeCodeGoPlanReviewSurface,
  FreeCodeGoPlanReviewRequest, FreeCodeGoSandboxMode, FreeCodeGoSandboxStatus, FreeCodeGoTrustDecision, FreeCodeGoTrustReason, FreeCodeGoTrustRecord, FreeCodeGoTrustStatus } from './types.ts'

const PROCESS_START_TIME = Date.now()

/**
 * The ratio the Harness's basic compaction compacts at.
 *
 * Mirrors `compaction-basic`'s own default (`thresholdRatio = 0.8`, applied as
 * `floor(contextWindow * ratio)` per target). A composition that overrides the
 * ratio makes the figure this plugin derives approximate rather than exact, which
 * is why the side-channel check reports a warning line and never enforces a hard
 * limit — an estimate must not be able to refuse work.
 */
const HARNESS_COMPACTION_THRESHOLD_RATIO = 0.8
/**
 * Cap on the per-session views this plugin keeps in memory.
 *
 * Two of them so far — the doom-loop lineage tree and the last compaction
 * fidelity verdict — and neither is a history: the dominant use is a parent with
 * the handful of subagents it spawned, or the conversation in front of the user.
 * This is orders of magnitude above that working set; what it bounds is a
 * long-lived Host that would otherwise retain a row per session it ever served.
 */
const MAX_TRACKED_SESSION_VIEWS = 512

/** Reject a malformed session id before it reaches a service lookup. */
function validateSandboxSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('sandbox mode session id is invalid')
  return sessionId
}

/**
 * Structural view of the Harness `sandboxPolicy` service.
 *
 * Declared here instead of importing `SandboxPolicyService` so the type stays
 * narrow (three members out of the service's full surface) and so a future
 * service refactor that breaks the Remote fails at this declaration with a
 * clear shape mismatch rather than at an unrelated call site.
 */
/** The slice of an agent the Plan Mode guidance injection needs. */
interface PlanModeAgent {
  readonly id?: unknown
  readonly inject?: (message: unknown) => void
  readonly session?: { readonly header?: { readonly parentSession?: unknown } }
}

/**
 * What the context budget needs from an Agent.
 *
 * All optional on purpose: measurement depends on services an embedder may not
 * mount (the token meter) and on a session that may not exist yet, and every one
 * of those absences has to degrade to "cannot measure" rather than to a number.
 */
/**
 * The cost side of a compaction decision, as the caller can supply it.
 *
 * Every field is optional because the tool is also the *room* report; a caller
 * that only wants the tokens-in-use figure should not have to answer questions
 * about cache pricing to get it. What cannot be supplied is reported as
 * unavailable rather than defaulted.
 */
interface ContextBudgetArgs {
  readonly archive_tokens?: number
  readonly write_tokens?: number
  readonly memo_tokens?: number
  readonly cache_write_read_ratio?: number
  readonly requests_per_boundary?: readonly number[]
  readonly remaining_boundaries?: number
  readonly carried_debt_tokens?: number
}

/** Arguments of `spill_recall`, as the model supplies them. */
interface SpillRecallArgs {
  readonly locator?: string
  readonly offset?: number
  readonly max_bytes?: number
  readonly max_lines?: number
}

/**
 * What the call card names, so a reader can tell two parked results apart.
 *
 * The last path segment only: a locator is an absolute path under the data home,
 * and the whole thing is noise on a card whose job is recognition.
 */
function spillRecallTitle(locator: string | undefined): string {
  if (locator === undefined || locator.trim() === '') return 'Read parked tool result'
  const segments = locator.replaceAll('\\', '/').split('/')
  return `Read parked result (${segments.at(-1) ?? locator})`
}

/**
 * Whether a `tool/result`'s payload reports a failure.
 *
 * The Harness writes no `tool/error` event: `agent-loop/src/tool-calls.ts`
 * appends the failure as an ordinary `tool/result`, with the flag on the
 * tool-result **content block** (`message.content[i].isError`) rather than on the
 * message — the same place the session invariant reads it
 * (`session/src/invariant.ts`, `event.data.message.content[0].isError`) and the
 * one place `error` is even permitted to appear. The turn classifier
 * (`headroom/output-shaper.ts`) is handed event **kinds** alone and so cannot see
 * either field — reading it here is what lets the tail carry
 * `ERROR_OUTPUT_EVENT_KIND` and the clamp leave a debugging turn alone.
 */
function isErroredToolResult(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const record = data as { readonly error?: unknown; readonly message?: unknown }
  if (record.error !== undefined) return true
  const message = record.message
  if (typeof message !== 'object' || message === null) return false
  const content = (message as { readonly content?: unknown }).content
  return Array.isArray(content)
    && content.some(block => typeof block === 'object' && block !== null && (block as { readonly isError?: unknown }).isError === true)
}

interface ContextBudgetAgent {
  readonly id?: unknown
  readonly inject?: (message: unknown) => void
  readonly session?: unknown
  readonly ctx?: { readonly agentOptions?: { readonly maxTokens?: unknown } }
}

interface SandboxPolicyLike {
  readonly defaultMode: FreeCodeGoSandboxMode
  overrideOf(session: Session): FreeCodeGoSandboxMode | undefined
  resolve(request: { readonly session?: Session }): { readonly workspaceRoot: string }
}

export type { CommunityCatalogPlugin, FreeCodeGoBackendSnapshot, FreeCodeGoManagedCatalog, FreeCodeGoPaymentPlan, FreeCodeGoPaymentOrder, FreeCodeGoPaymentConfig, FreeCodeGoRegistrationRequest, JsonValue, FreeCodeGoCodexRuntimeStatus, FreeCodeGoClaudeRuntimeStatus, FreeCodeGoPluginUpdateSettings, FreeCodeGoPluginUpdateStatus, AgnesStatus } from './types.ts'
export type { Config } from './plugin-config.ts'
export { installFreeCodeGoPluginConflictGuard } from './plugin-conflicts.ts'
export { registerFreeCodeGoSessionEventTypes } from './session-events.ts'

/**
 * Pre-loader bootstrap for records written by FreeCodeGo engines. Session
 * persistence validates stored event types before configured plugins mount, so
 * this must run before the ordinary Host entry constructs its service.
 */
/**
 * Report the built-in command policy's compile diagnostics, once per process.
 *
 * `compileCommandPolicy` validates each rule against *its own* match/notMatch
 * examples and drops the rules that fail — the right behaviour for a document a
 * user may have edited, and a silent capability loss for the policy this plugin
 * ships. The built-in document is currently the only one, so a diagnostic here
 * means a rule in `BUILT_IN_COMMAND_POLICY` stopped matching its own example: its
 * pattern drifted, or an earlier rule stole the command it was written for. Until
 * now the only trace was that rule's unit test, which the same edit would have
 * changed. Once per process because every session constructs this service, and a
 * warning repeated per session is one nobody reads.
 */
let commandPolicyDiagnosticsReported = false
function reportCommandPolicyDiagnostics(ctx: Context, policy: CompiledCommandPolicy): void {
  if (commandPolicyDiagnosticsReported || policy.diagnostics.length === 0) return
  commandPolicyDiagnosticsReported = true
  ctx.logger?.warn?.(`freecodego: the built-in command policy compiled with ${policy.diagnostics.length} diagnostic(s); rules that failed their own examples were dropped and are no longer enforced — ${describePolicyDiagnostics(policy.diagnostics)}`)
}

/**
 * Pre-loader bootstrap for records written by FreeCodeGo engines. Session
 * persistence validates stored event types before configured plugins mount, so
 * this must run before the ordinary Host entry constructs its service.
 * @param ctx - context carrying the services this call reads.
 * @returns the conflict guard's disposer, so the Host entry can release it.
 */
export function bootstrapFreeCodeGoHarness(ctx: Context): ReturnType<typeof installFreeCodeGoPluginConflictGuard> {
  registerFreeCodeGoSessionEventTypes()
  return installFreeCodeGoPluginConflictGuard(ctx)
}
export { AGNES_AUTH_REF, AGNES_API_KEY_REF, AgnesClient, AgnesAdapter } from './agnes.ts'
export type { AgnesAccountStatus, AgnesImageRequest, AgnesImageResult, AgnesVideoRequest, AgnesVideoResult } from './agnes.ts'
export { CLINE_AUTH_REF, ClineClient, ClineAdapter, ClineUpstreamError } from './cline.ts'
export type { ClineAccountInfo, ClineDeviceLogin, ClineFreeModel, ClineLoginPoll, ClineStatus } from './types.ts'

export type * from './types.ts'
export type {
  FreeCodeGoAgentProgressEntry,
  FreeCodeGoAgentProgressSnapshot,
  FreeCodeGoAgentProgressState,
} from './agent-progress.ts'
export type { HeadroomStats } from './headroom/runtime.ts'
export type { ProjectConfigKey, ProjectConfigReadResult, ProjectConfigReport } from './project-config.ts'
// The three results the memory Remotes answer with. Re-exported so the browser
// half can name them instead of restating the shapes: a hand-copied mirror of
// `MemoryConsolidation` is exactly the drift this package's contract test
// exists to catch.
export type { MemoryConsolidation } from './memory/memory-pipeline.ts'
export type { MemoryManifest, MemoryManifestEntry } from './memory/manifest.ts'
export type { ForgetRefusal, ForgetResult } from './memory/forget.ts'
import type { OAuthLoginPendingRegistration } from './types.ts'
export type { OAuthLoginProvider } from './oauth-login.ts'

/**
 * The file-based memory home for one workspace.
 *
 * Separate from the SQLite store's directory on purpose. The store is the
 * authoritative record and is written by `engineering-memory.ts`; this home is
 * the *curated* layer the consolidation pass owns — `MEMORY.md`, the lease, and
 * the `topics/` archive — and mixing the two would put a model-written topic
 * beside a database file under a name neither module claims.
 *
 * Keyed by the workspace identity rather than by the store's project id: the
 * store's id is computed inside `engineering-memory.ts` from git remote or
 * normalized path, and reaching into it would make this layer depend on an
 * implementation detail of the layer it curates. The reduction is the same shape
 * (resolved, slash-normalized, lowercased, hashed) so one checkout is one home
 * on a case-insensitive filesystem, which is the property that matters here.
 */
function memoryPipelineHome(cwd: string): string {
  const identity = path.resolve(cwd).replaceAll('\\', '/').toLowerCase()
  const segment = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return path.join(freeCodeGoDataHome(), 'freecodego', 'engineering', 'memory-home', segment)
}

/**
 * The file operations the consolidation pass and the forget gesture share.
 *
 * `read` distinguishes "absent" from "unreadable" rather than collapsing both to
 * `undefined`: the port's contract has no error channel, so a permission error
 * reported as an absent file would make a lease look unheld and let a second pass
 * start writing while the first is still working. Only the two codes that mean
 * "there is no file here" are absorbed.
 */
function memoryPipelineIo(): DreamIo {
  return {
    read: (target) => {
      try {
        return readFileSync(target, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
        throw error
      }
    },
    write: (target, contents) => {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, contents, 'utf8')
    },
    // The temporary is moved over its target rather than copied, so no reader
    // ever observes a partial topic under its real name — the property
    // `commitTopics` cannot keep without a real rename.
    rename: (from, to) => {
      mkdirSync(path.dirname(to), { recursive: true })
      renameSync(from, to)
    },
    remove: (target) => { rmSync(target) },
  }
}

/**
 * One telemetry record as a single host log line.
 *
 * Every field is a count, a duration, a boolean or a declared enum member, so the
 * line cannot carry a topic, a path, or a sentence out of the pipeline — which is
 * the whole reason the schema is enforced at construction rather than trusted.
 */
function describeMemoryTelemetry(record: MemoryTelemetryRecord): string {
  return `freecodego: memory ${record.event} ${JSON.stringify(record.fields)}`
}

/** How long a quiet period must last before a background consolidation runs. */
const MEMORY_CONSOLIDATION_DEBOUNCE_MS = 15_000

/**
 * How long a project-tier report stays fresh.
 *
 * The same window {@link FreeCodeGoHarnessPlugin.hookDocumentsFor} uses for the
 * project's hook files, and for the same reason: a repository author fixes
 * `.freecodego/config.json` and re-opens the surface, and an answer cached for
 * the session would show them the `ignored` list they just corrected.
 */
const PROJECT_CONFIG_TTL_MS = 5_000

/** Registers engine definitions while keeping native engines unavailable until artifacts are supplied. */
export class FreeCodeGoHarnessPlugin extends TypertRemoteService {
  // Authentication state is stored only through the Host credential service.
  // Declare it here so construction cannot race the base bundle activation.
  static inject = ['credentials', 'settings', 'llm', 'tools', 'agents', 'sessions', 'sessionPersistence']
  /**
   * Runtime schema for {@link Config}, declared inline so the generated config
   * catalog can walk it: it is the only statically resolvable form a
   * plugin-class schema may take. Schemastery has no first-class `.optional()`;
   * the public `Config` type already types these fields as optional, so the
   * schema carries the same contract at runtime (absent input passes through)
   * without fighting the inferred builder types.
   */
  static Config: z<Config> = z.object({
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
  private account: FreeCodeGoAccountCoordinator | undefined
  private api: FreeCodeGoApiClient | undefined
  private credentials: CredentialProvider | undefined
  /**
   * The registered settings namespace. Nothing outside this class reads it.
   *
   * Every behaviour read goes through {@link policy}, so exactly one place
   * answers "what is configured".
   */
  private readonly engineSettings: FreeCodeGoEngineSettingsScope | undefined
  /** The one accessor behaviour reads go through (see `policy.ts`). */
  private readonly policy: FreeCodeGoPolicy
  private readonly capabilities: FreeCodeGoCapabilityRegistry
  private readonly engineering: FreeCodeGoEngineeringRegistry
  /**
   * The memory consolidation pipeline: the rollout gate, the dream lease, the
   * curated topics, the `MEMORY.md` index, and the `memory.*` counters.
   *
   * Held here rather than inside the engineering registry because the registry
   * owns the *store* and this owns the *curated layer*.
   */
  private readonly memoryPipeline: MemoryPipeline
  /** Pending debounced consolidation per workspace, so a burst of turns runs one pass. */
  private readonly memoryConsolidations = new Map<string, ReturnType<typeof setTimeout>>()
  /** Declarative failure recovery and workspace-local scheduled prompts. */
  private readonly automation: FreeCodeGoAutomationRuntime
  private readonly pluginConflictGuard: ReturnType<typeof installFreeCodeGoPluginConflictGuard>
  private readonly advisor: FreeCodeGoAdvisorRuntime
  /**
   * One review surface per workspace, assembled on first use.
   *
   * Keyed by workspace rather than held once because the review rules are read
   * from the workspace under review: a single shared port would make every session
   * resolve against whichever checkout happened to run first. The value is the
   * *promise*, so two tools called in the same turn share one assembly instead of
   * racing to read the same rule files twice.
   */
  private readonly reviewInstalls = new Map<string, Promise<ReviewInstall>>()
  private readonly agentProgress: FreeCodeGoAgentProgressRuntime
  private readonly engineCouncil: FreeCodeGoEngineCouncil
  private readonly pluginUpdates: FreeCodeGoPluginUpdateService
  private readonly subagentModelRouting: FreeCodeGoSubagentModelRouting
  private readonly headroom: FreeCodeGoHeadroomRuntime
  private readonly deferredTools: FreeCodeGoDeferredTools
  /** The stop-time verification gate, owned so the verify tool can satisfy it. */
  private verifyOnStop: FreeCodeGoVerifyOnStop | undefined
  /**
   * Session id → the session that spawned it, for the doom-loop lineage chain.
   *
   * Declared before {@link doomLoopGuard} because field initializers run in
   * order and the guard's `chainKey` closure reads this map — and because the
   * guard must exist before any tool call, while the map fills in from
   * `agent/created` as sessions appear.
   */
  /**
   * The last compaction-fidelity verdict per conversation, bounded like every
   * other per-session cache here.
   *
   * Kept because the audit runs once, on an event nobody is awaiting, and the
   * question it answers ("was that summary faithful?") is asked later, by a
   * reader looking at the compacted session.
   */
  private readonly compactionFidelity = new Map<string, CompactionFidelityVerdict>()
  private readonly sessionParents = new Map<string, string>()
  private readonly doomLoopGuard = new DoomLoopGuard({ chainKey: exec => this.lineageKeyOf(exec) })
  /**
   * Streaming repetition guard for the model's own output.
   *
   * The doom-loop guard above is a *tool-call* guard; this is its prose
   * counterpart, and the two cannot be merged because they observe different
   * things — one sees dispatched tool calls, the other sees the assistant's own
   * deltas. Both are on by default and both are settings-gated the same way.
   */
  private readonly assistantLoopGuard = new AssistantLoopGuard({
    enabled: () => this.policy.get()?.assistantLoopGuardEnabled !== false,
    onStop: (agent, finding) => {
      // Stop through the Agent's own cause vocabulary: this is a policy
      // decision, so it is `hook` — not the user, and not a parent agent. The
      // cancel runs first because a logging failure must never keep a runaway
      // turn alive.
      agent.cancel({ kind: 'hook', reason: `assistant output repeated ${finding.repetitions}x after a reminder` })
      try {
        this.ctx.logger.warn(`freecodego: assistant output looped again after a reminder (${finding.kind}, ${finding.repetitions}x${finding.period}); turn stopped`)
      } catch {
        // The turn is already stopped; a failed log line changes nothing.
      }
    },
  })
  /**
   * One folder-trust gate for every project-scoped surface this plugin mounts.
   *
   * Held here rather than inside each consumer so the three surfaces cannot
   * disagree: MCP servers, Skill roots and the LSP mount all ask this one
   * object, and every one of them gets the same answer for the same repository.
   */
  private readonly folderTrust = new FolderTrustStore()
  /** Durable Plan Mode per conversation. */
  private readonly planModeStore = new PlanModeStore()
  /** Compiled command policy the guard and Plan Mode both consult. */
  private readonly commandPolicy: CompiledCommandPolicy = COMPILED_BUILT_IN_COMMAND_POLICY
  /**
   * One fragment log per conversation, so Plan Mode guidance is diffed rather
   * than re-sent, and — the half that matters more — *retracted* when the mode
   * ends instead of being dropped silently.
   */
  /**
   * The plan document's store, owned by this plugin.
   *
   * A plugin-owned file rather than a property of the conversation, because the
   * plan must survive a restart: the mode is the Harness's, but the artifact the
   * user approves is this plugin's, and reading it back after a resume is the
   * whole reason the store reads the file rather than a memory copy.
   */
  private readonly planFileStore = new PlanFileStore()
  private readonly planModeLogs = new Map<string, ContextFragmentLog>()
  /**
   * Length of the plan the automatic council last declined to review, per
   * conversation. It exists so the refusal is announced once per plan rather
   * than once per turn: the guard runs on every turn-stopping. Released with
   * the session, like the other per-conversation views.
   */
  private readonly councilPlanTooLong = new Map<string, number>()
  /**
   * Band memory for the model-visible context budget. The fragment text is
   * quantized into bands, so this map is what keeps a session's prefix stable:
   * only a band crossing produces an injection.
   */
  private readonly contextBudget = new ContextBudgetStore()
  /**
   * Per-conversation shrunk views. The decision to clear fires once, when the
   * cache is provably cold; the view then has to be reproduced on every later
   * step or the next request would restore the transcript and move the break.
   */
  private readonly cacheColdView = new CacheColdView()

  /**
   * The mounted spill backend, or `undefined` when the composition has none.
   *
   * Read through a cast rather than the service's module augmentation, because the
   * augmentation types the property as always present: this plugin is also deployed
   * in compositions without a spill backend, and the clearing path must degrade to
   * the plain marker there instead of failing on a service that was never mounted.
   */
  private spillStore(): SpillWriter | undefined {
    return (this.ctx as unknown as { readonly spillStore?: SpillWriter }).spillStore
  }

  /** Last cache-relevant request-shape change per conversation, for diagnostics. */
  private readonly requestShapes = new RequestShapeLog()
  private readonly lastShapeChange = new Map<string, ShapeChange>()
  /** Last measurement per conversation, so the on-demand tool needs no re-measure. */
  private readonly contextBudgetReports = new Map<string, ContextBudgetReport>()
  /** Last prompt-composition snapshot per conversation: the ratio carry-forward
   *  that keeps consecutive breakdowns comparable instead of re-scaled noise. */
  private readonly promptCompositions = new Map<string, PromptCompositionSnapshot>()
  /**
   * Per-session action-review budget and cursor.
   *
   * Held here rather than left to `installActionReview`'s own default so the
   * per-session records can be released when the conversation is disposed; the
   * module has no disposal signal of its own.
   */
  private readonly actionReview = new ActionReviewState()
  /**
   * The hook runtime: documents, handler execution, and the fifteen seams.
   *
   * Constructed with the plugin rather than with a session because hook files
   * belong to a workspace, not to a conversation — two sessions in one repository
   * read the same rules, and a rule edited mid-session must not be applied to one
   * of them only.
   */
  private readonly hookRuntime: FreeCodeGoHookRuntime
  /**
   * Hook documents per workspace, with the time they were read.
   *
   * Cached because every tool call consults them, and re-read after a short delay
   * so a user editing a hook file is not told to restart the session to see it.
   * The TTL is the honest middle: reading on every call would make a slow disk a
   * per-call cost, and caching forever would make an edited rule invisible.
   */
  private readonly hookDocuments = new Map<string, { readonly documents: readonly HookDocument[]; readonly at: number }>()
  /**
   * Project-tier reports per workspace, with the time they were read.
   *
   * The same TTL as {@link hookDocuments} and for the same reason: the report is
   * a read of a file the user can edit while the settings surface is open, and a
   * cached-forever answer would show a repository's own `ignored` list as it was
   * before the author fixed it.
   */
  private readonly projectConfigReports = new Map<string, { readonly report: ProjectConfigReport; readonly at: number }>()
  /**
   * Compiled project command policies per workspace, for the synchronous guards.
   *
   * The project tier's `permissionRules` cannot be compiled on the guard path:
   * a tool guard is synchronous, and reading a repository's file would make every
   * shell call wait on a disk. So the policy is compiled when the tier is read
   * (workspace start, a session opening, the settings surface asking) and this map
   * is what a guard looks a policy up in. A workspace with no rules simply has no
   * entry, and the built-in policy is then the whole answer.
   */
  private readonly projectCommandPolicies = new Map<string, CompiledCommandPolicy>()
  /**
   * Workspaces whose tier read has been requested, so the guard asks once.
   *
   * Separate from {@link projectCommandPolicies} because "asked" and "found rules"
   * are different states: a repository that declares none and one nobody has read yet
   * both leave no entry, and only the second is worth retrying on the next call.
   */
  private readonly projectTierReads = new Set<string>()
  /**
   * One worktree set per workspace, built on first use.
   *
   * Per workspace rather than one instance because the registry file is
   * workspace-scoped: two sessions in different repositories must not be handed
   * the same registry, and a session that never asks for isolation must not
   * create the file.
   */
  private readonly worktreeSessions = new Map<string, SessionWorktrees>()
  /**
   * Required outputs owed by children that are still running.
   *
   * Held on the plugin rather than inside the start tool so the end-of-run
   * observer can check them: a child finishes in another event than the call
   * that started it.
   */
  private readonly personaRuns = new PersonaRuns()
  private lspMount: ReturnType<typeof installFreeCodeGoLspMount> | undefined = undefined
  private readonly codexRuntime: CodexRuntimeManager
  private readonly claudeRuntime: ClaudeRuntimeManager
  private readonly claudeBridge: ClaudeProtocolBridge
  private gatewayBaseUrl = FREECODEGO_CLOUD_ORIGIN
  private readonly agentEngines: { setAvailability?: (id: 'codex' | 'claude', availability: 'available' | 'unavailable' | 'updating') => void } | undefined
  private agnes: AgnesClient | undefined
  private cline: ClineClient | undefined
  private workbuddy: WorkBuddyIntlClient | undefined
  private workbuddyPool: WorkBuddyPoolService | undefined
  private qoder: QoderClient | undefined
  private trae: TraeClient | undefined
  /** Mutex and in-flight caches shared with the extracted community remotes. */
  private readonly communityState: CommunityRemotesState = {
    communityMutationTask: undefined,
    communityCatalogPromise: undefined,
    communityCatalogRefreshPromise: undefined,
    marketplaceRefreshPromises: new Map(),
    communityIconCacheTask: undefined,
    marketplaceCachePrunedAt: 0,
  }
  private readonly catalogs: FreeCodeGoManagedCatalogs
  /**
   * Boot-time writes this plugin starts without an awaiter — the bundled
   * preset sync and every catalog refresh that advertises itself as
   * "background". They belong to this plugin's lifetime: without tracking, a
   * write that started before an unload can land after it, into a home that is
   * no longer the one the work was started for. Teardown drains instead.
   */
  private readonly pendingWrites = new PendingWriteDrain()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'freeCodeGoHarness')
    reportCommandPolicyDiagnostics(ctx, this.commandPolicy)
    ensureDesktopDshShim()
    // The FreeCodeGo agent preset rides the harness user roster: preset
    // discovery re-scans <DSH_HOME>/.agent-presets on every roster read, so
    // our mode appears in the picker once this plugin loads — without
    // modifying harness source or requiring a restart. Best-effort; a locked
    // home directory must never block boot, but the write is still tracked so
    // an unload waits for it rather than racing a home that is being removed.
    void this.pendingWrites.run(() => ensureFreeCodeGoAgentPreset())
    // Harness v0.1.3 rejects a persisted session whose event vocabulary is
    // unknown to the running process. Keep every plugin-owned durable event
    // registered while this plugin is mounted, including historical engine
    // bindings and Advisor records, so an unmodified Harness can reopen an
    // existing FreeCodeGo conversation without a core-source patch.
    ctx.effect(() => {
      const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
      const added = freeCodeGoSessionEventTypes.filter(type => !known.has(type))
      for (const type of added) known.add(type)
      return () => { for (const type of added) known.delete(type) }
    }, 'freecodego: session event vocabulary')
    this.hookRuntime = new FreeCodeGoHookRuntime({
      documents: async workspaceRoot => await this.hookDocumentsFor(workspaceRoot),
    })
    // Registered **before** `headroom.start()` on purpose, and the order is load
    // bearing: cordis composes a waterfall first-registered-outermost, and the
    // outermost listener's return value is the waterfall's result. So the hook
    // seam, which awaits `next()` and then merges its own answer into what came
    // back, is the listener that decides what the model finally sees — which is
    // the property `hooks/seams.ts` states as "the user's rule wins". Moving this
    // call below `headroom.start()` would flip that silently: the user's hook
    // would merge into the uncompressed result and the compressor would then have
    // the last word. `hook-seams.spec.ts` asserts the relative order, because no
    // behavioural test can see it from inside either module.
    this.registerHookRuntime(ctx)
    this.codexRuntime = new CodexRuntimeManager({
      ...(config.codexRuntimeDirectory === undefined || config.codexRuntimeDirectory.trim() === '' ? {} : { rootDirectory: config.codexRuntimeDirectory }),
      ...(config.codexRuntimeSourceDirectory === undefined || config.codexRuntimeSourceDirectory.trim() === '' ? {} : { sourceDirectory: config.codexRuntimeSourceDirectory }),
    })
    this.claudeRuntime = new ClaudeRuntimeManager({
      ...(config.claudeRuntimeDirectory === undefined || config.claudeRuntimeDirectory.trim() === '' ? {} : { rootDirectory: config.claudeRuntimeDirectory }),
      engineManifestPath: requireClaudeEngineManifestPath(),
    })
    this.claudeBridge = new ClaudeProtocolBridge(ctx.get('llm') as { stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> })
    // Getters (not snapshots) keep configureGateway()'s rebuilt clients and
    // instance-level test overrides visible to the catalog runtime.
    this.catalogs = new FreeCodeGoManagedCatalogs({
      ctx,
      credentials: () => this.credentials,
      account: () => this.account,
      api: () => this.api,
      settings: () => this.policy,
      gatewayBaseUrl: () => this.gatewayBaseUrl,
      claudeBridge: () => this.claudeBridge,
      agnes: () => this.agnes,
      cline: () => this.cline,
      workbuddy: () => this.workbuddy,
      qoder: () => this.qoder,
      trae: () => this.trae,
      configuredProviderRoute: model => this.configuredProviderRoute(model),
      directConnection: (model, allowExternalProviders) => this.directConnection(model, allowExternalProviders),
      managedRuntime: model => this.managedRuntime(model),
      managedCatalog: () => this.managedCatalog(),
      restoreAccount: () => this.restoreAccount(),
      readManagedCatalogCache: () => this.readManagedCatalogCache(),
      refreshManagedCatalogInBackground: () => { this.refreshManagedCatalogInBackground() },
      refreshGatewayHealthInBackground: () => { this.refreshGatewayHealthInBackground() },
    })
    void this.catalogs.loadGatewayReasoningCapabilities()
    // A listen failure (e.g. no loopback available) must not surface as an
    // unhandled rejection from the constructor.
    this.claudeBridge.start().catch((error: unknown) => { this.ctx.logger?.warn?.(`FreeCodeGo Claude protocol bridge failed to start: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`) })
    ctx.effect(() => () => { void this.claudeBridge.dispose() }, 'freecodego: Claude protocol bridge')
    this.agentEngines = ctx.get('agentEngines') as { setAvailability?: (id: 'codex' | 'claude', availability: 'available' | 'unavailable' | 'updating') => void } | undefined
    const claudeStatus = this.claudeRuntime.status()
    setEngineAvailability(this.agentEngines, 'claude', claudeStatus.installed ? 'available' : 'unavailable')
    const settings = ctx.get('settings')
    if (settings !== undefined) {
      this.engineSettings = settings.register('freecodego-harness', z.intersect([
        z.object({
          defaultModel: z.string().default(config.defaultModel ?? ''),
          defaultEngine: z.string().default(config.defaultEngine ?? 'deepseek'),
          mediaDefaults: z.object({ image: z.string().default(''), video: z.string().default(''), audio: z.string().default('') }).default({ image: '', video: '', audio: '' }),
        }),
        FreeCodeGoCapabilitySettingsSchema,
        FreeCodeGoPluginConflictSettingsSchema,
        FreeCodeGoPluginUpdateSettingsSchema,
        FreeCodeGoEngineeringSettingsSchema,
        FreeCodeGoAutomationSettingsSchema,
        FreeCodeGoGuardSettingsSchema,
        FreeCodeGoTrustSettingsSchema,
        z.object({
          /**
           * Sandbox profile deny globs, enforced in the plugin policy layer.
           *
           * Empty by default: a deny list is containment the user asked for, and
           * inventing one would refuse paths nobody named.
           */
          sandboxDenyPatterns: z.array(z.string()).default([]),
        }),
        z.object({
          // Post-compaction rehydration of todo list and durable memory.
          rehydrationEnabled: z.boolean().default(true),
          /**
           * Conversation-arc rehydration (goals + decisions folded from the
           * session's own goal events, promoted memories, and announced
           * choices). Off by default: it changes what the post-compaction
           * message contains, and a user must opt into new prompt surface —
           * the mechanical fold is bounded, but its wording is still model-
           * visible behavior.
           */
          rehydrationArcEnabled: z.boolean().default(false),
        }),
        z.object({
          advisorEnabled: z.boolean().default(config.autoAdvisorEnabled !== false),
          advisorMode: z.union([z.const('async'), z.const('catchup'), z.const('blocker-only')]).default('async'),
          // Advisor uses a registered text provider route, not the retired
          // gateway alias. Existing freecodego/hy3 profiles are normalized by
          // the Advisor runtime for backward compatibility. The default is
          // OpenCode's virtual `auto` route: the upstream free roster rotates
          // (hy3-free left the directory; big-pickle appeared), so the best
          // free model is resolved live per request instead of pinned.
          advisorProvider: z.string().default('opencode'),
          advisorModel: z.string().default('auto'),
          advisorAllowAgentControl: z.boolean().default(true),
          advisorInterruptCooldownTurns: z.number().step(1).min(0).max(20).default(3),
          // Durable Advisor findings also land in project memory as pending
          // drafts so reviews survive the session (reviewed in memory settings).
          advisorMemoryDraftsEnabled: z.boolean().default(true),
          // Stop-time review is opt-in. `off` costs nothing; `record` runs the
          // pass and writes a durable summary; `gate` turns that same pass into
          // a delivery channel that injects findings at or above the threshold.
          // The default is `off` because a review spends model calls and, in
          // `gate`, changes the shape of every conversation — neither is a thing
          // to enable on a user's behalf. The manual tools work regardless.
          reviewMode: z.union([z.const('off'), z.const('record'), z.const('gate')]).default('off'),
          reviewThreshold: z.union([z.const('critical'), z.const('high'), z.const('medium'), z.const('low')]).default('high'),
          reviewCooldownTurns: z.number().step(1).min(0).max(20).default(3),
          // Deeper per-file review: every reviewed file is read by its own
          // read-only child agent, which can search for callers and open the
          // implementation a test covers instead of judging the diff alone. Off
          // by default because it opens one child agent per file, which is a
          // decision with a cost rather than a better default.
          reviewDeep: z.boolean().default(false),
          // Adjudication of high-severity findings. Off by default because it costs
          // a call per escalated finding and its shipped implementation is one
          // route, not the multi-engine council the port is designed for.
          reviewEscalation: z.boolean().default(false),
          // Headroom context compression: on by default; the threshold bounds
          // which tool results are considered oversized. The remaining knobs
          // mirror the runtime's reader defaults (min savings ratio, dedup,
          // excluded tools, opt-in read folds).
          headroomEnabled: z.boolean().default(true),
          headroomThresholdChars: z.number().step(1).min(256).max(1_000_000).default(1_200),
          headroomMinSavingsRatio: z.number().min(0.05).max(0.95).default(0.85),
          headroomDedupEnabled: z.boolean().default(true),
          /**
           * Tools to protect *in addition* to the built-in list.
           *
           * Additional, not instead of: the built-in set
           * (`DEFAULT_EXCLUDE_TOOLS`) is a safety guarantee — those outputs are
           * what the model byte-patches against — and this field defaults to an
           * empty array, so a reading where it replaced the built-ins would make
           * the default install protect nothing.
           */
          headroomExcludeTools: z.array(z.string()).default([]),
          headroomFoldReads: z.boolean().default(false),
          /**
           * Skeletonize large source-file reads: retained lines stay byte-exact
           * while whole body runs collapse to a marker. On by default because
           * `read` is the largest single source of re-sent context; the original
           * is always retrievable through `headroom_retrieve`.
           */
          headroomCodeSkeletonEnabled: z.boolean().default(true),
          /**
           * Reversible-render competition policy. `reversible` (default) delivers a
           * render that clears `FOLD_DECISIVE_RATIO` on sight — a Stage 2 fold, or a
           * mixed-content splice; `max` demotes every one of them to a candidate so
           * the compressor written for the payload's shape is always asked first.
           * The two settings are two products, not a fine-tuning — see
           * `HeadroomRuntime.foldPolicy` for the measured difference on the shapes
           * where they disagree.
           */
          headroomFoldPolicy: z.union([z.const('reversible'), z.const('max')]).default('reversible'),
          /**
           * Keep task-specific tool schemas out of the request until the model
           * asks for them with `tool_search`. Measured saving is ~3.2k tokens per
           * request on this plugin's own 37 tools alone.
           */
          deferredToolSchemasEnabled: z.boolean().default(true),
          /** Explicit deferral list; when empty the plugin-owned prefix rule applies. */
          deferredToolNames: z.array(z.string()).default([]),
          // Output shaper (original HEADROOM_OUTPUT_SHAPER): off by default —
          // both levers change model output behavior and are opt-in.
          headroomOutputShaper: z.boolean().default(false),
          headroomVerbosityLevel: z.number().step(1).min(0).max(4).default(0),
        }),
        z.object({
          /**
           * Memory consolidation rollout (`memory/rollout.ts`).
           *
           * A stage rather than a switch because consolidating runs a model over
           * the session's successful turns: `record_only` captures without
           * consolidating, `shadow` consolidates without committing, and only
           * `active` writes. Off by default, and off is where an unrecognised
           * value lands too — see `resolveMemoryRollout`, which fails closed
           * rather than falling back to the legacy search path.
           */
          memoryRollout: z.union([z.const('off'), z.const('record_only'), z.const('shadow'), z.const('active')]).default('off'),
        }),
      ]), { applies: 'live' })
    } else {
      this.engineSettings = undefined
    }
    this.policy = new FreeCodeGoPolicy(this.engineSettings)
    this.capabilities = new FreeCodeGoCapabilityRegistry(
      ctx,
      this.policy,
      directory => this.projectScopeTrust(directory),
      // Mounting is process-wide while a project tier is per-repository, so the
      // workspace asked about here is the process directory — the same default
      // `projectConfigReport()` answers with, and the same directory the trust
      // record is seeded for at boot. A session opened elsewhere still gets its
      // own hooks and its own command policy, which are the two surfaces that are
      // genuinely per-session; MCP servers and Skill roots are not.
      async () => {
        const tier = await this.projectTierFor(process.cwd()).catch(() => undefined)
        return { mcpServers: tier?.mcpServers ?? [], skillRoots: tier?.skillRoots ?? [] }
      },
    )
    this.capabilities.start()
    // First sight of a gate-enabled install seeds a grant for the repository we
    // booted in, so an upgrade does not present itself as "your MCP servers and
    // Skill roots vanished". The reconcile started above may already have
    // refused them against the empty record, so a seed is always followed by a
    // remount instead of assuming the next settings change will notice.
    void seedTrustRecordOnce({
      directory: process.cwd(),
      enabled: folderTrustEnabled(this.policy.get()),
      // The gate's own store, so the grant is visible to the reads that follow it
      // instead of only to the next launch.
      store: this.folderTrust,
    })
      .then(seeded => (seeded ? this.capabilities.remount() : undefined))
      .catch(() => undefined)
    // Suspend detection (`system-power.ts`): a wall-clock jump over a monotonic
    // clock that barely moved is the only evidence a suspended process can see, and
    // the response is one session rotation. Started here because the runtime it
    // talks to is this instance's account, which is bound later than the settings
    // are; the interval is unref'd so it cannot hold the process open.
    const stopSuspendWatch = startSuspendWatch({
      readClock: () => ({ wallMs: Date.now(), monoMs: Number(process.hrtime.bigint() / 1_000_000n) }),
      onSuspectSleep: (evidence) => { this.revalidateSessionAfterSuspend(evidence) },
    })
    ctx.effect(() => stopSuspendWatch, 'freecodego: suspend watch')
    ctx.effect(() => () => { void this.capabilities.dispose() }, 'freecodego: managed MCP and Skill providers')
    // Read the project tier for the host's own directory, and for the workspace of
    // every session that opens. The read is asynchronous — resolving trust is — so
    // this is a *head start*, not the guarantee it used to be written as: the guard
    // lookup is synchronous and answers nothing until the read lands, and the first
    // tool call of a cold workspace therefore runs on the built-in policy alone.
    // The guard path asks for the read itself (`projectPolicyForAgent`), which is
    // what covers the following call in the same workspace.
    void this.projectTierFor(process.cwd()).catch(() => undefined)
    ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
      const cwd = agent.session.header.cwd
      if (cwd === undefined || cwd.trim() === '') return
      void this.projectTierFor(cwd).catch(() => undefined)
    }), 'freecodego: project command policy')
    this.engineering = new FreeCodeGoEngineeringRegistry(ctx, this.policy)
    // Session automation: declarative failure recovery plus workspace-local
    // scheduled prompts. Both are gated by their own settings switches; the
    // rules themselves live in the repository, where a diff can review them.
    this.automation = new FreeCodeGoAutomationRuntime(
      ctx as unknown as AutomationEventHost,
      this.policy === undefined ? undefined : { get: () => this.policy.get() },
      ctx,
    )
    this.automation.start()
    ctx.effect(() => () => { this.automation.dispose() }, 'freecodego: session automation')
    this.engineering.start()
    // Semantic memory recall. The selector runs on the configured Advisor route
    // rather than a route of its own: that route is already the plugin's
    // "second, small model" setting and is already visible to the user, so a
    // separate one would be a switch almost nobody would turn on. Its own flag
    // (`engineeringMemorySelectorEnabled`, default off) decides whether a search
    // spends a request at all — the route only says which model it would be.
    this.engineering.setMemorySelector(context => memorySelectorFor({
      enabled: this.policy.get()?.engineeringMemorySelectorEnabled === true,
      provider: this.policy.get()?.advisorProvider ?? '',
      model: this.policy.get()?.advisorModel ?? '',
      llm: this.ctx.llm,
      sessionId: context.sessionId,
      // No `signal` here on purpose: the per-call signal `selectMemories` hands
      // the selector is the one that reaches the request, so threading the
      // context's into the factory would be accepted and ignored.
    }))
    ctx.effect(() => () => { this.engineering.setMemorySelector(undefined) }, 'freecodego: semantic memory recall selector')
    // Memory consolidation: the pipeline the `src/memory` modules were written
    // for. It is the only consumer of `memory/rollout.ts`, `memory/dream.ts`,
    // `memory/manifest.ts`, `memory/telemetry.ts` and `memory/forget.ts`, and it
    // is wired here rather than inside the engineering registry because the gate
    // reads the settings document, which the registry does not hold — and because
    // the store the registry owns is a different layer from the curated topics
    // this pass writes.
    //
    // The gate is recomputed per call, so a settings change takes effect without a
    // restart. The default stage is `off`, so
    // nothing here runs, and nothing here is even scheduled, until someone asks
    // for it — see `memory/rollout.ts` for why `off` may not fall back to
    // anything. The model is the Advisor route, the same "second, small model"
    // setting the memory selector above uses, for the same reason.
    this.memoryPipeline = new MemoryPipeline({
      // Raw: `resolveMemoryRollout` is what reports a stage this build does not
      // know, and a value dropped here would make that report unreachable.
      stage: () => this.policy.get()?.memoryRollout,
      home: cwd => memoryPipelineHome(cwd),
      io: memoryPipelineIo(),
      observations: cwd => this.memoryObservationsFor(cwd),
      topics: cwd => this.memoryTopicSlugsFor(cwd),
      plan: async (request, context) => {
        const planner = memoryDreamPlannerFor({
          provider: this.policy.get()?.advisorProvider ?? '',
          model: this.policy.get()?.advisorModel ?? '',
          llm: this.ctx.llm,
          sessionId: (context.sessionId ?? 'freecodego-memory-consolidation') as SessionId,
        })
        // An unconfigured route is `undefined`, not a throw: the pass still takes
        // its lease and writes its index, and reports that it had no planner.
        return planner === undefined ? undefined : await planner(request)
      },
      telemetry: record => { this.ctx.logger?.info?.(describeMemoryTelemetry(record)) },
    })
    // The consolidation trigger. `agent/turn-stopping` is the same seam the
    // engineering registry captures observations on, and it is the last moment a
    // turn's evidence exists and the session is still live. The pass is debounced
    // per workspace because it runs a model: a burst of turns consolidates once,
    // and the snapshot it reads is whatever the store held when it started —
    // which is the isolation `memory/dream.ts` documents, not a race.
    ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent }) => {
      // The gate is consulted before a timer is even created, so a deployment at
      // `off` pays nothing per turn — not even a no-op callback.
      if (!this.memoryPipeline.rollout().behaviour.consolidate) return
      const cwd = agent.session.header.cwd
      if (cwd === undefined || cwd.trim() === '') return
      this.scheduleMemoryConsolidation(cwd, String(agent.session.id))
    }), 'freecodego: memory consolidation')
    ctx.effect(() => () => {
      for (const pending of this.memoryConsolidations.values()) clearTimeout(pending)
      this.memoryConsolidations.clear()
    }, 'freecodego: memory consolidation timers')
    // The doctor's deny-enforcement section reads the same normalized patterns the
    // guard enforces. Injected for the same reason the selector above is: the
    // registry holds no settings source, so a report cannot disagree with what is
    // actually applied.
    this.engineering.setDenyPatterns(() => this.denyPatterns())
    ctx.effect(() => () => { this.engineering.setDenyPatterns(undefined) }, 'freecodego: deny enforcement report')
    // Automated action review: one listener on the Host's approval waterfall. It
    // answers only when the reviewer clears or refuses an action it could read;
    // every other path — disabled, no route, unreadable arguments, an uncertain or
    // failed reviewer, or an exhausted budget — delegates to `next()`, which is
    // the approval prompt the user already had. Same route and the same reasoning
    // as the memory selector above: the Advisor route is the plugin's existing
    // "second, small model" setting, and the opt-in flag decides whether it is used.
    installActionReview(ctx as unknown as Parameters<typeof installActionReview>[0], {
      enabled: () => this.policy.get()?.engineeringActionReviewEnabled === true,
      route: () => ({
        provider: this.policy.get()?.advisorProvider ?? '',
        model: this.policy.get()?.advisorModel ?? '',
      }),
      llm: this.ctx.llm,
      // The Harness's Auto preset is the user choosing "let the Harness decide",
      // and its reviewer already refuses an action at `tools/pre-execute` before
      // any approval is raised. Answering the prompt as well would put two
      // independent verdicts on one action, so this reviewer steps aside there.
      standsDown: agent => this.harnessOwnsApproval(agent),
      // An automatic gate that decides silently is indistinguishable from one
      // that does not run, and this one *approves actions*. Every outcome is
      // therefore written down, at the level its consequence deserves: a clear
      // verdict because an action ran without the user seeing a prompt, a
      // refusal because someone will ask why it was blocked, and a fallback to
      // the user at debug because it is the ordinary case rather than an event.
      onOutcome: (outcome) => {
        const line = `freecodego: ${describeReviewOutcome(outcome)}`
        if (outcome.kind === 'allow') this.ctx.logger?.info?.(line)
        else if (outcome.kind === 'deny') this.ctx.logger?.warn?.(line)
        else this.ctx.logger?.debug?.(line)
      },
    },
    // Passed positionally so this plugin owns the per-session records and can
    // release them on disposal: the module subscribes to no lifecycle event.
    this.actionReview)
    ctx.effect(() => () => this.engineering.dispose(), 'freecodego: engineering enhancement')
    ctx.effect(() => () => { this.doomLoopGuard.clear() }, 'freecodego: doom-loop guard state')
    // The lineage the doom-loop guard shares a chain across. Recorded where the
    // tree is knowable — a subagent's session header names the session that
    // spawned it — and released with the agent, because an entry that outlived
    // its session would fold a later one into a tree that no longer exists.
    ctx.on('agent/created', ({ agent }) => {
      // Wrapped like the other creation listeners here: a throwing listener
      // vetoes creation, and recording a lineage is not worth a session.
      try {
        const header = (agent as unknown as { readonly session: { readonly header: { readonly parentSession?: unknown } } }).session.header
        const parent = header.parentSession
        if (typeof parent !== 'string' || parent === '') return
        this.sessionParents.set(String(agent.id), parent)
        // Bounded like every other per-session map here: a long-lived Host must
        // not retain one row per session it has ever served.
        while (this.sessionParents.size > MAX_TRACKED_SESSION_VIEWS) {
          const oldest = this.sessionParents.keys().next().value
          if (oldest === undefined) break
          this.sessionParents.delete(oldest)
        }
      } catch { /* fail-open: the lineage axis falls back to the agent's own id */ }
    })
    ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
      this.sessionParents.delete(String(agent.id))
    }), 'freecodego: doom-loop lineage state')
    // Assistant-output repetition guard. It reads the stream while the answer is
    // still being written, which is the only point at which stopping a loop is
    // cheap: once the text is in the history the model pays for it on every
    // later turn as well. `global: true` matches every other Host-wide observer
    // of this event, and the guard itself keys its state per session.
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.assistantLoopGuard.accept(agent, frame)
    }, { global: true })
    ctx.effect(() => () => { this.assistantLoopGuard.clear() }, 'freecodego: assistant loop guard state')
    this.deferredTools = new FreeCodeGoDeferredTools(ctx, this.policy)
    this.deferredTools.start()
    ctx.effect(() => () => { this.deferredTools.dispose() }, 'freecodego: deferred tool schemas')
    this.pluginConflictGuard = installFreeCodeGoPluginConflictGuard(ctx, this.policy)
    // Two refusals on the model's `skill` tool, and both are needed here rather
    // than in the registry: Harness 0.1.6 lets a provider declare one Skill's
    // invocation policy at discovery time and offers no way to revise it, so a
    // user's manual-only answer has to be enforced by the surface that answers
    // for the model. The user's own `/name` gesture never passes through this
    // tool, so it stays the one entry point a manual-only Skill keeps.
    ctx.get('tools')?.guard((exec) => {
      if (exec.name !== 'skill') return undefined
      if (!this.capabilities.skillEnabled() && !this.engineering.skillEnabled()) return 'Skill is disabled in FreeCodeGo settings'
      const name = (exec.arguments as { readonly name?: unknown } | undefined)?.name
      return typeof name === 'string' && this.capabilities.skillInvocationLocked(name)
        ? `Skill "${name}" is manual-only in FreeCodeGo settings`
        : undefined
    })
    // Credential-file protection, the declarative command policy, and Plan Mode:
    // monotonic denials on every host-dispatched tool call (settings-gated).
    //
    // Loop hygiene is deliberately *absent* here. Every call this guard sees is
    // also a call `tools/pre-execute` dispatched, which is exactly the population
    // the Harness's own `dsh-repeat-tool-reminder` counts and reminds the model
    // about at 3, 5 and 8 repeats. Denying the same repeat here as well would put
    // two answers on one call — a reminder to change approach and a refusal — so
    // this path leaves loops to the Harness. The engine's own tools never reach
    // `tools/pre-execute`; `nativeToolGuard` below is where the denial is still
    // the only protection there is.
    ctx.get('tools')?.guard(freeCodeGoToolGuard({
      settings: () => this.policy.get(),
      policy: this.commandPolicy,
      projectPolicy: agent => this.projectPolicyForAgent(agent),
      planMode: {
        policy: this.commandPolicy,
        modeFor: agent => this.planModeModeFor(agent),
      },
    }))
    // Sandbox profile denials. Installed as a registry guard rather than inside the
    // tool implementations so it covers every tool the Host dispatches, including
    // ones this plugin does not own and the MCP bridge's, and so it cannot be
    // bypassed by a tool that forgets to ask. The native engines' own tools never
    // reach the registry, which is why `nativeToolGuard` runs the same judgment.
    ctx.get('tools')?.guard(exec => denyRefusal({ deny: this.denyPatterns(), args: exec.arguments }))
    this.registerPlanModeTool()
    this.registerSurfaceReportTool()
    this.registerInspectTool()
    this.registerReviewTools()
    this.registerInspectCommand()
    this.registerSpillRecallTool()
    this.registerContextBudgetTool()
    this.registerContextControlTools()
    this.registerPromptCompositionTool()
    this.registerReadDocumentTool()
    this.registerWorktreeTools()
    this.registerPersonaTools()
    ctx.effect(() => () => { this.contextBudget.clear(); this.contextBudgetReports.clear() }, 'freecodego: context budget bands')
    ctx.effect(() => () => { this.promptCompositions.clear() }, 'freecodego: prompt composition snapshots')
    ctx.effect(() => () => { this.cacheColdView.clear(); this.requestShapes.clear(); this.lastShapeChange.clear() }, 'freecodego: cache-cold views and request shapes')
    // Warm the mode for a conversation the moment it starts, so the synchronous
    // guard above reads a real mode rather than the default, and so re-entering a
    // session that was in Plan Mode restores the enforcement addendum.
    //
    // Upstream is asked first: when it is composed it is the authority, and its
    // `plan` projection already folded the resumed session's log, so it knows the
    // mode a restarted process would otherwise have to guess. Reading the store
    // first here would resurrect a stale local answer over upstream's folded one —
    // the two-authority bug this seam exists to remove.
    ctx.on('agent/created', ({ agent }) => {
      const upstream = this.upstreamPlanMode()
      if (upstream !== undefined) {
        try {
          this.injectPlanModeGuidance(agent as unknown as PlanModeAgent, upstream.get(agent).active ? 'plan' : 'execute')
          return
        } catch {
          // Fall through to the durable store rather than losing the warm-up.
        }
      }
      void this.planModeStore.read(planModeSessionKey(agent as unknown as { readonly id?: unknown })).then((mode) => {
        this.injectPlanModeGuidance(agent as unknown as PlanModeAgent, mode)
      }).catch(() => undefined)
    })
    // A completed compaction rewrites the surface, so guidance injected earlier
    // may no longer be there. The plan-mode fragment log has to stop believing the
    // model still holds it, or the next assertion of the mode plans no fragment and
    // the rules stay lost — the resume/compaction case the fragment engine
    // documents and that nothing was wired to.
    // A compaction summary replaces the history it was written from, and the
    // history is gone in the same commit — so `compaction/summary` is the only
    // moment the claim it makes can still be checked. Wired here rather than in
    // the compaction engine because the engine wrote the summary: a check the
    // author runs on itself is not the check this is.
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if ((event.type as string) !== 'compaction/summary') return
      this.auditCompactionSummary(session, event)
    }), 'freecodego: compaction summary fidelity')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if ((event.type as string) !== 'compaction/end') return
      if (typeof (event.data as { readonly error?: unknown } | undefined)?.error === 'string') return
      this.planModeLogs.get(planModeSessionKey({ id: session.id ?? undefined }))?.markUnknown()
      // The same boundary rewrites what the prompt is made of: the conversation
      // collapses into a summary, so the stored breakdown describes a request
      // that no longer exists. Same event, same reason, different view.
      this.refreshPromptCompositionAfterCompaction(session)
    }), 'freecodego: plan mode fragment invalidation')
    // One log per conversation is a cache, not a history. Release the per-session
    // views with the session so a long-lived Host does not accumulate one entry
    // for every conversation it has ever served.
    ctx.effect(() => ctx.on('session/disposed', (session) => {
      const key = planModeSessionKey({ id: session.id ?? undefined })
      this.planModeLogs.delete(key)
      this.councilPlanTooLong.delete(key)
      // The durable mode is on disk, so dropping the cached projection here costs
      // one read if the session is ever resumed and keeps the map bounded.
      this.planModeStore.forget(key)
      this.contextBudget.forget(key)
      this.contextBudgetReports.delete(key)
      this.requestShapes.forget(key)
      this.lastShapeChange.delete(key)
      this.promptCompositions.delete(key)
      // The shrunk view keeps one marker map per conversation for every tool
      // result it ever parked, so it is released here for the same reason the
      // six views above are: nothing else ever revisits a disposed session.
      this.cacheColdView.forget(key)
      // Two maps below are keyed by the raw session id rather than by the
      // plan-mode key: action review by the id its approval request used, and a
      // persona child's output contract by the id the child was created with.
      const rawSessionId = session.id === undefined ? '' : String(session.id)
      if (rawSessionId !== '') {
        this.actionReview.forget(rawSessionId)
        // The loop guard is keyed by the same raw id, and it is the one view here
        // that never hears an `end` frame for a session disposed mid-attempt: its
        // detector is holding that attempt's accumulated stream text, which is the
        // largest thing in this handler.
        this.assistantLoopGuard.forget(rawSessionId)
        // A contract is dropped when the child reports. A child disposed without
        // ever reporting — the parent's turn was cancelled, the Host is shutting
        // down — would otherwise leave one entry behind per child for the life of
        // the process, which is the leak this handler exists to prevent.
        this.personaRuns.forget(rawSessionId)
      }
    }), 'freecodego: per-session fragment and budget views')
    // Cline-style auto-checkpoint: before any file-mutating host tool runs,
    // capture a shadow snapshot (throttled, content-addressed, best-effort) so
    // every edit has a pre-image even when the model never calls the capture
    // tool itself.
    //
    // The workspace is read from the executing agent's session header, and two
    // listeners below need it: written once so the optional chains the tool seam's
    // shape requires are stated once rather than duplicated per seam.
    const sessionCwd = (exec: unknown): string | undefined =>
      (exec as { readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } } } | undefined)
        ?.agent?.session?.header?.cwd
    ctx.on('tools/pre-execute', async (exec, next) => {
      // Symlink- and short-name-aware credential denial. The synchronous guard
      // above answers about the name the model wrote; only a resolution can see
      // that `docs/notes.md` is a link to `.ssh/id_rsa`. Denying here (rather
      // than throwing) keeps the refusal inside the same monotonic denial the
      // model already knows how to read, while leaving the sync guard's ordering
      // untouched. Fail-open: an unresolvable path is left to the lexical tier.
      if (this.policy.get()?.envReadGuardEnabled !== false) {
        const denial = await credentialRealpathDenial(exec.name, exec.arguments).catch(() => undefined)
        if (denial !== undefined) return { kind: 'deny', reason: denial }
      }
      // The deny list's own resolution tier, for the same reason and at the same
      // moment: the registry guard above answers about the name the model wrote, so a
      // call naming a junction into a denied directory walked past it. Ahead of the
      // checkpoint capture below, because a refused call must not leave one behind.
      const denyDenial = await denyRealpathRefusal({ deny: this.denyPatterns(), args: exec.arguments }).catch(() => undefined)
      if (denyDenial !== undefined) return { kind: 'deny', reason: denyDenial }
      // A workflow script is refused here for the same reason the guards above refuse
      // an action: the failure is already certain, and by the time the engine reports
      // it the run has already paid for child agents on the way to the failure. Keyed
      // on the argument shape rather than the tool name — the name is a documented
      // configuration knob, so a name-keyed rule stops guarding the moment a
      // deployment renames it — and nothing loads the compiler unless a call actually
      // carries a script.
      const scriptRefusal = workflowScriptRefusal(exec.arguments)
      if (scriptRefusal !== undefined) return { kind: 'deny', reason: scriptRefusal }
      const cwd = sessionCwd(exec)
      await this.engineering.checkpointAutoCapture(cwd, exec.name)
      // Hunk tracking (P-21) reads the same seam for the same reason: this is the
      // last moment the file still holds its pre-image. It is recorded under the
      // harness's `callId`, which is what makes "which call changed this line" a
      // lookup rather than a guess.
      await this.engineering.hunkPrepare(exec.callId, exec.name, exec.arguments, cwd)
      return next()
    })
    // …and the other half, on the way out. This observes rather than decides: the
    // hook seam belongs to whatever else is on it, so `next()` is always called and
    // a journal failure must never turn into a failed tool call. Recording on this
    // seam — not only on success — is deliberate: a call that wrote and then
    // reported an error is the change nobody can find by reading the transcript.
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      try {
        await this.engineering.hunkRecord(exec.callId, sessionCwd(exec))
      } catch { /* advisory only: attribution must never fail a tool call */ }
      return next()
    })
    // A cancelled or failed turn is the moment the plugin's own writes are
    // racing its teardown: the engine has stopped driving, nothing will await
    // the memory observation or the Skill-catalog injection that was already
    // started, and they are about to be abandoned mid-flight. Draining them here
    // — bounded, and never rejecting — is what keeps a result the turn already
    // paid tokens for from being thrown away. A completed turn needs nothing:
    // its writes were awaited, or are still on the queue that dispose drains.
    ctx.effect(() => ctx.on('session/event', (_session, event) => {
      if ((event.type as string) !== 'turn/end') return
      const kind = (event.data as { readonly reason?: { readonly kind?: unknown } } | undefined)?.reason?.kind
      if (kind !== 'aborted' && kind !== 'error') return
      void this.engineering.pendingWrites.drain().then((outcome) => {
        if (outcome.timedOut || outcome.remaining > 0) {
          this.ctx.logger.info(`freecodego: turn ended ${kind}; ${String(outcome.remaining)} engineering write(s) did not settle within ${String(outcome.timeoutMs)}ms`)
        }
      }, () => undefined)
    }), 'freecodego: aborted-turn write drain')
    // `agent/created` is the single serial creation announcement in Harness
    // 0.1.6 (it replaced `agent/session-start`) and a throwing listener vetoes
    // creation, so this keeps its original non-fatal disposition.
    ctx.on('agent/created', ({ agent }) => {
      try {
        if (this.capabilities.skillEnabled() || this.engineering.skillEnabled() || agent.ctx.tools.get('skill', agent) === undefined) return
        agent.ctx.tools.restrict({ deny: ['skill'] })
      } catch { /* fail-open: the skill denial must never veto agent creation */ }
    })
    // After a successful compaction, re-inject standing context (latest todo
    // list + durable project memory) so the compacted surface keeps its plan.
    installRehydration(ctx, {
      enabled: () => this.policy.get()?.rehydrationEnabled !== false,
      recall: cwd => this.engineering.memoryRecall(cwd),
      bodies: (cwd, ids) => {
        const details = this.engineering.memoryGetForReview(cwd, ids) ?? []
        return new Map(details.map(detail => [detail.id, detail.body]))
      },
      arcEnabled: () => this.policy.get()?.rehydrationArcEnabled === true,
      // Plan Mode's rules do not survive a compaction by themselves. The
      // rehydrated body cannot carry them either — they are not a todo and not a
      // memory — so the reminder is computed separately and injected even when
      // there is nothing else to restore, which is exactly the case of a young
      // session that has been in plan mode the whole time.
      planReminder: session => this.planModeCompactionReminder(session),
    })
    // Probe-based LSP stack: mounts dsh-lsp + lsp-stdio + tool-lsp only when
    // language servers resolve on PATH; boot never depends on tooling.
    this.lspMount = installFreeCodeGoLspMount(ctx, this.policy)
    ctx.effect(() => {
      void this.lspMount?.status().catch(() => undefined)
      return () => { this.lspMount = undefined }
    }, 'freecodego: LSP probe')
    this.advisor = new FreeCodeGoAdvisorRuntime(ctx, this.policy, {
      // Durable Advisor findings become pending project-memory drafts; the user
      // reviews them in the existing memory settings surface.
      saveMemoryDraft: (cwd, advice) => {
        if (this.policy.get()?.advisorMemoryDraftsEnabled === false) return
        this.engineering.saveDraftFromAdvisor(cwd, advice)
      },
      // The Advisor is the plugin's own side channel, so its prompt is the one it
      // is best placed to measure. Reusing the stored context report keeps this
      // from adding a second meter pass to every turn.
      sideChannelBudget: agent => this.sideChannelBudget(agent as unknown as ContextBudgetAgent),
    })
    this.agentProgress = new FreeCodeGoAgentProgressRuntime(ctx)
    ctx.effect(() => () => { this.agentProgress.dispose() }, 'freecodego: delegated Agent progress')
    this.engineCouncil = new FreeCodeGoEngineCouncil(this.policy, () => this.defaultAgentOptions())
    ctx.effect(() => () => { this.engineCouncil.dispose() }, 'freecodego: engine council')
    // Close the autonomous engineering loop. `dsh-goal-round-driver` (mounted by
    // the base bundle) owns *continuation*; this listener owns the termination
    // half — when a goal leaves the active phase, the declared verification
    // stages run and a failing result is fed back to the agent.
    //
    // The signal is the goal service's own `goal/changed` event rather than the
    // raw session log: it fires after the session event has already committed,
    // is scope-filtered to the owning agent, and carries the fresh projection.
    // Reached through the context's event bus by name so this package needs no
    // dependency on `dsh-goal` for a type-only import.
    const verifiedGoals = new Set<string>()
    const goalEvents = ctx as unknown as {
      on(event: 'goal/changed', listener: (payload: { readonly agent?: Agent; readonly change?: { readonly goal?: { readonly id?: string; readonly phase?: string } } }) => void): void
    }
    goalEvents.on('goal/changed', (payload) => {
      const phase = payload?.change?.goal?.phase
      const goalId = payload?.change?.goal?.id
      const agent = payload?.agent
      if (agent === undefined || goalId === undefined || phase === undefined) return
      // A goal that is active again is a new occurrence of whatever terminal phase
      // it reaches next: the user pressed 继续, or raised 目标最大回合数 and the cap
      // was extended, so the driver is running again under an authorization it did
      // not have before. Retiring this goal's dedup keys here is what makes the
      // *second* block of one goal reported and re-verified instead of matching the
      // key the first one left behind — a match that returned before either the
      // verification or the unattended-stop report below.
      if (phase === 'active') {
        for (const entry of [...verifiedGoals]) if (entry.startsWith(`${goalId}:`)) verifiedGoals.delete(entry)
        return
      }
      const key = `${goalId}:${phase}`
      if (verifiedGoals.has(key)) return
      verifiedGoals.add(key)
      // Bound the dedup set: goal ids are unique, so an unbounded Set would grow
      // for the life of the process on a long-lived Host.
      if (verifiedGoals.size > 256) verifiedGoals.clear()
      // The phase rides along so the terminal-only gate inside stays decidable:
      // a `paused` goal is a user stop, not a finished one, and must not launch
      // the project's verification scripts.
      void this.engineering.verifyCompletedGoal(agent, phase).then((result) => {
        if (result === undefined) return
        const failed = result.stages.filter(stage => stage.state === 'fail' || stage.state === 'unavailable')
        if (failed.length === 0) return
        agent.inject(createUserMessage({
          source: { kind: 'plugin', plugin: 'freecodego-engineering-loop' },
          content: [{
            type: 'text',
            text: `Engineering goal "${goalId}" ended in phase "${phase}", but verification did not pass: ${failed.map(stage => `${stage.id}=${stage.state}`).join(', ')}. Resolve these before treating the plan as done.`,
          }],
        }))
      }).catch(() => undefined)
      // An unattended goal that stopped with a blocker is the one stopping
      // condition a user cannot see for themselves: the driver gave up mid-plan
      // and the session simply went idle. Report the blocker and the budget it
      // burned — the round cap is the common case — plus the control that would
      // continue. Reported only while auto-continue is on, because that is when
      // the stop was the driver's decision rather than the user's.
      if (this.policy.get()?.engineeringLoopAutoContinue === true) {
        const loop = this.engineering.goalLoopStatus(agent)
        if (loop.phase === 'blocked') {
          const budget = loop.roundsStarted === undefined || loop.maxGoalRounds === undefined
            ? ''
            : ` after ${loop.roundsStarted}/${loop.maxGoalRounds} goal rounds`
          agent.inject(createUserMessage({
            source: { kind: 'plugin', plugin: 'freecodego-engineering-loop' },
            content: [{
              type: 'text',
              text: `Engineering goal "${goalId}" stopped unattended${budget}: ${loop.blockedMessage ?? loop.blockedCode ?? 'the round driver blocked it'}. Nothing continues until that is resolved; use 工程增强 → 无人值守工程回路 → 继续 to resume it.`,
            }],
          }))
        }
      }
    })
    // Cache-cold clearing, placed where it can still help: the waterfall runs
    // before a model call, and the whole point is to shrink the prompt *before*
    // it is sent. Running after the first miss would only help later turns.
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (this.policy.get()?.cacheColdClearEnabled === false) return decision
        if (decision.kind !== 'enter') return decision
        const agent = (payload as { readonly agent?: ContextBudgetAgent }).agent
        // The key needs only the id and the parent session, and asking for exactly
        // that is what keeps this call independent of the richer agent shape the
        // rest of the handler uses.
        const key = planModeSessionKey(agent as { readonly id?: unknown } | undefined)
        const messages = (decision as { readonly messages?: readonly unknown[] }).messages ?? []
        const lastAssistantAt = this.lastAssistantAt(agent as unknown as ContextBudgetAgent)
        const plan = this.cacheColdView.plan(key, {
          ...(lastAssistantAt === undefined ? {} : { lastAssistantAt }),
          now: Date.now(),
          messages: messages as readonly { readonly role?: unknown; readonly content?: unknown }[],
        })
        if (plan.fire) {
          this.ctx.logger.info(`freecodego: clearing ${plan.clearCount} old tool result(s) (~${plan.reclaimTokens} tokens) because the prompt cache is live cold`)
        } else if (plan.refusal !== undefined && plan.refusal !== 'gap-below-threshold' && plan.refusal !== 'no-assistant-message') {
          this.ctx.logger.debug?.(`freecodego: cache-cold clear not taken: ${describeCacheColdRefusal(plan.refusal)}`)
        }
        // Park what is about to be cleared, so the marker can carry a locator
        // instead of a dead end. This runs when the view is active rather than only
        // when `plan` fires, because results enter the cleared window over time as
        // the conversation grows — each one needs parking exactly once, and
        // `hasMarker` is what keeps a later step from parking it again.
        const view = messages as readonly { readonly role?: unknown; readonly content?: unknown }[]
        const targets = this.cacheColdView.clearTargets(key, view)
          .filter(target => !this.cacheColdView.hasMarker(key, target.callId))
        if (targets.length > 0) {
          const store = this.spillStore()
          // A missing backend is a degraded mode, not a failure, but it is worth
          // saying out loud: without it the marker is a dead end, and a silent
          // version of that is indistinguishable from parking being broken.
          if (store === undefined) this.ctx.logger.debug?.(`freecodego: ${targets.length} cleared tool result(s) cannot be parked for retrieval because this composition mounted no spill backend`)
          const markers = await spillClearedResults(
            store,
            key as SessionId,
            targets,
            (target, error) => { this.ctx.logger.warn(`freecodego: could not park cleared ${target.tool} result for retrieval, it will be cleared unrecoverably: ${redactCredentialShapes(String(error))}`) },
          )
          this.cacheColdView.recordMarkers(key, markers)
        }
        const applied = this.cacheColdView.apply(key, view)
        if (!applied.changed) return decision
        // The transform spreads each message and replaces only a tool result's
        // content, so every entry is still the message shape it came in as — the
        // double cast is only bridging the waterfall's mutable `UserMessage[]`
        // against a structurally identical read-only view of the same objects.
        return { ...decision, messages: applied.messages } as unknown as typeof decision
      } catch (error) {
        this.ctx.logger.warn(`freecodego: cache-cold clearing failed: ${redactCredentialShapes(String(error))}`)
        return decision
      }
    })
    // Announce the context budget at band granularity once a turn settles: the
    // surface is stable then, and a band crossing is what the model needs to know
    // before it plans the next read rather than after the request is refused.
    ctx.on('agent/turn-stopping', ({ agent }) => {
      try {
        this.refreshContextBudget(agent as unknown as ContextBudgetAgent)
        this.recordRequestShape(agent as unknown as ContextBudgetAgent)
      } catch (error) {
        this.ctx.logger.warn(`freecodego: context budget refresh failed: ${redactCredentialShapes(String(error))}`)
      }
    })
    ctx.on('agent/turn-stopping', ({ agent, signal }) => {
      const settings = this.policy.get()
      if (settings?.engineeringEnabled !== true || ! settings.engineeringCouncilEnabled || ! settings.engineeringCouncilAutoRun || signal.aborted) return
      const events = hostSessionEvents(agent.session)
      const plan = latestApprovedPlan(events)
      // The guard answers more than "has this plan been tried": a plan whose one
      // attempt died of the council's own deadline or a Host restart was never
      // reviewed, so it gets one retry, while a review that happened, a council
      // still running, and a council the user cancelled all stay off. See
      // `autoCouncilSkipReason` for the policy and its bound.
      if (plan === undefined || autoCouncilSkipReason(events, plan) !== undefined) return
      // A plan too long for the council is a decision, not a failure. Asking the
      // contract's own predicate keeps it off the log after the first turn:
      // `start` would raise the same input error on every turn-stopping, because
      // the same plan stays the latest approved one until another is approved.
      if (! councilCanReviewPlan(plan)) {
        // The same expression the session/disposed cleanup uses, so the entry is
        // released by the same key it was stored under.
        const key = planModeSessionKey({ id: agent.session.id ?? undefined })
        if (this.councilPlanTooLong.get(key) !== plan.length) {
          this.councilPlanTooLong.set(key, plan.length)
          this.ctx.logger.warn(`freecodego: the approved plan is ${plan.length} characters and the engineering council reviews at most ${COUNCIL_MAX_PLAN_CHARS}, so automatic review stays off until a shorter plan is approved`)
        }
        return
      }
      try {
        const parentEngine = latestSessionEngine(events)
        // The roster comes from the module that owns it, not from a literal here.
        // This site hands `engines` straight to `engineCouncil.start` — the same
        // field the explicit council tool fills and the validator gates on
        // `COUNCIL_ENGINES` — so a literal was the roster one reader short: an
        // engine added to `COUNCIL_ENGINES` would have been offered by the
        // explicit tool and silently skipped by the automatic one.
        const engines = councilPeersFor(parentEngine)
        this.engineCouncil.start(agent, { objective: 'Review and validate the approved implementation plan before execution.', plan, engines }, signal)
      } catch (error) {
        this.ctx.logger.warn(`freecodego: automatic engineering council failed: ${redactCredentialShapes(String(error))}`)
      }
    })
    this.registerAdvisorTools()
    this.registerEditAndRunComposite()
    this.pluginUpdates = new FreeCodeGoPluginUpdateService({
      settings: this.policy,
      ...(config.updatePackageName === undefined ? {} : { packageName: config.updatePackageName }),
      ...(config.updateReleaseRepository === undefined ? {} : { releaseRepository: config.updateReleaseRepository }),
      ...(config.updateReleaseTokenEnv === undefined ? {} : { releaseTokenEnv: config.updateReleaseTokenEnv }),
    })
    this.pluginUpdates.start()
    ctx.effect(() => () => { this.pluginUpdates.stop() }, 'freecodego: plugin update checks')
    // A real agent creation, not a timer, confirms a staged plugin update.
    let updateConfirmHooked = false
    ctx.on('agent/created', () => {
      if (updateConfirmHooked) return
      updateConfirmHooked = true
      void this.pluginUpdates.confirmStartup().catch(() => undefined)
    })
    this.configureGateway()
    this.catalogs.registerFreeCodeGoAdapter()
    this.catalogs.registerVyceAdapter()
    this.catalogs.registerOpenCodeAdapter()
    this.catalogs.registerLogfareAdapter()
    this.catalogs.registerAgnesAdapter()
    this.catalogs.registerClineAdapter()
    this.catalogs.registerWorkbuddyAdapter()
    this.catalogs.registerQoderAdapter()
    this.catalogs.registerTraeAdapter()
    // The WorkBuddy pool sweeps credits and the daily check-in on its own clock;
    // the timers are unref'd so a Host that is otherwise idle can still exit.
    ctx.effect(() => () => this.workbuddyPool?.stop(), 'freecodego: WorkBuddy pool maintenance')
    this.catalogs.registerSenseNovaAdapter()
    this.catalogs.registerNvidiaAdapter()
    this.catalogs.registerKiloAdapter()
    // Every directory behind those registrations is read once here, behind the
    // answer, after the snapshot the previous process left has been restored. The
    // model menu's first catalog arrives after a browser has connected, so it
    // should find the directories known rather than wait for twelve network reads
    // (see `known-provider-catalog.ts`). The reads themselves are fire-and-forget:
    // a route that has not answered by the time the picker asks is answered by its
    // own cold budget instead of being waited on.
    void this.catalogs.prewarmProviderCatalogs()
    this.catalogs.refreshLogfareHealthInBackground()
    this.registerAgnesTools()
    this.registerMediaTools()
    // The preset sync above and the directory refreshes around it are all
    // fire-and-forget by design, but the files they write belong to this
    // plugin's lifetime. Draining both on unload keeps a late write from landing
    // in a home this plugin no longer owns, and is what lets a teardown that owns
    // a temporary home remove it instead of racing the writer. Both drains are
    // bounded and never reject.
    ctx.effect(() => async () => {
      await Promise.all([this.pendingWrites.drain(), this.catalogs.pendingWrites.drain()])
    }, 'freecodego: background preset and catalog writes')
    // Headroom context compression: hooks the tools/post-execute waterfall so
    // oversized log/JSON tool results reach the model compressed while the
    // durable log keeps the lossless value; the model can pull originals back
    // through the registered headroom_retrieve tool.
    this.headroom = new FreeCodeGoHeadroomRuntime(ctx, this.policy)
    // Second on the `tools/post-execute` waterfall, after the hook seams registered
    // above — see the note there. Reordering these two lines changes which listener
    // has the last word on a hook that replaces tool output.
    this.headroom.start()
    ctx.effect(() => () => { this.headroom.dispose() }, 'freecodego: headroom context compression')
    // Output shaper (opt-in): verbosity steering appends a byte-stable L1-L4
    // block at the tail of the system prompt (cache-safe); effort routing
    // clamps an explicitly-set reasoning effort down one step on mechanical
    // tool-continuation turns. Both default off.
    this.startOutputShaper(ctx)
    this.subagentModelRouting = new FreeCodeGoSubagentModelRouting(ctx, config.autoSubagentModelSelection !== false)
    ctx.effect(() => () => { this.subagentModelRouting.dispose() }, 'freecodego: automatic Subagent model routing')
    this.registerVerifyOnStop(ctx)
    this.registerReviewGate(ctx)
  }

  /**
   * Wire the stop-time verification gate (`verify-on-stop.ts`).
   *
   * The gate owns the judgement and this owns the three facts it needs, which is
   * the split that keeps the judgement testable: `cwd` comes from the session
   * header, "a mutating tool ran" comes from the post-execute waterfall, and
   * "the turn is ending" comes from the turn-stopping serial hook.
   *
   * Off unless the engineering surface is on, because the only verification
   * runner this plugin registers is an engineering tool; a nudge that points at
   * a tool the composition did not mount is a dead pointer.
   */
  private registerVerifyOnStop(ctx: Context): void {
    /**
     * The agents the gate may speak to, by id.
     *
     * Both the workspace and the inbox are properties of a live agent, and the
     * gate is handed an id — so the id has to resolve to something. Entries are
     * dropped on disposal, both because the agent is gone and because an id that
     * outlived its agent would inject into the next one to reuse it.
     */
    const agents = new Map<string, { readonly id?: unknown; readonly session?: { readonly header?: { readonly cwd?: string } }; readonly inject?: (message: unknown) => void }>()
    /** The workspace of the agent a gate question is about; one resolution for both readers. */
    const workspaceOf = (agentId: string): string => {
      const cwd = agents.get(agentId)?.session?.header?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
    }
    const gate = new FreeCodeGoVerifyOnStop({
      enabled: () => this.policy.get()?.engineeringEnabled === true,
      readChangedPaths: async (agentId) => {
        const scope = await readWorkspaceChangeScope(workspaceOf(agentId))
        // `undefined` means git could not answer, which is not the same fact as
        // "nothing changed" — but the gate can only speak about a change it can
        // name, and a guessed change set would make the nudge wrong instead of
        // quiet.
        return scope?.changedPaths ?? []
      },
      // Content, not just which files: a second edit of a file the turn has
      // already modified changes no path, so the path list cannot tell the state a
      // verification measured from the state the turn ends with. Same module that
      // owns the change reader, so the two are one notion of the workspace.
      readChangeRevision: async (agentId) => await readWorkspaceRevision(workspaceOf(agentId)),
      inject: (agentId, text) => {
        const agent = agents.get(agentId)
        if (typeof agent?.inject !== 'function') return
        agent.inject(createUserMessage({
          source: { kind: 'plugin', plugin: 'freecodego-verify-on-stop' },
          content: [{ type: 'text', text: `<verify-on-stop>\n${text}\n</verify-on-stop>` }],
        }))
      },
      log: (message) => { this.ctx.logger.warn(`freecodego: ${message}`) },
    })
    // Published so the verify tool can satisfy this gate. Without a caller for
    // `recordVerification` the gate has no reachable satisfied state, so every
    // turn that touched the workspace is nudged even after it verified.
    this.verifyOnStop = gate
    ctx.on('agent/created', ({ agent }) => {
      agents.set(String(agent.id), agent as unknown as { readonly id?: unknown })
    })
    // The waterfall is where the tool that ran is named. `next()` is always
    // called: this observes a turn, it does not decide anything about it.
    ctx.on('tools/post-execute', (exec, _result, next) => {
      try {
        const id = exec.agent?.id
        if (id !== undefined) gate.noteToolCall(String(id), exec.name)
      } catch { /* advisory only: never fail a tool call to observe it */ }
      return next()
    })
    ctx.on('agent/turn-stopping', ({ agent }) => {
      void gate.onTurnStopping(String(agent.id))
    })
    ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
      const id = String(agent.id)
      agents.delete(id)
      gate.forget(id)
    }), 'freecodego: verify-on-stop state')
  }

  /** The stop-time review settings, defaulted field by field. */
  private reviewGateSettings(): ReviewGateSettings {
    const stored = this.policy.get()
    return {
      mode: stored?.reviewMode ?? DEFAULT_REVIEW_GATE_SETTINGS.mode,
      threshold: stored?.reviewThreshold ?? DEFAULT_REVIEW_GATE_SETTINGS.threshold,
      cooldownTurns: stored?.reviewCooldownTurns ?? DEFAULT_REVIEW_GATE_SETTINGS.cooldownTurns,
    }
  }

  /**
   * Register the stop-time review.
   *
   * One pass per change set, run when the turn is about to end, with two delivery
   * channels: the findings are always recorded as a durable session summary, and
   * are injected only when a finding reaches the configured threshold and the
   * cooldown has elapsed. Sharing one pass between "review each turn" and "gate the
   * stop" is deliberate — two hooks would read the same diff twice, pay for it
   * twice, and be able to disagree about the same tree.
   *
   * The run is confined to the paths the turn actually changed, so a turn does not
   * re-review files that were already dirty and cannot report their findings as its
   * own. A failure to review never blocks the stop: the turn must still be able to
   * end, and a review that could not run is not evidence that a change is clean.
   */
  private registerReviewGate(ctx: Context): void {
    const agents = new Map<string, {
      readonly session?: {
        readonly id?: unknown
        readonly header?: { readonly cwd?: string }
        readonly append?: unknown
        /** Read for the per-turn change record; absent on a session shape without it. */
        readonly snapshotEvents?: () => readonly unknown[]
      }
      readonly inject?: (message: unknown) => void
    }>()
    const workspaceOf = (agentId: string): string => {
      const cwd = agents.get(agentId)?.session?.header?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
    }
    const gate = new FreeCodeGoReviewGate({
      settings: () => this.reviewGateSettings(),
      workspaceOf,
      readChangedPaths: async (agentId, turn) => {
        const scope = await readWorkspaceChangeScope(workspaceOf(agentId))
        if (scope === undefined) return undefined
        // The Host's per-turn record is preferred over the workspace's whole
        // uncommitted set, and only when it is provably a subset of it — see
        // `review/turn-scope.ts`, where both rules and their reasons live.
        const turnPaths = readReviewTurnPaths(this.ctx, agents.get(agentId)?.session, turn)
        return narrowTurnScope(turnPaths, scope.changedPaths)
      },
      readChangeRevision: async agentId => await readWorkspaceRevision(workspaceOf(agentId)),
      portFor: async workspace => (await this.reviewInstallFor(workspace)).port,
      record: (agentId, report, delivery) => {
        const session = agents.get(agentId)?.session
        if (session === undefined || typeof session.append !== 'function') return
        try {
          // The session records the summary; the report itself stays in the run
          // manager, which is what `engineering_review_report` reads. A session
          // event is replayed on every resume, so the full report would be an
          // unbounded durable cost for a fact the tool can answer on demand.
          (session.append as (type: string, data: unknown) => unknown)('freecodego/review', reviewGateRecord(report, delivery))
        } catch { /* a disposed session cannot record a review */ }
      },
      inject: (agentId, text) => {
        const agent = agents.get(agentId)
        if (typeof agent?.inject !== 'function') return false
        agent.inject(createUserMessage({
          source: { kind: 'plugin', plugin: 'freecodego-review' },
          content: [{ type: 'text', text: `<stop-time-review>\n${text}\n</stop-time-review>` }],
        }))
        return true
      },
    })
    ctx.on('agent/created', ({ agent }) => {
      agents.set(String(agent.id), agent as unknown as { readonly session?: { readonly header?: { readonly cwd?: string } } })
    })
    ctx.on('tools/post-execute', (exec, _result, next) => {
      try {
        const id = exec.agent?.id
        if (id !== undefined) gate.noteToolCall(String(id), exec.name)
      } catch { /* advisory only: never fail a tool call to observe it */ }
      return next()
    })
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      void gate.onTurnStopping(String(agent.id), {
        ...(typeof turn === 'number' ? { turn } : {}),
        ...(signal === undefined ? {} : { signal }),
      }).then(outcome => {
        if (outcome.kind === 'failed') {
          this.ctx.logger.warn(`freecodego: the stop-time review could not run: ${redactCredentialShapes(outcome.reason)}`)
        }
      }).catch(() => undefined)
    })
    // Dropped on disposal for the same reason `verify-on-stop` drops its own: the
    // agent is gone, and an id that outlived its agent would resolve to a stale
    // workspace — and would be kept for the life of the plugin process, one entry
    // per agent a long-running host has ever seen.
    ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
      const id = String(agent.id)
      agents.delete(id)
      gate.forget(id)
    }), 'freecodego: review gate state')
    ctx.effect(() => () => {
      gate.clear()
      agents.clear()
    }, 'freecodego: review gate')
  }

  /** Return a dynamic opener; each session revalidates the installed artifact. 
   * @returns the native Agent Runtime Openers.
   */
  nativeRuntimeOpeners(): NativeAgentRuntimeOpeners {
    return nativeRuntimeOpeners(this.engineRemotesHost)
  }

    /**
   * Report the installed Codex runtime state, as the native-runtime surface reads it.
   * @returns the runtime's install state.
   */
nativeRuntimeStatus(): FreeCodeGoCodexRuntimeStatus { return this.codexRuntime.status() }
  /** Root-engine defaults are read by the Host API only for new identities. 
   * @returns the default engine, provider, and model new identities start with.
   */
  defaultAgentOptions(): { readonly engine: 'deepseek' | 'codex' | 'claude'; readonly provider: string; readonly model?: string } {
    return defaultAgentOptions(this.engineRemotesHost)
  }

  /** Resolve the native execution plan through the RC.1 AgentFactory seam. 
   * @param restore - the durable engine plan being restored, when reopening an existing session.
   * @param requested - the caller's options to layer over that plan.
   * @returns the options a native child agent is created with.
   */
  nativeAgentOptionsAlpha(
    restore?: { readonly engine: 'codex' | 'claude'; readonly modelId?: string; readonly provider?: string },
    requested?: AgentOptions,
  ): AgentOptions & FreeCodeGoAgentOptions & { readonly provider: string } {
    return nativeAgentOptionsAlpha(this.engineRemotesHost, restore, requested)
  }

    /**
   * Persist the engine future sessions open with.
   * @param engine - engine id to persist.
   * @returns the persisted engine.
   */
@Remote('setDefaultEngine')
  async setDefaultEngine(engine: string): Promise<{ readonly engine: 'deepseek' | 'codex' | 'claude' }> {
    return setDefaultEngine(this.engineRemotesHost, engine)
  }

  /** Persist the model id used by future sessions; live sessions remain pinned. 
   * @param model - model id the turn runs.
   * @returns the persisted model id.
   */
  @Remote('setDefaultModel')
  async setDefaultModel(model: string): Promise<{ readonly model: string }> {
    return setDefaultModel(this.engineRemotesHost, model)
  }

  /** Return browser-safe aggregate status for the Host-managed Advisor. 
   * @returns the advisor Status.
   */
  @Remote('advisorStatus')
  advisorStatus(): FreeCodeGoAdvisorStatus {
    return this.advisor.status()
  }

  /** Persist a partial Advisor configuration update. 
   * @returns the advisor Status.
   * @param input - the partial Advisor configuration to merge.
   */
  @Remote('advisorUpdate')
  async advisorUpdate(input: FreeCodeGoAdvisorUpdate): Promise<FreeCodeGoAdvisorStatus> {
    return this.advisor.update(input)
  }

  /** List text-capable managed routes suitable for an independent Advisor call. 
   * @returns the advisor Model rows, in backend order.
   */
  @Remote('advisorModels')
  async advisorModels(): Promise<readonly FreeCodeGoAdvisorModel[]> {
    return advisorModels(this.engineeringRemotesHost)
  }

  /** Recent durable notes for currently live sessions; transcript data stays Host-owned. 
   * @returns the advisor Note rows, in backend order.
   */
  @Remote('advisorNotes')
  advisorNotes(): readonly FreeCodeGoAdvisorNote[] {
    const sessions = this.ctx.get('sessions') as { list?: () => readonly ({ readonly id: unknown } & HostSessionEvents)[] } | undefined
    return (sessions?.list?.() ?? [])
      .flatMap(advisorNotesFromSession)
      .sort((left, right) => right.time - left.time)
      .slice(0, 40)
  }

  /** Ask the Advisor to review the latest durable facts of one live session. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the advisor Status.
   */
  @Remote('advisorReviewNow')
  advisorReviewNow(sessionId: string): FreeCodeGoAdvisorStatus {
    return advisorReviewNow(this.engineeringRemotesHost, sessionId)
  }

  /** Read one workspace's review surface: its settings, its runs, and its last report. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the review Status.
   */
  @Remote('reviewStatus')
  async reviewStatus(sessionId: string): Promise<FreeCodeGoReviewStatus> {
    return reviewStatus(this.reviewRemotesHost, sessionId)
  }

  /** Start a review for one session's workspace; the run continues in the background. 
   * @param sessionId - the Harness session this operation acts on.
   * @param request - what to review.
   * @returns the review Status.
   */
  @Remote('reviewStart')
  async reviewStart(sessionId: string, request: FreeCodeGoReviewStartRequest): Promise<FreeCodeGoReviewStatus> {
    return reviewStart(this.reviewRemotesHost, sessionId, request)
  }

  /** Persist a review settings change and return the workspace's new surface. 
   * @param sessionId - the Harness session this operation acts on.
   * @param patch - the settings fields to change.
   * @returns the review Status.
   */
  @Remote('reviewUpdate')
  async reviewUpdate(sessionId: string, patch: FreeCodeGoReviewUpdate): Promise<FreeCodeGoReviewStatus> {
    return reviewUpdate(this.reviewRemotesHost, sessionId, patch)
  }

  /** Request architecture, security, and testing perspectives without steering the main Agent. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the advisor Council Report.
   */
  @Remote('engineeringCouncilReview')
  engineeringCouncilReview(sessionId: string): Promise<FreeCodeGoAdvisorCouncilReport> {
    return engineeringCouncilReview(this.engineeringRemotesHost, sessionId)
  }

  /** Read the most recent durable Council reports for a live or restored session. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the advisor Council Report rows, in backend order.
   */
  @Remote('engineeringCouncilReports')
  async engineeringCouncilReports(sessionId: string): Promise<readonly FreeCodeGoAdvisorCouncilReport[]> {
    return engineeringCouncilReports(this.engineeringRemotesHost, sessionId)
  }

  /** Expose the user-owned provider match to the engine router. 
   * @param model - model id the turn runs.
   * @returns the provider and model the user's route maps to, or `undefined` when the caller's own provider owns it.
   */
  resolveModelRoute(model: string): { readonly provider: string; readonly model: string } | undefined {
    return this.configuredProviderRoute(model.trim())
  }

  /** Resolve a saved model against user-owned llm-pi-ai routes before falling back to FreeCodeGo. */
  private configuredProviderRoute(model: string): { readonly provider: string; readonly model: string } | undefined {
    return configuredProviderRoute(this.ctx, model)
  }

  /** Start a bounded three-engine engineering council for one live parent Agent. 
   * @param sessionId - the Harness session this operation acts on.
   * @param request - the request this call projects from.
   * @returns the engineering Council Job.
   */
  @Remote('engineeringTeamStart')
  engineeringTeamStart(sessionId: string, request: FreeCodeGoEngineeringCouncilRequest): FreeCodeGoEngineeringCouncilJob {
    return engineeringTeamStart(this.engineeringRemotesHost, sessionId, request)
  }

  /** Read one live engineering council task. 
   * @returns the engineering Council Job.
   * @param id - id of the council job to read.
   */
  @Remote('engineeringTeamJob')
  async engineeringTeamJob(id: string): Promise<FreeCodeGoEngineeringCouncilJob> {
    return engineeringTeamJob(this.engineeringRemotesHost, id)
  }

  /** Cancel one live engineering council and all of its child Agents. 
   * @returns the engineering Council Job.
   * @param id - id of the council job to cancel.
   */
  @Remote('engineeringTeamCancel')
  engineeringTeamCancel(id: string): FreeCodeGoEngineeringCouncilJob {
    if (typeof id !== 'string' || !/^council_[a-f0-9]{32}$/i.test(id)) throw new Error('engineering council job id is invalid')
    return this.engineCouncil.cancel(id)
  }

  /** Read durable council reports from one live parent Agent. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Council Report rows, in backend order.
   */
  @Remote('engineeringTeamReports')
  async engineeringTeamReports(sessionId: string): Promise<readonly FreeCodeGoEngineeringCouncilReport[]> {
    return engineeringTeamReports(this.engineeringRemotesHost, sessionId)
  }

  /** Record the user's explicit approval or rejection of a completed engineering council. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Council Decision.
   * @param request - the council id and the decision to record.
   */
  @Remote('engineeringTeamDecision')
  async engineeringTeamDecision(
    sessionId: string,
    request: { readonly id: string; readonly decision: FreeCodeGoEngineeringCouncilDecision['state'] },
  ): Promise<FreeCodeGoEngineeringCouncilDecision> {
    return engineeringTeamDecision(this.engineeringRemotesHost, sessionId, request)
  }

  /** Run declared verification after the user approved a completed engineering council. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Verification Result.
   * @param request - the council id and the verification stages to run.
   */
  @Remote('engineeringTeamVerify')
  async engineeringTeamVerify(
    sessionId: string,
    request: { readonly id: string; readonly stages?: readonly FreeCodeGoEngineeringVerificationStage[] },
  ): Promise<FreeCodeGoEngineeringVerificationResult> {
    return engineeringTeamVerify(this.engineeringRemotesHost, sessionId, request)
  }

  /** Mark an approved plan as implemented before running verification. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Council Implementation.
   * @param request - the council id and the implementation summary.
   */
  @Remote('engineeringTeamImplementation')
  async engineeringTeamImplementation(sessionId: string, request: { readonly id: string; readonly summary: string }): Promise<FreeCodeGoEngineeringCouncilImplementation> {
    return engineeringTeamImplementation(this.engineeringRemotesHost, sessionId, request)
  }

  /** Browser-safe engineering enhancement state; modules remain isolated from account loading. 
   * @returns the engineering Status.
   */
  @Remote('engineeringStatus')
  async engineeringStatus(): Promise<FreeCodeGoEngineeringStatus> {
    return engineeringStatus(this.engineeringRemotesHost)
  }

  /** Enable or disable every engineering enhancement resource without affecting MCP or user Skills. 
   * @param enabled - whether this capability is switched on.
   * @returns the engineering Status.
   */
  @Remote('engineeringSetEnabled')
  async engineeringSetEnabled(enabled: boolean): Promise<FreeCodeGoEngineeringStatus> {
    return engineeringSetEnabled(this.engineeringRemotesHost, enabled)
  }

  /** Persist an explicitly bounded engineering settings patch. 
   * @returns the engineering Status.
   * @param input - the bounded engineering settings patch.
   */
  @Remote('engineeringSettingsUpdate')
  async engineeringSettingsUpdate(input: Partial<FreeCodeGoEngineeringSettings>): Promise<FreeCodeGoEngineeringStatus> {
    return engineeringSettingsUpdate(this.engineeringRemotesHost, input)
  }

  /** Read the session's autonomous loop: goal, phase, continuation, round budget. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Loop Status.
   */
  @Remote('engineeringLoopStatus')
  async engineeringLoopStatus(sessionId: string): Promise<FreeCodeGoEngineeringLoopStatus> {
    return engineeringLoopStatus(this.engineeringRemotesHost, sessionId)
  }

  /** Let the goal's round driver continue without a user turn. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Loop Status.
   */
  @Remote('engineeringLoopArm')
  async engineeringLoopArm(sessionId: string): Promise<FreeCodeGoEngineeringLoopStatus> {
    return engineeringLoopArm(this.engineeringRemotesHost, sessionId)
  }

  /** Stop unattended continuation for the session's goal. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Loop Status.
   */
  @Remote('engineeringLoopStop')
  async engineeringLoopStop(sessionId: string): Promise<FreeCodeGoEngineeringLoopStatus> {
    return engineeringLoopStop(this.engineeringRemotesHost, sessionId)
  }

  /** List compact local memories for the selected workspace without exposing drafts to Agents. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Page.
   * @param request - the trust filter, page size, and cursor.
   */
  @Remote('engineeringMemoryList')
  engineeringMemoryList(sessionId: string, request?: { readonly trusts?: readonly FreeCodeGoEngineeringMemoryTrust[]; readonly limit?: number; readonly cursor?: string }): FreeCodeGoEngineeringMemoryPage {
    return engineeringMemoryList(this.engineeringRemotesHost, sessionId, request)
  }

  /** Search reviewed historical knowledge for the selected workspace. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Index rows, in backend order.
   * @param searchText - the text to match.
   * @param limit - the maximum number of records to return.
   */
  @Remote('engineeringMemorySearch')
  engineeringMemorySearch(sessionId: string, searchText?: string, limit?: number): readonly FreeCodeGoEngineeringMemoryIndex[] {
    return engineeringMemorySearch(this.engineeringRemotesHost, sessionId, searchText, limit)
  }

  /** Preview the bounded reviewed-memory index that is injected only at session start. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Recall.
   */
  @Remote('engineeringMemoryRecall')
  engineeringMemoryRecall(sessionId: string): FreeCodeGoEngineeringMemoryRecall {
    const started = Date.now()
    const recall = engineeringMemoryRecall(this.engineeringRemotesHost, sessionId)
    // The recall half of the memory telemetry schema. `hit`/`miss` rather than a
    // count of candidates, because the record the schema allows carries no ids
    // and no titles — which is exactly why it is safe to emit from a surface a
    // user is watching.
    this.ctx.logger?.info?.(describeMemoryTelemetry(buildMemoryTelemetry('memory.recall', {
      outcome: recall.records.length === 0 ? 'miss' : 'hit',
      selected: recall.records.length,
      durationMs: Date.now() - started,
    })))
    return recall
  }

  /** Read a bounded time neighborhood around a user-selected local memory record. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Timeline.
   * @param request - the record id and the time window around it.
   */
  @Remote('engineeringMemoryTimeline')
  engineeringMemoryTimeline(sessionId: string, request: { readonly id: string; readonly before?: number; readonly after?: number }): FreeCodeGoEngineeringMemoryTimeline {
    return engineeringMemoryTimeline(this.engineeringRemotesHost, sessionId, request)
  }

  /** Read selected local memory details for human review. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Detail rows, in backend order.
   * @param ids - ids of the records to read.
   */
  @Remote('engineeringMemoryGet')
  engineeringMemoryGet(sessionId: string, ids: readonly string[]): readonly FreeCodeGoEngineeringMemoryDetail[] {
    return engineeringMemoryGet(this.engineeringRemotesHost, sessionId, ids)
  }

  /** User-only review decision. Agent tools cannot call this path. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Detail.
   * @param request - the record id and the review decision.
   */
  @Remote('engineeringMemoryReview')
  engineeringMemoryReview(sessionId: string, request: { readonly id: string; readonly decision: FreeCodeGoEngineeringMemoryReviewDecision }): FreeCodeGoEngineeringMemoryDetail {
    return engineeringMemoryReview(this.engineeringRemotesHost, sessionId, request)
  }

  /** Permanently delete one local memory selected by the user. 
   * @param sessionId - the Harness session this operation acts on.
   * @param id - id of the record to delete.
   * @returns true once the record is gone.
   */
  @Remote('engineeringMemoryDelete')
  engineeringMemoryDelete(sessionId: string, id: string): { readonly deleted: true } {
    return engineeringMemoryDelete(this.engineeringRemotesHost, sessionId, id)
  }

  /** Clear non-reviewed records by default; reviewed knowledge needs an explicit opt-in. 
   * @param sessionId - the Harness session this operation acts on.
   * @param request - whether reviewed knowledge is included in the purge.
   * @returns how many records were deleted.
   */
  @Remote('engineeringMemoryPurgeProject')
  engineeringMemoryPurgeProject(sessionId: string, request?: { readonly includeReviewed?: boolean }): { readonly deleted: number } {
    return engineeringMemoryPurgeProject(this.engineeringRemotesHost, sessionId, request)
  }

  /** Export reviewed project knowledge without drafts, rejected records, or database paths. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the reviewable records, with drafts and rejected entries omitted.
   */
  @Remote('engineeringMemoryExport')
  engineeringMemoryExport(sessionId: string): { readonly version: 1; readonly exportedAt: number; readonly projectId: string; readonly records: readonly FreeCodeGoEngineeringMemoryDetail[] } {
    return engineeringMemoryExport(this.engineeringRemotesHost, sessionId)
  }

  /** Produce a consistent plugin-private SQLite backup without exposing its path. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Backup.
   */
  @Remote('engineeringMemoryBackup')
  engineeringMemoryBackup(sessionId: string): Promise<FreeCodeGoEngineeringMemoryBackup> {
    return engineeringMemoryBackup(this.engineeringRemotesHost, sessionId)
  }

  /** Trim only stale generated/rejected memory and completed Outbox entries. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Memory Retention Result.
   * @param retentionDays - age in days beyond which stale records are trimmed.
   */
  @Remote('engineeringMemoryRetentionSweep')
  engineeringMemoryRetentionSweep(sessionId: string, retentionDays?: number): FreeCodeGoEngineeringMemoryRetentionResult {
    const started = Date.now()
    const result = engineeringMemoryRetentionSweep(this.engineeringRemotesHost, sessionId, retentionDays)
    // The sweep is the retention half of the memory telemetry schema. Emitted
    // here rather than inside the store because the store has no logger and the
    // counts are the only thing this surface can report: the schema has no field
    // for a record id, by design.
    this.ctx.logger?.info?.(describeMemoryTelemetry(buildMemoryTelemetry('memory.retention', {
      outcome: 'swept',
      removed: result.deletedMemories + result.deletedOutboxEntries,
      durationMs: Date.now() - started,
    })))
    return result
  }

  /**
   * Run one memory consolidation pass for this workspace, now.
   *
   * The same pass the background trigger runs, exposed so a user can force one
   * after turning the stage up, and so the stage's effect is inspectable without
   * waiting out the debounce. It is gated exactly like the background path: the
   * rollout stage decides whether a model is called and whether anything is
   * written.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the memory Consolidation.
   */
  @Remote('engineeringMemoryConsolidate')
  async engineeringMemoryConsolidate(sessionId: string): Promise<MemoryConsolidation> {
    return await this.memoryPipeline.consolidate({
      cwd: engineeringMemoryCwd(this.engineeringRemotesHost, sessionId),
      sessionId,
    })
  }

  /**
   * Render this workspace's curated memory index (`MEMORY.md`) and return it.
   *
   * A bounded list of absolute pointers to the curated topics, so a reader who
   * opens only this file never sees a row whose file is missing. Regenerated here
   * rather than only during a pass, because a user who edited a topic by hand
   * needs a way to bring the index back in step without spending a model request.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the memory Manifest.
   */
  @Remote('engineeringMemoryManifest')
  engineeringMemoryManifest(sessionId: string): MemoryManifest {
    return this.memoryPipeline.writeManifest(engineeringMemoryCwd(this.engineeringRemotesHost, sessionId))
  }

  /**
   * Forget exactly one curated record, given the bytes the caller read.
   *
   * The evidence — a path and the `sha256` of what the caller read — is the whole
   * safety argument in `memory/forget.ts`: the caller does the reading, and this
   * path verifies the file still hashes to what was read before removing it. It
   * refuses a directory, a glob, a path outside the archive, a symlink, a
   * protected file, an unknown archive, stale evidence, and a live dream lease.
   *
   * The result names the forgotten path relative to the archive and nothing else:
   * the tombstone and audit locations are filesystem detail, and every other
   * memory Remote on this surface is careful not to hand those out.
   * @param sessionId - the Harness session this operation acts on.
   * @param request - the path and the sha256 of the bytes the caller read.
   * @returns whether the record was forgotten, with the refusal when it was not.
   */
  @Remote('engineeringMemoryForget')
  engineeringMemoryForget(
    sessionId: string,
    request: { readonly path?: string; readonly sha256?: string } | undefined,
  ): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly refusal: ForgetRefusal; readonly message: string } {
    // A missing field is refused rather than repaired: `''` is not a path and
    // `''` is not a digest, and both land on a refusal that names why instead of
    // on a removal the caller did not ask for.
    const result = this.memoryPipeline.forget(engineeringMemoryCwd(this.engineeringRemotesHost, sessionId), {
      path: typeof request?.path === 'string' ? request.path : '',
      sha256: typeof request?.sha256 === 'string' ? request.sha256 : '',
    })
    return result.ok ? { ok: true, path: result.path } : result
  }

  /** Capture a checkpoint of the workspace's tracked source files. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Checkpoint.
   * @param input - the label the checkpoint is listed under.
   */
  @Remote('engineeringCheckpointCapture')
  async engineeringCheckpointCapture(sessionId: string, input: { readonly label: string }): Promise<FreeCodeGoEngineeringCheckpoint> {
    return engineeringCheckpointCapture(this.engineeringRemotesHost, sessionId, input?.label)
  }

  /** List this workspace's checkpoints, newest first. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Checkpoint rows, in backend order.
   */
  @Remote('engineeringCheckpointList')
  engineeringCheckpointList(sessionId: string): readonly FreeCodeGoEngineeringCheckpoint[] {
    return engineeringCheckpointList(this.engineeringRemotesHost, sessionId)
  }

  /** Restore the workspace to a checkpoint. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Checkpoint Restore Result.
   * @param input - id of the checkpoint to restore.
   */
  @Remote('engineeringCheckpointRestore')
  async engineeringCheckpointRestore(sessionId: string, input: { readonly id: string }): Promise<FreeCodeGoEngineeringCheckpointRestoreResult> {
    return engineeringCheckpointRestore(this.engineeringRemotesHost, sessionId, input?.id)
  }

  /** Delete one checkpoint manifest. 
   * @param sessionId - the Harness session this operation acts on.
   * @param input - id of the checkpoint to delete.
   * @returns true once the manifest is gone.
   */
  @Remote('engineeringCheckpointRemove')
  engineeringCheckpointRemove(sessionId: string, input: { readonly id: string }): { readonly deleted: true } {
    return engineeringCheckpointRemove(this.engineeringRemotesHost, sessionId, input?.id)
  }

  /** Preview what restoring one checkpoint would change, without touching files. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Checkpoint Diff.
   * @param input - id of the checkpoint to preview.
   */
  @Remote('engineeringCheckpointDiff')
  engineeringCheckpointDiff(sessionId: string, input: { readonly id: string }): FreeCodeGoEngineeringCheckpointDiff {
    return engineeringCheckpointDiff(this.engineeringRemotesHost, sessionId, input?.id)
  }

  /** Pin or unpin one checkpoint; pinned ones survive the retention cap. 
   * @param sessionId - the Harness session this operation acts on.
   * @param input - the checkpoint id and the pin state to store.
   * @returns the pin state now stored.
   */
  @Remote('engineeringCheckpointSetPinned')
  engineeringCheckpointSetPinned(sessionId: string, input: { readonly id: string; readonly pinned: boolean }): { readonly pinned: boolean } {
    return engineeringCheckpointSetPinned(this.engineeringRemotesHost, sessionId, input?.id,  input?.pinned)
  }

  /**
   * Derive draft Skills from this project's reviewed memory.
   *
   * Writes drafts only; it never registers a Skill root. The gap between "a file
   * exists" and "every engine now follows it" is exactly the boundary a human
   * should cross deliberately.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Skill Draft Result.
   */
  @Remote('engineeringSkillDraft')
  async engineeringSkillDraft(sessionId: string): Promise<FreeCodeGoEngineeringSkillDraftResult> {
    const host = this.engineeringRemotesHost
    return await host.engineering.skillDraftGenerate(engineeringMemoryCwd(host, sessionId))
  }

  /**
   * Export one approved council report as `specs/<id>/{spec,plan,tasks}.md`.
   *
   * The report is already durable in the session log; this makes it reviewable —
   * a file a teammate can read in a pull request. Only an approved report is
   * exported, because an unreviewed plan is not a decision the project has made.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Spec Bundle.
   * @param request - the council report id to export.
   */
  @Remote('engineeringSpecExport')
  async engineeringSpecExport(sessionId: string, request: { readonly id: string }): Promise<FreeCodeGoEngineeringSpecBundle> {
    const host = this.engineeringRemotesHost
    return engineeringSpecExport(host, sessionId, request)
  }

  /**
   * Run the deterministic capability evaluation and return its report.
   *
   * Read-only and side-effect free, so it is safe to call from a settings
   * refresh or a diagnostics script. It measures this plugin's own
   * deterministic units — guards, repo map, memory ranking, compression,
   * council merge — and never model behaviour, which needs a keyed harness.
   * @returns the engineering Eval Report.
   */
  @Remote('engineeringEval')
  async engineeringEval(): Promise<FreeCodeGoEngineeringEvalReport> {
    return await runEngineeringEval()
  }

  /** Read live Headroom context-compression state and savings counters. 
   * @returns the headroom Stats.
   */
  @Remote('headroomStatus')
  headroomStatus(): HeadroomStats {
    return this.headroom.status()
  }

  /** What the deferred-tool split currently saves on every request. 
   * @returns the deferred Tool Status.
   */
  @Remote('deferredToolsStatus')
  deferredToolsStatus(): DeferredToolStatus {
    return this.deferredTools.status()
  }

  /** Toggle deferred tool schemas for future sessions. 
   * @param enabled - whether this capability is switched on.
   * @returns the deferred Tool Status.
   */
  @Remote('deferredToolsSetEnabled')
  async deferredToolsSetEnabled(enabled: boolean): Promise<DeferredToolStatus> {
    const settings = this.policy
    if (settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    await settings.update({ deferredToolSchemasEnabled: enabled })
    return this.deferredTools.status()
  }

  /** Probe-and-mount status for the optional LSP stack (fail-soft). 
   * @returns the probe-and-mount state of the optional LSP stack.
   */
  @Remote('lspMountStatus')
  async lspMountStatus(): Promise<import('./types.ts').FreeCodeGoLspMountStatus> {
    if (this.lspMount === undefined) return { enabled: false, mounted: false, servers: [] }
    return this.lspMount.status()
  }

  /**
   * Read one session's Harness file-sandbox policy.
   *
   * The plugin owns no sandbox state: the Harness `sandboxPolicy` service and
   * the session's last `sandbox/mode` event are the single source of truth. This
   * Remote exists because the stock client has no surface for it, and a
   * FreeCodeGo session that lands in `read-only` otherwise reports every failed
   * write as a generic tool error instead of an explicable policy denial.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the sandbox Status.
   */
  @Remote('sandboxModeStatus')
  async sandboxModeStatus(sessionId: string): Promise<FreeCodeGoSandboxStatus> {
    const id = validateSandboxSessionId(sessionId)
    const policy = this.sandboxPolicy()
    if (policy === undefined) throw new Error('the Harness sandbox policy service is not mounted in this composition')
    const session = this.sessionFor(id)
    const workspaceRoot = this.sessionWorkspaceRoot(id)
    if (session === undefined) {
      // A closed or restored session keeps its durable choice; report it as the
      // effective mode rather than pretending the deployment default applies.
      const logged = this.loggedSandboxMode(id)
      const mode = logged ?? policy.defaultMode
      return {
        sessionId: id, mode, defaultMode: policy.defaultMode, live: false,
        ...(logged === undefined ? {} : { override: logged }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      }
    }
    const override = policy.overrideOf(session)
    return {
      sessionId: id,
      mode: override ?? policy.defaultMode,
      defaultMode: policy.defaultMode,
      live: true,
      ...(override === undefined ? {} : { override }),
      ...(policy.resolve({ session }).workspaceRoot === undefined ? {} : { workspaceRoot: policy.resolve({ session }).workspaceRoot }),
    }
  }

  /**
   * Switch one session's Harness file-sandbox mode.
   *
   * The write path is deliberately the Harness service, not plugin state: it
   * appends exactly one `sandbox/mode` event, so the choice is durable, replay
   * safe, and scoped to this session. `danger-full-access` is reachable here
   * because a user explicitly asking for it is the intended flow; the model has
   * no path to this Remote.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the sandbox Status.
   * @param mode - the Harness sandbox mode to apply to this session.
   */
  @Remote('sandboxModeSet')
  async sandboxModeSet(sessionId: string, mode: string): Promise<FreeCodeGoSandboxStatus> {
    const id = validateSandboxSessionId(sessionId)
    if (!SANDBOX_MODES.includes(mode as FreeCodeGoSandboxMode)) {
      throw new Error(`sandbox mode must be one of ${SANDBOX_MODES.join(', ')}`)
    }
    const policy = this.sandboxPolicy()
    if (policy === undefined) throw new Error('the Harness sandbox policy service is not mounted in this composition')
    const session = this.sessionFor(id)
    if (session === undefined) throw new Error(`session "${id}" is not live; a sandbox mode can only be switched on an open session`)
    setSandboxMode(session, mode as FreeCodeGoSandboxMode)
    return await this.sandboxModeStatus(id)
  }

  /**
   * Report the folder-trust gate: the master switch, the record, and the
   * decision for one directory when the caller names one.
   *
   * The status carries the record's path on purpose. The record lives outside
   * the workspace so a repository cannot grant itself, which means it is also
   * not discoverable by looking in the workspace — so the only way it stays
   * auditable is if the surface that reports trust also reports where the truth
   * is written.
   * A caller that names no directory is asking about the workspace this Host is
   * running in — the same `process.cwd()` every other workspace-scoped reader
   * uses — because that is the question a settings panel is asking. Answering with
   * the record alone would report "what has ever been granted" and leave the panel
   * with no root to revoke, which is a different screen and not a useful one.
   * @param directory - an absolute directory to resolve, or absent for this Host's workspace.
   * @returns the trust Status.
   */
  @Remote('trustFolderStatus')
  async trustFolderStatus(directory?: string): Promise<FreeCodeGoTrustStatus> {
    const resolution = await this.resolveTrust(directory ?? process.cwd())
    return {
      enabled: resolution.enabled,
      recordPath: defaultTrustRecordPath(),
      entries: resolution.record.entries.map(entry => ({ root: entry.root, grantedAt: entry.grantedAt })),
      ...(resolution.root === undefined ? {} : { currentRoot: resolution.root }),
      ...(resolution.decision === undefined ? {} : { current: resolution.decision }),
    }
  }

  /**
   * Grant trust for the repository containing one directory.
   *
   * The unit is the repository root rather than the directory: the caller names
   * where it is working, and the gate decides what that implies. Outside any
   * repository there is nothing to grant, and this fails loudly instead of
   * recording an entry no consumer would ever match.
   * @param directory - an absolute directory inside the repository to trust.
   * @returns the trust Status.
   */
  @Remote('trustFolderGrant')
  async trustFolderGrant(directory: string): Promise<FreeCodeGoTrustStatus> {
    const root = await repositoryRoot(directory)
    if (root === undefined) throw new Error(`"${directory}" is not inside a git repository, so there is no repository to trust`)
    await this.folderTrust.grant(root)
    // The hook documents are cached for a few seconds per workspace, and the cached
    // list is the *gated* one. A grant that did not clear it would leave the
    // project's hooks unloaded for up to that window while the panel already says
    // "granted" — a state the user reads as "trust did nothing".
    this.hookDocuments.clear()
    const knownWorkspaces = [...this.projectConfigReports.keys()]
    // The project report carries the gate's answer, so a cached one would keep
    // reporting `not-a-repository` for the same window the comment above is
    // about — the panel would say the grant did nothing.
    this.projectConfigReports.clear()
    this.projectCommandPolicies.clear()
    this.projectTierReads.clear()
    // Re-read every workspace this process has already asked about, so the
    // repository's own command policy is live before the next tool call rather
    // than whenever something happens to ask again.
    await this.refreshProjectTiers([directory], knownWorkspaces)
    await this.capabilities.remount()
    return await this.trustFolderStatus(directory)
  }

  /**
   * Withdraw trust for the repository containing one directory.
   *
   * Takes effect on the next mount pass rather than lazily: the granted
   * surfaces are already live, and a revoke that only applied to the next
   * settings change would leave a project's MCP servers running after the user
   * said no.
   * @param directory - an absolute directory inside the repository to distrust.
   * @returns the trust Status.
   */
  @Remote('trustFolderRevoke')
  async trustFolderRevoke(directory: string): Promise<FreeCodeGoTrustStatus> {
    const root = await repositoryRoot(directory)
    if (root === undefined) throw new Error(`"${directory}" is not inside a git repository, so there is no repository to distrust`)
    await this.folderTrust.revoke(root)
    // And a revoke has to clear it for the opposite reason: the cached documents
    // are the ones already trusted at the moment of the read, so without this the
    // repository's hooks would keep running for the length of the cache window
    // after the user withdrew trust — the plan's "a revoke takes effect at once",
    // broken by a cache rather than by a decision.
    this.hookDocuments.clear()
    const knownWorkspaces = [...this.projectConfigReports.keys()]
    // Same reason as the revoke's hook cache, one step further: a report cached
    // across the withdrawal would still list the repository's accepted keys and
    // still claim the gate admits them, which is the surface telling the user the
    // opposite of what the process will do.
    this.projectConfigReports.clear()
    // And the compiled project policy goes with it, for the strongest version of
    // the same argument: `permissionRules` from a repository the user just
    // distrusted must stop denying (or being reported as) commands at once. The
    // refresh below re-reads every known workspace, finds the gate refusing, and
    // leaves no policy behind.
    this.projectCommandPolicies.clear()
    this.projectTierReads.clear()
    await this.refreshProjectTiers([directory], knownWorkspaces)
    await this.capabilities.remount()
    return await this.trustFolderStatus(directory)
  }

  /**
   * Re-read the project tier for every workspace already asked about.
   *
   * Exists for the trust transitions, where the *input to the gate* moved and
   * nothing in a settings document did: a grant must make a repository's rules
   * live and a revoke must make them stop, and both must happen for the
   * workspaces this process is actually using rather than for one directory the
   * caller happens to name.
   *
   * @param extra - additional directories to read, typically the one just changed.
   */
  private async refreshProjectTiers(extra: readonly string[], known: readonly string[] = [...this.projectConfigReports.keys()]): Promise<void> {
    // `known` is passed in rather than read here: both callers have just cleared
    // the report cache, so the keys this method needs are the ones that were in
    // it a moment ago, and re-reading the map at this point returns nothing.
    const keys = new Set<string>([...known, process.cwd(), ...extra])
    await Promise.all([...keys].map(async (key) => {
      await this.projectTierFor(key).catch(() => undefined)
    }))
  }

  /**
   * Whether repository-supplied content under `directory` may be mounted.
   *
   * The one question every project-scoped consumer asks. Answering it in one
   * place is the whole point of the gate: three surfaces that each decided for
   * themselves would eventually disagree about the same checkout.
   * @param directory - an absolute directory holding repository-supplied content.
   * @returns the decision and the canonical root it was made against.
   */
  async projectScopeTrust(directory: string): Promise<{ readonly trusted: boolean; readonly reason: FreeCodeGoTrustReason }> {
    const resolution = await this.resolveTrust(directory)
    return resolution.decision ?? { trusted: false, reason: 'not-a-repository' }
  }

  /**
   * The project tier of configuration for a workspace, as the settings surface
   * reports it.
   *
   * `project-config.ts` was written for exactly this caller and never had one:
   * the module parses and whitelists a repository's own `.freecodego/config.json`,
   * and its header names the settings surface as the consumer of the contract.
   * Nothing opened the file, so a repository could write the tier's four keys and
   * have them read by no one — and a key *outside* the whitelist was dropped with
   * no way to tell its author why, which the module's own doc calls out as the
   * failure that makes a whole tier look broken.
   *
   * The gate is asked before the file is opened, and through
   * {@link projectScopeTrust} rather than a second reading of the trust record:
   * that method is the one answer every project-scoped consumer asks, so a
   * surface that resolved trust for itself would eventually disagree with
   * `admit()` about the same checkout.
   * @param workspaceRoot - the workspace to report on; the process directory by default.
   * @returns the accepted keys, the ignored names, the gate's answer, and any note.
   */
  @Remote('projectConfigReport')
  async projectConfigReport(workspaceRoot?: string): Promise<ProjectConfigReport> {
    const key = workspaceRoot ?? process.cwd()
    const cached = this.projectConfigReports.get(key)
    if (cached !== undefined && Date.now() - cached.at < PROJECT_CONFIG_TTL_MS) return cached.report
    const trust = await this.projectScopeTrust(key)
    const result = await loadProjectConfig({
      root: key,
      trusted: { trusted: trust.trusted, reason: trust.reason },
      read: async (target) => {
        try {
          return await readFile(target, 'utf8')
        } catch {
          return undefined
        }
      },
    })
    const report: ProjectConfigReport = {
      workspaceRoot: key,
      trusted: trust.trusted,
      trustReason: trust.reason,
      path: PROJECT_CONFIG_RELATIVE_PATH,
      whitelist: PROJECT_CONFIG_WHITELIST,
      ...result,
    }
    this.projectConfigReports.set(key, { report, at: Date.now() })
    return report
  }

  /**
   * The project tier as *entries*, for the surfaces that mount it.
   *
   * Derived from {@link projectConfigReport} rather than read again: one file,
   * one trust decision, one cache, and therefore one answer to "what does this
   * repository declare" — the settings surface and the mounting surfaces cannot
   * show different versions of the same file. An untrusted repository reports no
   * accepted keys, so this is empty for it without a second gate here.
   *
   * The compiled `permissionRules` are filed in {@link projectCommandPolicies} as
   * a side effect, because that map is the only thing a synchronous guard can
   * read; a workspace whose rules were dropped leaves no entry rather than a
   * stale policy.
   *
   * @param workspaceRoot - the repository to read; the process directory by default.
   * @returns the mountable entries, the compiled project policy, and the notes.
   */
  private async projectTierFor(workspaceRoot?: string): Promise<ProjectTier> {
    const key = workspaceRoot ?? process.cwd()
    const report = await this.projectConfigReport(key).catch(() => undefined)
    this.projectTierReads.add(key)
    if (report === undefined) {
      // A read that failed is not a repository that declares nothing. Deleting the
      // compiled policy here used to take a repository's own denials out of force
      // for the rest of the session on one transient failure — and the guard cannot
      // tell that state from "this workspace declared no rules". The rules already
      // compiled therefore stay in force, and the failure is named instead of
      // swallowed by the caller's `.catch(() => undefined)`.
      this.ctx.logger?.warn?.(`freecodego: ${PROJECT_CONFIG_RELATIVE_PATH} could not be read for ${key}; keeping the project command rules already compiled for it and retrying at the next session start`)
      return projectTierFrom({ accepted: {}, ignored: [], note: 'project tier unavailable' }, key)
    }
    const tier = projectTierFrom(report, key)
    if (tier.policy === undefined) this.projectCommandPolicies.delete(key)
    else this.projectCommandPolicies.set(key, tier.policy)
    // Reported rather than dropped quietly: `ignored` already names the *keys* a
    // repository may not use, and this is the other half — an accepted key whose
    // entry was unusable, which otherwise looks exactly like a typo in a field
    // name from the author's side.
    if (tier.notes.length > 0) {
      this.ctx.logger?.warn?.(`freecodego: ${PROJECT_CONFIG_RELATIVE_PATH} was read for ${key} but some declarations were set aside: ${tier.notes.join('; ')}`)
    }
    return tier
  }

  /**
   * The project command policy for one call's workspace, or none.
   *
   * Synchronous by contract: it is called from the tool guards, which run on the
   * pre-execute path. A terse `Map` lookup is the whole body, and the fallback to
   * the process directory is what makes a guard whose Agent has no recorded cwd
   * behave like every other project-scoped surface in this plugin.
   *
   * @param agent - the Agent the guarded call belongs to, when there is one.
   * @returns the repository's compiled policy, or `undefined` when it declared none.
   */
  private projectPolicyForAgent(agent: unknown): CompiledCommandPolicy | undefined {
    const cwd = (agent as { readonly session?: { readonly header?: { readonly cwd?: unknown } } } | undefined)?.session?.header?.cwd
    const key = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
    const compiled = this.projectCommandPolicies.get(key)
    if (compiled !== undefined) return compiled
    // Nothing was compiled for this workspace: either it declares no rules, or no
    // read has been asked for it. The two look identical from here, so the read is
    // requested once and the *next* call sees the answer — the first call after a
    // cold workspace still runs on the built-in policy, which is why the read is
    // fired at session start and why this stays asynchronous: resolving trust is
    // asynchronous, so there is no synchronous answer to give here.
    if (!this.projectTierReads.has(key)) {
      this.projectTierReads.add(key)
      void this.projectTierFor(key).catch(() => undefined)
    }
    return undefined
  }

  /**
   * One trust resolution: the canonical root, the loaded record, and the
   * enabled switch, all sampled together so the answer cannot mix generations.
   */
  private async resolveTrust(directory: string | undefined): Promise<{
    readonly enabled: boolean
    readonly record: FreeCodeGoTrustRecord
    readonly root: string | undefined
    readonly decision: FreeCodeGoTrustDecision | undefined
  }> {
    const enabled = folderTrustEnabled(this.policy.get())
    const record = await this.folderTrust.read()
    if (directory === undefined) return { enabled, record, root: undefined, decision: undefined }
    const root = await repositoryRoot(directory)
    return { enabled, record, root, decision: resolveFolderTrust({ repoRoot: root, record, enabled }) }
  }

  /**
   * Revalidate the session after a clock jump that looks like a suspend.
   *
   * Deliberately quiet and idempotent, because the detection is a *suspicion*: a
   * user who changed their system clock is indistinguishable from a machine that
   * slept, and the response — one rotation — is what a healthy session does for
   * free. An unremembered or signed-out session is left alone, and a failure is
   * swallowed rather than surfaced: nothing the user asked for is waiting on it,
   * and `refresh()` keeps the vault unless the gateway definitively rejected the
   * credential.
   * @param evidence - the drift that triggered the suspicion, logged so the cause is
   *   never guessed at from the effect.
   */
  private revalidateSessionAfterSuspend(evidence: SuspendEvidence): void {
    const account = this.account
    if (account === undefined) return
    this.ctx.logger.info(`freecodego: suspected suspend (wall clock advanced ${String(evidence.wallMs)}ms while the monotonic clock advanced ${String(evidence.monoMs)}ms); revalidating the session`)
    void account.hasStoredSession()
      .then(present => (present ? account.refresh().catch(() => undefined) : undefined))
      .catch(() => undefined)
  }

  /**
   * The sandbox profile's deny globs in force.
   *
   * Normalized on every read rather than cached: the settings document is replaced
   * wholesale on a commit, so a cache would have to be invalidated on a signal this
   * class does not currently observe — and normalization is a handful of string
   * operations against a list that is empty for almost every install.
   */
  private denyPatterns(): readonly string[] {
    return normalizeDenyPatterns(this.policy.get()?.sandboxDenyPatterns ?? [])
  }

  /** The Harness sandbox-policy service, when the composition mounts it. */
  private sandboxPolicy(): SandboxPolicyLike | undefined {
    return this.ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
  }

  /** The live session object for an id, or undefined once it has closed. */
  private sessionFor(id: string): Session | undefined {
    const sessions = this.ctx.get('sessions') as { get?: (sessionId: string) => Session | undefined } | undefined
    return sessions?.get?.(id)
  }

  /** Durable last logged sandbox mode for a session that is no longer live. */
  private loggedSandboxMode(id: string): FreeCodeGoSandboxMode | undefined {
    const sessions = this.ctx.get('sessions') as { get?: (sessionId: string) => { snapshotEvents?: () => readonly { readonly type: string; readonly data: Record<string, unknown> }[]; events?: readonly { readonly type: string; readonly data: Record<string, unknown> }[] } | undefined } | undefined
    const events = sessions?.get?.(id)?.snapshotEvents?.() ?? sessions?.get?.(id)?.events
    const mode = events?.findLast(event => event.type === 'sandbox/mode')?.data.mode
    return SANDBOX_MODES.includes(mode as FreeCodeGoSandboxMode) ? mode as FreeCodeGoSandboxMode : undefined
  }

  /** Workspace root for a session id, read from its durable header when possible. */
  private sessionWorkspaceRoot(id: string): string | undefined {
    const sessions = this.ctx.get('sessions') as { get?: (sessionId: string) => { header?: { cwd?: string } } | undefined } | undefined
    const cwd = sessions?.get?.(id)?.header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
  }

  /**
   * The captured observations one consolidation pass may read.
   *
   * Read through the registry's public list/get pair rather than from the store
   * directly: the pass curates what the store already holds, and reaching into
   * the store's internals would let the curated layer disagree with the review
   * surface about what a `captured` record is. The digest covers title and body
   * together, so a record rewritten between two passes is a different
   * observation — which is what `MemoryObservation.sha256` is for.
   */
  private memoryObservationsFor(cwd: string): readonly MemoryObservation[] {
    if (this.policy.get()?.engineeringMemoryEnabled !== true) return []
    const listed = this.engineering.memoryList(cwd, { trusts: ['captured'], limit: 100 })
    if (listed.records.length === 0) return []
    const details = this.engineering.memoryGetForReview(cwd, listed.records.map(record => record.id))
    return details.map(detail => ({
      id: detail.id,
      sha256: createHash('sha256').update(`${detail.title}\u0000${detail.body}`).digest('hex'),
      capturedAt: detail.createdAt,
      text: `${detail.title}\n${detail.body}`,
    }))
  }

  /**
   * The topic slugs already curated for one workspace.
   *
   * A missing directory is an empty list, not a failure: the first pass for a
   * workspace has no topics and must still be able to run. Only the two codes
   * that mean "there is no directory here" are absorbed — a permission error is
   * raised, because reporting it as "no topics" would make the pass plan against
   * an empty archive and overwrite nothing.
   */
  private memoryTopicSlugsFor(cwd: string): readonly string[] {
    const directory = path.join(memoryPipelineHome(cwd), MEMORY_TOPICS_DIRECTORY)
    try {
      return readdirSync(directory).filter(name => name.endsWith('.md')).map(name => name.slice(0, -'.md'.length)).sort()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }
  }

  /**
   * Coalesce consolidation for one workspace behind a quiet period.
   *
   * One timer per workspace, reset on each turn: a session that stops and starts
   * repeatedly inside the window runs one pass rather than one per turn. The timer
   * is unref'd so a pending pass cannot hold the process open, and the map entry
   * is cleared before the run so a turn arriving *during* a pass schedules the
   * next one instead of being swallowed by a stale handle.
   */
  private scheduleMemoryConsolidation(cwd: string, sessionId: string): void {
    const pending = this.memoryConsolidations.get(cwd)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.memoryConsolidations.delete(cwd)
      void this.runMemoryConsolidation(cwd, sessionId)
    }, MEMORY_CONSOLIDATION_DEBOUNCE_MS)
    timer.unref?.()
    this.memoryConsolidations.set(cwd, timer)
  }

  /**
   * Run one consolidation pass, and never reject.
   *
   * The pass is a background aid, so a failed consolidation must not surface as a
   * turn failure. The pipeline already records every outcome as a `memory.dream`
   * telemetry record; the log line here adds the *reason* a `failed` outcome
   * carries, because the schema deliberately has no free-text field for it. The
   * catch is for the unexpected — a port that threw outside the pass's own
   * try — and it logs rather than swallowing, since a silent one would leave a
   * deployment believing consolidation is running when it is not.
   */
  private async runMemoryConsolidation(cwd: string, sessionId: string | undefined): Promise<void> {
    try {
      const outcome = await this.memoryPipeline.consolidate(sessionId === undefined ? { cwd } : { cwd, sessionId })
      // A caveat on a `completed` pass is reported exactly like a failure's
      // reason, because both are the pass saying something its outcome does not:
      // `planProblem` writes the first kind, the takeover of a crashed pass's
      // lease writes the second, and this line used to read only the `failed`
      // half — so the sentence that exists to end a silent drop was itself
      // dropped one frame after it was written.
      const caveat = memoryConsolidationCaveat(outcome)
      if (caveat !== undefined) {
        const line = `freecodego: memory consolidation for ${cwd} ${caveat}`
        if (outcome.outcome === 'failed') this.ctx.logger?.warn?.(line)
        else this.ctx.logger?.info?.(line)
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`freecodego: memory consolidation could not run for ${cwd}: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`)
    }
  }

  /**
   * Test seam: run one consolidation pass directly, without the debounce timer.
   *
   * The timer exists to bound cost, not to change behaviour, so a test that
   * wanted to observe a pass would otherwise have to wait out the debounce.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the memory Consolidation.
   * @param cwd - the workspace the consolidation pass runs against.
   */
  async consolidateMemoryForTest(cwd: string, sessionId?: string): Promise<MemoryConsolidation> {
    return await this.memoryPipeline.consolidate(sessionId === undefined ? { cwd } : { cwd, sessionId })
  }

  /** All guard/quality toggles in one snapshot for the settings UI. 
   * @returns the guard Settings Status.
   */
  @Remote('guardSettingsStatus')
  async guardSettingsStatus(): Promise<FreeCodeGoGuardSettingsStatus> {
    const settings = this.policy.get()
    const lsp = this.lspMount === undefined ? undefined : await this.lspMount.status().catch(() => undefined)
    return {
      envReadGuardEnabled: settings?.envReadGuardEnabled !== false,
      doomLoopGuardEnabled: settings?.doomLoopGuardEnabled !== false,
      lspEnabled: settings?.lspEnabled !== false,
      rehydrationEnabled: settings?.rehydrationEnabled !== false,
      rehydrationArcEnabled: settings?.rehydrationArcEnabled === true,
      advisorMemoryDraftsEnabled: settings?.advisorMemoryDraftsEnabled !== false,
      commandPolicyEnabled: settings?.commandPolicyEnabled !== false,
      planModeEnabled: settings?.planModeEnabled !== false,
      contextBudgetEnabled: settings?.contextBudgetEnabled !== false,
      cacheColdClearEnabled: settings?.cacheColdClearEnabled !== false,
      cacheBreakAttributionEnabled: settings?.cacheBreakAttributionEnabled !== false,
      assistantLoopGuardEnabled: settings?.assistantLoopGuardEnabled !== false,
      promptCompositionEnabled: settings?.promptCompositionEnabled !== false,
      ...(lsp === undefined ? {} : { lsp }),
    }
  }

  /**
   * The upstream plan-mode authority, when the composition mounted one.
   *
   * Resolved per call rather than cached: `ctx.get` is a map lookup, and a cache
   * would have to be invalidated when a realm loads or unloads the service — a
   * stale hit would answer with the wrong authority, which is worse than the
   * lookup.
   */
  private upstreamPlanMode(): UpstreamPlanMode | undefined {
    return findUpstreamPlanMode(this.ctx)
  }

  /**
   * The Host tool registry, narrowed to the members every registration here uses.
   *
   * `ctx.tools` is typed against the Host's own `ToolDefinition`, while these call
   * sites build definitions from their local literal shapes (checked at compile
   * time by `tool-definition.ts`), so the registry has to be narrowed — and it was
   * narrowed ten times over, character for character. One accessor keeps the next
   * Harness change to `register` a single edit, and keeps the one `schemas`
   * consumer honest about the seam being optional.
   */
  private toolRegistry(): {
    register(tool: ToolDefinitionShape): (() => void) | { dispose?: () => void }
    schemas?(): readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown }[]
  } | undefined {
    return (this.ctx as unknown as { get(name: string): unknown }).get('tools') as {
      register(tool: ToolDefinitionShape): (() => void) | { dispose?: () => void }
      schemas?(): readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown }[]
    } | undefined
  }

  /**
   * Whether the Harness's own reviewer owns this action's approval.
   *
   * True only while the session's permission preset is the Harness's Auto
   * preset. Read live from `ctx.permissionPresets` rather than tracked locally,
   * because the user can switch presets mid-conversation and a cached answer
   * would leave this reviewer answering — or standing down — for a preset the
   * session no longer has.
   *
   * A missing service, a missing session, or a `current` that throws all answer
   * `false`, which is the conservative direction here: this listener then
   * behaves exactly as it did before the predicate existed, delegating to the
   * user's prompt whenever it cannot read an action.
   */
  private harnessOwnsApproval(agent: unknown): boolean {
    const presets = (this.ctx as unknown as { get(name: string): unknown }).get('permissionPresets') as { current(session: unknown): unknown } | undefined
    if (typeof presets?.current !== 'function') return false
    const session = (agent as { readonly session?: unknown } | undefined)?.session
    if (session === undefined) return false
    try { return presets.current(session) === HARNESS_AUTO_PRESET } catch { return false }
  }

  /**
   * The mode for one call, for the synchronous guard.
   *
   * Upstream first and the durable store second. Deliberately *not* "either" or a
   * union: two authorities that can disagree are the bug being fixed, so there is
   * one answer and a fallback, never a merge.
   */
  private planModeModeFor(agent: unknown): PlanMode | undefined {
    const upstream = this.upstreamPlanMode()
    if (upstream !== undefined) {
      try { return upstream.get(agent).active ? 'plan' : 'execute' } catch { /* fall through to the store */ }
    }
    return this.planModeStore.peek(planModeSessionKey(agent as { readonly id?: unknown } | undefined))
  }

  /**
   * The lineage chain one tool call belongs to, for the doom-loop guard.
   *
   * A loop distributed over a parent and its subagents is invisible to a
   * per-agent counter — each agent sees one call — so the chain is keyed on the
   * root of the session tree instead. The walk climbs `parentSession` links and
   * is bounded, which turns a cycle in a regenerated session tree into a stop
   * rather than a hang, and a depth past the bound into the deepest ancestor
   * the bound reached.
   *
   * An agent whose tree is unknown answers with its own id, which is exactly the
   * per-agent chain the guard had before this axis existed.
   */
  private lineageKeyOf(exec: Readonly<{ readonly agent?: unknown; readonly name: string }>): string {
    const agent = exec.agent as { readonly id?: string } | undefined
    const own = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : '*'
    let key = own
    for (let hops = 0; hops < 32; hops += 1) {
      const parent = this.sessionParents.get(key)
      if (parent === undefined || parent === '' || parent === key) break
      key = parent
    }
    return key
  }

  /** Read the conversation's mode through the same single authority the guard uses. */
  private async readPlanMode(agent: PlanModeAgent): Promise<PlanMode> {
    const upstream = this.upstreamPlanMode()
    if (upstream !== undefined) {
      try { return upstream.get(agent).active ? 'plan' : 'execute' } catch { /* fall through to the store */ }
    }
    return this.planModeStore.read(planModeSessionKey(agent))
  }

  /**
   * Transition the conversation's mode through upstream when it is composed.
   *
   * Upstream's `set` is the method that keeps everything else in step — the
   * `plan/mode` log entry, the `plan` projection the client carrier reads, the
   * `plan:policy` section, and `/plan`. Writing the plugin's own file instead
   * would move the mode for this plugin only, leaving the model told one thing by
   * `plan:policy` and refused another by the guard.
   */
  private async applyPlanMode(agent: PlanModeAgent, active: boolean): Promise<PlanMode> {
    const upstream = this.upstreamPlanMode()
    if (upstream !== undefined) {
      try { upstream.set(agent, active); return active ? 'plan' : 'execute' } catch (error) {
        // The fallback below still moves the mode, but it moves it in the *other*
        // authority — and the fence reads upstream, so a failure here produces
        // exactly the two-authority disagreement this method exists to prevent.
        // Continuing is the design; continuing *invisibly* would leave the model
        // told one mode by `plan:policy` and refused another by the guard.
        this.ctx.logger.warn(`freecodego: the harness plan-mode write failed, so the plugin's own record is being used instead and the enforcement fence may disagree: ${redactCredentialShapes(String(error))}`)
      }
    }
    return (await this.planModeStore.write(planModeSessionKey(agent), active ? 'plan' : 'execute')).mode
  }

  /**
   * The plan under review, for a client that cannot call a tool.
   *
   * Read from the file on every call rather than from an in-memory copy: the plan
   * is edited by the plugin's own tool and by the user's remarks, so a cached copy
   * would be a review of something the user is no longer looking at. An absent plan
   * still produces a reviewable surface, with the reason — a client that renders
   * nothing would leave plan mode active with no visible action.
   *
   * @param sessionId - the session whose plan is being reviewed.
   * @returns the surface: numbered lines, the section warnings, and whether there
   *   is a plan at all.
   */
  @Remote('planReviewOpen')
  async planReviewOpen(sessionId: string): Promise<FreeCodeGoPlanReviewSurface> {
    const key = validateSandboxSessionId(sessionId)
    const text = await this.planFileStore.read(key)
    const surface = planReviewSurface(text)
    const sections = inspectPlanSections(text)
    return {
      empty: surface.empty,
      body: surface.body,
      lineCount: surface.lineCount,
      path: planFilePath(key),
      missingSections: [...sections.missing],
      emptySections: [...sections.blank],
      warnings: sections.warnings,
    }
  }

  /**
   * Turn line-level remarks into the message that asks for a revision.
   *
   * The composition lives in `plan/plan-review.ts` and is shared with the tool
   * path, so a remark cannot mean one thing in the UI and another in a tool call.
   * An unusable submission is refused rather than partially applied: a dropped
   * remark is one the user believes they sent.
   * @param request - the remarks, plus optional overall notes.
   * @returns the message, or the reason nothing was composed.
   */
  @Remote('planReviewCompose')
  planReviewCompose(request: FreeCodeGoPlanReviewRequest): { readonly message?: string; readonly rejected?: string } {
    const key = validateSandboxSessionId(request.sessionId)
    return composePlanReworkMessage({
      planPath: planFilePath(key),
      comments: request.comments ?? [],
      ...(request.notes === undefined ? {} : { notes: request.notes }),
    })
  }

  /**
   * The plan rules to restate after a compaction, or nothing when the mode is off.
   *
   * The mode is read from the same projection everything else reads, so this
   * cannot disagree with the fence: if the fence is in force, the reminder says
   * so, and if the mode ended there is nothing to restate. The existing plan text
   * is named rather than repeated — repeating it would put a copy of the plan in
   * the model's context that no longer matches the file it was copied from.
   * @param session - the session that was just compacted.
   * @returns the reminder text, or undefined when it does not apply.
   */
  private async planModeCompactionReminder(session: { readonly id?: unknown }): Promise<string | undefined> {
    try {
      const agent = { id: session.id ?? undefined } as PlanModeAgent
      const key = planModeSessionKey(agent)
      const upstream = this.upstreamPlanMode()
      // Upstream first, because it is the authority the fence reads — asking the
      // local store first would let this reminder contradict the enforcement that
      // is actually in force. The store is the fallback for a composition that
      // mounted no upstream plan mode, where the plugin's own record is the only
      // one that exists.
      let active: boolean | undefined
      if (upstream !== undefined) {
        try {
          active = upstream.get(agent).active
        } catch {
          active = undefined
        }
      }
      if (active === undefined) active = await this.planModeStore.read(key) === 'plan'
      if (!active) return undefined
      return [
        '<freecodego-plan-mode>',
        'Plan Mode is still active for this conversation, and the compaction above may have dropped the rules that were injected with it.',
        PLAN_MODE_GUIDANCE,
        `The plan document is ${planFilePath(key)}. Use engineering_plan_mode with action "write" to replace it and action "status" to confirm the mode.`,
        '</freecodego-plan-mode>',
      ].join('\n')
    } catch {
      return undefined
    }
  }

  /**
   * Register Plan Mode as one tool with three actions.
   *
   * The mode is a property of the conversation, so `status` is what a user or a
   * supervisor reads, and `enter`/`exit` are the only two transitions. Entering
   * injects the mode rules, exiting retracts them, and both go through the
   * fragment log so a repeated enter costs nothing and an exit cannot leave the
   * rules live in the model's context.
   *
   * This tool is the *programmatic* path onto the one mode the Harness owns — for
   * a supervisor, a teammate, or the model itself. The user-facing path stays
   * upstream's `/plan` and `exit_plan_mode`, which is what the client carrier and
   * the tool catalog already expose.
   */
  private registerPlanModeTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    const enabled = (): boolean => this.policy.get()?.planModeEnabled !== false
    try {
      const dispose = tools.register({
        name: 'engineering_plan_mode',
        description: 'Enter, leave, read, or write Plan Mode\'s plan document for this conversation. The mode is the Harness\'s own plan mode when this deployment composes it, so this tool moves the same state `/plan` and `exit_plan_mode` move. What it adds is enforcement: tools that change files are refused and shell commands the command policy does not clear are refused, so the mode cannot be broken by an imperative sentence; reading, searching, and running checks stay available. Action "write" replaces the plan document at the path this tool reports; the plan is written by this tool rather than by the file tools, which are refused while the mode is active. Leaving is a deliberate act: call this tool with action "exit" when the plan is decision complete and the user has agreed to implementation. Two known limits, stated because they are not enforced: a shell command that redirects output into a file is judged by the command policy rather than by the mode, and a subagent inherits this conversation\'s mode, so it is refused where its parent is.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['enter', 'exit', 'status', 'write'], description: 'Transition, read the current mode, or replace the plan document.' },
            reason: { type: 'string', description: 'Why the mode is being entered, recorded with the state.' },
            plan: { type: 'string', description: 'Action "write": the complete plan document. Replaces what is there; there is no append, because a plan that grew by paraphrase is not a plan anyone reviewed.' },
          },
          required: ['action'],
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (args: { readonly action?: string; readonly reason?: string; readonly plan?: string }, exec: { readonly agent?: unknown }) => {
          const agent = exec?.agent as PlanModeAgent | undefined
          if (agent === undefined) return { error: 'Plan Mode needs an active agent' }
          const upstream = this.upstreamPlanMode() !== undefined
          if (args?.action === 'write') {
            const key = planModeSessionKey(agent)
            if (typeof args.plan !== 'string' || args.plan.trim() === '') {
              return { error: 'a plan document is required; pass the complete text, since there is no append' }
            }
            try {
              const path = await this.planFileStore.write(key, args.plan)
              const sections = inspectPlanSections(args.plan)
              return {
                mode: await this.readPlanMode(agent),
                path,
                lines: args.plan.split('\n').length,
                missingSections: [...sections.missing],
                emptySections: [...sections.blank],
                // A warning, never a refusal: a one-line plan is a good plan, and
                // refusing it would teach the model to pad the headings instead of
                // deciding anything.
                warnings: sections.warnings,
              }
            } catch (error) {
              return { error: `the plan could not be written: ${error instanceof Error ? error.message : String(error)}` }
            }
          }
          if (!enabled()) {
            return {
              mode: await this.readPlanMode(agent),
              enforced: false,
              authority: upstream ? 'harness' : 'plugin',
              note: 'The FreeCodeGo enforcement layer is off in settings, so no call is refused for Plan Mode. The mode itself is still the Harness\'s, and `/plan` and `exit_plan_mode` keep working.',
            }
          }
          const action = args?.action ?? 'status'
          if (action === 'enter' || action === 'exit') {
            const mode = await this.applyPlanMode(agent, action === 'enter')
            this.injectPlanModeGuidance(agent, mode)
            return mode === 'plan'
              ? { mode, enforced: true, authority: upstream ? 'harness' : 'plugin', guidance: planModeGuidanceText(upstream), reason: args?.reason ?? '' }
              : { mode, enforced: false, authority: upstream ? 'harness' : 'plugin', note: 'Plan Mode ended; file-mutating tools are available again. Only leave the mode when the user has agreed to implementation.' }
          }
          const mode = await this.readPlanMode(agent)
          return { mode, enforced: mode === 'plan', authority: upstream ? 'harness' : 'plugin', guidance: planModeGuidanceText(upstream) }
        },
        presentCall: (args: { readonly action?: string }) => ({ card: 'generic', title: `Plan mode: ${args?.action ?? 'status'}` }),
      })
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: plan mode tool')
    } catch (error) {
      // A registration failure must not take the plugin down; the guard still
      // enforces the mode from durable state, only the transition tool is absent.
      // *That absence* is the part worth saying out loud: a model that is never
      // offered `engineering_plan_mode` has no programmatic way into the mode, and
      // nothing else in the composition reports it.
      this.ctx.logger.warn(`freecodego: engineering_plan_mode was not registered, so Plan Mode can only be entered through /plan or the harness's own exit_plan_mode: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * The collectors, wired to this plugin's own objects.
   *
   * Every reader here already exists: trust resolution, the capability
   * registry's snapshot, the sandbox profile in force, the engine status
   * objects. The inspect surface adds no second way to ask any of those
   * questions — which is the only thing that keeps `inspect` and `doctor` from
   * drifting apart.
   *
   * The workspace is a parameter rather than `process.cwd()`, because the sections
   * that read project files — hooks, rules, personas — and the trust decision that
   * gates them all answer a question about one directory. Every other
   * workspace-scoped reader here takes the session's `header.cwd` and falls back to
   * the process directory, and the tool has a session to ask; reporting the Host's
   * launch directory instead would answer about a folder the user is not in, and
   * the hooks section's whole claim — "the counts here are the counts a dispatch
   * would see" — would be false whenever the two differ. The Remote and the command
   * pass nothing, which is the same fallback by name rather than a second rule.
   * @param workspaceRoot - the session's workspace, when the caller has one.
   */
  private inspectCollectors(workspaceRoot?: string): readonly InspectCollector[] {
    return buildInspectCollectors({
      workspace: () => workspaceRoot ?? process.cwd(),
      home: () => harnessHomeDirectory(),
      dataHome: () => freeCodeGoDataHome(),
      trust: async (directory) => {
        const resolved = await this.resolveTrust(directory)
        return {
          enabled: resolved.enabled,
          trusted: resolved.decision?.trusted ?? false,
          reason: resolved.decision?.reason ?? 'not-a-repository',
          ...(resolved.root === undefined ? {} : { root: resolved.root }),
        }
      },
      // The same answer the dispatcher gets, from the same method: the hooks
      // section reads the dispatcher's own discovery, so a report that decided
      // this question for itself would list a file the runtime no longer opens.
      claudeHookDialect: () => this.claudeHookDialect(),
      capabilities: async () => {
        const snapshot = await this.capabilities.snapshot()
        return {
          skills: snapshot.skills,
          mcpServers: snapshot.mcpServers,
          mcpTools: snapshot.mcpTools,
          ...(snapshot.mountErrors === undefined ? {} : { mountErrors: snapshot.mountErrors }),
          ...(snapshot.trustRefusals === undefined ? {} : { trustRefusals: snapshot.trustRefusals }),
        }
      },
      sandbox: () => {
        const policy = this.sandboxPolicy()
        const deny = this.denyPatterns()
        return {
          denyPatterns: [...deny],
          defaultMode: policy?.defaultMode ?? null,
          // The three-state enforcement answer, so "no deny patterns" is
          // distinguishable from "patterns the sandbox seam cannot express".
          enforcement: describeDenyEnforcement(deny) as unknown as JsonValue,
          guardInstalled: this.ctx.get('tools') !== undefined,
        }
      },
      engines: () => ({
        deepseek: { available: true },
        codex: this.codexRuntime.status() as unknown as JsonValue,
        claude: this.claudeRuntime.status() as unknown as JsonValue,
      }),
      readFile: async (target) => {
        try {
          return await readFile(target, 'utf8')
        } catch {
          return undefined
        }
      },
      listDir: async (target) => {
        try {
          return await readdir(target)
        } catch {
          return []
        }
      },
      // The same reader the verification tier calls, not a second `git status`:
      // the scan section exists to show what a run would cover, and it shows the
      // change set the tier already agreed on or it shows nothing useful.
      changes: async workspace => await readWorkspaceChangeScope(workspace).catch(() => undefined),
      // The trust module's own resolver, not a second `rev-parse`: it is already the
      // plugin's one answer to "what repository is this directory in", and the scan
      // section needs it to resolve the root-relative paths `changes` hands back.
      repositoryRoot,
      // A size, never a read. `isFile` is checked because a changed path can be a
      // directory (a submodule, an empty directory git reported) and a directory's
      // size is not a size a scan ceiling should be compared against.
      fileSize: async (target) => {
        try {
          const info = await stat(target)
          return info.isFile() ? info.size : undefined
        } catch {
          return undefined
        }
      },
    })
  }

  /**
   * One collection pass, shared by the tool, the command and the Remote.
   * @param now - the report's timestamp.
   * @param workspaceRoot - the session's workspace, when the caller has one.
   */
  private async buildInspectReport(now: number = Date.now(), workspaceRoot?: string): Promise<InspectReport> {
    return collectInspectReport(this.inspectCollectors(workspaceRoot), now)
  }

  /**
   * Register the unified inspect surface.
   *
   * One tool, one collection pass, every declared section. It exists because the
   * same question ("what is actually loaded?") previously required four commands,
   * and
   * because a section that could not be read has to say so rather than render as
   * empty — see `inspect/collect.ts` for the isolation rule.
   */
  /**
   * The review surface for one workspace, assembled on first use.
   *
   * Assembly is deferred rather than done at boot because it reads the
   * workspace's rule files: reading every checkout's rules during construction
   * would do filesystem work for workspaces this session never reviews, and would
   * warn about a malformed rule file for a workspace nobody asked about. A failure
   * here is a rejected promise the tool reports, not a broken plugin.
   * @param workspace - the workspace under review, as an absolute path.
   */
  private reviewInstallFor(workspace: string): Promise<ReviewInstall> {
    const existing = this.reviewInstalls.get(workspace)
    if (existing !== undefined) return existing
    const created = createReviewInstall({
      llm: this.ctx.llm,
      settings: {
        get: () => {
          const current = this.policy.get()
          return current === undefined
            ? undefined
            : { advisorProvider: current.advisorProvider, advisorModel: current.advisorModel }
        },
      },
      workspace,
      home: homedir(),
      readFile: async candidate => {
        try {
          return await readFile(candidate, 'utf8')
        } catch {
          return undefined
        }
      },
      joinPath: (left, right) => path.join(left, right),
      maxConcurrent: 1,
      escalationEnabled: () => this.policy.get()?.reviewEscalation === true,
    }).then(install => {
      // A rule file a project wrote and this plugin cannot use is the one failure
      // a user cannot see any other way: the review runs, and simply applies a
      // standard other than the one the repository asked for.
      for (const warning of install.warnings) {
        this.ctx.logger.warn(`freecodego: a review rule file could not be used — ${redactCredentialShapes(warning)}`)
      }
      return install
    })
    this.reviewInstalls.set(workspace, created)
    return created
  }

  /**
   * The deeper per-file reviewer for one tool call, or nothing when there is none.
   *
   * Three ways to answer "no": the setting is off, the call carried no session with
   * a workspace (so a child could not be opened anywhere), or the caller was not an
   * agent at all. Each falls back to the installed single-shot reviewer, which is a
   * working reviewer rather than a failure — a review that cannot be deep is still
   * worth having.
   * @param agent - the agent that made the tool call, as the tool surface typed it.
   */
  private deepReviewerFor(agent: unknown): ReviewFilePort | undefined {
    const stored = this.policy.get()
    if (stored?.reviewDeep !== true) return undefined
    const parent = agentForReviewSubagent(agent)
    if (parent === undefined) return undefined
    return createSubagentFileReviewer(parent, reviewSubagentOptions(stored))
  }

  /**
   * Register the review tools.
   *
   * Four doors over one engine: run a review, preview its coverage without a model
   * call, read what is running, and re-render the last report. Keys are resolved
   * per call from the executing session's working directory, so a review is always
   * about the workspace the caller is in. A registration failure is logged rather
   * than thrown, matching every other tool set here: the remaining tools still
   * work, and which door is missing is the observable half of the problem.
   */
  private registerReviewTools(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const disposers = reviewToolDefinitions({
        forWorkspace: workspace => this.reviewInstallFor(workspace).then(install => install.port),
        // Resolved per call rather than cached with the workspace's port: the deep
        // reviewer opens a child in the calling agent's session, and one workspace's
        // port is shared by every session in it. The setting is read here for the
        // same reason the advisor's route is — a toggle takes effect on the next
        // review instead of on the next reload.
        deepReviewer: agent => this.deepReviewerFor(agent),
      }).map(tool => tools.register(tool))
      const cleanups = disposers.map(dispose => typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() })
      this.ctx.effect(() => () => {
        for (const cleanup of cleanups) cleanup()
        this.reviewInstalls.clear()
      }, 'freecodego: review tools')
    } catch (error) {
      this.ctx.logger.warn(`freecodego: the review tools were not registered: ${redactCredentialShapes(String(error))}`)
    }
  }

  private registerInspectTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const dispose = tools.register({
        name: 'engineering_inspect',
        description: 'Report every surface this plugin has loaded: folder trust, sandbox, Skills, Hooks, rules and project instructions with token counts, personas, MCP servers and their mount state, engine availability, and which changed files a scan would cover and why the others are excluded. Use it before changing a setting, when something does not appear to be loading, when you need to know how large the injected rule surface is, or when you need to know whether a file you expected to be scanned is in the scan\'s denominator. Pass `json: true` for the raw report.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            json: { type: 'boolean', description: 'Return the report as structured JSON instead of a readable summary.' },
          },
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (
          args: { readonly json?: boolean },
          exec?: { readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } } },
        ) => {
          const cwd = exec?.agent?.session?.header?.cwd
          const report = await this.buildInspectReport(Date.now(), typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined)
          if (args?.json === true) return inspectReportToJson(report)
          return { summary: renderInspectReport(report), unavailable: report.unavailable }
        },
        presentCall: () => ({ card: 'generic', title: 'Inspect loaded surfaces' }),
      })
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: inspect tool')
    } catch (error) {
      // A registration failure must not take the plugin down; the Remote and the
      // command still answer from the same collection pass. Which of the three
      // doors is missing is the observable half — a report the model can never ask
      // for looks identical to a report that has nothing to say.
      this.ctx.logger.warn(`freecodego: engineering_inspect was not registered; the inspect Remote and /inspect still answer: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * Register `/inspect`.
   *
   * Looked up through `ctx.get` rather than declared in `static inject`, and that
   * is deliberate: a hard injection makes the whole plugin fail to load in a
   * composition that does not mount the command registry, and this is a
   * convenience door onto a report the tool already serves. A missing registry
   * means the command is absent, which is a smaller loss than the plugin being
   * absent.
   *
   * The definition and result shapes are declared structurally here for the same
   * reason: importing the commands package would add a dependency this plugin
   * does not otherwise need, and both shapes are three fields wide.
   */
  private registerInspectCommand(): void {
    const commands = this.ctx.get('commands') as { register(definition: {
      readonly definitionId?: string
      readonly name: string
      readonly description: string
      readonly input?: { readonly hint: string }
      readonly handler: (invocation: { readonly rawInput: string }) => Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>
    }): () => void } | undefined
    if (commands?.register === undefined) return
    try {
      const unregister = commands.register({
        definitionId: '@deepseek-ai/dsh-freecodego-harness-plugin/inspect',
        name: 'inspect',
        description: 'Report every surface this plugin has loaded, and how large it is',
        input: { hint: 'json' },
        handler: async (invocation) => {
          const wantsJson = invocation.rawInput.trim().toLowerCase() === 'json'
          const report = await this.buildInspectReport()
          return {
            kind: 'success',
            text: wantsJson ? JSON.stringify(inspectReportToJson(report), null, 2) : renderInspectReport(report),
          }
        },
      })
      if (typeof unregister === 'function') this.ctx.effect(() => () => { unregister() }, 'freecodego: inspect command')
    } catch (error) {
      // Same rule as the tool: a registration failure leaves the tool and the
      // Remote working rather than taking the plugin down.
      this.ctx.logger.warn(`freecodego: the /inspect command was not registered; the tool and the Remote still answer: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * The same report, for a client that cannot call a tool.
   *
   * Deliberately the same collection pass rather than a second renderer: the
   * tool, the command and this Remote must not be able to disagree about what is
   * loaded.
   * @returns the inspect Report.
   */
  @Remote('inspectReport')
  async inspectReport(): Promise<FreeCodeGoInspectReport> {
    const report = await this.buildInspectReport()
    return inspectReportToJson(report) as unknown as FreeCodeGoInspectReport
  }

  /**
   * Register the injected-surface report.
   *
   * A prompt surface is code: it reaches the model on every request and it is
   * reviewed by nobody. This tool answers two questions with numbers instead of
   * adjectives — how many bytes this plugin injects, and whether any of it moved
   * since it was last reviewed — while saying plainly that the token figure is an
   * estimate rather than a measurement.
   */
  private registerSurfaceReportTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const dispose = tools.register({
        name: 'engineering_surface_report',
        description: 'Report how much prompt surface this plugin injects (tool schemas plus guidance) and whether it changed since the reviewed lock in .freecodego/surface-lock.json. Use it after editing guidance or tool descriptions, so a prompt change is a reviewable diff instead of an invisible one.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: JSON_TOOL_OUTPUT,
        execute: async (_args: unknown, exec: { readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } } }) => {
          // `schemas` is optional on this structural seam, and a missing list is
          // not an empty one. `collectPluginSurfaces` defaults it to `[]`, so
          // reading the seam directly made an *unreadable* tool surface
          // indistinguishable from a plugin that registers no tools. The lock
          // digests one value per group, so the false alarm was not a list of
          // missing tools: it was `changed: ['tool-schemas']` — the same verdict
          // a genuine prompt edit produces, which is the one thing this tool
          // exists to tell apart. An unread surface is reported as unread, the
          // same way an unreadable workspace means no audit rather than a clean
          // one.
          const readSchemas = tools.schemas
          const toolSchemas = typeof readSchemas === 'function' ? readSchemas.call(tools) : undefined
          const surfaces = collectPluginSurfaces({
            ...(toolSchemas === undefined ? {} : { toolSchemas }),
            // Measure what this plugin actually injects. When upstream plan mode is
            // composed the injected text is the enforcement addendum, not the full
            // rule set, so measuring the constant here would over-report the
            // surface and hide the addendum from the reviewed lock.
            guidance: [{ name: 'plan-mode', text: planModeGuidanceText(this.upstreamPlanMode() !== undefined) }],
          })
          const report = measureSurfaces(surfaces)
          const cwd = exec?.agent?.session?.header?.cwd
          let lock: SurfaceLockDocument | undefined
          let lockPath: string | undefined
          if (typeof cwd === 'string' && cwd.trim() !== '') {
            lockPath = path.join(cwd, '.freecodego', 'surface-lock.json')
            try { lock = JSON.parse(await readFile(lockPath, 'utf8')) as SurfaceLockDocument } catch { lock = undefined }
          }
          // A diff against a partial surface is worse than no diff: the tool
          // group would differ from the lock and the summary would say the
          // injected surfaces changed, which is a prompt-change verdict issued
          // without a measurement. The tool says it could not measure instead of
          // measuring half of it.
          const diff = toolSchemas === undefined ? undefined : diffSurfaceLock(lock, surfaces)
          return {
            ...report,
            lockPath,
            toolSurface: toolSchemas === undefined ? 'unreadable' : 'measured',
            ...(diff === undefined ? {} : {
              diff,
              // The diff object is the evidence; this is the answer. A caller that
              // has to read `added`/`changed`/`removed` and compose the sentence
              // itself is one step away from reporting "the lock did not match"
              // without saying what moved, which is the invisible prompt change
              // this tool exists to prevent.
              summary: describeSurfaceLockDiff(diff),
            }),
            note: toolSchemas === undefined
              ? 'The mounted tools registry exposes no `schemas()`, so the tool half of this surface could not be read and no lock diff was attempted. The byte and token figures below cover the injected guidance only — they are not a statement that this plugin registers no tools.'
              : lock === undefined
                ? 'No reviewed lock found, so every surface counts as new. Commit one with buildSurfaceLock() from the plugin package to turn future prompt edits into a visible diff.'
                : 'Digests cover tool schemas and injected guidance, sorted by entry name so a registration order change is not reported as a prompt change.',
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Injected surface report' }),
      })
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: surface report tool')
    } catch (error) {
      // Diagnostic only: a failure here must not affect a session. The tool being
      // absent is still a deployment fact — `engineering_surface_report` is how a
      // prompt change is turned into a reviewable diff, and a reviewer who cannot
      // call it has no second door onto the same numbers.
      this.ctx.logger.warn(`freecodego: engineering_surface_report was not registered: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * The on-demand half of the budget signal.
   *
   * Its schema is deferred (see `deferred-tools.ts`), so it costs nothing until
   * the model asks — which is the whole reason the injected fragment can afford
   * to stay coarse. Any model that wants the exact number pays one tool call
   * instead of paying a rewritten prefix on every turn.
   */
  /**
   * PDF and notebook reading, the two formats the harness `read` tool cannot
   * show the model. Registered through the same seam as the other plugin
   * tools; the credential guard's path tier names this tool, so a symlinked
   * key file is refused the same way as for `read`.
   */
  private registerReadDocumentTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const dispose = tools.register(readDocumentToolDefinition())
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: read document tool')
      // Advertise it on the same terms the harness advertises `read`: the tool
      // list makes it callable, and the prompt line makes it chosen. Ordered
      // right after the read guidance it complements.
      const systemPrompt = (this.ctx as unknown as { get(name: string): unknown }).get('systemPrompt') as { section?: (section: { readonly name: string; readonly order: number; readonly text: string }) => () => void } | undefined
      systemPrompt?.section?.({
        name: 'freecodego: read document guidance',
        order: 9510,
        text: 'Use read_document — not read — for PDF files and Jupyter notebooks (.ipynb): it extracts PDF text and formats notebook cells, while read would return binary bytes or raw JSON. Pass include_outputs to see a notebook cell\'s outputs.',
      })
    } catch (error) {
      // Diagnostic only: a failure here must not affect a session; the harness
      // `read` remains available for text formats. The tool and its prompt line
      // are registered under this one `try`, so a failure after the tool itself
      // landed leaves a tool that is callable but never *chosen* — the prompt line
      // is what makes the model reach for it over `read`.
      this.ctx.logger.warn(`freecodego: read_document did not finish registering, so it may be callable without its prompt line; the harness read still serves text formats: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * Hook documents for a workspace, read at most once per TTL.
   *
   * The trust gate runs inside `loadHookDocuments`, before any project file is
   * opened: a hook is a command this process runs, and an untrusted checkout's
   * hook file is a command the repository chose. Resolving trust first also
   * means an untrusted workspace reads only the user's own files.
   * @param workspaceRoot - the session's workspace, or the process directory.
   * @returns the documents, each with its provenance.
   */
  private async hookDocumentsFor(workspaceRoot?: string): Promise<readonly HookDocument[]> {
    const key = workspaceRoot ?? process.cwd()
    const cached = this.hookDocuments.get(key)
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached.documents
    const resolved = await this.resolveTrust(key)
    const documents = await loadHookDocuments({
      workspaceRoot: key,
      trusted: resolved.decision?.trusted === true && resolved.enabled,
      home: harnessHomeDirectory(),
      port: {
        readFile: async (target) => {
          try {
            return await readFile(target, 'utf8')
          } catch {
            return undefined
          }
        },
      },
      claudeDialect: this.claudeHookDialect(),
    })
    // The project tier's own `hooks` key: `.freecodego/config.json` accepts a hook
    // block, and until this was appended the key was reported as accepted and
    // never run — a repository could declare a `PreToolUse` guard and watch
    // nothing happen. It carries the same `project` provenance as the checkout's
    // hook files, so `collectHookHandlers` orders and dedupes it with them, and
    // the value is handed over unparsed: the fifteen-event dialect belongs to
    // `hooks/surface.ts`, not to the tier reader.
    const tier = await this.projectTierFor(key).catch(() => undefined)
    const withTier = tier?.hooks === undefined
      ? documents
      : [...documents, { source: 'project' as const, path: `${PROJECT_CONFIG_RELATIVE_PATH}#hooks`, value: tier.hooks }]
    this.hookDocuments.set(key, { documents: withTier, at: Date.now() })
    return withTier
  }

  /**
   * Who owns `.claude/settings.json` in this composition.
   *
   * The Harness's own bridge parses the same file and *runs the same commands*
   * (`@deepseek-ai/dsh-hooks-claude-code`), so a composition that mounts both
   * fires every Claude hook twice. The native row keeps the file; this reader
   * keeps the dialects no Harness package parses.
   *
   * Read off the Loader rather than off a bundle name, because the bridge is not
   * in any bundle: the two profiles that mount it are test fixtures that insert
   * the row themselves, so "is the package currently started" is the only question
   * whose answer matches what will actually run. A loader that is absent or
   * throws answers `'plugin'`, which keeps the user's own files running — the
   * direction that never drops a rule nobody else would run.
   * @returns the owner of the Claude dialect.
   */
  private claudeHookDialect(): ClaudeHookDialectOwner {
    // The decision and its fail-open rules live in `hooks/files.ts`, beside the
    // file list they decide about, so they can be tested without a Host.
    return claudeHookDialectOf(this.ctx.get('loader'))
  }

  /**
   * Install the hook seams and their session records.
   *
   * There is no settings switch, deliberately. The hook files *are* the switch: a
   * user who wants no hooks has none, and a second toggle that silently overrides
   * rules already declared in a file would be the "I set it and it did not apply"
   * failure this plan is written against. What a deployment can do is remove the
   * files, which is visible in `engineering_inspect`'s hooks section.
   * @param ctx - the context to install listeners on.
   */
  private registerHookRuntime(ctx: Context): void {
    const sessions = {
      get: (id: string) => (ctx.get('sessions') as { get?(sessionId: string): { append?(type: string, data: unknown): unknown } | undefined } | undefined)?.get?.(id),
    }
    installHookSeams(ctx, {
      runtime: this.hookRuntime,
      // The persona output contract, checked at the moment the child ends.
      //
      // The check is a name search over the child's final message, so it can only
      // report *absence*: a name that never appears is worth the parent knowing
      // about, and a name that does appear is not proof the artifact exists. That
      // asymmetry is the contract's own — `persona/contract.ts` explains why a
      // shortfall warns instead of failing.
      // `subagent/start` and `subagent/end` carry a session *id* and no
      // workspace, so the child's own durable header is where their project-tier
      // hooks find their file set. See `HookSeamDeps.sessionCwd`.
      sessionCwd: id => this.sessionWorkspaceRoot(id),
      subagentEnd: (info) => {
        const childId = String((info as { readonly id?: unknown; readonly sessionId?: unknown })?.id ?? (info as { readonly sessionId?: unknown })?.sessionId ?? '')
        if (childId === '') return
        const expected = this.personaRuns.expectedFor(childId)
        if (expected === undefined) return
        const produced = namedOutputsIn((info as { readonly lastAssistantMessage?: unknown }).lastAssistantMessage, expected)
        const outcome = this.personaRuns.complete(childId, produced)
        if (outcome?.message === undefined) return
        const parent = outcome.parent as { inject?(message: unknown): void } | undefined
        parent?.inject?.(createUserMessage({
          source: { kind: 'plugin', plugin: 'freecodego-persona' },
          content: [{ type: 'text', text: `[freecodego] ${outcome.message}` }],
        }))
      },
      record: (entry) => {
        if (entry.phase !== 'result' && entry.phase !== 'invoked') return
        if (entry.sessionId === undefined) return
        try {
          sessions.get(entry.sessionId)?.append?.(
            entry.phase === 'invoked' ? 'freecodego/hook-invoked' : 'freecodego/hook-result',
            {
              hook_event_name: entry.event,
              matcher: entry.matcher,
              sources: [...entry.sources],
              command: entry.command,
              ...(entry.status === undefined ? {} : { status: entry.status }),
              ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
              ...(entry.message === undefined ? {} : { message: entry.message }),
              ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
            },
          )
        } catch {
          // A session being torn down must not turn a hook record into an error:
          // the dispatch already happened, and its outcome is also in the log the
          // handler may have written itself.
        }
      },
    })
    // An observing seam does not hold the turn open, so disposal waits for the
    // dispatches in flight rather than abandoning a handler mid-write.
    ctx.effect(() => () => { void this.hookRuntime.settled() }, 'freecodego: hooks in flight')
    ctx.effect(() => () => { this.hookDocuments.clear() }, 'freecodego: hook document cache')
    ctx.effect(() => () => { this.projectConfigReports.clear(); this.projectCommandPolicies.clear() }, 'freecodego: project config report cache')
  }

  /**
   * One session-worktree set per workspace, built on first use.
   *
   * The registry is a `WorktreeRegistry` over
   * `<workspace>/.freecodego/worktrees.json`: one document per workspace, holding
   * every copy that workspace has handed out — this session's, and entries written
   * before this build by the retired team runtime. The risk of two registries over
   * one directory of worktrees — the orphan neither can find — is answered by the
   * parser refusing a document whose `cwd` is a different workspace, so a stray
   * file cannot be read as this one's.
   */
  private sessionWorktreesFor(workspaceRoot: string): SessionWorktrees {
    const existing = this.worktreeSessions.get(workspaceRoot)
    if (existing !== undefined) return existing
    const registry = new WorktreeRegistry(workspaceRoot, path.join(workspaceRoot, '.freecodego', 'worktrees.json'))
    const runGit = async (args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
      try {
        const result = await promisify(execFile)('git', args, { timeout: 120_000, windowsHide: true, maxBuffer: 64_000 })
        return { code: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string }
        return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) }
      }
    }
    const sessions = new SessionWorktrees({
      registry,
      create: async (input): Promise<WorktreeCreation> => createWorktree({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        requested: input.requested,
        branch: input.branch,
        gitAvailable: (await runGit(['-C', input.repoRoot, 'rev-parse', '--is-inside-work-tree'])).code === 0,
      }, realCreatorDeps(args => runGit(['-C', input.repoRoot, ...args]))),
      remove: async (input) => {
        if (input.strategy === 'git') {
          // `worktree remove` refuses a copy with local changes, and a session
          // worktree almost always has some — `--force` is the point of exiting.
          const removal = await runGit(['-C', input.repoRoot, 'worktree', 'remove', '--force', input.path])
          // The exit code has to be read here, because `runGit` reports failures
          // in its result rather than by throwing: without this the port always
          // returned normally, so `exit` recorded the copy as released and
          // reported `removed: true` even when git had removed nothing. That is
          // the failure its own catch block exists to prevent — a copy still on
          // disk, registered as abandoned, listed by nothing as live and offered
          // by nothing for removal. The reasons are ordinary: a locked worktree,
          // a path that is not a worktree of this repository, or a file another
          // process still holds, which on Windows is the common case.
          if (removal.code !== 0) throw new Error(`git worktree remove failed: ${redactCredentialShapes((removal.stderr || removal.stdout).trim()) || `exit code ${removal.code}`}`)
          await runGit(['-C', input.repoRoot, 'worktree', 'prune'])
          return
        }
        rmSync(input.path, { recursive: true, force: true })
      },
      exclude: async () => registry.excludeWorktreeDirectory(),
      head: async (repoRoot) => {
        const result = await runGit(['-C', repoRoot, 'rev-parse', 'HEAD'])
        return result.code === 0 ? result.stdout.trim() : undefined
      },
    })
    this.worktreeSessions.set(workspaceRoot, sessions)
    return sessions
  }

  /**
   * Register the worktree tools.
   *
   * Four tools over one object, so `exit` finds what `enter` recorded. They are
   * the session-level isolation the plugin previously had and lost; the plan's
   * one degradation is stated in every result rather than implied — the
   * Harness fixes a session's working directory at creation, so this conversation
   * is pointed at the copy rather than moved into it.
   */
  private registerWorktreeTools(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    const definitions = worktreeToolDefinitions({
      sessions: workspaceRoot => this.sessionWorktreesFor(workspaceRoot),
      sessionOf: (exec) => {
        const agent = (exec as { readonly agent?: { readonly id?: unknown; readonly session?: { readonly id?: unknown; readonly header?: { readonly cwd?: string } } } } | undefined)?.agent
        const id = typeof agent?.session?.id === 'string' ? agent.session.id : agent?.id
        const cwd = agent?.session?.header?.cwd
        if (typeof id !== 'string' || id === '' || typeof cwd !== 'string' || cwd.trim() === '') return undefined
        return { id, cwd }
      },
    })
    for (const definition of definitions) {
      try {
        const dispose = tools.register(definition)
        const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
        this.ctx.effect(() => () => { cleanup() }, `freecodego: ${definition.name}`)
      } catch (error) {
        // One failed registration must not remove the other three. *Which* one is
        // gone has to be in the log: a worktree tool the model is never offered
        // fails the same way as one that does not exist.
        this.ctx.logger.warn(`freecodego: ${definition.name} was not registered: ${redactCredentialShapes(String(error))}`)
      }
    }
  }

  /**
   * Register the persona roster and dispatcher.
   *
   * The spawn path is the Harness's own (`ctx.agents.create` off the parent's
   * context), with one difference that is the whole point of a persona here: the
   * child's `cwd` is the isolated copy when the persona asks for one.
   * A session's cwd cannot be revised after creation, but a child's is set by the
   * act of creating it — so this is where `default_isolation` becomes a real
   * redirect rather than an intention.
   */
  private registerPersonaTools(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    const readText = async (target: string): Promise<string | undefined> => {
      try {
        return await readFile(target, 'utf8')
      } catch {
        return undefined
      }
    }
    const rosterFor = async (cwd: string) => {
      const resolved = await this.resolveTrust(cwd)
      return await loadPersonaRoster({
        workspaceRoot: cwd,
        trusted: resolved.decision?.trusted === true && resolved.enabled,
        userDirectory: path.join(freeCodeGoDataHome(), 'personas'),
        port: {
          readFile: readText,
          listDir: async (target) => {
            try {
              return await readdir(target)
            } catch {
              return []
            }
          },
        },
      })
    }
    const definitions = personaToolDefinitions({
      roster: rosterFor,
      instructions: async persona => await loadPersonaInstructions(persona, readText),
      isolate: async (input) => {
        const outcome = await this.sessionWorktreesFor(input.workspaceRoot).enter({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.sessionId,
        })
        return {
          path: outcome.worktree.path,
          strategy: outcome.strategy,
          ...(outcome.fallbackReason === undefined ? {} : { fallbackReason: outcome.fallbackReason }),
        }
      },
      newSessionId: () => randomUUID(),
      callerOf: (exec) => {
        const agent = (exec as { readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } } } | undefined)?.agent
        const cwd = agent?.session?.header?.cwd
        if (agent === undefined || typeof cwd !== 'string' || cwd.trim() === '') return undefined
        return { cwd, agent }
      },
      spawn: async (input) => {
        const parent = input.parent as {
          readonly id?: unknown
          readonly ctx?: { readonly agents?: { create(request: unknown): Promise<{ readonly agent?: unknown }> } }
        }
        const agents = parent?.ctx?.agents
        if (agents === undefined) throw new Error('this composition has no agent service, so a persona child cannot be started')
        const handle = await agents.create({
          sessionId: input.sessionId as SessionId,
          meta: {
            cwd: input.session.cwd,
            ...(parent.id === undefined ? {} : { parentSession: String(parent.id) }),
            origin: 'subagent',
            delegationDepth: 1,
          },
          agentOptions: {
            ...(input.session.model === undefined ? {} : { model: input.session.model }),
            ...(input.session.reasoningEffort === undefined ? {} : { reasoningEffort: input.session.reasoningEffort }),
          } as never,
          ...(input.session.signal === undefined ? {} : { signal: input.session.signal }),
        })
        const child = handle.agent as { followup?(message: unknown): void } | undefined
        if (child?.followup === undefined) {
          // Loud rather than silent: a child that exists with no brief is a
          // session the user will find later, doing nothing.
          throw new Error('the child agent was created but cannot be sent its brief; it was not given one')
        }
        child.followup(createUserMessage({
          source: { kind: 'plugin', plugin: 'freecodego-persona' },
          content: [{ type: 'text', text: input.session.brief }],
        }))
      },
    }, this.personaRuns)
    for (const definition of definitions) {
      try {
        const dispose = tools.register(definition)
        const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
        this.ctx.effect(() => () => { cleanup() }, `freecodego: ${definition.name}`)
      } catch (error) {
        // One failed registration must not remove the other.
        this.ctx.logger.warn(`freecodego: ${definition.name} was not registered: ${redactCredentialShapes(String(error))}`)
      }
    }
  }

  /**
   * Read a parked tool result back in byte-exact pages.
   *
   * The locator in a cleared-result marker is already readable with the file
   * tools, and that is exactly the problem: `read` answers with a line-limited
   * window and no statement of how much is left, so a model retrieving a 200KB
   * artifact either reads it whole — re-spending what the clear reclaimed — or
   * reads its start and never learns there was more. This tool answers with the
   * bytes served, the offset to ask for next, and whether it was the last page,
   * so paging is exact and its end is knowable.
   */
  private registerSpillRecallTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const dispose = tools.register(rawTool({
        name: 'spill_recall',
        description: 'Read a parked tool result back, in pages the size you ask for. The locator comes from a cleared-result marker (the text was too large to keep in context and was written to disk instead). Each answer reports the bytes and lines it served, the exact nextOffset to pass back as offset, and eof — so page until eof rather than re-reading from the start. Prefer this over read/grep on a locator: this one tells you how much is left.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['locator'],
          properties: {
            locator: { type: 'string', description: 'The parked artifact path named in the cleared-result marker.' },
            offset: { type: 'integer', minimum: 0, description: 'Byte offset to start at. Pass the previous page\'s nextOffset to continue. An offset that lands inside a multi-byte character is moved back to that character\'s first byte, and the offset field of the answer reports the byte that was really served.' },
            max_bytes: { type: 'integer', minimum: 1, maximum: MAX_RECALL_BYTES, description: `Bytes to serve at most (default ${DEFAULT_RECALL_MAX_BYTES}, hard ceiling ${MAX_RECALL_BYTES}).` },
            max_lines: { type: 'integer', minimum: 1, description: `Whole lines to serve at most (default ${DEFAULT_RECALL_MAX_LINES}).` },
          },
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (args: SpillRecallArgs | undefined) => this.recallSpill(args),
        presentCall: (args: SpillRecallArgs | undefined) => ({ card: 'generic', title: spillRecallTitle(args?.locator) }),
      }))
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: spill recall tool')
    } catch (error) {
      // Diagnostic only: a failure to register must not take the plugin down. But
      // a parked result is only retrievable through this tool, so its absence
      // turns every cleared result into a dead end the model cannot even ask
      // about — the marker names a locator and nothing serves it.
      this.ctx.logger.warn(`freecodego: spill_recall was not registered, so parked results cannot be read back: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * Serve one page of a parked artifact.
   *
   * Read from the filesystem, not from the spill service: the locator the local
   * backend hands out *is* the path, which is what makes the artifact readable at
   * all after the session view that mentioned it is gone. The read is windowed so
   * a locator naming a huge file cannot be turned into one enormous page, and the
   * window is decoded only up to its last complete character — the remainder
   * belongs to the next page, whose offset starts where this one stopped.
   */
  private async recallSpill(args: SpillRecallArgs | undefined): Promise<unknown> {
    if (this.policy.get()?.spillRecallEnabled === false) return { available: false, note: 'Parked-result recall is disabled in FreeCodeGo settings.' }
    const locator = typeof args?.locator === 'string' ? args.locator.trim() : ''
    if (locator === '') return { available: false, note: 'A locator is required; take it from the cleared-result marker.' }
    // The shield, not a duplicate of it: this refuses exactly what the file tools
    // refuse, because a path becoming a file read is the same act whichever tool
    // performs it.
    if (isCredentialPath(locator)) return { available: false, note: 'Refused by the FreeCodeGo credential guard: this path looks like a credential or secret file.' }
    const requested = Number.isFinite(args?.offset) && (args?.offset ?? 0) > 0 ? Math.floor(args?.offset as number) : 0
    const budget = Math.max(1, Math.min(Math.floor(args?.max_bytes ?? DEFAULT_RECALL_MAX_BYTES), MAX_RECALL_BYTES))
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(locator, 'r')
      const totalBytes = (await handle.stat()).size
      if (requested > totalBytes) return { available: false, note: `offset ${requested} is past the end of the artifact (${totalBytes} bytes)` }
      // An offset that lands inside a character retreats to that character's first
      // byte, by the same rule the in-memory reader applies — half a character
      // decodes to U+FFFD, and a caller reconstructing the artifact from pages
      // would then read text that was never parked. The four bytes ending at the
      // requested offset always contain its first byte, since a UTF-8 character is
      // at most four bytes long, so one small read in front of the window is enough
      // to apply that rule here instead of a second time in its own words.
      const probeStart = Math.max(0, requested - 3)
      let offset = requested
      if (probeStart < requested) {
        const probe = Buffer.allocUnsafe(requested - probeStart + 1)
        const probeRead = await handle.read(probe, 0, probe.length, probeStart)
        offset = probeStart + characterStartIndex(probe.subarray(0, probeRead.bytesRead), requested - probeStart)
      }

      // Four spare bytes: a UTF-8 character is at most four, so a window of the
      // budget plus four always contains at least one complete character past the
      // budget and the trim does not empty the page.
      const window = Buffer.allocUnsafe(Math.min(budget + 4, Math.max(1, totalBytes - offset)))
      const { bytesRead } = await handle.read(window, 0, window.length, offset)
      const complete = completeByteLength(window.subarray(0, bytesRead))
      // The window's bytes are the file's bytes, so the page is computed on them
      // and not on a decoded string: `readSpillPageBytes` keeps every figure —
      // `bytes`, `lines`, `nextOffset` — in the file's byte domain, which is the
      // domain `offset` is added to below. Decoding first made the two domains
      // differ on any artifact that is not valid UTF-8: an invalid byte becomes
      // U+FFFD and re-encodes as three, so `nextOffset` ran ahead of the file
      // offset, pages ran out early, and the tail of the artifact was never served.
      // The trim is still what makes the tail whole — `completeByteLength` keeps a
      // split character for the next page — and the next page's offset starts
      // exactly where this one stopped.
      const page = readSpillPageBytes(window.subarray(0, complete), { maxBytes: budget, maxLines: args?.max_lines ?? DEFAULT_RECALL_MAX_LINES })
      const nextOffset = offset + page.nextOffset
      return {
        available: true,
        locator,
        text: page.text,
        bytes: page.bytes,
        lines: page.lines,
        // The offset that was served, which is lower than the one requested when
        // that landed inside a character. Reported rather than corrected in
        // silence, exactly as the in-memory page reports it: a caller paging by
        // arithmetic has to be able to see that it did not get what it asked for.
        offset,
        nextOffset,
        eof: nextOffset >= totalBytes,
        totalBytes,
      }
    } catch (error) {
      return { available: false, note: `the parked artifact could not be read: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private registerContextBudgetTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const dispose = tools.register({
        name: 'engineering_context_budget',
        description: 'Report how full this conversation\'s context is: tokens in use, the routed model\'s window, and what is left after a reply reserve, with whether the figure is provider usage or a heuristic estimate. Also reports whether compacting would pay for itself, which is a cost question rather than a room question: supply write_tokens, memo_tokens, and cache_write_read_ratio to get a decision, or read the note explaining why none can be computed. Prefer this over guessing when deciding whether to read a whole file or to compact.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            archive_tokens: { type: 'integer', minimum: 0, description: 'Tokens the conversation history occupies today. Defaults to the measured context use.' },
            write_tokens: { type: 'integer', minimum: 0, description: 'Tokens the rewritten prefix would cost to write.' },
            memo_tokens: { type: 'integer', minimum: 0, description: 'Tokens the summary would be carried at on every later request.' },
            cache_write_read_ratio: { type: 'number', minimum: 1, description: 'What a cache write costs relative to a read for the routed model (1.25 means 25% more).' },
            requests_per_boundary: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Requests each completed compaction boundary took, in order. Omit when no boundary has completed.' },
            remaining_boundaries: { type: 'integer', minimum: 0, description: 'How many further boundaries this session expects to cross. Defaults to 1, the most conservative reading.' },
            carried_debt_tokens: { type: 'integer', minimum: 0, description: 'Cost the previous compaction has not yet earned back.' },
          },
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (args: ContextBudgetArgs | undefined, exec: { readonly agent?: ContextBudgetAgent }) => {
          if (this.policy.get()?.contextBudgetEnabled === false) return { enabled: false, note: 'The model-visible context budget is disabled in FreeCodeGo settings.' }
          const agent = exec?.agent
          if (agent === undefined) return { available: false, note: 'This call has no session to measure.' }
          // Measure fresh when possible: the tool is the precise path, and a
          // stale cached number would be worse here than the coarse fragment.
          const report = this.measureContextBudget(agent) ?? this.contextBudgetReports.get(planModeSessionKey(agent as { readonly id?: unknown } | undefined))
          if (report === undefined) return { available: false, note: 'No token meter is mounted in this composition, so context pressure cannot be measured.' }
          this.contextBudgetReports.set(planModeSessionKey(agent as { readonly id?: unknown } | undefined), report)
          const key = planModeSessionKey(agent as { readonly id?: unknown } | undefined)
          return {
            available: true,
            band: report.band,
            summary: describeContextBudget(report),
            report,
            compaction: this.compactionEconomicsFor(agent, report, args),
            // Absent until a compaction happened in this conversation, and absent
            // is the honest answer: no summary has been checked, so nothing is
            // being certified about an older one.
            ...(this.compactionFidelity.has(key) ? { lastCompactionSummary: this.compactionFidelity.get(key) } : {}),
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Context budget' }),
      })
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: context budget tool')
    } catch (error) {
      // Diagnostic only: a failure here must not affect a session — but the
      // precise path onto the budget numbers is then gone, and the coarse
      // fragment is the only reading left. That is a difference an operator
      // should be able to see rather than infer from a tool that is not there.
      this.ctx.logger.warn(`freecodego: the context budget tool was not registered, so only the coarse budget fragment remains: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * Register the two manual context-control tools.
   *
   * Registered unconditionally, including in a composition with no compaction
   * engine: the engine is resolved per call, so a missing one is answered by the
   * tool ("no engine is mounted for this session") rather than by the tool being
   * absent. An absent tool tells the model nothing about *why*, and a deployment
   * can mount an engine into a session later than the plugin loads.
   */
  private registerContextControlTools(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    const control = new ContextControl(this.ctx)
    for (const definition of contextControlToolDefinitions(control)) {
      try {
        const dispose = tools.register(definition)
        const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
        this.ctx.effect(() => () => { cleanup() }, `freecodego: ${definition.name}`)
      } catch (error) {
        // One failed registration must not take the other with it.
        this.ctx.logger.warn(`freecodego: ${definition.name} was not registered: ${redactCredentialShapes(String(error))}`)
      }
    }
  }

  /**
   * Check a compaction summary against the history it replaced, while that
   * history still exists.
   *
   * Never throws and never blocks: the summary is already committed by the time
   * this runs, so the only honest outcomes are "it holds" and "it does not, and
   * here is which part". A rejection is logged rather than enforced — refusing a
   * compaction after the fact is not something a listener on an append event can
   * do, and pretending otherwise would be worse than reporting it.
   */
  private auditCompactionSummary(session: Session, event: { readonly data?: unknown }): void {
    if (this.policy.get()?.compactionFidelityEnabled === false) return
    try {
      const data = event.data as { readonly summary?: unknown; readonly shadowedSeqs?: unknown } | undefined
      const summary = typeof data?.summary === 'string' ? data.summary : undefined
      const seqs = Array.isArray(data?.shadowedSeqs)
        ? data.shadowedSeqs.filter((value): value is number => typeof value === 'number')
        : []
      if (summary === undefined || seqs.length === 0) return
      const wanted = new Set(seqs)
      const archive: string[] = []
      for (const entry of hostSessionEvents(session)) {
        // The accessor declares `{type, time, data}`; the stored event carries a
        // `seq`, and matching on it is the only way to identify the replaced
        // span rather than guessing from the range's endpoints.
        const seq = (entry as { readonly seq?: unknown }).seq
        if (typeof seq !== 'number' || !wanted.has(seq)) continue
        archive.push(...archiveTextFrom(entry.data))
      }
      // Unresolvable sequences mean the log shape is not the one this reads, and
      // an audit over an empty archive would report every quotation as invented.
      if (archive.length === 0) {
        this.ctx.logger.debug?.('freecodego: compaction summary could not be checked, the replaced events are not readable from this session log')
        return
      }
      const verdict = auditCompactionFidelity({ summary, archive })
      const key = planModeSessionKey({ id: session.id ?? undefined })
      this.compactionFidelity.set(key, verdict)
      while (this.compactionFidelity.size > MAX_TRACKED_SESSION_VIEWS) {
        const oldest = this.compactionFidelity.keys().next().value
        if (oldest === undefined) break
        this.compactionFidelity.delete(oldest)
      }
      if (!verdict.accepted) {
        const first = verdict.misses[0]
        this.ctx.logger.warn(`freecodego: compaction summary is not faithful to the history it replaced — ${verdict.note}${first === undefined ? '' : ` First miss (${first.kind}): ${first.text}`}`)
      }
    } catch (error) {
      // An audit that can break a session is worse than the omission it reports.
      this.ctx.logger.warn(`freecodego: compaction fidelity audit failed: ${redactCredentialShapes(String(error))}`)
    }
  }

  /**
   * Whether compacting this conversation would pay for itself.
   *
   * The room question is already answered by the budget bands; this is the cost
   * question, and `compaction-economics.ts` records why it is the one that was
   * never being asked (compaction does not run in practice). Two inputs are
   * measurable here — how full the window is, and how many compactions have
   * already happened — and the cost side is not, because the summary's size is
   * the compaction engine's own choice. That split is reported rather than
   * papered over: an unavailable comparison names the inputs it lacks instead of
   * deciding on invented numbers.
   */
  private compactionEconomicsFor(agent: ContextBudgetAgent, report: ContextBudgetReport, args: ContextBudgetArgs | undefined): CompactionEconomicsView {
    let priorCompactionCount = 0
    try {
      // `ContextBudgetAgent` types its session loosely because the budget only
      // needs the token views; the event log is read through the same accessor
      // every other session reader here uses.
      for (const event of hostSessionEvents(agent.session as HostSessionEvents)) {
        if (event.type === 'compaction/start') priorCompactionCount += 1
      }
    } catch {
      // A session that exposes no readable log keeps the count at zero, which is
      // the conservative reading: a first compaction gets no subsidy it may not
      // deserve, so the arithmetic has to stand on its own.
      priorCompactionCount = 0
    }
    return compactionEconomicsView({
      archiveTokens: args?.archive_tokens ?? report.usedTokens,
      writeTokens: args?.write_tokens ?? 0,
      ...(args?.memo_tokens === undefined ? {} : { memoTokens: args.memo_tokens }),
      cacheWriteReadRatio: args?.cache_write_read_ratio ?? null,
      contextTokens: report.usedTokens,
      contextWindowTokens: report.contextWindow ?? null,
      completedBoundaryRequestCounts: args?.requests_per_boundary ?? null,
      remainingBoundaries: args?.remaining_boundaries ?? 1,
      // Not measurable from the plugin: the growth rate needs a per-request token
      // history, and inventing one would silently double-count the window bound.
      averageContextTokenIncrement: null,
      priorCompactionCount,
      carriedDebtTokens: args?.carried_debt_tokens ?? 0,
    })
  }

  /**
   * Where the prompt's tokens actually go, with the tree that names them.
   *
   * The breakdown answers a different question from `engineering_context_budget`:
   * that one says how full the window is, this one says what filled it, which is
   * what turns "the prompt is large" into a next step — defer tool schemas, turn
   * a Skill pack off, or compact. The rows are apportioned to the provider's own
   * measured prompt total when the token meter has one, and labelled as a lexical
   * estimate when it does not, because a breakdown of an estimate is not a
   * measurement and must not be rendered as one.
   */
  private registerPromptCompositionTool(): void {
    const tools = this.toolRegistry()
    if (tools?.register === undefined) return
    try {
      const dispose = tools.register({
        name: 'engineering_context_prompt',
        description: 'Report where this conversation\'s prompt tokens actually go — system prompt, tool definitions, rules, Skills, MCP servers, subagent definitions, summarized conversation, and the transcript — plus a bounded tree naming the largest individual items and any tool call whose result never arrived. Call this when the context is filling up and the next step depends on *what* is large: a bloated tool block calls for deferring schemas or turning a Skill pack off, a long transcript calls for compacting, and a broken tool pairing means a turn was interrupted. Pair it with engineering_context_budget, which reports how much room is left rather than what filled it.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: JSON_TOOL_OUTPUT,
        execute: async (_args: unknown, exec: { readonly agent?: ContextBudgetAgent }) => {
          if (this.policy.get()?.promptCompositionEnabled === false) return { enabled: false, note: 'The model-visible prompt composition is disabled in FreeCodeGo settings.' }
          const agent = exec?.agent
          if (agent === undefined) return { available: false, note: 'This call has no session to measure.' }
          const measured = this.measureContextBudget(agent)
          const snapshot = this.promptCompositionFor(agent, measured)
          if (snapshot === undefined) return { available: false, note: 'This composition exposes neither a session log nor a request header, so the prompt cannot be broken down.' }
          const collected = collectPromptUsageItems(this.promptCompositionEvents(agent))
          const tree = buildPromptUsageTree(snapshot, collected.items)
          return {
            available: true,
            summary: describePromptComposition(snapshot),
            measured: snapshot.measured,
            totalTokens: snapshot.totalTokens,
            categories: snapshot.categories.map(category => ({ id: category.id, label: category.label, tokens: category.tokens, chars: category.chars, share: category.share })),
            // The largest items only: the tree's job is to name the few things a
            // decision turns on, and a full node dump would be the same wall of
            // numbers this tool exists to replace.
            largestItems: tree.nodes
              .filter(node => node.kind !== 'category')
              .sort((left, right) => right.tokens - left.tokens)
              .slice(0, 12)
              .map(node => ({ id: node.id, label: node.label, kind: node.kind, tokens: node.tokens, chars: node.chars, content: node.content?.kind ?? 'none' })),
            omittedItems: tree.omittedItems + collected.omitted,
            omittedRedacted: tree.omittedRedacted,
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Prompt composition' }),
      })
      const cleanup = typeof dispose === 'function' ? dispose : () => { dispose.dispose?.() }
      this.ctx.effect(() => () => { cleanup() }, 'freecodego: prompt composition tool')
    } catch (error) {
      // Diagnostic only: a failure here must not affect a session.
      this.ctx.logger.warn(`freecodego: the prompt composition tool was not registered: ${redactCredentialShapes(String(error))}`)
    }
  }

  /** The session's events, or an empty log when the agent exposes none. */
  /**
   * Re-resolve the stored breakdown after a compaction rewrote the prompt.
   *
   * Why the stored snapshot and not a fresh build: the store is the ratio
   * carry-forward the next measurement reads, and compaction may leave a
   * conversation un-measured until its next prompt. Refreshing here means that
   * next measurement scales against a snapshot taken *after* the rewrite rather
   * than before it — the compaction is not silently absorbed as a ratio change.
   *
   * The summary's size comes from the same collector the full build uses, so
   * there is one character count for one category. Nothing is done when the
   * conversation has no stored snapshot yet, and nothing is done when the log
   * yields no summary text: re-resolving a row against nothing would report a
   * zero where the previous report had a figure, which is a worse answer than
   * leaving the stale-but-true snapshot for the next measurement to replace.
   */
  private refreshPromptCompositionAfterCompaction(session: {
    readonly id?: unknown
    readonly requestHeader?: () => PromptRequestHeaderLike | undefined
    readonly snapshotEvents?: () => readonly PromptEventLike[]
  }): void {
    const key = planModeSessionKey({ id: session.id })
    const previous = this.promptCompositions.get(key)
    if (previous === undefined) return
    let events: readonly PromptEventLike[]
    try { events = session.snapshotEvents?.() ?? [] } catch { return }
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const summaryChars = countCategoryChars(collectPromptCompositionSources(header, events)).summary
    if (summaryChars <= 0) return
    this.promptCompositions.set(key, refreshPromptCompositionAfterCompaction(previous, summaryChars))
  }

  private promptCompositionEvents(agent: ContextBudgetAgent): readonly PromptEventLike[] {
    const session = agent?.session as { readonly snapshotEvents?: () => readonly PromptEventLike[] } | undefined
    if (typeof session?.snapshotEvents !== 'function') return []
    try { return session.snapshotEvents() } catch { return [] }
  }

  /**
   * Build this conversation's breakdown, carrying the previous ratios forward.
   *
   * The store is per conversation because the ratio carry-forward is: a category
   * whose characters did not move should report the same tokens it reported last
   * turn, and that comparison only exists within one transcript.
   */
  private promptCompositionFor(agent: ContextBudgetAgent, measured: ContextBudgetReport | undefined): PromptCompositionSnapshot | undefined {
    const session = agent?.session as {
      readonly snapshotEvents?: () => readonly PromptEventLike[]
      readonly requestHeader?: () => PromptRequestHeaderLike | undefined
    } | undefined
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    if (header === undefined && typeof session?.snapshotEvents !== 'function') return undefined
    const key = planModeSessionKey(agent as { readonly id?: unknown } | undefined)
    const sources = collectPromptCompositionSources(header, this.promptCompositionEvents(agent))
    const snapshot = buildPromptComposition({
      sources,
      ...(measured === undefined ? {} : { measuredPromptTokens: measured.usedTokens, ...(measured.contextWindow === undefined ? {} : { contextWindow: measured.contextWindow }) }),
      ...(this.promptCompositions.has(key) ? { previous: this.promptCompositions.get(key) } : {}),
    })
    this.promptCompositions.set(key, snapshot)
    return snapshot
  }

  /**
   * The conversation's pressure and its compaction threshold, for a side channel.
   *
   * Prefers the report this session already has (written when its turn settled)
   * over a fresh measurement, so the invariant costs no second meter pass on the
   * common path. `undefined` when either half is unknown: a channel judged
   * against a threshold nobody can name would be reported as safe by default.
   */
  private sideChannelBudget(agent: ContextBudgetAgent): { readonly mainLoopTokens: number; readonly compactionThresholdTokens: number } | undefined {
    const report = this.contextBudgetReports.get(planModeSessionKey(agent as { readonly id?: unknown } | undefined)) ?? this.measureContextBudget(agent)
    if (report === undefined || report.contextWindow === undefined) return undefined
    return {
      mainLoopTokens: report.usedTokens,
      compactionThresholdTokens: Math.floor(report.contextWindow * HARNESS_COMPACTION_THRESHOLD_RATIO),
    }
  }

  /**
   * Measure the current request pressure for a conversation.
   *
   * Returns `undefined` when the composition has no token meter (an embedder may
   * omit it) — an absent meter is reported as absent rather than as zero pressure,
   * which would look like an empty context and is the more dangerous mistake.
   */
  private measureContextBudget(agent: ContextBudgetAgent): ContextBudgetReport | undefined {
    const meter = (this.ctx as unknown as { get(name: string): unknown }).get('tokenMeter') as { measure?(session: unknown): { readonly totalTokens?: unknown; readonly baseline?: { readonly kind?: unknown } } } | undefined
    if (meter?.measure === undefined) return undefined
    const session = agent?.session
    if (session === undefined) return undefined
    const measurement = meter.measure(session)
    const total = measurement?.totalTokens
    if (typeof total !== 'number' || !Number.isFinite(total)) return undefined
    const requestContext = typeof (session as { requestContext?: unknown }).requestContext === 'function'
      ? (session as { requestContext(): { readonly contextWindow?: unknown } | undefined }).requestContext()
      : undefined
    const contextWindow = typeof requestContext?.contextWindow === 'number' && Number.isFinite(requestContext.contextWindow) && requestContext.contextWindow > 0
      ? requestContext.contextWindow
      : undefined
    // The meter's own baseline states whether the figure came from provider
    // usage or from its heuristic price; the fragment must carry that too.
    const measured = measurement?.baseline?.kind === 'usage'
    const reserve = agent?.ctx?.agentOptions?.maxTokens
    return contextBudgetReport({
      usedTokens: total,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      measured,
      ...(typeof reserve === 'number' && Number.isFinite(reserve) && reserve > 0 ? { responseReserve: reserve } : {}),
    })
  }

  /** Epoch ms of the conversation's last assistant message, when it has one. */
  private lastAssistantAt(agent: ContextBudgetAgent): number | undefined {
    const session = agent?.session as { readonly snapshotEvents?: () => readonly { readonly type?: unknown; readonly time?: unknown }[] } | undefined
    if (typeof session?.snapshotEvents !== 'function') return undefined
    for (const event of [...session.snapshotEvents()].reverse()) {
      if (event?.type === 'assistant/message' && typeof event.time === 'number') return event.time
    }
    return undefined
  }

  /**
   * Fingerprint the request shape the next request will use, and report the diff.
   *
   * `session.requestHeader()` is the folded header event, so it carries the
   * rendered system text and the assembled tool schemas — the wire shape itself,
   * not a reconstruction. That is what lets the diff name the specific tool whose
   * description moved, which is the case that dominates tool-schema cache breaks
   * and the one no added/removed count can see.
   */
  private recordRequestShape(agent: ContextBudgetAgent): void {
    if (this.policy.get()?.cacheBreakAttributionEnabled === false) return
    const session = agent?.session as { readonly requestHeader?: () => unknown } | undefined
    if (typeof session?.requestHeader !== 'function') return
    const key = planModeSessionKey(agent as { readonly id?: unknown } | undefined)
    let change: ShapeChange
    try {
      change = this.requestShapes.record(key, fingerprintRequest(session.requestHeader() as never))
    } catch (error) {
      this.ctx.logger.warn(`freecodego: request-shape fingerprint failed: ${redactCredentialShapes(String(error))}`)
      return
    }
    if (!change.cacheRelevant) return
    this.lastShapeChange.set(key, change)
    this.ctx.logger.info(`freecodego: request shape changed before this request — ${describeShapeChange(change)}`)
  }

  /**
   * Tell the model how full its own context is, at band granularity.
   *
   * Called after a turn settles, so the measurement describes a stable surface
   * rather than a request still being assembled. The fragment is appended, which
   * is what keeps this affordable: everything before the last cache breakpoint
   * stays a cache hit, and inside a band nothing is sent at all.
   */
  private refreshContextBudget(agent: ContextBudgetAgent): void {
    if (this.policy.get()?.contextBudgetEnabled === false) return
    const report = this.measureContextBudget(agent)
    if (report === undefined) return
    const key = planModeSessionKey(agent as { readonly id?: unknown } | undefined)
    this.contextBudgetReports.set(key, report)
    const plan = this.contextBudget.plan(key, report)
    if (!plan.changed) return
    if (typeof agent?.inject !== 'function') return
    agent.inject(createUserMessage({
      source: { kind: 'plugin', plugin: 'freecodego-context-budget' },
      content: [{ type: 'text', text: `<context-budget>\n${plan.text}\n</context-budget>` }],
    }))
    this.contextBudget.commit(key, plan.band)
  }

  /**
   * Inject or retract the Plan Mode rules for one conversation.
   *
   * The section's value is the guidance while the mode is on and empty while it
   * is off, so the diff protocol turns "entered" into a content fragment and
   * "left" into an explicit removal notice.
   */
  private injectPlanModeGuidance(agent: PlanModeAgent, mode: PlanMode): void {
    const key = planModeSessionKey(agent)
    const log = this.planModeLogs.get(key) ?? new ContextFragmentLog()
    this.planModeLogs.set(key, log)
    const section: ContextSection<unknown> = {
      id: 'plan-mode',
      markers: ['<plan-mode>', '</plan-mode>'],
      render: value => String(value),
      replacementNotice: 'This Plan Mode guidance replaces all previously provided Plan Mode guidance.',
      removalNotice: 'Plan Mode has ended. The previously provided Plan Mode restrictions no longer apply; file-mutating tools are available again.',
    }
    const modeRules = planModeGuidanceText(this.upstreamPlanMode() !== undefined)
    const inputs: SectionInput<unknown>[] = [{ section, value: mode === 'plan' ? modeRules : undefined }]
    const fragments = log.plan(inputs)
    if (fragments.length === 0) return
    if (typeof agent.inject !== 'function') return
    agent.inject(createUserMessage({
      source: { kind: 'plugin', plugin: 'freecodego-plan-mode' },
      content: [{ type: 'text', text: renderFragments(fragments) }],
    }))
    log.commit(fragments)
  }

  /**
   * Read the session-automation switches currently in effect.
   *
   * Separate from the update face because a settings surface has to render the
   * current policy on mount, and `automationSettingsUpdate` only answers after a
   * write: a panel with no reader can only display the switches empty and let
   * them look disabled until the user happens to change one.
   *
   * Answers from the runtime rather than from the settings document, so the
   * caller sees the values actually in force — including the defaults a partial
   * or hand-edited settings document falls back to.
   * @returns the automation Settings.
   */
  @Remote('automationSettingsStatus')
  async automationSettingsStatus(): Promise<FreeCodeGoAutomationSettings> {
    return this.automation.effectiveSettings()
  }

  /**
   * Update any subset of the session-automation switches.
   *
   * The schema promised four switches — `hookChainsEnabled`,
   * `hookChainsMaxDepth`, `hookChainsCooldownMs`, `scheduledTasksEnabled` — and
   * no surface could turn one: no Remote accepted them and no code path wrote
   * them, so failure recovery could not be disabled, its loop guards could not be
   * widened, and the calendar planner could not be switched off. One of those
   * four was worse than inert: `freecodego_schedule_plan` refuses a call by
   * naming `scheduledTasksEnabled` as the reason, which told the model about a
   * switch the user had no way to reach.
   *
   * The answer is the policy now in effect, so the caller reads back what landed
   * rather than what it asked for.
   *
   * A Remote is a capability, not a control: this one spent its first revision
   * with no caller at all, which is the same unreachability in a new shape. The
   * settings surface now renders these four switches, and `harness-ui`'s Remote
   * contract test refuses to let a declared Remote go uncalled again.
   * @returns the automation Settings.
   * @param patch - the session-automation switches to update.
   */
  @Remote('automationSettingsUpdate')
  async automationSettingsUpdate(patch: FreeCodeGoAutomationSettingsUpdate): Promise<FreeCodeGoAutomationSettings> {
    const settings = this.policy
    if (settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    const update = automationSettingsPatch(patch)
    if (Object.keys(update).length > 0) await settings.update(update)
    return this.automation.effectiveSettings()
  }

  /** Update any subset of the guard/quality toggles. 
   * @returns the guard Settings Status.
   * @param patch - the guard and quality toggles to update.
   */
  @Remote('guardSettingsUpdate')
  async guardSettingsUpdate(patch: FreeCodeGoGuardSettingsUpdate): Promise<FreeCodeGoGuardSettingsStatus> {
    const settings = this.policy
    if (settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    const update: Record<string, unknown> = {}
    for (const key of ['envReadGuardEnabled', 'doomLoopGuardEnabled', 'lspEnabled', 'rehydrationEnabled', 'rehydrationArcEnabled', 'advisorMemoryDraftsEnabled', 'commandPolicyEnabled', 'planModeEnabled', 'contextBudgetEnabled', 'cacheColdClearEnabled', 'cacheBreakAttributionEnabled', 'assistantLoopGuardEnabled', 'promptCompositionEnabled'] as const) {
      const value = patch[key]
      if (typeof value === 'boolean') update[key] = value
    }
    if (Object.keys(update).length > 0) await settings.update(update)
    return this.guardSettingsStatus()
  }

  /** Enable or disable Headroom context compression for future tool results. 
   * @param enabled - whether this capability is switched on.
   * @returns the headroom Stats.
   */
  @Remote('headroomSetEnabled')
  async headroomSetEnabled(enabled: boolean): Promise<HeadroomStats> {
    const settings = this.policy
    if (settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    await settings.update({ headroomEnabled: enabled })
    return this.headroom.status()
  }

  /** Update Headroom tuning knobs (threshold, savings floor, exclusion list). 
   * @returns the headroom Stats.
   * @param patch - the Headroom tuning knobs to update.
   */
  @Remote('headroomUpdate')
  async headroomUpdate(patch: { readonly thresholdChars?: number; readonly minSavingsRatio?: number; readonly dedupEnabled?: boolean; readonly excludeTools?: readonly string[]; readonly foldReads?: boolean; readonly codeSkeletonEnabled?: boolean; readonly foldPolicy?: 'reversible' | 'max' }): Promise<HeadroomStats> {
    const settings = this.policy
    if (settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    const update: Record<string, unknown> = {}
    if (typeof patch.thresholdChars === 'number' && Number.isFinite(patch.thresholdChars)) update.headroomThresholdChars = Math.max(256, Math.min(1_000_000, Math.floor(patch.thresholdChars)))
    if (typeof patch.minSavingsRatio === 'number' && Number.isFinite(patch.minSavingsRatio)) update.headroomMinSavingsRatio = Math.max(0.05, Math.min(0.95, patch.minSavingsRatio))
    if (typeof patch.dedupEnabled === 'boolean') update.headroomDedupEnabled = patch.dedupEnabled
    if (Array.isArray(patch.excludeTools)) update.headroomExcludeTools = patch.excludeTools.map(entry => String(entry).toLowerCase().trim()).filter(entry => entry !== '')
    if (typeof patch.foldReads === 'boolean') update.headroomFoldReads = patch.foldReads
    if (typeof patch.codeSkeletonEnabled === 'boolean') update.headroomCodeSkeletonEnabled = patch.codeSkeletonEnabled
    if (patch.foldPolicy === 'reversible' || patch.foldPolicy === 'max') update.headroomFoldPolicy = patch.foldPolicy
    await settings.update(update)
    return this.headroom.status()
  }

  /**
   * Output shaper (opt-in, both levers default off):
   * - Verbosity steering: registers a byte-stable L1-L4 block at the tail of
   *   the system prompt when `headroomVerbosityLevel` ≥ 1.
   * - Effort routing: lowers an explicitly-set reasoning effort one step on
   *   mechanical tool-continuation turns when `headroomOutputShaper` is on.
   */
  private startOutputShaper(ctx: Context): void {
    const settings = this.policy
    if (settings === undefined) return
    const read = (): { shaper: boolean; verbosity: number } => {
      const value = settings.get() as { headroomOutputShaper?: boolean; headroomVerbosityLevel?: number } | undefined
      return {
        shaper: value?.headroomOutputShaper === true,
        verbosity: typeof value?.headroomVerbosityLevel === 'number' ? Math.max(0, Math.min(4, Math.floor(value.headroomVerbosityLevel))) : 0,
      }
    }
    // Verbosity steering — one registered section whose text is a pure function
    // of the level, so the forwarded bytes are still stable per level
    // (prefix-cache friendly, same contract as the original's system-tail
    // append) while the *level* stays live.
    //
    // Registering per level was the bug this replaces: `systemPrompt.section`
    // refuses a second section with the same name in one scope, so a level change
    // either threw (swallowed here as a startup concern, leaving the first level's
    // steering in place forever) or added a contradictory block, and a level that
    // went back to 0 had nothing left to remove the block at all. The registry's
    // documented answer for a value that changes between assemblies is a text
    // provider: register once, resolve per request. Empty text is dropped by the
    // renderer, so level 0 needs no unregistration.
    try {
      const systemPrompt = ctx.get('systemPrompt') as { section: (section: { readonly name: string; readonly order: number; readonly text: string | (() => string) }) => () => void } | undefined
      systemPrompt?.section({
        name: 'freecodego: headroom output steering',
        order: 9500,
        text: () => steeringText(read().verbosity) ?? '',
      })
    } catch (error) {
      // A missing registry (or one that rejects the name) must never break
      // startup. The steering being absent is a different thing from the level
      // being 0, though: the settings say one thing and every request forwards
      // another, which is the "I set it and it did not apply" failure this
      // provider exists to end — so it is logged rather than inferred.
      ctx.logger.warn(`freecodego: the headroom verbosity steering section was not registered, so the configured level will not reach the model: ${redactCredentialShapes(String(error))}`)
    }
    // Effort routing — clamp-only: on mechanical continuations, an explicitly
    // set effort is lowered one step on the returned call config. Errors and
    // new user asks pass through untouched.
    const lastEventKindsPerAgent = new Map<string, string[]>()
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      const key = String(session.id ?? '')
      if (key === '') return
      const kinds = lastEventKindsPerAgent.get(key) ?? []
      // A failed tool result arrives as an ordinary `tool/result`, so the verdict
      // is read off the payload and recorded as its own token: the classifier sees
      // kinds alone, and without this a turn spent debugging a failure was
      // indistinguishable from a mechanical one and had its effort clamped.
      kinds.push(event?.type === 'tool/result' && isErroredToolResult(event.data) ? ERROR_OUTPUT_EVENT_KIND : (event?.type ?? ''))
      if (kinds.length > 8) kinds.shift()
      lastEventKindsPerAgent.set(key, kinds)
    }), 'freecodego: headroom effort-routing turn tracking')
    // The tail is keyed by session id and nothing ever revisits a disposed
    // session, so it is released here for the same reason the plugin's other
    // per-session maps are released on this event: without it the Host keeps one
    // entry per session it has ever run, forever.
    ctx.effect(() => ctx.on('session/disposed', (session) => {
      lastEventKindsPerAgent.delete(String(session.id ?? ''))
    }), 'freecodego: headroom effort-routing turn tracking cleanup')
    ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      try {
        const { shaper } = read()
        if (!shaper || config.reasoningEffort === undefined) return config
        const agentKey = String(payload.agent?.session?.id ?? '')
        const kinds = lastEventKindsPerAgent.get(agentKey) ?? []
        const turnKind = classifyTurnFromTail(kinds)
        const adjusted = routeEffort(config.reasoningEffort, turnKind, true)
        return adjusted === config.reasoningEffort ? config : { ...config, reasoningEffort: adjusted as typeof config.reasoningEffort }
      } catch {
        return config
      }
    }), 'freecodego: headroom effort routing')  }

  /** Status for the fixed official Graphify Runtime. This check does not start Python. 
   * @returns the engineering Graph Runtime Status.
   */
  @Remote('engineeringGraphRuntimeStatus')
  engineeringGraphRuntimeStatus(): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    return engineeringGraphRuntimeStatus(this.engineeringRemotesHost)
  }

  /** Supported private Graphify Runtime installation sources for this platform. 
   * @returns the engineering Graph Runtime Package rows, in backend order.
   */
  @Remote('engineeringGraphRuntimePackages')
  engineeringGraphRuntimePackages(): Promise<readonly FreeCodeGoEngineeringGraphRuntimePackage[]> {
    return engineeringGraphRuntimePackages(this.engineeringRemotesHost)
  }

  /** Install the fixed official Graphify Wheel into a plugin-private Python environment. 
   * @returns the engineering Graph Runtime Status.
   * @param input - the Python package to install, and the interpreter when an existing one is reused.
   */
  @Remote('engineeringGraphRuntimeInstall')
  engineeringGraphRuntimeInstall(input: { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string }): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    return engineeringGraphRuntimeInstall(this.engineeringRemotesHost, input)
  }

  /** Remove only the plugin-owned Graphify Runtime; project graphs remain preserved. 
   * @returns the engineering Graph Runtime Status.
   */
  @Remote('engineeringGraphRuntimeRemove')
  engineeringGraphRuntimeRemove(): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    return engineeringGraphRuntimeRemove(this.engineeringRemotesHost)
  }

  /** Read the current workspace's Graphify output state without scanning the workspace. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Graph Project Status.
   */
  @Remote('engineeringGraphProjectStatus')
  engineeringGraphProjectStatus(sessionId: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    return engineeringGraphProjectStatus(this.engineeringRemotesHost, sessionId)
  }

  /** Build the official Graphify code graph into DSH_HOME, never into the workspace. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Graph Project Status.
   * @param request - whether the existing graph is rebuilt by force.
   */
  @Remote('engineeringGraphBuild')
  engineeringGraphBuild(sessionId: string, request?: { readonly force?: boolean }): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    return engineeringGraphBuild(this.engineeringRemotesHost, sessionId, request)
  }

    /**
   * Refresh the workspace Graphify graph from what changed since the last build.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the graph project status.
   */
@Remote('engineeringGraphUpdate')
  engineeringGraphUpdate(sessionId: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    return engineeringGraphUpdate(this.engineeringRemotesHost, sessionId)
  }

  /** Abort only the plugin-owned Graphify process tree associated with this workspace. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns true once the plugin-owned build process tree was aborted.
   */
  @Remote('engineeringGraphCancel')
  engineeringGraphCancel(sessionId: string): { readonly cancelled: boolean } {
    return engineeringGraphCancel(this.engineeringRemotesHost, sessionId)
  }

  /** Provide a bounded graph projection to compatible Canvas plugins without leaking raw graph JSON. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Canvas Graph.
   * @param request - the node budget for this projection.
   */
  @Remote('engineeringGraphCanvas')
  engineeringGraphCanvas(sessionId: string, request?: { readonly maxNodes?: number }): Promise<FreeCodeGoEngineeringCanvasGraph> {
    return engineeringGraphCanvas(this.engineeringRemotesHost, sessionId, request)
  }

    /**
   * Drop this workspace's Graphify graph and its caches.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the graph project status.
   */
@Remote('engineeringGraphClearProject')
  engineeringGraphClearProject(sessionId: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    return engineeringGraphClearProject(this.engineeringRemotesHost, sessionId)
  }

  /** Status for the self-contained CodeGraph Runtime (bundled Node, no Python). 
   * @returns the engineering Code Graph Runtime Status.
   */
  @Remote('engineeringCodeGraphRuntimeStatus')
  engineeringCodeGraphRuntimeStatus(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    return engineeringCodeGraphRuntimeStatus(this.engineeringRemotesHost)
  }

  /** The verified CodeGraph platform bundle for this OS/CPU, when one exists. 
   * @returns the engineering Code Graph Runtime Package rows, in backend order.
   */
  @Remote('engineeringCodeGraphRuntimePackages')
  engineeringCodeGraphRuntimePackages(): Promise<readonly FreeCodeGoEngineeringCodeGraphRuntimePackage[]> {
    return engineeringCodeGraphRuntimePackages(this.engineeringRemotesHost)
  }

  /** Download and install the SHA-256 verified official CodeGraph bundle. 
   * @returns the engineering Code Graph Runtime Status.
   */
  @Remote('engineeringCodeGraphRuntimeInstall')
  engineeringCodeGraphRuntimeInstall(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    return engineeringCodeGraphRuntimeInstall(this.engineeringRemotesHost)
  }

  /** Remove only the plugin-owned CodeGraph Runtime; workspace indexes stay. 
   * @returns the engineering Code Graph Runtime Status.
   */
  @Remote('engineeringCodeGraphRuntimeRemove')
  engineeringCodeGraphRuntimeRemove(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    return engineeringCodeGraphRuntimeRemove(this.engineeringRemotesHost)
  }

  /** Read the current workspace's CodeGraph index state. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Code Graph Project Status.
   */
  @Remote('engineeringCodeGraphProjectStatus')
  engineeringCodeGraphProjectStatus(sessionId: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    return engineeringCodeGraphProjectStatus(this.engineeringRemotesHost, sessionId)
  }

  /** Initialize or refresh the workspace CodeGraph index. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engineering Code Graph Project Status.
   * @param request - whether the existing index is rebuilt by force.
   */
  @Remote('engineeringCodeGraphBuild')
  engineeringCodeGraphBuild(sessionId: string, request?: { readonly force?: boolean }): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    return engineeringCodeGraphBuild(this.engineeringRemotesHost, sessionId, request)
  }

    /**
   * Re-index only the files that changed since the last CodeGraph build.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the codegraph project status.
   */
@Remote('engineeringCodeGraphSync')
  engineeringCodeGraphSync(sessionId: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    return engineeringCodeGraphSync(this.engineeringRemotesHost, sessionId)
  }

    /**
   * Abort the plugin-owned CodeGraph indexing process tree for this workspace.
   * @param sessionId - the Harness session this operation acts on.
   * @returns true once the build process tree was aborted.
   */
@Remote('engineeringCodeGraphCancel')
  engineeringCodeGraphCancel(sessionId: string): { readonly cancelled: boolean } {
    return engineeringCodeGraphCancel(this.engineeringRemotesHost, sessionId)
  }

    /**
   * Drop this workspace's CodeGraph index and its caches.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the codegraph project status.
   */
@Remote('engineeringCodeGraphClearProject')
  engineeringCodeGraphClearProject(sessionId: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    return engineeringCodeGraphClearProject(this.engineeringRemotesHost, sessionId)
  }

  /** Permanently delete one idle session and withdraw it from workspace navigation. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns true once the session is gone.
   */
  @Remote('sessionDelete')
  async sessionDelete(sessionId: string): Promise<{ readonly deleted: true }> {
    return sessionDelete(this.engineRemotesHost, sessionId)
  }

  /** Return the current cross-engine MCP and Skill capability inventory. 
   * @returns the capability snapshot the Host reports.
   */
  @Remote('capabilities')
  async capabilitiesSnapshot(): Promise<FreeCodeGoCapabilitySnapshot> {
    return capabilitiesSnapshot(this.engineRemotesHost)
  }

  /** Persist MCP and Skill switches; disabled capabilities are not mounted for future sessions. 
   * @returns the capability snapshot the Host reports.
   * @param input - the capability switches to persist.
   */
  @Remote('capabilitiesSetEnabled')
  async capabilitiesSetEnabled(input: { readonly mcpEnabled?: boolean; readonly skillEnabled?: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean }): Promise<FreeCodeGoCapabilitySnapshot> {
    return capabilitiesSetEnabled(this.engineRemotesHost, input)
  }

  /** Persist a manual model capability category without altering native provider settings. 
   * @returns the capability snapshot the Host reports.
   * @param input - the model key and the category to store for it.
   */
  @Remote('modelCategorySet')
  async modelCategorySet(input: { readonly key: string; readonly category?: FreeCodeGoModelCategory }): Promise<FreeCodeGoCapabilitySnapshot> {
    return modelCategorySet(this.engineRemotesHost, input)
  }

  /** Read automatic third-party plugin conflict protection state and repair history. 
   * @returns the plugin Conflict Status.
   */
  @Remote('pluginConflictStatus')
  pluginConflictStatus(): FreeCodeGoPluginConflictStatus {
    return pluginConflictStatus(this.engineRemotesHost)
  }

  /** Enable or disable automatic third-party plugin conflict prevention. 
   * @param enabled - whether this capability is switched on.
   * @returns the plugin Conflict Status.
   */
  @Remote('pluginConflictSetEnabled')
  async pluginConflictSetEnabled(enabled: boolean): Promise<FreeCodeGoPluginConflictStatus> {
    return pluginConflictSetEnabled(this.engineRemotesHost, enabled)
  }

  /** Save one third-party stdio or Streamable HTTP MCP server. 
   * @returns the capability snapshot the Host reports.
   * @param input - the MCP server to save, carrying its id when it already exists.
   */
  @Remote('mcpSave')
  async mcpSave(input: Omit<FreeCodeGoMcpServer, 'id'> & { readonly id?: string }): Promise<FreeCodeGoCapabilitySnapshot> {
    return mcpSave(this.engineRemotesHost, input)
  }

  /** Remove one third-party MCP server. 
   * @returns the capability snapshot the Host reports.
   * @param id - id of the MCP server to remove.
   */
  @Remote('mcpRemove')
  async mcpRemove(id: string): Promise<FreeCodeGoCapabilitySnapshot> {
    return mcpRemove(this.engineRemotesHost, id)
  }

  /** Save one additional filesystem Skill root. 
   * @returns the capability snapshot the Host reports.
   * @param input - the Skill root to save, carrying its id when it already exists.
   */
  @Remote('skillRootSave')
  async skillRootSave(input: Omit<FreeCodeGoSkillRoot, 'id'> & { readonly id?: string }): Promise<FreeCodeGoCapabilitySnapshot> {
    return skillRootSave(this.engineRemotesHost, input)
  }

  /** Remove one additional filesystem Skill root. 
   * @returns the capability snapshot the Host reports.
   * @param id - id of the Skill root to remove.
   */
  @Remote('skillRootRemove')
  async skillRootRemove(id: string): Promise<FreeCodeGoCapabilitySnapshot> {
    return skillRootRemove(this.engineRemotesHost, id)
  }

    /**
   * Persist whether one Skill may be invoked by the model alone.
   * @param input - the Skill name and its model-invocability.
   * @returns the capability snapshot the Host reports.
   */
@Remote('skillInvocationSet')
  async skillInvocationSet(input: { readonly name: string; readonly modelInvocable?: boolean }): Promise<FreeCodeGoCapabilitySnapshot> {
    return skillInvocationSet(this.engineRemotesHost, input)
  }

  /**
   * Read one Skill's body, or one of its companion files, for the library dialog.
   *
   * The settings library lists user-invoked Skills too, so this cannot reuse the
   * model-facing `loadSkill`, which rejects anything without
   * `modelInvocable` and would leave the entries the dialog matters most for
   * unreadable.
   * @returns the skill Detail.
   * @param input - the Skill and the companion file to read.
   */
  @Remote('skillDetail')
  async skillDetail(input: FreeCodeGoSkillDetailRequest): Promise<FreeCodeGoSkillDetail> {
    return skillDetail(this.engineRemotesHost, input)
  }

  /** Read one bounded page from the public MCP.so or skills.sh directory. 
   * @returns the capability Marketplace Page.
   * @param input - the directory query and its page cursor.
   */
  @Remote('capabilityMarketplace')
  async capabilityMarketplace(input: FreeCodeGoCapabilityMarketplaceRequest): Promise<FreeCodeGoCapabilityMarketplacePage> {
    return capabilityMarketplace(this.communityHost, input)
  }

  /** Add a public MCP.so entry when its published configuration can be represented by the shared runtime. 
   * @returns the capability snapshot the Host reports.
   * @param id - id of the public MCP.so entry to add.
   */
  @Remote('mcpPresetInstall')
  async mcpPresetInstall(id: string): Promise<FreeCodeGoCapabilitySnapshot> {
    return mcpPresetInstall(this.communityHost, id)
  }

  /** Import one skills.sh entry from its verified GitHub source repository. 
   * @returns the capability snapshot the Host reports.
   * @param id - id of the skills.sh entry to import.
   */
  @Remote('skillPresetInstall')
  async skillPresetInstall(id: string, placement?: FreeCodeGoSkillPlacement): Promise<FreeCodeGoCapabilitySnapshot> {
    return skillPresetInstall(this.communityHost, id, placement)
  }

  /**
   * The Skill placement matrix, as the settings page shows it.
   *
   * Its own Remote rather than a field on the catalog response: the rows depend on
   * the *folder* — whether it is trusted, and where it is — and a page that read them
   * out of a cached catalog would keep offering a project install after the folder
   * stopped being trusted.
   * @returns the resolved rows and the folder they were resolved against.
   */
  @Remote('skillPlacements')
  async skillPlacements(): Promise<FreeCodeGoSkillPlacements> {
    return skillPlacements(this.communityHost)
  }

  /**
   * Remember where a Skill install should land, or clear the preference.
   *
   * The axes travel, not a path: the Host resolves them again at install time, so a
   * stored preference keeps meaning the same *choice* even after the folder it was
   * chosen in has moved or lost its trust.
   * @param input - the two axes to prefer, or neither to go back to the community root.
   * @returns the capability snapshot the Host reports.
   */
  @Remote('skillPlacementPrefer')
  async skillPlacementPrefer(input?: { readonly agent?: 'harness' | 'agents'; readonly scope?: 'project' | 'user' }): Promise<FreeCodeGoCapabilitySnapshot> {
    // No argument is the clear: a caller that names no axes is going back to the
    // community root, which is the one request that has nothing to say about a
    // destination. A *partial* pair is refused below, by the registry.
    return this.capabilities.setPreferredSkillPlacement(input ?? {})
  }

  /** Remove one Skill an earlier Marketplace install added to the managed root.
   * @returns the capability snapshot, carrying what was removed.
   * @param id - id of the skills.sh entry to remove.
   */
  @Remote('skillPresetRemove')
  async skillPresetRemove(id: string): Promise<FreeCodeGoCapabilitySnapshot> {
    return skillPresetRemove(this.communityHost, id)
  }

  /** Resolve native-worker requests through the same Host-owned capability inventory used by DeepSeek. 
   * @returns the backend payload, of unknown shape.
   * @param request - the bridge call the native worker asked for.
   */
  async claudeBridgeHandle(request: { readonly bridge: string; readonly op: string; readonly input: unknown; readonly sessionId: string; readonly workspaceRoot?: string; readonly signal: AbortSignal }): Promise<unknown> {
    return claudeBridgeHandle(this.engineRemotesHost, request)
  }

  /**
   * Judge one *native engine* tool call against the FreeCodeGo guards.
   *
   * The engine's own file and shell tools never enter the Harness tool
   * registry, so the guards installed there cannot see them; this is the seam
   * that closes that gap, called from the root agent's permission handler — the
   * one place both native transports report a pending call.
   *
   * Deny-only: it returns a refusal message or `undefined`, and `undefined`
   * means the call proceeds to the engine's own approval exactly as before. A
   * request this module cannot classify also returns `undefined`.
   *
   * The doom-loop tier is this path's alone, and that is the point of it. The
   * calls judged here never cross `tools/pre-execute` — they run inside the
   * engine's process — so the Harness's advisory `dsh-repeat-tool-reminder`
   * cannot see them and `freeCodeGoToolGuard` no longer carries a loop tier to
   * duplicate it on the calls it does see. An identical retry loop on a native
   * engine's own shell is therefore only ever stopped here.
   *
   * The agent the request belongs to is bound here rather than passed onward:
   * the guard keys its fingerprints by agent, and every call in one request
   * belongs to one agent, so the projection carries the key the guard reads.
   *
   * @param request - the transport's tool name (Claude) or method (Codex), its detail, and the agent it belongs to.
   * @returns the refusal to report to the model, or `undefined` to leave the call alone.
   */
  async nativeToolGuard(request: {
    readonly toolName?: unknown
    readonly method?: unknown
    readonly detail?: unknown
    readonly agent?: unknown
  }): Promise<string | undefined> {
    const calls = nativeCallsFromPermission(request)
    if (calls.length === 0) return undefined
    // Plan Mode is read once per request: every call in one request belongs to
    // the same agent, and a mode flip mid-request is not a case worth racing.
    const mode = this.planModeModeFor(request.agent)
    // Resolved once per request, beside the mode and for the same reason: every
    // call in one request belongs to the same agent, so every call in it belongs
    // to the same repository.
    const projectPolicy = this.projectPolicyForAgent(request.agent)
    const agent = request.agent as Parameters<DoomLoopGuard['deny']>[0]['agent']
    for (const call of calls) {
      const denial = await nativeToolDenial(call, {
        settings: () => this.policy.get(),
        policy: this.commandPolicy,
        ...(projectPolicy === undefined ? {} : { projectPolicy }),
        planMode: { mode, policy: this.commandPolicy },
        deny: this.denyPatterns(),
        doomLoop: {
          // `DoomLoopGuard.deny` reads `name`, `arguments`, and `agent.id`; the
          // rest of a `ToolExecution` (call id, signal, scope) is absent for a
          // call the Host never dispatched, so this is a narrowed view rather
          // than a fabricated execution.
          deny: projected => this.doomLoopGuard.deny({
            name: projected.name,
            arguments: projected.arguments,
            ...(agent === undefined ? {} : { agent }),
          } as unknown as Parameters<DoomLoopGuard['deny']>[0]),
        },
      }).catch(() => undefined)
      if (denial !== undefined) return denial
    }
    return undefined
  }

  /** Public, credential-free community catalog used by the embedded settings page. 
   * @returns the community Catalog Payload.
   */
  @Remote('communityCatalog')
  async communityCatalog(): Promise<CommunityCatalogPayload> {
    return communityCatalog(this.communityHost)
  }

  /** Resolve only verified repository artwork; never synthesize a plugin identity. 
   * @param urls - the repository artwork URLs to resolve.
   * @returns the resolved artwork, keyed by repository URL.
   */
  @Remote('communityCatalogIcons')
  async communityCatalogIcons(urls: readonly string[]): Promise<Record<string, string>> {
    return communityCatalogIcons(this.communityHost, urls)
  }

    /**
   * Describe the runtime this profile would install community plugins into.
   * @returns the Node, platform, and profile facts the installer surface shows.
   */
@Remote('communityEnvironment')
  async communityEnvironment(): Promise<{ readonly ready: boolean; readonly platform: string; readonly node: string; readonly profile: string }> {
    return communityEnvironment(this.communityHost)
  }

    /**
   * List the community plugins installed in this profile and how each of them activated.
   * @returns the installed versions, activation states, and the sources they came from.
   */
@Remote('communityInstalled')
  async communityInstalled(): Promise<{ readonly installed: Record<string, string>; readonly activation: Record<string, { readonly state: string }>; readonly sources: Record<string, readonly string[]>; readonly restartRequired: boolean }> {
    return communityInstalled(this.communityHost)
  }

    /**
   * Install one community plugin from its published URL.
   * @param url - the plugin's published URL.
   * @returns the installed package names, and that a restart is required.
   */
@Remote('communityInstall')
  async communityInstall(url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
    return communityInstall(this.communityHost, url)
  }

  /** Remove an installed community plugin from the running profile and its next boot. 
   * @param url - absolute URL the request is sent to.
   * @returns the removed package names, and that a restart is required.
   */
  @Remote('communityUninstall')
  async communityUninstall(url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
    return communityUninstall(this.communityHost, url)
  }

  /** Shared base of every cluster dependency view below. The view is rebuilt
   * at each access (so configureGateway()'s rebuilt clients and instance-level
   * test overrides stay visible) and members that correspond to plugin methods
   * delegate back to the live instance so overrides keep working. Each host
   * getter spreads this base and adds its cluster-specific members. */
  private get coreDeps() {
    return {
      ctx: this.ctx,
      account: this.account,
      api: this.api,
      credentials: this.credentials,
      agnes: this.agnes,
      cline: this.cline,
      policy: this.policy,
      capabilities: this.capabilities,
      catalogs: this.catalogs,
      codexRuntime: () => this.codexRuntime,
      claudeRuntime: () => this.claudeRuntime,
      restoreAccount: () => this.restoreAccount(),
      configuredProviderRoute: (model: string) => this.configuredProviderRoute(model),
      directConnection: (model: string | undefined, allowExternalProviders?: boolean) => this.directConnection(model, allowExternalProviders),
      managedRuntime: (model?: string) => this.managedRuntime(model),
      generateImageWithFallback: (args: ImageGenerationArgs, signal: AbortSignal) => this.generateImageWithFallback(args, signal),
      generateVideoWithFallback: (args: MediaVideoArgs, signal: AbortSignal) => this.generateVideoWithFallback(args, signal),
    }
  }

  private get communityHost(): CommunityRemotesHost {
    return {
      ...this.coreDeps,
      state: this.communityState,
      communityCatalog: () => this.communityCatalog(),
      communityProfileDirectory: () => this.communityProfileDirectory(),
      communitySkillDirectory: () => this.communitySkillDirectory(),
      communityRuntimeStartTime: () => this.communityRuntimeStartTime(),
      skillPlacementContext: () => this.skillPlacementContext(),
    }
  }

  /**
   * The roots and the folder trust the Skill placement matrix resolves against.
   *
   * Read here rather than in the remote because this class is what knows the data
   * home, the home directory, and — through the same trust resolution every other
   * workspace-scoped reader uses — whether the folder this process runs in has been
   * trusted. The workspace is `process.cwd()`, the same answer
   * `trustFolderStatus` gives when asked about "this Host", so a settings panel that
   * shows a folder as trusted and a placement panel that refuses a project install
   * cannot be looking at two different checkouts.
   *
   * `workspace` falls back to the resolved directory when it is not inside a
   * repository: the field names where a project install would land, and `undefined`
   * would say "no folder" about a folder that merely has no repository root. The
   * project rows refuse it on their own (`not-a-repository`), which is the reason
   * worth showing.
   */
  private async skillPlacementContext(): Promise<PlacementContext> {
    const directory = process.cwd()
    const resolution = await this.resolveTrust(directory)
    return {
      workspace: resolution.root ?? path.resolve(directory),
      dataHome: harnessHomeDirectory(),
      home: homedir(),
      projectTrusted: resolution.decision?.trusted === true,
    }
  }

  private communityRuntimeStartTime(): number {
    const loader = this.ctx.get('loader') as { readonly envData?: { readonly startTime?: unknown } } | undefined
    const startTime = loader?.envData?.startTime
    return typeof startTime === 'number' && Number.isFinite(startTime) ? startTime : PROCESS_START_TIME
  }

  private communityProfileDirectory(): string {
    const index = process.argv.indexOf('--profile')
    const profile = index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : 'web'
    return path.join(harnessHomeDirectory(), 'profiles', profile)
  }

  private communitySkillDirectory(): string {
    return path.join(harnessHomeDirectory(), 'skills', 'freecodego-community')
  }

  /** Return the redacted engine directory consumed by settings surfaces. 
   * @returns the engine directory settings surfaces render.
   */
  @Remote('catalog')
  catalog(): { readonly defaultEngine: FreeCodeGoEngineId; readonly defaultModel?: string; readonly engines: readonly FreeCodeGoEngineSnapshot[] } {
    return catalog(this.engineRemotesHost)
  }

  /**
   * The generic Harness SessionController catalog intentionally carries only
   * portable model fields. Preserve FreeCodeGo credential readiness here so
   * our private picker can render known-but-unconfigured routes as disabled.
   * @returns the model Availability rows, in backend order.
   */
  @Remote('modelAvailability')
  async modelAvailability(): Promise<readonly FreeCodeGoModelAvailability[]> {
    return modelAvailability(this.engineRemotesHost)
  }

  /** Session-local execution fact for the UI. This is log-derived rather than
   * inferred from the currently selected toolbar default. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the engine fact recorded for that session.
   */
  @Remote('sessionEngineStatus')
  async sessionEngineStatus(sessionId: string): Promise<{ readonly engine: string; readonly executor: 'native' | 'adapter-loop'; readonly provider: string; readonly model: string }> {
    return sessionEngineStatus(this.engineRemotesHost, sessionId)
  }

    /**
   * Report whether the optional Codex runtime is installed.
   * @returns the runtime's install state.
   */
@Remote('codexRuntimeStatus')
  codexRuntimeStatus(): FreeCodeGoCodexRuntimeStatus { return this.codexRuntime.status() }

    /**
   * Install one official Codex runtime package.
   * @param packageID - the package to install; defaults to this platform's.
   * @returns the install state after the swap.
   */
@Remote('codexRuntimeInstall')
  async codexRuntimeInstall(packageID?: string): Promise<FreeCodeGoCodexRuntimeStatus> {
    return codexRuntimeInstall(this.engineRemotesHost, packageID)
  }

    /**
   * List the Codex runtime packages this platform can install.
   * @returns one row per known package, flagged for compatibility.
   */
@Remote('codexRuntimePackages')
  async codexRuntimePackages(): Promise<readonly FreeCodeGoRuntimePackage[]> { return (await this.codexRuntime.packages()).map(runtimePackageView) }

    /**
   * Remove the installed Codex runtime.
   * @returns the install state after removal.
   */
@Remote('codexRuntimeRemove')
  async codexRuntimeRemove(): Promise<FreeCodeGoCodexRuntimeStatus> {
    return codexRuntimeRemove(this.engineRemotesHost)
  }

    /**
   * Report whether the optional Claude Agent SDK runtime is installed.
   * @returns the runtime's install state.
   */
@Remote('claudeRuntimeStatus')
  claudeRuntimeStatus(): FreeCodeGoClaudeRuntimeStatus { return this.claudeRuntime.status() }

    /**
   * Install one official Claude Agent SDK runtime package.
   * @param packageID - the package to install; defaults to this platform's.
   * @returns the install state after the swap.
   */
@Remote('claudeRuntimeInstall')
  async claudeRuntimeInstall(packageID?: string): Promise<FreeCodeGoClaudeRuntimeStatus> {
    return claudeRuntimeInstall(this.engineRemotesHost, packageID)
  }

    /**
   * List the Claude Agent SDK runtime packages this platform can install.
   * @returns one row per known package, flagged for compatibility.
   */
@Remote('claudeRuntimePackages')
  claudeRuntimePackages(): readonly FreeCodeGoRuntimePackage[] { return this.claudeRuntime.packages().map(runtimePackageView) }

    /**
   * Remove the installed Claude Agent SDK runtime.
   * @returns the install state after removal.
   */
@Remote('claudeRuntimeRemove')
  async claudeRuntimeRemove(): Promise<FreeCodeGoClaudeRuntimeStatus> { return claudeRuntimeRemove(this.engineRemotesHost) }

  /** Read the Host-owned FreeCodeGo package update state. 
   * @returns the current update state.
   */
  @Remote('pluginUpdateStatus')
  pluginUpdateStatus(): import('./types.ts').FreeCodeGoPluginUpdateStatus { return this.pluginUpdates.status() }

  /** Check the configured NPM registry for a newer FreeCodeGo package. 
   * @returns the update state after the registry check.
   */
  @Remote('pluginUpdateCheck')
  async pluginUpdateCheck(): Promise<import('./types.ts').FreeCodeGoPluginUpdateStatus> { return this.pluginUpdates.check(true) }

  /** Enable or disable periodic FreeCodeGo update checks. 
   * @param enabled - whether this capability is switched on.
   * @returns the update state after the change.
   */
  @Remote('pluginUpdateSetEnabled')
  async pluginUpdateSetEnabled(enabled: boolean): Promise<import('./types.ts').FreeCodeGoPluginUpdateStatus> { return this.pluginUpdates.setEnabled(enabled) }

  /** Restore the retained pre-update Profile and require a Host restart. 
   * @returns the update state after the rollback.
   */
  @Remote('pluginUpdateRollback')
  async pluginUpdateRollback(): Promise<import('./types.ts').FreeCodeGoPluginUpdateStatus> { return this.pluginUpdates.rollback() }

  /** Install the checked package version; a Harness restart is required. 
   * @returns the update state after the install.
   */
  @Remote('pluginUpdateInstall')
  async pluginUpdateInstall(): Promise<import('./types.ts').FreeCodeGoPluginUpdateStatus> { return this.pluginUpdates.install() }

    /**
   * Read the account state the settings surface renders.
   * @returns the account snapshot.
   */
@Remote('accountStatus')
  async accountStatus(): Promise<FreeCodeGoAccountSnapshot> {
    return accountStatus(this.accountRemotesHost)
  }

    /**
   * Read the account's backend profile for the settings surface.
   * @returns the backend payload, or the reason it is unavailable.
   */
@Remote('accountDetail')
  async accountDetail(): Promise<FreeCodeGoBackendSnapshot> {
    return accountDetail(this.accountRemotesHost)
  }

    /**
   * Create an account and sign in with the credentials just registered.
   * @param input - registration details and the remember-me intent of this attempt.
   * @returns the account snapshot after the sign-in.
   */
@Remote('accountRegister')
  async register(input: FreeCodeGoRegistrationRequest): Promise<FreeCodeGoAccountSnapshot> {
    return register(this.accountRemotesHost, input)
  }

    /**
   * Send the registration verification code to one address.
   * @param email - the address the code is sent to.
   * @returns the countdown a resend control waits for.
   */
@Remote('accountSendVerifyCode')
  async sendVerifyCode(email: string): Promise<{ readonly countdown: number }> {
    return sendVerifyCode(this.accountRemotesHost, email)
  }

    /**
   * Sign in with a password, keeping the issued tokens in the Host vault.
   * @param input - credentials and the remember-me intent of this attempt.
   * @returns the account snapshot after the sign-in.
   */
@Remote('accountLogin')
  async login(input: FreeCodeGoLoginRequest): Promise<FreeCodeGoAccountSnapshot> {
    return login(this.accountRemotesHost, input)
  }

    /**
   * Read the password this machine remembers for the sign-in form.
   * @returns the remembered password, or `undefined` when the user never asked to keep one.
   */
@Remote('accountRememberedPassword')
  async rememberedPassword(): Promise<{ readonly password?: string }> {
    return readRememberedPassword(this.accountRemotesHost)
  }

  /**
   * Federated sign-in (Google / GitHub). Opens the provider authorization
   * page in the system browser and polls the backend handoff until the issued
   * pair lands in the Host vault; see `oauth-login.ts`.
   * @returns the account Snapshot.
   * @param provider - which federated provider to sign in with.
   */
  @Remote('accountOAuthLogin')
  async oauthLogin(provider: 'google' | 'github'): Promise<FreeCodeGoAccountSnapshot> {
    return accountOAuthLogin(this.accountRemotesHost, provider)
  }

  /** Read the pending federated registration the browser step left behind. 
   * @returns the pending registration, or `undefined` when none is waiting.
   */
  @Remote('accountOAuthPendingStatus')
  async oauthPendingStatus(): Promise<OAuthLoginPendingRegistration | undefined> {
    return accountOAuthPendingStatus(this.accountRemotesHost)
  }

  /** Send the registration verification email for the pending session. 
   * @param email - the address the code is sent to.
   * @returns the countdown a resend control waits for.
   */
  @Remote('accountOAuthPendingSendVerifyCode')
  async oauthPendingSendVerifyCode(email: string): Promise<{ readonly countdown: number }> {
    return accountOAuthPendingSendVerifyCode(this.accountRemotesHost, email)
  }

  /** Bind the pending federated identity to an existing password account. 
   * @returns the account Snapshot.
   * @param input - the existing account's credentials and an optional second factor.
   */
  @Remote('accountOAuthPendingBind')
  async oauthPendingBind(input: { readonly email: string; readonly password: string; readonly totpCode?: string }): Promise<FreeCodeGoAccountSnapshot> {
    return accountOAuthPendingBind(this.accountRemotesHost, input)
  }

  /** Create a new account from the pending federated identity. 
   * @returns the account Snapshot.
   * @param input - the new account's credentials and codes.
   */
  @Remote('accountOAuthPendingCreate')
  async oauthPendingCreate(input: { readonly email: string; readonly password: string; readonly verifyCode?: string; readonly invitationCode?: string }): Promise<FreeCodeGoAccountSnapshot> {
    return accountOAuthPendingCreate(this.accountRemotesHost, input)
  }

    /**
   * Complete the pending two-factor challenge.
   * @param totpCode - the code the user's authenticator produced.
   * @param deviceId - device identifier recorded with the session.
   * @returns the account snapshot after the second factor.
   */
@Remote('accountMfaComplete')
  async completeMfa(totpCode: string, deviceId?: string): Promise<FreeCodeGoAccountSnapshot> {
    return completeMfa(this.accountRemotesHost, totpCode, deviceId)
  }

    /**
   * Rotate the stored session token.
   * @param deviceId - device identifier recorded with the rotated session.
   * @returns the account snapshot after the rotation.
   */
@Remote('accountRefresh')
  async refreshAccount(deviceId?: string): Promise<FreeCodeGoAccountSnapshot> {
    return refreshAccount(this.accountRemotesHost, deviceId)
  }

    /**
   * Sign out and erase the stored session from the Host vault.
   * @returns the signed-out account snapshot.
   */
@Remote('accountLogout')
  async logout(): Promise<FreeCodeGoAccountSnapshot> {
    return logout(this.accountRemotesHost)
  }

  /** List the desktop sessions of the signed-in account for the Settings page. 
   * @returns the device Sessions.
   */
  @Remote('accountDeviceSessions')
  async deviceSessions(): Promise<FreeCodeGoDeviceSessions> {
    return deviceSessions(this.accountRemotesHost)
  }

    /**
   * Revoke one device session and report the sessions that remain.
   * @param deviceId - id of the device session to revoke.
   * @returns the sessions the account still has.
   */
@Remote('accountRevokeDeviceSession')
  async revokeDeviceSession(deviceId: string): Promise<FreeCodeGoDeviceSessions> {
    return revokeDeviceSession(this.accountRemotesHost, deviceId)
  }

  /** Revoke every session, including this device's; returns how many were revoked. 
   * @returns how many sessions the backend revoked.
   */
  @Remote('accountRevokeAllSessions')
  async revokeAllSessions(): Promise<number> {
    return revokeAllSessions(this.accountRemotesHost)
  }

  /** Fetch a redacted remote catalog using the Host vault; tokens never cross this Remote boundary. 
   * @returns the managed Catalog.
   */
  async managedCatalog(): Promise<FreeCodeGoManagedCatalog> { return managedCatalog(this.engineRemotesHost) }

  /** Return the existing backend model directory without exposing access tokens. 
   * @returns the managed Catalog.
   */
  @Remote('backendCatalog')
  async backendCatalog(): Promise<FreeCodeGoManagedCatalog> {
    return backendCatalog(this.accountRemotesHost)
  }

    /**
   * Read the Vyce account and key state.
   * @returns the status the settings surface renders.
   */
@Remote('vyceStatus')
  async vyceStatus(): Promise<FreeCodeGoVyceStatus> {
    return vyceStatus(this.accountRemotesHost)
  }

    /**
   * Store the Vyce API key in the Host credential vault.
   * @param value - the key to store; an empty value clears it.
   * @returns the status after the change.
   */
@Remote('vyceSetKey')
  async vyceSetKey(value: string): Promise<FreeCodeGoVyceStatus> {
    return vyceSetKey(this.accountRemotesHost, value)
  }

    /**
   * Transcribe one recorded clip through Groq Whisper.
   * @param audioBase64 - the recorded audio, base64 encoded.
   * @param mimeType - the recording's MIME type.
   * @param language - the expected spoken language, when the caller knows it.
   * @returns the transcript and the model that produced it.
   */
@Remote('groqWhisperTranscribe')
  async groqWhisperTranscribe(audioBase64: string, mimeType: string, language?: string): Promise<{ readonly text: string; readonly model: string }> {
    return groqWhisperTranscribe(this.accountRemotesHost, audioBase64, mimeType, language)
  }

    /**
   * Read the Logfare account and key state.
   * @returns the status the settings surface renders.
   */
@Remote('logfareStatus')
  async logfareStatus(): Promise<FreeCodeGoLogfareStatus> {
    return logfareStatus(this.accountRemotesHost)
  }

    /**
   * Store the Logfare API key in the Host credential vault.
   * @param value - the key to store; an empty value clears it.
   * @returns the status after the change.
   */
@Remote('logfareSetKey')
  async logfareSetKey(value: string): Promise<FreeCodeGoLogfareStatus> {
    return logfareSetKey(this.accountRemotesHost, value)
  }

    /**
   * Create a Logfare account from the settings surface.
   * @param input - the registration details.
   * @returns the status after the registration.
   */
@Remote('logfareRegister')
  async logfareRegister(input: FreeCodeGoLogfareRegistrationRequest): Promise<FreeCodeGoLogfareStatus> {
    return logfareRegister(this.accountRemotesHost, input)
  }

    /**
   * Record whether this account's traffic may be used for training.
   * @param enabled - whether this capability is switched on.
   * @returns the status after the change.
   */
@Remote('logfareSetTrainingOptIn')
  async logfareSetTrainingOptIn(enabled: boolean): Promise<FreeCodeGoLogfareStatus> {
    return logfareSetTrainingOptIn(this.accountRemotesHost, enabled)
  }

    /**
   * Read the SenseNova account and key state.
   * @returns the status the settings surface renders.
   */
@Remote('sensenovaStatus')
  async sensenovaStatus(): Promise<FreeCodeGoSenseNovaStatus> {
    return sensenovaStatus(this.accountRemotesHost)
  }

    /**
   * Store the SenseNova API key in the Host credential vault.
   * @param value - the key to store; an empty value clears it.
   * @returns the status after the change.
   */
@Remote('sensenovaSetKey')
  async sensenovaSetKey(value: string): Promise<FreeCodeGoSenseNovaStatus> {
    return sensenovaSetKey(this.accountRemotesHost, value)
  }

    /**
   * Read the NVIDIA account and key state.
   * @returns the status the settings surface renders.
   */
@Remote('nvidiaStatus')
  async nvidiaStatus(): Promise<FreeCodeGoNvidiaStatus> {
    return nvidiaStatus(this.accountRemotesHost)
  }

    /**
   * Store the NVIDIA API key in the Host credential vault.
   * @param value - the key to store; an empty value clears it.
   * @returns the status after the change.
   */
@Remote('nvidiaSetKey')
  async nvidiaSetKey(value: string): Promise<FreeCodeGoNvidiaStatus> {
    return nvidiaSetKey(this.accountRemotesHost, value)
  }

  // ============================================================================
  // WorkBuddy International Edition (workbuddy.ai)
  // ============================================================================

    /**
   * Read the WorkBuddy accounts, the active one, and its credits.
   * @returns the status the settings surface renders.
   */
@Remote('workbuddyStatus')
  async workbuddyStatus(): Promise<WorkBuddyInternationalStatus> {
    return workbuddyStatus(this.accountRemotesHost)
  }

    /**
   * Import the desktop client's existing WorkBuddy login.
   * @returns the status after the import.
   */
@Remote('workbuddyImportDesktopLogin')
  async workbuddyImportDesktopLogin(): Promise<WorkBuddyInternationalStatus> {
    return workbuddyImportDesktopLogin(this.accountRemotesHost)
  }

    /**
   * Open the WorkBuddy web sign-in page in the system browser.
   * @returns whether a browser opened, and the URL it was sent to.
   */
@Remote('workbuddyOpenSignIn')
  async workbuddyOpenSignIn(): Promise<{ readonly opened: boolean; readonly url: string }> {
    return workbuddyOpenSignIn(this.accountRemotesHost)
  }

    /**
   * Start the WorkBuddy browser sign-in handshake.
   * @returns the state a poll continues with.
   */
@Remote('workbuddyStartBrowserLogin')
  async workbuddyStartBrowserLogin(): Promise<WorkBuddyBrowserLogin> {
    return workbuddyStartBrowserLogin(this.accountRemotesHost)
  }

    /**
   * Poll the WorkBuddy browser sign-in handshake.
   * @param state - the handshake state the start call returned.
   * @returns the outcome of this poll.
   */
@Remote('workbuddyPollBrowserLogin')
  async workbuddyPollBrowserLogin(state: string): Promise<WorkBuddyLoginPoll> {
    return workbuddyPollBrowserLogin(this.accountRemotesHost, state)
  }

    /**
   * Sign every WorkBuddy account out and clear the stored sessions.
   * @returns the signed-out status.
   */
@Remote('workbuddyLogout')
  async workbuddyLogout(): Promise<WorkBuddyInternationalStatus> {
    return workbuddyLogout(this.accountRemotesHost)
  }

    /**
   * Forget one WorkBuddy account locally.
   * @param accountId - id of the account to remove.
   * @returns the status after the removal.
   */
@Remote('workbuddyRemoveAccount')
  async workbuddyRemoveAccount(accountId: string): Promise<WorkBuddyInternationalStatus> {
    return workbuddyRemoveAccount(this.accountRemotesHost, accountId)
  }

    /**
   * Choose which WorkBuddy account carries new requests.
   * @param accountId - id of the account to activate.
   * @returns the status after the change.
   */
@Remote('workbuddySetActiveAccount')
  async workbuddySetActiveAccount(accountId: string): Promise<WorkBuddyInternationalStatus> {
    return workbuddySetActiveAccount(this.accountRemotesHost, accountId)
  }

    /**
   * Exchange a WorkBuddy refresh token for a fresh pair.
   * @param refreshToken - the refresh token to exchange.
   * @returns the rotated token pair and its expiry.
   */
@Remote('workbuddyRefreshToken')
  async workbuddyRefreshToken(refreshToken: string): Promise<{ readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number }> {
    return workbuddyRefreshToken(this.accountRemotesHost, refreshToken)
  }

    /**
   * Re-read the WorkBuddy account credits from upstream.
   * @returns the status with the credits it read.
   */
@Remote('workbuddyRefreshCredits')
  async workbuddyRefreshCredits(): Promise<WorkBuddyInternationalStatus> {
    return workbuddyRefreshCredits(this.accountRemotesHost)
  }

  // Qoder (qoder.com / qoder.com.cn) free-model connector.

    /**
   * Read the Qoder accounts, the active one, its quota, and the free route.
   * @returns the status the settings surface renders.
   */
@Remote('qoderStatus')
  async qoderStatus(): Promise<QoderStatus> {
    return qoderStatus(this.accountRemotesHost)
  }

    /**
   * Start the Qoder browser sign-in handshake.
   * @returns the state a poll continues with.
   */
@Remote('qoderStartBrowserLogin')
  async qoderStartBrowserLogin(): Promise<QoderBrowserLogin> {
    return qoderStartBrowserLogin(this.accountRemotesHost)
  }

    /**
   * Poll the Qoder browser sign-in handshake.
   * @param state - the handshake state the start call returned.
   * @returns the outcome of this poll.
   */
@Remote('qoderPollBrowserLogin')
  async qoderPollBrowserLogin(state: string): Promise<QoderLoginPoll> {
    return qoderPollBrowserLogin(this.accountRemotesHost, state)
  }

    /**
   * Sign every Qoder account out and clear the stored sessions.
   * @returns the signed-out status.
   */
@Remote('qoderLogout')
  async qoderLogout(): Promise<QoderStatus> {
    return qoderLogout(this.accountRemotesHost)
  }

    /**
   * Forget one Qoder account locally.
   * @param accountId - id of the account to remove.
   * @returns the status after the removal.
   */
@Remote('qoderRemoveAccount')
  async qoderRemoveAccount(accountId: string): Promise<QoderStatus> {
    return qoderRemoveAccount(this.accountRemotesHost, accountId)
  }

    /**
   * Choose which Qoder account carries new requests.
   * @param accountId - id of the account to activate.
   * @returns the status after the change.
   */
@Remote('qoderSetActiveAccount')
  async qoderSetActiveAccount(accountId: string): Promise<QoderStatus> {
    return qoderSetActiveAccount(this.accountRemotesHost, accountId)
  }

  /**
   * Re-read the Qoder account quotas from upstream.
   * @returns the status with the quota it read.
   */
@Remote('qoderRefreshQuota')
  async qoderRefreshQuota(): Promise<QoderStatus> {
    return qoderRefreshQuota(this.accountRemotesHost)
  }

  /**
   * Claim today's campaign credits for every Qoder account.
   * @returns the run's report.
   */
@Remote('qoderCheckin')
  async qoderCheckin(): Promise<FreeCodeGoCheckinReport> {
    return qoderCheckin(this.accountRemotesHost)
  }

  // TRAE (www.trae.cn) SOLO channel. The sign-in is a browser redirect into a
  // loopback listener this Host opens, so the pending state carries the URL the
  // card offers as a link and the callback the user may have to paste.

  /**
   * Read the stored TRAE accounts and whether a sign-in is in flight.
   * @returns the status the settings surface renders.
   */
@Remote('traeStatus')
  async traeStatus(): Promise<TraeStatus> {
    return traeStatus(this.accountRemotesHost)
  }

  /**
   * Start a TRAE browser authorization against one deployment and open its sign-in page.
   * @param realm - `cn` or `sg`; an omitted or unknown value means China.
   * @returns the pending status with the login URL.
   */
@Remote('traeStartBrowserLogin')
  async traeStartBrowserLogin(realm?: string): Promise<TraeStatus> {
    return traeStartBrowserLogin(this.accountRemotesHost, realm)
  }

  /**
   * Poll a TRAE authorization; the exchange happens on the first poll that
   * finds the redirect already captured.
   * @returns the status after the poll.
   */
@Remote('traePollBrowserLogin')
  async traePollBrowserLogin(): Promise<TraeStatus> {
    return traePollBrowserLogin(this.accountRemotesHost)
  }

  /**
   * Complete a TRAE sign-in from a callback URL the user pasted.
   * @param url - the callback URL as the browser shows it.
   * @returns the status after the sign-in.
   */
@Remote('traeSubmitCallback')
  async traeSubmitCallback(url: string): Promise<TraeStatus> {
    return traeSubmitCallback(this.accountRemotesHost, url)
  }

  /**
   * Abandon a TRAE authorization the user no longer wants.
   * @returns the status after the cancellation.
   */
@Remote('traeCancelBrowserLogin')
  async traeCancelBrowserLogin(): Promise<TraeStatus> {
    return traeCancelBrowserLogin(this.accountRemotesHost)
  }

  /**
   * Read the TRAE configuration table the signed-in accounts can serve.
   * @returns the model rows.
   */
@Remote('traeModels')
  async traeModels(): Promise<readonly TraeModel[]> {
    return traeModels(this.accountRemotesHost)
  }

  /**
   * Sign every TRAE account out and clear the stored sessions.
   * @returns the signed-out status.
   */
@Remote('traeLogout')
  async traeLogout(): Promise<TraeStatus> {
    return traeLogout(this.accountRemotesHost)
  }

  /**
   * Forget one TRAE account locally.
   * @param accountId - id of the account to remove.
   * @returns the status after the removal.
   */
@Remote('traeRemoveAccount')
  async traeRemoveAccount(accountId: string): Promise<TraeStatus> {
    return traeRemoveAccount(this.accountRemotesHost, accountId)
  }

  /**
   * Choose which TRAE account carries new requests.
   * @param accountId - id of the account to activate.
   * @returns the status after the change.
   */
@Remote('traeSetActiveAccount')
  async traeSetActiveAccount(accountId: string): Promise<TraeStatus> {
    return traeSetActiveAccount(this.accountRemotesHost, accountId)
  }

  /**
   * Claim today's credits for every TRAE account.
   * @returns the run's report.
   */
@Remote('traeCheckin')
  async traeCheckin(): Promise<FreeCodeGoCheckinReport> {
    return traeCheckin(this.accountRemotesHost)
  }

  // Cline (api.cline.bot) free-model pool.

    /**
   * Read the stored Cline accounts and their pool state.
   * @returns the status the settings surface renders.
   */
@Remote('clineStatus')
  async clineStatus(): Promise<ClineStatus> {
    return clineStatus(this.accountRemotesHost)
  }

    /**
   * Start Cline device sign-in; the caller then polls with the returned code.
   * @returns the device code and the verification URL.
   */
@Remote('clineStartLogin')
  async clineStartLogin(): Promise<ClineDeviceLogin> {
    return clineStartLogin(this.accountRemotesHost)
  }

    /**
   * Poll the Cline device sign-in.
   * @param deviceCode - the device code the start call returned.
   * @returns the outcome of this poll.
   */
@Remote('clinePollLogin')
  async clinePollLogin(deviceCode: string): Promise<ClineLoginPoll> {
    return clinePollLogin(this.accountRemotesHost, deviceCode)
  }

    /**
   * Add a Cline account from a refresh token.
   * @param refreshToken - the account's refresh token.
   * @returns the status after the account was added.
   */
@Remote('clineAddAccount')
  async clineAddAccount(refreshToken: string): Promise<ClineStatus> {
    return clineAddAccount(this.accountRemotesHost, refreshToken)
  }

    /**
   * Forget one Cline account locally.
   * @param accountId - id of the account to remove.
   * @returns the status after the removal.
   */
@Remote('clineRemoveAccount')
  async clineRemoveAccount(accountId: string): Promise<ClineStatus> {
    return clineRemoveAccount(this.accountRemotesHost, accountId)
  }

    /**
   * Revalidate one Cline account's session.
   * @param accountId - the account to revalidate; defaults to the active one.
   * @returns the status after the revalidation.
   */
@Remote('clineRefresh')
  async clineRefresh(accountId?: string): Promise<ClineStatus> {
    return clineRefresh(this.accountRemotesHost, accountId)
  }

    /**
   * Sign every Cline account out and clear the stored sessions.
   * @returns the signed-out status.
   */
@Remote('clineLogout')
  async clineLogout(): Promise<ClineStatus> {
    return clineLogout(this.accountRemotesHost)
  }

  /** Return the existing FreeCodeGo bootstrap snapshot through a redacted Remote. 
   * @returns the backend Snapshot.
   */
  @Remote('backendBootstrap')
  async backendBootstrap(): Promise<FreeCodeGoBackendSnapshot> {
    return backendBootstrap(this.accountRemotesHost)
  }

  /** Return the existing backend quota snapshot without exposing credentials. 
   * @returns the backend Snapshot.
   */
  @Remote('backendQuota')
  async backendQuota(): Promise<FreeCodeGoBackendSnapshot> {
    return backendQuota(this.accountRemotesHost)
  }

  /** Return existing backend runtime health. 
   * @returns the backend Snapshot.
   */
  @Remote('backendRuntimeHealth')
  async backendRuntimeHealth(): Promise<FreeCodeGoBackendSnapshot> {
    return backendRuntimeHealth(this.accountRemotesHost)
  }

    /**
   * Read the account's gateway usage over a number of days.
   * @param days - how many days back the read starts.
   * @returns the usage payload, or the reason it is unavailable.
   */
@Remote('backendUsage')
  async backendUsage(days: number): Promise<FreeCodeGoBackendSnapshot> {
    return backendUsage(this.accountRemotesHost, days)
  }

    /**
   * Compute token usage from this machine's own session logs.
   * @param usageQuery - the filters the snapshot is computed for.
   * @returns the computed usage snapshot.
   */
@Remote('tokenUsageLocal')
  async tokenUsageLocal(usageQuery: LocalTokenUsageQuery): Promise<LocalTokenUsageSnapshot> {
    return tokenUsageLocal(this.paymentRemotesHost, usageQuery)
  }

    /**
   * Read the gateway's token usage over a number of days.
   * @param days - how many days back the read starts.
   * @returns the usage figures the gateway reported.
   */
@Remote('tokenUsageGateway')
  async tokenUsageGateway(days: number): Promise<GatewayUsageSnapshot> {
    return tokenUsageGateway(this.paymentRemotesHost, days)
  }

    /**
   * Compute token usage for one session.
   * @param sessionId - the session whose usage is computed.
   * @returns the session's usage snapshot, or `undefined` when nothing is recorded.
   */
@Remote('tokenUsageCurrentSession')
  async tokenUsageCurrentSession(sessionId: string): Promise<LocalTokenUsageSnapshot | undefined> {
    return tokenUsageCurrentSession(this.paymentRemotesHost, sessionId)
  }

    /**
   * Read the stored Agnes accounts and which of them is active.
   * @returns the status the settings surface renders.
   */
@Remote('agnesStatus')
  async agnesStatus(): Promise<AgnesStatus> { return this.requireAgnes().status() }

    /**
   * Send the Agnes registration verification code.
   * @param email - the address the code is sent to.
   * @returns true once the platform accepted the request.
   */
@Remote('agnesSendVerification')
  async agnesSendVerification(email: string): Promise<{ readonly sent: boolean }> { return this.requireAgnes().sendVerificationCode(email) }

    /**
   * Send the Agnes password-reset code.
   * @param email - the address the code is sent to.
   * @returns true once the platform accepted the request.
   */
@Remote('agnesSendPasswordReset')
  async agnesSendPasswordReset(email: string): Promise<{ readonly sent: boolean }> { return this.requireAgnes().sendPasswordResetCode(email) }

    /**
   * Set a new Agnes password using the mailed code.
   * @param email - the account's address.
   * @param password - the new password to set.
   * @param code - the code the platform mailed.
   * @returns true once the platform accepted the change.
   */
@Remote('agnesResetPassword')
  async agnesResetPassword(email: string, password: string, code: string): Promise<{ readonly updated: boolean }> { return this.requireAgnes().resetPassword({ email, password, code }) }

    /**
   * Sign in to Agnes with a password.
   * @param email - the account's address.
   * @param password - the account's password.
   * @returns the status after the sign-in.
   */
@Remote('agnesLogin')
  async agnesLogin(email: string, password: string): Promise<AgnesStatus> { return this.requireAgnes().login(email, password) }

    /**
   * Register an Agnes account, then sign in with it.
   * @param email - the address being registered.
   * @param password - the password to set.
   * @param code - the code the platform mailed.
   * @returns the status after the sign-in.
   */
@Remote('agnesRegister')
  async agnesRegister(email: string, password: string, code: string): Promise<AgnesStatus> { return this.requireAgnes().register({ email, password, code }) }

    /**
   * Provision, or reuse, this plugin's Agnes API key.
   * @param accountId - the account to provision for; defaults to the active one.
   * @returns whether a key is configured, and the account it belongs to.
   */
@Remote('agnesCreateApiKey')
  async agnesCreateApiKey(accountId?: string): Promise<{ readonly configured: boolean; readonly accountId: string }> { return this.requireAgnes().createApiKey(accountId) }

    /**
   * Forget one Agnes account locally.
   * @param accountId - id of the account to remove.
   * @returns the status after the removal.
   */
@Remote('agnesRemoveAccount')
  async agnesRemoveAccount(accountId: string): Promise<AgnesStatus> { return this.requireAgnes().removeAccount(accountId) }

    /**
   * Revalidate one Agnes account's session.
   * @param accountId - the account to revalidate; defaults to the active one.
   * @returns the status after the revalidation.
   */
@Remote('agnesRefresh')
  async agnesRefresh(accountId?: string): Promise<AgnesStatus> { return this.requireAgnes().refreshAccount(accountId) }

    /**
   * Sign one Agnes account out, or every account.
   * @param accountId - the account to sign out; omitted signs every account out.
   * @returns the status after the sign-out.
   */
@Remote('agnesLogout')
  async agnesLogout(accountId?: string): Promise<AgnesStatus> { return this.requireAgnes().logout(accountId) }


  /** Return saleable plans from the existing FreeCodeGo payment API. 
   * @returns the payment Plan rows, in backend order.
   */
  @Remote('paymentPlans')
  async paymentPlans(): Promise<readonly FreeCodeGoPaymentPlan[]> {
    return paymentPlans(this.paymentRemotesHost)
  }

    /**
   * List the payment channels the backend offers this account.
   * @returns the channels the checkout surface shows.
   */
@Remote('paymentChannels')
  async paymentChannels(): Promise<readonly FreeCodeGoPaymentChannel[]> {
    return paymentChannels(this.paymentRemotesHost)
  }

  /** Limits and the publishable Stripe key the in-plugin card form needs. 
   * @returns the payment Config.
   */
  @Remote('paymentConfig')
  async paymentConfig(): Promise<FreeCodeGoPaymentConfig> {
    return paymentConfig(this.paymentRemotesHost)
  }

  /** Return the current account-visible tariff catalog. Account model options
   * provide the enabled whitelist and effective group pricing. 
   * @param language - locale the returned labels are written in.
   * @returns the gateway Model Price rows, in backend order.
   */
  @Remote('gatewayModelPrices')
  async gatewayModelPrices(language: 'zh' | 'en'): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
    return gatewayModelPrices(this.paymentRemotesHost, language)
  }

  private async accountGatewayModelPrices(language: 'zh' | 'en'): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
    return accountGatewayModelPrices(this.paymentRemotesHost, language)
  }

  private async localGatewayModelPrices(): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
    return localGatewayModelPrices(this.paymentRemotesHost)
  }

    /**
   * Read the account's payment orders.
   * @returns the order payload as the backend returned it.
   */
@Remote('paymentOrders')
  async paymentOrders(): Promise<JsonValue> {
    return paymentOrders(this.paymentRemotesHost)
  }

  /** Create a payment order through the existing FreeCodeGo endpoint. 
   * @returns the payment Order.
   * @param planId - the plan being purchased.
   * @param paymentType - the payment channel to use.
   * @param returnUrl - where the provider returns the browser after payment.
   * @param amount - the amount to charge, when the channel allows an override.
   */
  @Remote('paymentCheckout')
  async paymentCheckout(planId: number, paymentType: string, returnUrl: string, amount?: number): Promise<FreeCodeGoPaymentOrder> {
    return paymentCheckout(this.paymentRemotesHost, planId, paymentType, returnUrl, amount)
  }

  /** Poll an existing FreeCodeGo payment order. 
   * @returns the payment Order.
   * @param orderId - id of the order to poll.
   */
  @Remote('paymentOrder')
  async paymentOrder(orderId: string): Promise<FreeCodeGoPaymentOrder> {
    return paymentOrder(this.paymentRemotesHost, orderId)
  }

    /**
   * Verify one payment with the provider.
   * @param outTradeNo - the out-trade number to verify.
   * @returns the order as the backend reports it.
   */
@Remote('paymentVerify')
  async paymentVerify(outTradeNo: string): Promise<FreeCodeGoPaymentOrder> {
    return paymentVerify(this.paymentRemotesHost, outTradeNo)
  }

    /**
   * Cancel one pending payment order.
   * @param orderId - id of the order to cancel.
   * @returns true once the order was cancelled.
   */
@Remote('paymentCancel')
  async paymentCancel(orderId: string): Promise<{ readonly cancelled: boolean }> {
    return paymentCancel(this.paymentRemotesHost, orderId)
  }

    /**
   * Mail the receipt for one order.
   * @param orderId - id of the order whose receipt is mailed.
   * @returns the address the receipt was sent to, and the backend's message when it sent one.
   */
@Remote('paymentReceiptEmail')
  async paymentReceiptEmail(orderId: string): Promise<{ readonly email: string; readonly message?: string }> {
    return paymentReceiptEmail(this.paymentRemotesHost, orderId)
  }

    /**
   * Render the receipt for one order.
   * @param orderId - id of the order whose receipt is rendered.
   * @returns the receipt document to download.
   */
@Remote('paymentReceiptDocument')
  async paymentReceiptDocument(orderId: string): Promise<FreeCodeGoReceiptDocument> {
    return paymentReceiptDocument(this.paymentRemotesHost, orderId)
  }

  /**
   * Render Stripe's own receipt for one order.
   *
   * A separate Remote from the receipt above because the two documents come from
   * different issuers, and the order list already says which rows have this one
   * (`stripe_receipt_available`) — so the page offers it only where the backend
   * will actually serve it.
   * @param orderId - id of the order whose Stripe receipt is rendered.
   * @returns the receipt document to download, base64 encoded as a PDF.
   */
@Remote('paymentStripeReceiptDocument')
  async paymentStripeReceiptDocument(orderId: string): Promise<FreeCodeGoReceiptDocument> {
    return paymentStripeReceiptDocument(this.paymentRemotesHost, orderId)
  }

  /** Instance-level seams preserved so tests can override or call the live
   * catalog runtime. These mirror the original private methods; the runtime
   * implementations live in FreeCodeGoManagedCatalogs. 
   * @param provider - provider id the turn is routed to.
   * @returns the llm Model Info rows, in backend order.
   */
  async listFreeCodeGoModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.catalogs.listFreeCodeGoModels(provider) }
    /**
   * List the models OpenCode exposes for one provider.
   * @param provider - provider id to list models for.
   * @returns the model rows the picker renders.
   */
async listOpenCodeModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.catalogs.listOpenCodeModels(provider) }
    /**
   * List the models Vyce exposes for one provider.
   * @param provider - provider id to list models for.
   * @returns the model rows the picker renders.
   */
async listVyceModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.catalogs.listVyceModels(provider) }
    /**
   * List the models SenseNova exposes for one provider.
   * @param provider - provider id to list models for.
   * @returns the model rows the picker renders.
   */
async listSenseNovaModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.catalogs.listSenseNovaModels(provider) }
    /**
   * List the models NVIDIA exposes for one provider.
   * @param provider - provider id to list models for.
   * @returns the model rows the picker renders.
   */
async listNvidiaModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.catalogs.listNvidiaModels(provider) }
  private async readManagedCatalogCache(): Promise<FreeCodeGoManagedCatalog | undefined> { return this.catalogs.readManagedCatalogCache() }
  private refreshManagedCatalogInBackground(): void { this.catalogs.refreshManagedCatalogInBackground() }
  private refreshGatewayHealthInBackground(): void { this.catalogs.refreshGatewayHealthInBackground() }

  /** Expose the independent review loop to every Agent through Harness tools. */
  private registerAdvisorTools(): void {
    registerAdvisorTools(this.agentToolsDeps())
  }

  /**
   * Register the `edit` + verify composite, when this composition has both halves.
   *
   * The registry is what makes the composite safe: it dispatches the nested edit
   * and shell calls through `ctx.tools.execute`, so the filesystem and shell
   * sandboxes, the read-before-edit policy, and per-call escalation all still
   * apply. A composite that called the delegates' bodies directly would be a
   * policy bypass wearing a convenience tool's clothes.
   */
  private registerEditAndRunComposite(): void {
    // The composite dispatches nested calls *through* the registry, so it does
    // not degrade on a tool service that can only register: a service without
    // `get`/`execute` has nothing to delegate to, and claiming a delegation
    // target that is not there would register a tool whose every call throws.
    // The module's own contract is "not registered at all when the delegate is
    // missing", and that has to be checked against what the service actually
    // exposes rather than against the cast below.
    const registry = this.ctx.get('tools') as Partial<EditAndRunRegistry> | undefined
    if (registry === undefined || typeof registry.get !== 'function' || typeof registry.execute !== 'function') return
    const dispose = registerEditAndRunTool({ ctx: this.ctx, registry: registry as EditAndRunRegistry })
    if (dispose !== undefined) this.ctx.effect(() => dispose, 'freecodego: edit_and_run composite tool')
  }

  /** Model-facing media tools keep Agnes API keys and requests in the Host. */
  private registerAgnesTools(): void {
    registerAgnesTools(this.agentToolsDeps())
  }

  private agentToolsDeps(): AgentToolsDeps {
    return {
      ...this.coreDeps,
      advisor: this.advisor,
      engineering: this.engineering,
      engineCouncil: this.engineCouncil,
      onVerificationRecorded: (agentId, verdict) => { void this.verifyOnStop?.recordVerification(agentId, verdict) },
      // The verified argv is spawned on this machine, so the repository's own
      // command policy judges it exactly as it judges a `bash` call.
      probeCommandPolicy: agent => this.projectPolicyForAgent(agent),
    }
  }

  /** Generic media tools resolve the user's live default at execution time. */
  private registerMediaTools(): void {
    registerMediaTools(this.mediaHost)
  }

  private get mediaHost(): MediaGenerationHost {
    return {
      ...this.coreDeps,
      requireAgnes: () => this.requireAgnes(),
      groqWhisperTranscribe: (audioBase64, mimeType, language) => this.groqWhisperTranscribe(audioBase64, mimeType, language),
      readManagedCatalogCache: () => this.readManagedCatalogCache(),
      logfareApiKey: () => this.catalogs.logfareApiKey(),
      logfareModels: () => this.catalogs.logfareModels(),
      mediaRoute: selection => this.mediaRoute(selection),
      // Media requests on the managed gateway share the account's one recovery
      // path: a 401 refreshes the session once and replays the request, exactly
      // like every API-client call, instead of a private retry of their own.
      recoverGatewayAuth: <T>(run: () => Promise<T>) => this.account === undefined ? run() : this.account.withAccessToken(async () => run()),
      // Forwarded with the caller's exact arity: only a protocol that needs
      // create-call headers passes the options argument, and a transport that
      // never needs it must not receive a trailing `undefined`.
      gatewayMediaJson: (...args) => this.gatewayMediaJson(...args),
      generateAudioWithFallback: (args, cwd, signal) => this.generateAudioWithFallback(args, cwd, signal),
    }
  }

  private async generateImageWithFallback(args: ImageGenerationArgs, signal: AbortSignal): Promise<unknown> {
    return generateImageWithFallback(this.mediaHost, args, signal)
  }

  private async generateVideoWithFallback(args: MediaVideoArgs, signal: AbortSignal): Promise<unknown> {
    return generateVideoWithFallback(this.mediaHost, args, signal)
  }

  private async generateAudioWithFallback(args: { input: string; voice?: string; format?: string; speed?: number }, cwd: string | undefined, signal: AbortSignal): Promise<unknown> {
    return generateAudioWithFallback(this.mediaHost, args, cwd, signal)
  }

  private async gatewayMediaJson(model: string, endpoint: string | readonly string[], body: Record<string, unknown>, signal: AbortSignal, options?: MediaRequestOptions): Promise<unknown> {
    return gatewayMediaJson(this.mediaHost, model, endpoint, body, signal, options)
  }

  private mediaRoute(selection: string): MediaRoute {
    return mediaRoute(this.mediaHost, selection)
  }

  /** Rebuild Host-only clients whenever the persisted endpoint changes. */
  private configureGateway(): void {
    configureGateway(this.engineRemotesHost)
  }

  private requireAgnes(): AgnesClient {
    if (this.agnes === undefined) throw new Error('Agnes credential service is not configured')
    return this.agnes
  }

  /** Mutable coordination state shared with the extracted account remotes;
   * mutated in place so the restore dedup keeps its original semantics. */
  private readonly accountRemotesState: AccountRemotesState = {
    restorePromise: undefined,
    restoreCompleted: false,
    pendingOAuthState: undefined,
  }

  /** Instance-level seam preserved so tests can override the durable-session
   * restore; configureGateway, the managed catalog runtime, and the extracted
   * account/payment remotes all call it through the live instance. */
  private restoreAccount(): Promise<void> {
    return restoreDurableAccount(this.accountRemotesHost)
  }

  private get accountRemotesHost(): AccountRemotesHost {
    return {
      ...this.coreDeps,
      workbuddyPool: this.workbuddyPool,
      qoder: this.qoder,
      trae: this.trae,
      state: this.accountRemotesState,
      logfareStatus: () => this.logfareStatus(),
      sensenovaStatus: () => this.sensenovaStatus(),
      nvidiaStatus: () => this.nvidiaStatus(),
    }
  }

  private get paymentRemotesHost(): PaymentRemotesHost {
    return {
      ...this.coreDeps,
      gatewayBaseUrl: () => this.gatewayBaseUrl,
      accountGatewayModelPrices: language => this.accountGatewayModelPrices(language),
      localGatewayModelPrices: () => this.localGatewayModelPrices(),
    }
  }

  /**
   * Match FreeCodeGo's own desktop client: gateway calls authenticate with the
   * Host-vault access token and select the model group through a route header.
   * Warp runtime keys are intentionally not used here because their default
   * route can differ from the selected model group.
   */
  private async managedRuntime(model?: string): Promise<FreeCodeGoManagedRuntime & { readonly routeKey?: string; readonly protocol?: string }> {
    return managedRuntime(this.engineRemotesHost, model)
  }

  /** Resolve direct upstream routes that stay outside the FreeCodeGo gateway. */
  private async directConnection(model: string | undefined, allowExternalProviders = true): Promise<{ connection: Omit<import('./openai-compatible-adapter.ts').OpenAiCompatibleConnection, 'apiKey'>; runtime: FreeCodeGoManagedRuntime } | undefined> {
    return directConnection(this.engineRemotesHost, model, allowExternalProviders)
  }

  private async routeForModel(model: string, accessToken: string): Promise<string> {
    return routeForModel(this.engineRemotesHost, model, accessToken)
  }

  private get engineRemotesHost(): EngineRemotesHost {
    return {
      ...this.coreDeps,
      config: this.config,
      pluginConflictGuard: this.pluginConflictGuard,
      agentEngines: this.agentEngines,
      claudeBridge: this.claudeBridge,
      gatewayBaseUrl: this.gatewayBaseUrl,
      defaultAgentOptions: () => this.defaultAgentOptions(),
      routeForModel: (model, accessToken) => this.routeForModel(model, accessToken),
      setCredentials: (credentials) => { this.credentials = credentials },
      setAgnes: (agnes) => { this.agnes = agnes },
      setCline: (cline) => { this.cline = cline },
      setWorkbuddy: (workbuddy) => { this.workbuddy = workbuddy },
      // The pool is rebuilt with the vault it reads, so the previous timer is
      // stopped before the new one exists; disposal stops the last one.
      setWorkbuddyPool: (pool) => {
        this.workbuddyPool?.stop()
        this.workbuddyPool = pool
        pool?.start()
      },
      setQoder: (qoder) => { this.qoder = qoder },
      setTrae: (trae) => { this.trae = trae },
      setAccount: (account) => { this.account = account },
      setApi: (api) => { this.api = api },
      setGatewayBaseUrl: (baseUrl) => { this.gatewayBaseUrl = baseUrl },
    }
  }

  /**
   * The review surface the Remotes read and write.
   *
   * The settings accessors are functions rather than values, for the same reason
   * every other live setting here is: a panel that showed the mode as it was at
   * connection time would keep showing it after the user changed it.
   */
  private get reviewRemotesHost(): ReviewRemotesHost {
    return {
      ctx: this.ctx,
      portFor: workspace => this.reviewInstallFor(workspace).then(install => install.port),
      deepReviewerFor: agent => this.deepReviewerFor(agent),
      settings: () => {
        const settings = this.reviewGateSettings()
        return {
          mode: settings.mode,
          threshold: settings.threshold,
          cooldownTurns: settings.cooldownTurns,
          deep: this.policy.get()?.reviewDeep === true,
          escalation: this.policy.get()?.reviewEscalation === true,
        }
      },
      // `policy.update` writes through the settings scope and does nothing at all
      // when there is none, which would leave the panel reporting a saved value it
      // never stored — the read-back comes from the same document. A composition
      // without a settings service cannot save review settings, and saying so is
      // the only outcome a user can act on.
      update: async patch => {
        if (!this.policy.configured) throw new Error('this composition has no settings service, so review settings cannot be saved')
        await this.policy.update(patch)
      },
    }
  }

  private get engineeringRemotesHost(): EngineeringRemotesHost {
    return {
      ...this.coreDeps,
      engineering: this.engineering,
      advisor: this.advisor,
      engineCouncil: this.engineCouncil,
      backendCatalog: () => this.backendCatalog(),
    }
  }

}
/**
 * The parent agent a review child may be opened in, when the tool call carried one.
 *
 * The tool surface types the agent as a small slice, so this is a check rather
 * than a cast: a child needs a session with a workspace to run in and an agent
 * registry to be created through, and a caller that is missing either is refused
 * here instead of failing deep inside the child's construction.
 * @param agent - the agent to test, as the tool surface handed it over.
 * @returns the agent, when it can host a review child.
 */
function agentForReviewSubagent(agent: unknown): Agent | undefined {
  const candidate = agent as Agent | undefined
  const cwd = candidate?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  if (candidate?.ctx?.agents === undefined) return undefined
  return candidate
}

/**
 * The paths the Host recorded for one turn, when it has a record for *that* turn.
 *
 * Both rules about trusting this record live in `review/turn-scope.ts`, along with
 * their reasons; this function is the plumbing that reaches them. Everything is read
 * defensively because the record is a Host service this plugin does not depend on:
 * a composition without `workspace-changes` has no per-turn record, and the gate
 * then reviews the workspace's change set as it always did.
 * @param ctx - the context the service is looked up on.
 * @param session - the stopping agent's session, as the gate's registry holds it.
 * @param turn - the stopping turn, which the record has to name.
 * @returns the turn's changed paths, or `undefined` when there is no such record.
 */
function readReviewTurnPaths(
  ctx: Context,
  session: { readonly id?: unknown; readonly snapshotEvents?: () => readonly unknown[] } | undefined,
  turn: number | undefined,
): readonly string[] | undefined {
  if (session === undefined || turn === undefined || session.id === undefined) return undefined
  const service = ctx.get('workspaceChanges') as
    | { readonly summary?: (sessionId: unknown, seq: number) => TurnScopeSummary | undefined }
    | undefined
  if (typeof service?.summary !== 'function') return undefined
  const summarize = service.summary.bind(service)
  return turnChangePaths({
    sessionId: String(session.id),
    turn,
    events: (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) as readonly TurnScopeEvent[],
    summarize: (sessionId, seq) => summarize(sessionId, seq),
  })
}

/**
 * The review child's model route: the plugin's own second-model route, as the review itself.
 *
 * The same pair, and for the same reason the review's single-shot model uses it —
 * "the model this plugin calls on its own behalf" is one intent, and a dedicated
 * route for the reviewer would be a second place to set it. Blank values are
 * dropped rather than passed on, so the child's engine resolves its own default
 * instead of receiving an empty model id.
 * @param settings - the stored settings holding the route.
 * @returns the child's options, with only the fields that were actually set.
 */
function reviewSubagentOptions(settings: { readonly advisorProvider?: string; readonly advisorModel?: string }): ReviewSubagentOptions {
  const provider = (settings.advisorProvider ?? '').trim()
  const model = (settings.advisorModel ?? '').trim()
  return {
    ...(provider === '' ? {} : { provider }),
    ...(model === '' ? {} : { model }),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    freeCodeGoHarness: FreeCodeGoHarnessPlugin
  }
}

export default FreeCodeGoHarnessPlugin
