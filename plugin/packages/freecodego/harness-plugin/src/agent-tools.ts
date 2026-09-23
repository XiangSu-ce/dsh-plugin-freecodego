/**
 * Agent-facing Harness tools for the FreeCodeGo plugin: the independent
 * Advisor review loop, the multi-engine engineering council workflow, and the
 * legacy Agnes media tool names.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/agent-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgnesClient } from './agnes.ts'
import { AGNES_VIDEO_SECONDS } from './agnes.ts'
import type { FreeCodeGoAdvisorRuntime } from './advisor.ts'
import type { FreeCodeGoEngineCouncil } from './engine-council.ts'
import type { FreeCodeGoEngineeringRegistry } from './engineering.ts'
import { COUNCIL_ENGINES, VERIFICATION_STAGES, normalizeEngineeringCouncilRequest, validateEngineeringVerificationStages, workspaceForAgent } from './engineering-remote-utils.ts'
import { normalizeEngineeringProbes, probeCommandDenial } from './engineering-quality.ts'
import type { CompiledCommandPolicy } from './command-policy.ts'
import { renderGeneratedImages, type ImageGenerationArgs, type MediaToolRegistration } from './media-generation.ts'
import type { MediaVideoArgs } from './media-utils.ts'
import { toolDefinition as rawAgnesTool, type ToolDefinitionShape } from './tool-definition.ts'
import type { FreeCodeGoEngineeringCouncilRequest, FreeCodeGoEngineeringVerificationResult, FreeCodeGoEngineeringVerificationStage, FreeCodeGoEngineeringVerificationVerdict } from './types.ts'
import { VERIFICATION_TOOL_NAME } from './verify-on-stop.ts'

/**
 * Narrow view of the plugin surface required by the Agent tool registration
 * cluster. Members that map to plugin methods delegate back to the live
 * instance so instance-level overrides keep working.
 */
export interface AgentToolsDeps {
  readonly ctx: Context
  readonly advisor: FreeCodeGoAdvisorRuntime
  readonly engineering: FreeCodeGoEngineeringRegistry
  readonly engineCouncil: FreeCodeGoEngineCouncil
  readonly agnes: AgnesClient | undefined
  readonly generateImageWithFallback: (args: ImageGenerationArgs, signal: AbortSignal) => Promise<unknown>
  readonly generateVideoWithFallback: (args: MediaVideoArgs, signal: AbortSignal) => Promise<unknown>
  /**
   * Report a verification run so the stop-time gate can be satisfied by it.
   *
   * Without this the gate's only reachable outcome is the nudge: it reads a
   * verdict nothing ever writes, so a turn that ran `engineering_team_verify`
   * and passed is told it established nothing — the gate would be a permanent
   * complaint rather than a check. The consumer owns the changed-path read,
   * because the workspace is a property of the session and not of this module.
   */
  readonly onVerificationRecorded?: (agentId: string, verdict: FreeCodeGoEngineeringVerificationVerdict) => void
  /**
   * The repository's own command policy for one agent's workspace, when it
   * declared one.
   *
   * The verification tool declares probes whose argv is spawned on this machine,
   * so it is a second way to run a command and gets the same judgment `bash`
   * gets: the built-in policy plus this one. A resolver rather than a value for
   * the reason the tool guard's is one — the answer is a property of the
   * repository a session opened, and this module has no workspace of its own.
   */
  readonly probeCommandPolicy?: (agent: unknown) => CompiledCommandPolicy | undefined
}

/** Expose the independent review loop to every Agent through Harness tools.
 * @param deps - the services and providers the advisor tools are built from.
 */
export function registerAdvisorTools(deps: AgentToolsDeps): void {
  const tools = deps.ctx.get('tools') as { register: (tool: ToolDefinitionShape) => () => void } | undefined
  if (tools === undefined) return
  const output = {
    schema: { type: 'object' as const, additionalProperties: true },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
  const requireAgent = (exec: { readonly agent?: Agent }): Agent => {
    if (exec.agent === undefined) throw new Error('Advisor tools require a calling Agent')
    return exec.agent
  }
  const disposeStatus = tools.register(rawAgnesTool({
    name: 'advisor_status',
    description: 'Inspect the independent FreeCodeGo Advisor review loop and recent findings for this conversation. Use this before requesting a review.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    execute: (_args: unknown, exec: { readonly agent?: Agent }) => {
      const agent = requireAgent(exec)
      return { ...deps.advisor.status(), recentNotes: deps.advisor.notes(agent, 3) }
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Advisor status' }),
  }))
  const disposeReview = tools.register(rawAgnesTool({
    name: 'advisor_review',
    description: 'Ask the independent Advisor model to review the latest durable conversation and workspace evidence now. Use when a second opinion can catch a regression, missed requirement, or verification gap.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    execute: async (_args: unknown, exec: { readonly agent?: Agent }) => {
      const agent = requireAgent(exec)
      const status = deps.advisor.status()
      if (!status.enabled || !status.routeReady) throw new Error('Advisor is not enabled with a valid model route')
      if (!status.allowAgentControl) throw new Error('Advisor Agent control is disabled in FreeCodeGo settings')
      const note = await deps.advisor.reviewNow(agent)
      return { reviewed: true, note: note ?? null }
    },
    presentCall: () => ({ card: 'generic', title: 'Request Advisor review' }),
  }))
  const disposeNotes = tools.register(rawAgnesTool({
    name: 'advisor_notes',
    description: 'Read recent durable Advisor findings for this conversation, including whether each finding was recorded, injected, or used to steer the Agent.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Maximum findings to return.' } }, additionalProperties: false },
    output,
    execute: (args: { readonly limit?: number }, exec: { readonly agent?: Agent }) => ({ notes: deps.advisor.notes(requireAgent(exec), args.limit ?? 10) }),
    presentCall: () => ({ card: 'generic', title: 'Read Advisor findings' }),
  }))
  const disposeCouncil = tools.register(rawAgnesTool({
    name: 'engineering_council_review',
    description: 'Run independent architecture, security, and testing Advisor perspectives over the latest completed turn. Findings remain separate and read-only; this tool never steers the primary Agent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    execute: async (_args: unknown, exec: { readonly agent?: Agent }) => {
      if (!deps.engineering.councilEnabled()) throw new Error('Advisor Council is disabled in engineering settings')
      return deps.advisor.councilReviewNow(requireAgent(exec))
    },
    presentCall: () => ({ card: 'generic', title: 'Run Advisor Council review' }),
  }))
  const disposeTeamStart = tools.register(rawAgnesTool({
    name: 'engineering_team_start',
    description: 'Start a bounded engineering council. The parent Agent remains the active engine while DeepSeek, Codex, and Claude child Agents independently review the supplied plan in read-only mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'plan'],
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 8_000 },
        plan: { type: 'string', minLength: 1, maxLength: 16_000 },
        constraints: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1_000 }, maxItems: 20 },
        engines: { type: 'array', items: { type: 'string', enum: [...COUNCIL_ENGINES] }, minItems: 1, maxItems: COUNCIL_ENGINES.length },
        maxRounds: { type: 'integer', minimum: 1, maximum: 3 },
        run_in_background: { type: 'boolean', description: 'Return a council id immediately instead of waiting for all reviewers.' },
      },
    },
    output,
    isConcurrencySafe: () => true,
    execute: async (args: unknown, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
      const agent = requireAgent(exec)
      const request = normalizeEngineeringCouncilRequest(args as FreeCodeGoEngineeringCouncilRequest)
      const input = args as FreeCodeGoEngineeringCouncilRequest & { readonly run_in_background?: boolean }
      if (input.run_in_background === true) return deps.engineCouncil.start(agent, request, exec.signal)
      return deps.engineCouncil.run(agent, request, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Start multi-engine engineering council' }),
  }))
  const disposeTeamStatus = tools.register(rawAgnesTool({
    name: 'engineering_team_status',
    description: 'Read the live state of a multi-engine engineering council by id.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^council_[a-fA-F0-9]{32}$' } } },
    output,
    execute: (args: { readonly id: string }) => deps.engineCouncil.job(args.id),
    presentCall: () => ({ card: 'generic', title: 'Inspect engineering council status' }),
  }))
  const disposeTeamReport = tools.register(rawAgnesTool({
    name: 'engineering_team_report',
    description: 'Read completed multi-engine council reports for this conversation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    execute: (_args: unknown, exec: { readonly agent?: Agent }) => ({ reports: deps.engineCouncil.reports(requireAgent(exec)) }),
    presentCall: () => ({ card: 'generic', title: 'Read engineering council reports' }),
  }))
  const disposeTeamCancel = tools.register(rawAgnesTool({
    name: 'engineering_team_cancel',
    description: 'Cancel a running multi-engine engineering council and dispose its child Agents.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^council_[a-fA-F0-9]{32}$' } } },
    output,
    execute: (args: { readonly id: string }) => deps.engineCouncil.cancel(args.id),
    presentCall: () => ({ card: 'generic', title: 'Cancel engineering council' }),
  }))
  const disposeTeamApproval = tools.register(rawAgnesTool({
    name: 'engineering_team_request_approval',
    description: 'Ask the user to explicitly approve or reject a completed engineering council before implementation. A council report is evidence only; this tool records the required durable user decision.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^council_[a-fA-F0-9]{32}$' } } },
    output,
    execute: async (args: { readonly id: string }, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
      const agent = requireAgent(exec)
      const report = deps.engineCouncil.report(agent, args.id)
      if (report.decision !== undefined) return report.decision
      if (report.state !== 'completed' && report.state !== 'partial') {
        throw new Error('engineering council "' + args.id + '" cannot be decided from state "' + report.state + '"')
      }
      const userQuestions = deps.ctx.get('userQuestions')
      if (userQuestions === undefined) throw new Error('user-questions service is not configured')
      const answer = await userQuestions.ask({
        agent,
        signal: exec.signal,
        questions: [{
          id: 'implementation-decision',
          header: 'Engineering implementation',
          question: 'Approve this reviewed implementation plan?',
          detail: report.plan,
          options: [
            { label: 'Approve implementation', description: 'Allow the primary Agent to implement this reviewed plan.' },
            { label: 'Reject plan', description: 'Keep the workspace unchanged and require a revised plan.' },
          ],
          intent: { kind: 'plan-review', approve: 'Approve implementation' },
        }],
      })
      const selected = answer.answers.find(item => item.id === 'implementation-decision')?.selected ?? []
      return await deps.engineCouncil.recordDecision(
        agent,
        args.id,
        selected.includes('Approve implementation') ? 'approved' : 'rejected',
      )
    },
    presentCall: () => ({ card: 'generic', title: 'Request implementation approval' }),
  }))
  const disposeTeamVerify = tools.register(rawAgnesTool({
    name: VERIFICATION_TOOL_NAME,
    description: 'Run the declared scope, build, type, lint, and test verification stages after the user approved and the primary Agent implemented an engineering council plan. Passing the project\'s own gates is not by itself a verification: every stage result carries the command that ran and its exit status, and the run is only VERIFIED when at least one adversarial probe you declare here ran and held its expectation. A probe is an independent check against the change — a boundary, a concurrency case, an idempotency re-run, an orphaned operation — with its expectation (pass or fail) declared before it runs and a rationale saying what breakage it would catch. A probe whose exit status does not match its declaration makes the whole verification FAIL, and a probe that reaches the network, publishes, or deletes is refused and also fails the run. Zero probes yields UNVERIFIED, never a pass.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: { type: 'string', pattern: '^council_[a-fA-F0-9]{32}$' },
      stages: { type: 'array', items: { type: 'string', enum: [...VERIFICATION_STAGES] }, minItems: 1, maxItems: VERIFICATION_STAGES.length },
      probes: {
        type: 'array',
        maxItems: 5,
        description: 'Independent checks declared before they run. Declare at least one; `expectation: "fail"` is for a guard that should refuse the new input.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'command', 'expectation', 'rationale'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 120 },
            command: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 32, description: 'Program followed by its arguments. Spawned without a shell.' },
            expectation: { type: 'string', enum: ['pass', 'fail'] },
            rationale: { type: 'string', minLength: 1, maxLength: 1_000, description: 'What breakage this probe would catch.' },
          },
        },
      },
    } },
    output,
    execute: async (args: { readonly id: string; readonly stages?: readonly FreeCodeGoEngineeringVerificationStage[]; readonly probes?: unknown }, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
      const agent = requireAgent(exec)
      const report = deps.engineCouncil.report(agent, args.id)
      if (report.decision?.state !== 'approved') {
        throw new Error('engineering council "' + args.id + '" requires user approval before verification')
      }
      if (report.verification !== undefined) return report.verification
      // Refused before the run starts, not after: a denied probe is the model's
      // own mistake to fix, and the place it can read the reason is the error this
      // throws. Recorded as a refused probe instead, the run would advance the
      // council to `verification started` and report a FAILED verdict for a call
      // that never had a chance to pass.
      const probes = normalizeEngineeringProbes(args.probes)
      const probePolicy = deps.probeCommandPolicy?.(agent)
      for (const probe of probes) {
        const denial = probeCommandDenial(probe.command, probePolicy)
        if (denial !== undefined) {
          throw new Error(`Probe "${probe.id}" would run a command the command policy forbids, so the verification was not started: ${denial}`)
        }
      }
      await deps.engineCouncil.beginVerification(agent, args.id)
      let result: FreeCodeGoEngineeringVerificationResult
      try {
        result = await deps.engineering.verify(
          workspaceForAgent(agent),
          validateEngineeringVerificationStages(args.stages) ?? VERIFICATION_STAGES,
          exec.signal,
          undefined,
          probes,
        )
      } catch (error) {
        deps.engineCouncil.failVerification(agent, args.id, error)
        throw error
      }
      const recorded = await deps.engineCouncil.recordVerification(agent, args.id, result)
      // Every verdict is reported, not only `verified`: the gate's nudge reads
      // differently for a run that came back FAILED, and only `verified` ever
      // satisfies it. An absent verdict is reported as `unverified`, because
      // results persisted before the verdict existed carry none and a missing
      // verdict is not a verification.
      deps.onVerificationRecorded?.(String(agent.id), result.verdict ?? 'unverified')
      return recorded.result
    },
    presentCall: () => ({ card: 'generic', title: 'Verify approved engineering council' }),
  }))
  const disposeTeamImplementation = tools.register(rawAgnesTool({
    name: 'engineering_team_mark_implemented',
    description: 'Record that the primary Agent completed an approved council plan. This explicit marker is required before verification can run.',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'summary'], properties: { id: { type: 'string', pattern: '^council_[a-fA-F0-9]{32}$' }, summary: { type: 'string', minLength: 1, maxLength: 4_000 } } },
    output,
    execute: async (args: { readonly id: string; readonly summary: string }, exec: { readonly agent?: Agent }) => deps.engineCouncil.recordImplementation(requireAgent(exec), args.id, args.summary),
    presentCall: () => ({ card: 'generic', title: 'Mark engineering council implemented' }),
  }))
  deps.ctx.effect(() => () => {
    disposeStatus(); disposeReview(); disposeNotes(); disposeCouncil()
    disposeTeamStart(); disposeTeamStatus(); disposeTeamReport(); disposeTeamCancel(); disposeTeamApproval(); disposeTeamVerify(); disposeTeamImplementation()
  }, 'freecodego: Advisor and engineering council tools')
}

/**
 * The two legacy names the image/video switch governs beside the generic pair.
 *
 * Declared once and read by both the registration below and the switch's status, the
 * same contract `MEDIA_GENERATION_TOOL_NAMES` follows on the other half.
 */
export const AGNES_MEDIA_TOOL_NAMES = { image: 'agnes_generate_image', video: 'agnes_generate_video' } as const

/**
 * Register the legacy Agnes-named image and video tools, and return their disposer.
 *
 * These are the historical spellings of the two image/video tools — kept callable for
 * persisted prompts — so they belong to the same switch as the generic pair and are
 * mounted and unmounted by the same code. A disposer rather than an `ctx.effect` is what
 * makes that possible.
 * @param deps - the services and providers the Agnes tools are built from.
 * @returns the mounted names and the disposer that releases them.
 */
export function registerAgnesMediaTools(deps: AgentToolsDeps): MediaToolRegistration {
  const client = deps.agnes
  const tools = deps.ctx.get('tools') as { register: (tool: ToolDefinitionShape) => () => void } | undefined
  if (client === undefined || tools === undefined) return { names: [], dispose: () => undefined }
  const disposeImage = tools.register(rawAgnesTool({
    name: AGNES_MEDIA_TOOL_NAMES.image,
    description: 'Legacy image-generation tool name. Generate an image with the FreeCodeGo Settings image default; do not assume Agnes is selected. The Host routes this request through the configured default image model and falls back safely when unavailable.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Detailed image prompt.' }, size: { type: 'string', description: 'Image size accepted by the default image model, for example 1024x1024.' } }, required: ['prompt'], additionalProperties: false },
    output: {
      // Keep the historical tool name, but accept the same attachment-rich
      // result as the generic media tool so generated images render inline.
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => renderGeneratedImages(value),
    },
    execute: async (args: { prompt: string; size?: string }, exec: { signal: AbortSignal }) => {
      // Keep this historical tool callable for persisted prompts, but never
      // let its name override the user's selected default media route.
      return deps.generateImageWithFallback({ prompt: args.prompt, ...(args.size === undefined ? {} : { size: args.size }) }, exec.signal)
    },
    presentCall: (args: { prompt: string }) => ({ card: 'generic', title: `Generate image: ${args.prompt}` }),
  }))
  const disposeVideo = tools.register(rawAgnesTool({
    name: AGNES_MEDIA_TOOL_NAMES.video,
    description: 'Legacy video-generation tool name. Generate a video with the FreeCodeGo Settings video default; do not assume Agnes is selected. The Host routes this request through the configured default video model and falls back safely when unavailable.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Detailed video prompt.' }, seconds: { type: 'string', enum: [...AGNES_VIDEO_SECONDS], description: 'Video duration in seconds; the Agnes route renders 4 through 12.' }, aspectRatio: { type: 'string', description: 'Video aspect ratio, for example 16:9.' }, images: { type: 'array', items: { type: 'string' }, description: 'Optional reference image URLs; the first entry becomes the source frame.' } }, required: ['prompt'], additionalProperties: false },
    output: {
      // The default route may return provider-specific fields such as
      // `model`; retain them for diagnostics instead of rejecting a valid
      // non-Agnes video result under the legacy tool name.
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: { prompt: string; seconds?: string; aspectRatio?: string; images?: string[] }, exec: { signal: AbortSignal }) => {
      // The legacy parameter keeps its documented "first entry is the source
      // frame" meaning; every further entry becomes a reference image rather
      // than being dropped on the floor.
      return deps.generateVideoWithFallback({ prompt: args.prompt, ...(args.seconds === undefined ? {} : { seconds: Number(args.seconds) }), ...(args.aspectRatio === undefined ? {} : { aspectRatio: args.aspectRatio }), ...(args.images?.[0] === undefined ? {} : { image: args.images[0] }), ...(args.images === undefined || args.images.length < 2 ? {} : { images: args.images.slice(1) }) }, exec.signal)
    },
    presentCall: (args: { prompt: string }) => ({ card: 'generic', title: `Generate video: ${args.prompt}` }),
  }))
  return { names: [AGNES_MEDIA_TOOL_NAMES.image, AGNES_MEDIA_TOOL_NAMES.video], dispose: () => { disposeImage(); disposeVideo() } }
}
