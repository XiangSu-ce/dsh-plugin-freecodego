/**
 * The review composition root.
 *
 * Why the plugin host does not wire this itself
 * --------------------------------------------
 * The host file is already six thousand lines and owns the plugin's lifecycle.
 * Composing a review needs eight collaborators — git, the LLM seam, a settings
 * read, a file reader, the rule layers, the reviewer, the run manager, and the
 * clock — and every one of them is a decision with a reason. Keeping those
 * reasons here means the host adds an import, a call, and a registration, and a
 * reader who wants to know *how a review is assembled* reads one file instead of
 * scrolling for it.
 *
 * The route is shared with the advisor, deliberately
 * -------------------------------------------------
 * Reviews use the plugin's second-model route (`advisorProvider`/`advisorModel`)
 * rather than a new pair of settings. Both are "the model this plugin calls on its
 * own behalf", the advisor's pair is already the one a user configures and the UI
 * already edits, and a second pair would be a second place for the same intent to
 * be set and disagree. A dedicated review route is a reasonable future change,
 * but only once there is a reason for the two to differ.
 *
 * The default route is the same virtual OpenCode route the advisor defaults to,
 * so a fresh install reviews out of the box instead of failing on the first call.
 * The route is resolved per request, so a settings change takes effect without a
 * reload.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/install
 */

import { OPENCODE_AUTO_MODEL } from '../managed-catalog-utils.ts'
import { createModelFileReviewer, type ReviewFilePort } from './reviewer.ts'
import { createReviewModelPort, type ReviewLlmSeam, type ReviewModelRoute } from './llm-port.ts'
import { createModelEscalationPort } from './escalation-model.ts'
import { loadReviewRules, type ReviewRuleFileReader } from './config.ts'
import { ReviewRuns, type ReviewRunPort } from './runs.ts'
import type { ReviewRuleResolver } from './rules.ts'
import type { ReviewGitPort } from './targets.ts'
import type { ReviewPlanTool } from './plan.ts'

/** The provider a review uses when nothing is configured. */
export const DEFAULT_REVIEW_PROVIDER = 'opencode'

/** The model a review uses when nothing is configured; a virtual route, so it cannot go stale. */
export const DEFAULT_REVIEW_MODEL = OPENCODE_AUTO_MODEL.id

/** The settings fields the review route is read from. */
export interface ReviewRouteSettings {
  readonly advisorProvider?: string
  readonly advisorModel?: string
}

/** Everything the composition needs. */
export interface ReviewInstallInput {
  readonly llm: ReviewLlmSeam
  /** The plugin's settings read; absent in headless compositions, which then use the default route. */
  readonly settings?: { get(): ReviewRouteSettings | undefined } | undefined
  /** The workspace a review is about. */
  readonly workspace: string
  /** The user's home directory, for the machine-level rule file. */
  readonly home?: string
  /** Absolute-path file reader; a missing file is `undefined`, not a throw. */
  readonly readFile: ReviewRuleFileReader
  readonly joinPath: (left: string, right: string) => string
  readonly sessionId?: Parameters<typeof createReviewModelPort>[2]
  /** An explicit rule file for every review this port runs. */
  readonly rulePath?: string
  /** Extra exclude patterns that come from configuration rather than a call. */
  readonly exclude?: readonly string[]
  readonly maxConcurrent?: number
  readonly keep?: number
  readonly now?: () => number
  /** Whether to adjudicate high-severity findings; read per run so a toggle takes effect. */
  readonly escalationEnabled?: () => boolean
  /** Override the git surface, which tests and non-repository workspaces both need. */
  readonly git?: ReviewGitPort
  /** Override the reviewer, e.g. with the subagent-backed one. */
  readonly reviewer?: ReviewFilePort
  readonly planTools?: readonly ReviewPlanTool[]
}

/** The assembled surface plus what assembling it found. */
export interface ReviewInstall {
  readonly port: ReviewRunPort
  readonly rules: ReviewRuleResolver
  /** Malformed rule files, named. Reported to the host so a user is told. */
  readonly warnings: readonly string[]
  /** The rule file paths that were read. */
  readonly sources: readonly string[]
}

/** Resolve the review model route from settings, falling back to the shipped default. */
export function resolveReviewRoute(settings: ReviewRouteSettings | undefined): ReviewModelRoute {
  const provider = (settings?.advisorProvider ?? '').trim() || DEFAULT_REVIEW_PROVIDER
  const model = (settings?.advisorModel ?? '').trim() || DEFAULT_REVIEW_MODEL
  return { provider, model }
}

/** Assemble a review run port. */
export async function createReviewInstall(input: ReviewInstallInput): Promise<ReviewInstall> {
  const rules = await loadReviewRules({
    workspace: input.workspace,
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.rulePath === undefined ? {} : { customPath: input.rulePath }),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    readFile: input.readFile,
    joinPath: input.joinPath,
  })

  const model = createReviewModelPort(
    input.llm,
    () => resolveReviewRoute(input.settings?.get()),
    input.sessionId,
  )

  const port = new ReviewRuns({
    ...(input.git === undefined ? {} : { git: input.git }),
    rules: rules.resolver,
    engine: {
      model,
      reviewer: input.reviewer ?? createModelFileReviewer(model),
      ...(input.planTools === undefined ? {} : { planTools: input.planTools }),
      ...(input.now === undefined ? {} : { now: input.now }),
    },
    ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
    ...(input.keep === undefined ? {} : { keep: input.keep }),
    ...(input.now === undefined ? {} : { now: input.now }),
    escalation: () => input.escalationEnabled?.() === true
      ? { port: createModelEscalationPort(model) }
      : {},
  })

  return { port, rules: rules.resolver, warnings: rules.warnings, sources: rules.sources }
}
