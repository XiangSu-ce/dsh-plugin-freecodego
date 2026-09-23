/**
 * Advisor and engineering remotes for the FreeCodeGo Harness plugin: the
 * Advisor model directory and review trigger, engineering councils, local
 * memory, and the Graphify code-graph remotes. The plugin class satisfies the
 * narrow host view below; members that map to plugin methods delegate back to
 * the live instance so instance-level overrides (tests, future remotes) keep
 * working.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engineering-remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ClaudeRuntimeManager, CodexRuntimeManager } from '@deepseek-ai/dsh-freecodego-native-runtime-host'
import type { FreeCodeGoAdvisorCouncilReport, FreeCodeGoAdvisorModel, FreeCodeGoAdvisorStatus, FreeCodeGoEngineeringCheckpoint, FreeCodeGoEngineeringCheckpointDiff, FreeCodeGoEngineeringCheckpointRestoreResult, FreeCodeGoEngineeringSettings, FreeCodeGoEngineeringStatus, FreeCodeGoManagedCatalog } from './types.ts'
import type { FreeCodeGoEngineeringCanvasGraph, FreeCodeGoEngineeringCodeGraphProjectStatus, FreeCodeGoEngineeringCodeGraphRuntimePackage, FreeCodeGoEngineeringCodeGraphRuntimeStatus, FreeCodeGoEngineeringCouncilDecision, FreeCodeGoEngineeringCouncilImplementation, FreeCodeGoEngineeringCouncilJob, FreeCodeGoEngineeringCouncilReport, FreeCodeGoEngineeringCouncilRequest, FreeCodeGoEngineeringGraphProjectStatus, FreeCodeGoEngineeringLoopStatus, FreeCodeGoEngineeringGraphRuntimePackage, FreeCodeGoEngineeringGraphRuntimeStatus, FreeCodeGoEngineeringMemoryBackup, FreeCodeGoEngineeringMemoryDetail, FreeCodeGoEngineeringMemoryIndex, FreeCodeGoEngineeringMemoryPage, FreeCodeGoEngineeringMemoryRecall, FreeCodeGoEngineeringMemoryRetentionResult, FreeCodeGoEngineeringMemoryReviewDecision, FreeCodeGoEngineeringMemoryTimeline, FreeCodeGoEngineeringMemoryTrust, FreeCodeGoEngineeringSpecBundle, FreeCodeGoEngineeringVerificationResult, FreeCodeGoEngineeringVerificationStage } from './types.ts'
import type { FreeCodeGoAdvisorRuntime } from './advisor.ts'
import type { FreeCodeGoEngineCouncil } from './engine-council.ts'
import { councilJobFromEvents, councilReportsFromEvents } from './engine-council.ts'
import type { FreeCodeGoEngineeringRegistry } from './engineering.ts'
import { writeSpecArtifacts } from './engineering-spec.ts'
import { VERIFICATION_STAGES, latestApprovedPlan, normalizeEngineeringCouncilRequest, validateEngineeringCouncilDecisionRequest, validateEngineeringCouncilVerificationRequest, validateEngineeringGraphRuntimeInstall, validateEngineeringMemoryListRequest, validateEngineeringMemoryReviewRequest, validateEngineeringMemoryTimelineRequest } from './engineering-remote-utils.ts'
import type { FreeCodeGoManagedCatalogs } from './managed-catalogs.ts'
import { agnesMediaCategory } from './agnes.ts'
import {
  advisorCouncilReportsFromSession, hostSessionEvents, isAdvisorTextModel, isAdvisorTextModalities,
  LOGFARE_AUTO_MODEL, MODEL_CATALOG_TIMEOUT_MS, withTimeout,
} from './managed-catalog-utils.ts'
import type { HostSessionEvents } from './managed-catalog-utils.ts'
import { readPersistedEvents } from './session-storage-utils.ts'
import type { SessionEventsPersistence } from './session-storage-utils.ts'

// Text and media Agnes routes are intentionally separate: only text-capable
// ids are eligible as a default chat model, while media tools route by their
// own ids. Media membership follows the live directory via the shared keyword
// heuristic instead of a pinned id list, so newly added Agnes image/video
// models are classified without a plugin update.
/**
 * Agnes model ids the plugin's text routes use.
 */
export const AGNES_TEXT_MODEL_IDS = new Set(['agnes-3.0-flash'])
function isAgnesMediaModelId(id: string): boolean { return agnesMediaCategory(id) !== undefined }

/**
 * Default look-back window (in days) for the memory retention sweep. The UI
 * currently passes no override, so this constant is the single Host-owned
 * default; a future settings control can replace the call-site literal.
 */
export const ENGINEERING_MEMORY_DEFAULT_RETENTION_DAYS = 90

/**
 * Narrow view of the plugin surface required by the Advisor and engineering
 * remotes. The plugin satisfies it through its `engineeringRemotesHost`
 * accessor.
 */
export interface EngineeringRemotesHost {
  readonly ctx: Context
  readonly engineering: FreeCodeGoEngineeringRegistry
  readonly advisor: FreeCodeGoAdvisorRuntime
  readonly engineCouncil: FreeCodeGoEngineCouncil
  readonly catalogs: FreeCodeGoManagedCatalogs
  /** Accessors keep instance-level runtime overrides visible. */
  readonly codexRuntime: () => CodexRuntimeManager
  readonly claudeRuntime: () => ClaudeRuntimeManager
  readonly backendCatalog: () => Promise<FreeCodeGoManagedCatalog>
}

function requireLiveAgent(host: EngineeringRemotesHost, sessionId: string): Agent {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('engineering council session id is invalid')
  const agent = host.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`session "${sessionId}" is not active`)
  return agent
}

/**
 * Resolve the workspace root for an engineering operation on one session.
 *
 * Exported because two unrelated surfaces need the identical rule and the
 * identical error text: a caller should not be able to tell whether the missing
 * workspace was reported by the memory Remote or the Skill-draft Remote.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the workspace root engineering operations for that session act on.
 */
export function engineeringMemoryCwd(host: EngineeringRemotesHost, sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('engineering memory session id is invalid')
  const cwd = host.ctx.sessions.get(SessionId(sessionId))?.header.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('engineering memory requires an open workspace-backed conversation')
  return cwd
}

async function engineeringStatusSnapshot(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringStatus> {
  const status = await host.engineering.status()
  const codex = host.codexRuntime().status()
  const claude = host.claudeRuntime().status()
  return {
    ...status,
    councilEngines: {
      deepseek: { enabled: status.engineeringCouncilDeepseekEnabled, available: true },
      codex: { enabled: status.engineeringCouncilCodexEnabled, available: codex.installed, ...(codex.reason === undefined ? {} : { reason: codex.reason }) },
      claude: { enabled: status.engineeringCouncilClaudeEnabled, available: claude.installed, ...(claude.reason === undefined ? {} : { reason: claude.reason }) },
    },
  }
}

/** List text-capable managed routes suitable for an independent Advisor call. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the advisor Model rows, in backend order.
 */
export async function advisorModels(host: EngineeringRemotesHost): Promise<readonly FreeCodeGoAdvisorModel[]> {
  // Start from the live Harness registry. This is the source of truth for
  // newly added provider/model routes; hand-maintained catalogs below are
  // only compatibility fallbacks for providers that are temporarily offline.
  const models = new Map<string, FreeCodeGoAdvisorModel>()
  const llm = host.ctx.get('llm') as {
    listProviders?: () => readonly { readonly id: string }[]
    listModels?: (provider: string) => Promise<readonly LlmModelInfo[]>
  } | undefined
  const providerEntries = llm?.listProviders?.() ?? []
  await Promise.all(providerEntries.map(async (entry) => {
    const provider = entry.id.trim()
    if (provider === '' || llm?.listModels === undefined) return
    try {
      const directory = await withTimeout(llm.listModels(provider), MODEL_CATALOG_TIMEOUT_MS, `${provider} Advisor model directory`)
      for (const model of directory) {
        const metadata = model as LlmModelInfo & { readonly availability?: unknown }
        // LlmModelInfo carries no protocol field; modalities are the only
        // reliable signal that a route can hold a text review conversation.
        if (metadata.availability === 'unavailable' || !isAdvisorTextModel(model) || !isAdvisorTextModalities(model.inputModalities)) continue
        const modelProvider = model.provider.trim() || provider
        const key = `${modelProvider}:${model.id}`
        models.set(key, {
          id: model.id,
          displayName: model.name,
          provider: modelProvider,
          description: model.description ?? `${modelProvider} · text review route`,
        })
      }
    } catch { /* one slow or credential-gated provider must not hide others */ }
  }))

  // OpenCode's public routes remain selectable before a FreeCodeGo account
  // is configured. Managed routes are an additive best-effort lookup.
  // The logfare auto route only resolves with a configured key: advertising
  // it without one would offer a route that fails at selection time.
  if (await host.catalogs.logfareApiKey() !== undefined) {
    models.set(`logfare:${LOGFARE_AUTO_MODEL.id}`, {
      id: LOGFARE_AUTO_MODEL.id,
      displayName: LOGFARE_AUTO_MODEL.name,
      provider: 'logfare',
      description: 'FreeCodeGo · free text route',
    })
  }
  for (const model of await host.catalogs.openCodeFreeModels()) {
    models.set(`opencode:${model.id}`, {
      id: model.id,
      displayName: model.name,
      provider: 'opencode',
      description: 'OpenCode · public free text route',
    })
  }
  try {
    const catalog = await host.backendCatalog()
    for (const model of catalog.models) {
      if (model.availability !== 'available' || !isAdvisorTextModel(model)) continue
      const provider = AGNES_TEXT_MODEL_IDS.has(model.id) || isAgnesMediaModelId(model.id) ? 'agnes' : 'freecodego'
      const key = `${provider}:${model.id}`
      if (models.has(key)) continue
      models.set(key, {
        id: model.id,
        displayName: model.displayName,
        provider,
        description: model.provider === 'agnes' ? 'Agnes AI · text review route' : `FreeCodeGo · ${model.protocol}`,
      })
    }
  } catch { /* public OpenCode routes remain available while signed out */ }
  try {
    for (const model of await host.catalogs.listSenseNovaModels('sensenova')) {
      // Skip routes the catalog itself marks unavailable (e.g. no key yet):
      // the advisor picker must not offer selections that fail on use.
      if ((model as LlmModelInfo & { readonly availability?: unknown }).availability === 'unavailable') continue
      models.set(`sensenova:${model.id}`, {
        id: model.id,
        displayName: model.name,
        provider: 'sensenova',
        description: 'SenseNova · public-beta free text route',
      })
    }
  } catch { /* SenseNova remains optional when its key or directory is unavailable */ }
  try {
    for (const model of await host.catalogs.listNvidiaModels('nvidia')) {
      if ((model as LlmModelInfo & { readonly availability?: unknown }).availability === 'unavailable') continue
      models.set(`nvidia:${model.id}`, {
        id: model.id,
        displayName: model.name,
        provider: 'nvidia',
        description: 'NVIDIA NIM · free tier',
      })
    }
  } catch { /* NVIDIA remains optional when its key or directory is unavailable */ }
  return [...models.values()].sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-Hans-CN'))
}

/** Ask the Advisor to review the latest durable facts of one live session. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the advisor Status.
 */
export function advisorReviewNow(host: EngineeringRemotesHost, sessionId: string): FreeCodeGoAdvisorStatus {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('advisor session id is invalid')
  const agent = host.ctx.get('agents')?.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`session "${sessionId}" is not active`)
  void host.advisor.reviewNow(agent)
  return host.advisor.status()
}

/** Request architecture, security, and testing perspectives without steering the main Agent. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the advisor Council Report.
 */
export function engineeringCouncilReview(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoAdvisorCouncilReport> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('engineering Council session id is invalid')
  if (!host.engineering.councilEnabled()) throw new Error('Advisor Council is disabled in engineering settings')
  const agent = host.ctx.get('agents')?.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`session "${sessionId}" is not active`)
  return host.advisor.councilReviewNow(agent)
}

/** Read the most recent durable Council reports for a live or restored session. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the advisor Council Report rows, in backend order.
 */
export async function engineeringCouncilReports(host: EngineeringRemotesHost, sessionId: string): Promise<readonly FreeCodeGoAdvisorCouncilReport[]> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('engineering Council session id is invalid')
  const live = host.ctx.get('sessions') as { get?(id: string): ({ readonly id: unknown } & HostSessionEvents) | undefined } | undefined
  const session = live?.get?.(sessionId)
  if (session !== undefined) return advisorCouncilReportsFromSession(session)
  const persistence = host.ctx.get('sessionPersistence') as SessionEventsPersistence | undefined
  if (persistence === undefined) throw new Error(`session "${sessionId}" is not available`)
  const restored = await readPersistedEvents(persistence, SessionId(sessionId))
  return advisorCouncilReportsFromSession({ id: sessionId, snapshotEvents: () => restored.events })
}

/** Start a bounded three-engine engineering council for one live parent Agent. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @param request - the request this call projects from.
 * @returns the engineering Council Job.
 */
export function engineeringTeamStart(host: EngineeringRemotesHost, sessionId: string, request: FreeCodeGoEngineeringCouncilRequest): FreeCodeGoEngineeringCouncilJob {
  const agent = requireLiveAgent(host, sessionId)
  return host.engineCouncil.start(agent, normalizeEngineeringCouncilRequest(request))
}

/** Read one live engineering council task. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Council Job.
 * @param id - id of the council job to read.
 */
export async function engineeringTeamJob(host: EngineeringRemotesHost, id: string): Promise<FreeCodeGoEngineeringCouncilJob> {
  if (typeof id !== 'string' || !/^council_[a-f0-9]{32}$/i.test(id)) throw new Error('engineering council job id is invalid')
  try { return host.engineCouncil.job(id) } catch (error) {
    for (const session of host.ctx.sessions.list()) {
      const restored = councilJobFromEvents(hostSessionEvents(session) as readonly SessionEvent[], id)
      if (restored !== undefined) return restored
    }
    const persistence = host.ctx.get('sessionPersistence') as SessionEventsPersistence & { list?(): readonly unknown[] | Promise<readonly unknown[]> } | undefined
    if (persistence?.list !== undefined) {
      const entries = await Promise.resolve(persistence.list())
      for (const entry of entries) {
        const sessionId = typeof entry === 'string'
          ? entry
          : entry !== null && typeof entry === 'object' && 'header' in entry
            ? String((entry as { readonly header?: { readonly id?: unknown } }).header?.id ?? '')
            : entry !== null && typeof entry === 'object' && 'id' in entry
              ? String((entry as { readonly id?: unknown }).id ?? '')
              : ''
        if (sessionId === '') continue
        try {
          const restored = councilJobFromEvents((await readPersistedEvents(persistence, SessionId(sessionId))).events, id)
          if (restored !== undefined) return restored
        } catch { /* one corrupt session must not hide other durable council tasks */ }
      }
    }
    throw error
  }
}

/** Read durable council reports from one live parent Agent. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Council Report rows, in backend order.
 */
export async function engineeringTeamReports(host: EngineeringRemotesHost, sessionId: string): Promise<readonly FreeCodeGoEngineeringCouncilReport[]> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('engineering council session id is invalid')
  // `ctx.agents` only holds live Agents; a disposed session must fall through
  // to persisted events instead of throwing past the durable fallback.
  const agent = host.ctx.agents.get(SessionId(sessionId))
  if (agent !== undefined) return host.engineCouncil.reports(agent)
  const persistence = host.ctx.get('sessionPersistence') as SessionEventsPersistence | undefined
  if (persistence === undefined) throw new Error(`session "${sessionId}" is not available`)
  return councilReportsFromEvents((await readPersistedEvents(persistence, SessionId(sessionId))).events)
}

/** Record the user's explicit approval or rejection of a completed engineering council. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Council Decision.
 * @param request - the council id and the decision to record.
 */
export async function engineeringTeamDecision(
  host: EngineeringRemotesHost,
  sessionId: string,
  request: { readonly id: string; readonly decision: FreeCodeGoEngineeringCouncilDecision['state'] },
): Promise<FreeCodeGoEngineeringCouncilDecision> {
  const input = validateEngineeringCouncilDecisionRequest(request)
  const agent = requireLiveAgent(host, sessionId)
  const decision = await host.engineCouncil.recordDecision(agent, input.id, input.decision)
  // Approval is the moment the engineering loop can start. The approved plan is
  // promoted to a durable Harness goal so the round driver — not a plugin timer —
  // owns continuation, and the goal's own round cap bounds unattended work.
  // Both calls are no-ops when the corresponding settings are off or the session
  // already holds an unfinished goal, so this stays a pure addition to approval.
  let goalId: string | undefined
  if (decision.state === 'approved') {
    // The decision record carries only a plan digest, so the objective text is
    // read back from the durable session log — the same source `latestApprovedPlan`
    // uses for automatic council runs. An unreadable plan simply captures no
    // goal; the approval message below stays the durable cue either way.
    const plan = latestApprovedPlan(hostSessionEvents(agent.session)) ?? ''
    goalId = host.engineering.captureApprovedPlanAsGoal(agent, plan)
    if (goalId !== undefined) host.engineering.armApprovedPlanGoal(agent)
  }
  agent.inject(createUserMessage({
    source: { kind: 'freecodego-engine-council' },
    content: [{
      type: 'text',
      text: decision.state === 'approved'
        ? goalId === undefined
          ? 'The user approved engineering council ' + decision.id + '. You may implement the reviewed plan, then run council verification.'
          : 'The user approved engineering council ' + decision.id + '. The approved plan is now goal "' + goalId + '", which the Harness continues automatically while it stays active. Work the plan to completion, then run council verification.'
        : 'The user rejected engineering council ' + decision.id + '. Do not implement this plan; revise it or start a new council.',
    }],
  }))
  return decision
}

/**
 * Export one approved council report into the workspace as spec artifacts.
 *
 * Gated on approval for the same reason verification is: an unreviewed plan is a
 * proposal, and writing it into the repository would present it as a decision
 * the project has already made.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Spec Bundle.
 * @param request - the council report id to export.
 */
export async function engineeringSpecExport(
  host: EngineeringRemotesHost,
  sessionId: string,
  request: { readonly id: string },
): Promise<FreeCodeGoEngineeringSpecBundle> {
  const id = typeof request?.id === 'string' ? request.id.trim() : ''
  if (!/^council_[a-f0-9]{32}$/i.test(id)) throw new Error('engineering council job id is invalid')
  const agent = requireLiveAgent(host, sessionId)
  const report = host.engineCouncil.report(agent, id)
  if (report.decision?.state !== 'approved') {
    throw new Error(`engineering council "${id}" requires user approval before its plan can be exported`)
  }
  return await writeSpecArtifacts(engineeringMemoryCwd(host, sessionId), report)
}

/** Run declared verification after the user approved a completed engineering council. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Verification Result.
 * @param request - the council id and the verification stages to run.
 */
export async function engineeringTeamVerify(
  host: EngineeringRemotesHost,
  sessionId: string,
  request: { readonly id: string; readonly stages?: readonly FreeCodeGoEngineeringVerificationStage[] },
): Promise<FreeCodeGoEngineeringVerificationResult> {
  const input = validateEngineeringCouncilVerificationRequest(request)
  const agent = requireLiveAgent(host, sessionId)
  const report = host.engineCouncil.report(agent, input.id)
  if (report.decision?.state !== 'approved') {
    throw new Error('engineering council "' + input.id + '" requires user approval before verification')
  }
  if (report.verification !== undefined) return report.verification
  await host.engineCouncil.beginVerification(agent, input.id)
  let result: FreeCodeGoEngineeringVerificationResult
  try {
    result = await host.engineering.verify(
      engineeringMemoryCwd(host, sessionId),
      input.stages ?? VERIFICATION_STAGES,
    )
  } catch (error) {
    host.engineCouncil.failVerification(agent, input.id, error)
    throw error
  }
  await host.engineCouncil.recordVerification(agent, input.id, result)
  agent.inject(createUserMessage({
    source: { kind: 'freecodego-engine-council' },
    content: [{
      type: 'text',
      text: 'Engineering council ' + input.id + ' verification is complete. Read the durable verification result and report failed, skipped, unavailable, or cancelled stages accurately.',
    }],
  }))
  return result
}

/** Mark an approved plan as implemented before running verification. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Council Implementation.
 * @param request - the council id and the implementation summary.
 */
export async function engineeringTeamImplementation(host: EngineeringRemotesHost, sessionId: string, request: { readonly id: string; readonly summary: string }): Promise<FreeCodeGoEngineeringCouncilImplementation> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('engineering council session id is invalid')
  const agent = requireLiveAgent(host, sessionId)
  if (request === null || typeof request !== 'object' || typeof request.summary !== 'string') throw new Error('engineering implementation request is invalid')
  // Match the sibling council Remotes' id contract; a malformed id would
  // otherwise flow into recordImplementation and its durable report lookup.
  if (!/^council_[a-f0-9]{32}$/i.test(request.id)) throw new Error('engineering council job id is invalid')
  const implementation = await host.engineCouncil.recordImplementation(agent, request.id, request.summary)
  // Executed verification, not just declared: the model used to be merely
  // told to "run verification next" and could silently skip it. Kick off the
  // bounded verification runner immediately so the durable record gets real
  // build/types/lint/test evidence. A failure here is surfaced through the
  // council's failed state, never as an unhandled rejection.
  const verification = engineeringTeamVerify(host, sessionId, { id: request.id }).catch(() => undefined)
  void verification
  agent.inject(createUserMessage({ source: { kind: 'freecodego-engine-council' }, content: [{ type: 'text', text: `Implementation for engineering council ${request.id} was marked complete. Executed verification (build/types/lint/tests) is starting automatically; read its durable result when reporting completion.` }] }))
  return implementation
}

/** Browser-safe engineering enhancement state; modules remain isolated from account loading. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Status.
 */
export async function engineeringStatus(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringStatus> {
  return engineeringStatusSnapshot(host)
}

/** Enable or disable every engineering enhancement resource without affecting MCP or user Skills. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param enabled - whether this capability is switched on.
 * @returns the engineering Status.
 */
export async function engineeringSetEnabled(host: EngineeringRemotesHost, enabled: boolean): Promise<FreeCodeGoEngineeringStatus> {
  if (typeof enabled !== 'boolean') throw new Error('engineering enabled must be a boolean')
  await host.engineering.setEnabled(enabled)
  return engineeringStatusSnapshot(host)
}

/** Persist an explicitly bounded engineering settings patch. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Status.
 * @param input - the bounded engineering settings patch.
 */
export async function engineeringSettingsUpdate(host: EngineeringRemotesHost, input: Partial<FreeCodeGoEngineeringSettings>): Promise<FreeCodeGoEngineeringStatus> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('engineering settings update must be an object')
  await host.engineering.update(input)
  return engineeringStatusSnapshot(host)
}

/**
 * Read the autonomous engineering loop for one session.
 *
 * Separate from the settings patch on purpose: the loop's goal belongs to the
 * session, not to the settings document, and it changes without anyone touching
 * a switch — the round driver creates and blocks goals on its own.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Loop Status.
 */
export function engineeringLoopStatus(host: EngineeringRemotesHost, sessionId: string): FreeCodeGoEngineeringLoopStatus {
  return host.engineering.goalLoopStatus(requireLiveAgent(host, sessionId))
}

/** Let the current goal's round driver continue without a user turn. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Loop Status.
 */
export function engineeringLoopArm(host: EngineeringRemotesHost, sessionId: string): FreeCodeGoEngineeringLoopStatus {
  return host.engineering.goalLoopArm(requireLiveAgent(host, sessionId))
}

/** Stop unattended continuation for the current goal, leaving the goal itself. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Loop Status.
 */
export function engineeringLoopStop(host: EngineeringRemotesHost, sessionId: string): FreeCodeGoEngineeringLoopStatus {
  return host.engineering.goalLoopStop(requireLiveAgent(host, sessionId))
}

/** List compact local memories for the selected workspace without exposing drafts to Agents. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Page.
 * @param request - the trust filter, page size, and cursor.
 */
export function engineeringMemoryList(host: EngineeringRemotesHost, sessionId: string, request?: { readonly trusts?: readonly FreeCodeGoEngineeringMemoryTrust[]; readonly limit?: number; readonly cursor?: string }): FreeCodeGoEngineeringMemoryPage {
  return host.engineering.memoryList(engineeringMemoryCwd(host, sessionId), validateEngineeringMemoryListRequest(request))
}

/** Search reviewed historical knowledge for the selected workspace. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Index rows, in backend order.
 * @param searchText - the text to match.
 * @param limit - the maximum number of records to return.
 */
export function engineeringMemorySearch(host: EngineeringRemotesHost, sessionId: string, searchText?: string, limit?: number): readonly FreeCodeGoEngineeringMemoryIndex[] {
  if (searchText !== undefined && (typeof searchText !== 'string' || searchText.length > 500)) throw new Error('engineering memory query is invalid')
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) throw new Error('engineering memory search limit is invalid')
  return host.engineering.memorySearch(engineeringMemoryCwd(host, sessionId), { ...(searchText === undefined ? {} : { query: searchText }), ...(limit === undefined ? {} : { limit }) })
}

/** Preview the bounded reviewed-memory index that is injected only at session start. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Recall.
 */
export function engineeringMemoryRecall(host: EngineeringRemotesHost, sessionId: string): FreeCodeGoEngineeringMemoryRecall {
  return host.engineering.memoryRecall(engineeringMemoryCwd(host, sessionId))
}

/** Read a bounded time neighborhood around a user-selected local memory record. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Timeline.
 * @param request - the record id and the time window around it.
 */
export function engineeringMemoryTimeline(host: EngineeringRemotesHost, sessionId: string, request: { readonly id: string; readonly before?: number; readonly after?: number }): FreeCodeGoEngineeringMemoryTimeline {
  const input = validateEngineeringMemoryTimelineRequest(request)
  return host.engineering.memoryTimeline(engineeringMemoryCwd(host, sessionId), input)
}

/** Read selected local memory details for human review. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Detail rows, in backend order.
 * @param ids - ids of the records to read.
 */
export function engineeringMemoryGet(host: EngineeringRemotesHost, sessionId: string, ids: readonly string[]): readonly FreeCodeGoEngineeringMemoryDetail[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some(id => typeof id !== 'string')) throw new Error('engineering memory ids are invalid')
  return host.engineering.memoryGetForReview(engineeringMemoryCwd(host, sessionId), ids)
}

/** User-only review decision. Agent tools cannot call this path. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Detail.
 * @param request - the record id and the review decision.
 */
export function engineeringMemoryReview(host: EngineeringRemotesHost, sessionId: string, request: { readonly id: string; readonly decision: FreeCodeGoEngineeringMemoryReviewDecision }): FreeCodeGoEngineeringMemoryDetail {
  const input = validateEngineeringMemoryReviewRequest(request)
  return host.engineering.memoryReview(engineeringMemoryCwd(host, sessionId), input.id, input.decision)
}

/** Permanently delete one local memory selected by the user. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @param id - id of the record to delete.
 * @returns true once the record is gone.
 */
export function engineeringMemoryDelete(host: EngineeringRemotesHost, sessionId: string, id: string): { readonly deleted: true } {
  if (typeof id !== 'string') throw new Error('engineering memory id is invalid')
  return host.engineering.memoryDelete(engineeringMemoryCwd(host, sessionId), id)
}

/** Clear non-reviewed records by default; reviewed knowledge needs an explicit opt-in. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @param request - whether reviewed knowledge is included in the purge.
 * @returns how many records were deleted.
 */
export function engineeringMemoryPurgeProject(host: EngineeringRemotesHost, sessionId: string, request?: { readonly includeReviewed?: boolean }): { readonly deleted: number } {
  if (request !== undefined && (request === null || typeof request !== 'object' || Array.isArray(request) || (request.includeReviewed !== undefined && typeof request.includeReviewed !== 'boolean'))) throw new Error('engineering memory purge request is invalid')
  return host.engineering.memoryPurgeProject(engineeringMemoryCwd(host, sessionId), request?.includeReviewed)
}

/**
 * Export reviewed project knowledge without drafts, rejected records, or database paths.
 *
 * `omitted` is part of the return shape for the same reason it is part of the
 * store's: the store reads at most its own export cap, so a caller that only saw
 * `records` could not tell a project holding five reviewed memories from one
 * holding five hundred. Naming it here keeps the UI axis from re-hiding what the
 * store just stopped hiding.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the reviewable records, with drafts and rejected entries omitted.
 */
export function engineeringMemoryExport(host: EngineeringRemotesHost, sessionId: string): { readonly version: 1; readonly exportedAt: number; readonly projectId: string; readonly records: readonly FreeCodeGoEngineeringMemoryDetail[]; readonly omitted: number } {
  return host.engineering.memoryExportReviewed(engineeringMemoryCwd(host, sessionId))
}

/** Produce a consistent plugin-private SQLite backup without exposing its path. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Backup.
 */
export function engineeringMemoryBackup(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringMemoryBackup> {
  engineeringMemoryCwd(host, sessionId)
  return host.engineering.memoryBackup()
}

/** Trim only stale generated/rejected memory and completed Outbox entries. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Memory Retention Result.
 * @param retentionDays - age in days beyond which stale records are trimmed.
 */
export function engineeringMemoryRetentionSweep(host: EngineeringRemotesHost, sessionId: string, retentionDays?: number): FreeCodeGoEngineeringMemoryRetentionResult {
  engineeringMemoryCwd(host, sessionId)
  if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)) throw new Error('engineering memory retention days are invalid')
  return host.engineering.memoryRetentionSweep(retentionDays ?? ENGINEERING_MEMORY_DEFAULT_RETENTION_DAYS)
}

/** Capture a checkpoint of the workspace's tracked source files. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Checkpoint.
 * @param label - the label to record with the entry.
 */
export async function engineeringCheckpointCapture(host: EngineeringRemotesHost, sessionId: string, label: string): Promise<FreeCodeGoEngineeringCheckpoint> {
  if (typeof label !== 'string' || label.trim() === '' || label.length > 160) throw new Error('engineering checkpoint label is invalid')
  return host.engineering.checkpointCapture(engineeringMemoryCwd(host, sessionId), label)
}

/** List this workspace's checkpoints, newest first. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Checkpoint rows, in backend order.
 */
export function engineeringCheckpointList(host: EngineeringRemotesHost, sessionId: string): readonly FreeCodeGoEngineeringCheckpoint[] {
  return host.engineering.checkpointList(engineeringMemoryCwd(host, sessionId))
}

/** Restore the workspace to a checkpoint. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Checkpoint Restore Result.
 * @param id - id of the checkpoint to restore.
 */
export async function engineeringCheckpointRestore(host: EngineeringRemotesHost, sessionId: string, id: string): Promise<FreeCodeGoEngineeringCheckpointRestoreResult> {
  if (typeof id !== 'string' || !/^ckpt_[a-f0-9]{24}$/u.test(id)) throw new Error('engineering checkpoint id is invalid')
  return host.engineering.checkpointRestore(engineeringMemoryCwd(host, sessionId), id)
}

/** Preview what restoring one checkpoint would change, without touching files. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Checkpoint Diff.
 * @param id - id of the checkpoint to preview.
 */
export function engineeringCheckpointDiff(host: EngineeringRemotesHost, sessionId: string, id: string): FreeCodeGoEngineeringCheckpointDiff {
  if (typeof id !== 'string' || !/^ckpt_[a-f0-9]{24}$/u.test(id)) throw new Error('engineering checkpoint id is invalid')
  return host.engineering.checkpointDiff(engineeringMemoryCwd(host, sessionId), id)
}

/** Pin or unpin one checkpoint; pinned ones survive the retention cap. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @param id - id of the checkpoint to pin or unpin.
 * @param pinned - the pin state to store.
 * @returns the pin state now stored.
 */
export function engineeringCheckpointSetPinned(host: EngineeringRemotesHost, sessionId: string, id: string, pinned: boolean): { readonly pinned: boolean } {
  if (typeof id !== 'string' || !/^ckpt_[a-f0-9]{24}$/u.test(id)) throw new Error('engineering checkpoint id is invalid')
  if (typeof pinned !== 'boolean') throw new Error('engineering checkpoint pin flag is invalid')
  return host.engineering.checkpointSetPinned(engineeringMemoryCwd(host, sessionId), id, pinned)
}

/**
 * Delete one checkpoint manifest.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @param id - id of the checkpoint to delete.
 * @returns true once the manifest is gone.
 */
export function engineeringCheckpointRemove(host: EngineeringRemotesHost, sessionId: string, id: string): { readonly deleted: true } {
  if (typeof id !== 'string' || !/^ckpt_[a-f0-9]{24}$/u.test(id)) throw new Error('engineering checkpoint id is invalid')
  return host.engineering.checkpointRemove(engineeringMemoryCwd(host, sessionId), id)
}

/** Status for the fixed official Graphify Runtime. This check does not start Python. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Graph Runtime Status.
 */
export function engineeringGraphRuntimeStatus(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
  return host.engineering.graphRuntimeStatus()
}

/** Supported private Graphify Runtime installation sources for this platform. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Graph Runtime Package rows, in backend order.
 */
export function engineeringGraphRuntimePackages(host: EngineeringRemotesHost): Promise<readonly FreeCodeGoEngineeringGraphRuntimePackage[]> {
  return host.engineering.graphRuntimePackages()
}

/** Install the fixed official Graphify Wheel into a plugin-private Python environment. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Graph Runtime Status.
 * @param input - the Python package to install, and the interpreter when an existing one is reused.
 */
export function engineeringGraphRuntimeInstall(host: EngineeringRemotesHost, input: { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string }): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
  return host.engineering.graphRuntimeInstall(validateEngineeringGraphRuntimeInstall(input))
}

/** Remove only the plugin-owned Graphify Runtime; project graphs remain preserved. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Graph Runtime Status.
 */
export function engineeringGraphRuntimeRemove(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
  return host.engineering.graphRuntimeRemove()
}

/** Read the current workspace's Graphify output state without scanning the workspace. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Graph Project Status.
 */
export function engineeringGraphProjectStatus(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
  return host.engineering.graphProjectStatus(engineeringMemoryCwd(host, sessionId))
}

/** Build the official Graphify code graph into DSH_HOME, never into the workspace. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Graph Project Status.
 * @param request - whether the existing graph is rebuilt by force.
 */
export function engineeringGraphBuild(host: EngineeringRemotesHost, sessionId: string, request?: { readonly force?: boolean }): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
  if (request !== undefined && (request === null || typeof request !== 'object' || Array.isArray(request) || (request.force !== undefined && typeof request.force !== 'boolean'))) throw new Error('engineering code graph build request is invalid')
  return host.engineering.graphBuild(engineeringMemoryCwd(host, sessionId), request?.force === true)
}

/**
 * Refresh this workspace's Graphify graph from what changed since the last build.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the graph project status.
 */
export function engineeringGraphUpdate(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
  return host.engineering.graphUpdate(engineeringMemoryCwd(host, sessionId))
}

/** Abort only the plugin-owned Graphify process tree associated with this workspace. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns true once the plugin-owned build process tree was aborted.
 */
export function engineeringGraphCancel(host: EngineeringRemotesHost, sessionId: string): { readonly cancelled: boolean } {
  return host.engineering.graphCancel(engineeringMemoryCwd(host, sessionId))
}

/** Provide a bounded graph projection to compatible Canvas plugins without leaking raw graph JSON. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Canvas Graph.
 * @param request - the node budget for this projection.
 */
export function engineeringGraphCanvas(host: EngineeringRemotesHost, sessionId: string, request?: { readonly maxNodes?: number }): Promise<FreeCodeGoEngineeringCanvasGraph> {
  if (request !== undefined && (request === null || typeof request !== 'object' || Array.isArray(request) || (request.maxNodes !== undefined && (!Number.isInteger(request.maxNodes) || request.maxNodes < 1 || request.maxNodes > 400)))) throw new Error('engineering graph canvas request is invalid')
  return host.engineering.graphCanvas(engineeringMemoryCwd(host, sessionId), request?.maxNodes)
}

/**
 * Drop this workspace's Graphify graph and its caches.
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the graph project status.
 */
export function engineeringGraphClearProject(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
  return host.engineering.graphClearProject(engineeringMemoryCwd(host, sessionId))
}

/**
 * The CodeGraph engine's remotes. CodeGraph is the Python-free sibling of the
 * Graphify engine above: its official per-platform bundle contains its own Node
 * runtime, so installation is one verified download instead of a private Python
 * environment, and it exposes no `existing-python`/path-based source.
 */

/** Status for the self-contained CodeGraph Runtime. This check starts no process. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Code Graph Runtime Status.
 */
export function engineeringCodeGraphRuntimeStatus(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
  return host.engineering.codeGraphRuntimeStatus()
}

/** The verified CodeGraph platform bundle for this OS/CPU, when one exists. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Code Graph Runtime Package rows, in backend order.
 */
export function engineeringCodeGraphRuntimePackages(host: EngineeringRemotesHost): Promise<readonly FreeCodeGoEngineeringCodeGraphRuntimePackage[]> {
  return host.engineering.codeGraphRuntimePackages()
}

/** Download, SHA-256 verify, and install the official CodeGraph bundle into a plugin-private directory. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Code Graph Runtime Status.
 */
export function engineeringCodeGraphRuntimeInstall(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
  return host.engineering.codeGraphRuntimeInstall()
}

/** Remove only the plugin-owned CodeGraph Runtime; every workspace index is left in place. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the engineering Code Graph Runtime Status.
 */
export function engineeringCodeGraphRuntimeRemove(host: EngineeringRemotesHost): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
  return host.engineering.codeGraphRuntimeRemove()
}

/** Read this workspace's CodeGraph index state without scanning the workspace. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Code Graph Project Status.
 */
export function engineeringCodeGraphProjectStatus(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
  return host.engineering.codeGraphProjectStatus(engineeringMemoryCwd(host, sessionId))
}

/** Initialize or refresh the workspace index; `force` asks for the full rebuild instead of an incremental sync. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Code Graph Project Status.
 * @param request - whether the existing index is rebuilt by force.
 */
export function engineeringCodeGraphBuild(host: EngineeringRemotesHost, sessionId: string, request?: { readonly force?: boolean }): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
  if (request !== undefined && (request === null || typeof request !== 'object' || Array.isArray(request) || (request.force !== undefined && typeof request.force !== 'boolean'))) throw new Error('engineering CodeGraph build request is invalid')
  return host.engineering.codeGraphBuild(engineeringMemoryCwd(host, sessionId), request?.force === true)
}

/** Incrementally absorb file changes into an existing workspace index. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Code Graph Project Status.
 */
export function engineeringCodeGraphSync(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
  return host.engineering.codeGraphSync(engineeringMemoryCwd(host, sessionId))
}

/** Abort only the plugin-owned CodeGraph process tree associated with this workspace. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns true once the plugin-owned indexing process tree was aborted.
 */
export function engineeringCodeGraphCancel(host: EngineeringRemotesHost, sessionId: string): { readonly cancelled: boolean } {
  return host.engineering.codeGraphCancel(engineeringMemoryCwd(host, sessionId))
}

/** Delete only this workspace's plugin-owned CodeGraph index directory. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param sessionId - the Harness session this operation acts on.
 * @returns the engineering Code Graph Project Status.
 */
export function engineeringCodeGraphClearProject(host: EngineeringRemotesHost, sessionId: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
  return host.engineering.codeGraphClearProject(engineeringMemoryCwd(host, sessionId))
}
