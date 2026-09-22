/**
 * The review Remotes: what a settings page can see and start.
 *
 * Why a review from the UI is fire-and-forget
 * ------------------------------------------
 * A review spends model calls per file and can run for minutes. A Remote that
 * awaited it would hold a request open for that whole time and fail on the first
 * transport timeout, so this starts the run and answers with the runs as they
 * stand: the caller polls the same Remote it used to start the review, and the run
 * manager is the single source of truth for what is happening. The two checks
 * before starting are what keep that honest — a workspace's manager already
 * refuses a second concurrent run, and refusing it *here* means the caller gets a
 * sentence naming the run that is in the way instead of a rejection nobody sees.
 *
 * Why the workspace comes from the session
 * ---------------------------------------
 * Same rule as the tools: a review is about the workspace the caller is in, and a
 * path parameter would let a browser ask about a directory the session never
 * opened. Every Remote here takes the session id and resolves the working
 * directory from it, so the UI cannot review a checkout the user is not looking at.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ReviewRunPort } from './runs.ts'
import type { ReviewFilePort } from './reviewer.ts'
import { reviewRef, type ReviewTargetMode, type ReviewTargetRequest } from './targets.ts'
import type {
  FreeCodeGoReviewStartRequest,
  FreeCodeGoReviewStatus,
  FreeCodeGoReviewUpdate,
} from '../types.ts'

/** How long a ref, a path fragment, or a background paragraph may be. */
const MAX_REF_CHARS = 256
const MAX_BACKGROUND_CHARS = 2_000
const MAX_EXCLUDE_PATTERNS = 64

/** The stored review settings, defaulted, as both the gate and this surface read them. */
export interface ReviewRemoteSettings {
  readonly mode: 'off' | 'record' | 'gate'
  readonly threshold: 'critical' | 'high' | 'medium' | 'low'
  readonly cooldownTurns: number
  readonly deep: boolean
  readonly escalation: boolean
}

/** What these Remotes reach the Host services through. */
export interface ReviewRemotesHost {
  readonly ctx: Context
  /** The run surface for one workspace, assembled on first use. */
  readonly portFor: (workspace: string) => Promise<ReviewRunPort>
  /** The deeper per-file reviewer for one agent's run, or nothing when it is off. */
  readonly deepReviewerFor: (agent: unknown) => ReviewFilePort | undefined
  readonly settings: () => ReviewRemoteSettings
  /** Persist a settings patch through the plugin's own settings document. */
  readonly update: (patch: FreeCodeGoReviewUpdate) => Promise<void>
}

/**
 * The workspace a review Remote acts on, resolved from the session.
 *
 * The error text names the requirement rather than the id, because the two cases
 * a caller can hit — an unknown session and a session without a workspace — are
 * one problem from the browser's side: there is nothing here to review.
 * @param host - the Host surface this Remote call reaches its services through.
 * @param sessionId - the session the request came from.
 * @returns the workspace root to review.
 */
export function reviewWorkspace(host: ReviewRemotesHost, sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > MAX_REF_CHARS) {
    throw new Error('a review requires the session it is about')
  }
  const cwd = host.ctx.sessions.get(SessionId(sessionId))?.header.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('a review requires an open workspace-backed conversation')
  }
  return cwd
}

/** One workspace's review surface: its settings, its runs, and its last report. */
export async function reviewStatus(host: ReviewRemotesHost, sessionId: string): Promise<FreeCodeGoReviewStatus> {
  const workspace = reviewWorkspace(host, sessionId)
  const settings = host.settings()
  const port = await host.portFor(workspace)
  const report = port.report()
  return {
    workspace,
    deep: settings.deep,
    mode: settings.mode,
    threshold: settings.threshold,
    cooldownTurns: settings.cooldownTurns,
    escalation: settings.escalation,
    runs: port.list(),
    ...(report === undefined ? {} : { report }),
  }
}

/**
 * Start a review for one session's workspace and answer with the current runs.
 *
 * The promise this starts is deliberately not awaited — see the module doc — and
 * its rejection is swallowed because the run manager publishes a run *before* the
 * work can fail: a target that cannot be resolved, a git command that failed, and a
 * reviewer that threw are all already visible in `runs` with their reason. Letting
 * the rejection escape would turn a review that failed into an unhandled rejection,
 * which is the one way a failure could be reported nowhere at all.
 * @param host - the Host surface this Remote call reaches its services through.
 * @param sessionId - the session the request came from.
 * @param request - what to review.
 * @returns the workspace's review surface, including the run just started.
 */
export async function reviewStart(
  host: ReviewRemotesHost,
  sessionId: string,
  request: FreeCodeGoReviewStartRequest | undefined,
): Promise<FreeCodeGoReviewStatus> {
  const workspace = reviewWorkspace(host, sessionId)
  const port = await host.portFor(workspace)
  const active = port.list().find(run => run.phase !== 'done')
  if (active !== undefined) {
    throw new Error(`a review is already running (${active.id}, ${active.mode}); wait for it to finish before starting another`)
  }
  const agent = host.ctx.agents.get(SessionId(sessionId))
  const reviewer = host.deepReviewerFor(agent)
  const inputs = reviewStartInputs(request, workspace)
  void port.review({
    request: inputs.request,
    ...(inputs.background === undefined ? {} : { background: inputs.background }),
    ...(reviewer === undefined ? {} : { reviewer }),
  }).catch(() => undefined)
  return reviewStatus(host, sessionId)
}

/** Persist a review settings change and answer with the workspace's new surface. */
export async function reviewUpdate(
  host: ReviewRemotesHost,
  sessionId: string,
  patch: FreeCodeGoReviewUpdate,
): Promise<FreeCodeGoReviewStatus> {
  await host.update(normalizeReviewPatch(patch))
  return reviewStatus(host, sessionId)
}

/**
 * Keep only the fields a settings page may set, with the values a review accepts.
 *
 * Built as an allow list rather than passing the object through: the patch arrives
 * from a browser, and `policy.update` merges whatever it is given into the plugin's
 * settings document. An unknown key that reached it would be written and then
 * blamed on the user's file.
 * @param patch - the patch as it arrived.
 * @returns the fields that will actually be written.
 */
export function normalizeReviewPatch(patch: FreeCodeGoReviewUpdate | undefined): FreeCodeGoReviewUpdate {
  if (patch === null || typeof patch !== 'object') throw new Error('a review settings update is required')
  const out: {
    reviewMode?: NonNullable<FreeCodeGoReviewUpdate['reviewMode']>
    reviewThreshold?: NonNullable<FreeCodeGoReviewUpdate['reviewThreshold']>
    reviewCooldownTurns?: number
    reviewDeep?: boolean
    reviewEscalation?: boolean
  } = {}
  if (patch.reviewMode !== undefined) {
    if (patch.reviewMode !== 'off' && patch.reviewMode !== 'record' && patch.reviewMode !== 'gate') throw new Error('the review mode must be off, record or gate')
    out.reviewMode = patch.reviewMode
  }
  if (patch.reviewThreshold !== undefined) {
    const severity = patch.reviewThreshold
    if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      throw new Error('the review threshold must be critical, high, medium or low')
    }
    out.reviewThreshold = severity
  }
  if (patch.reviewCooldownTurns !== undefined) {
    // Bounded here as well as in the schema so a value the schema would reject is
    // refused with a sentence rather than silently dropped by a merge.
    if (!Number.isInteger(patch.reviewCooldownTurns) || patch.reviewCooldownTurns < 0 || patch.reviewCooldownTurns > 20) {
      throw new Error('the review cooldown must be a whole number of stops between 0 and 20')
    }
    out.reviewCooldownTurns = patch.reviewCooldownTurns
  }
  if (patch.reviewDeep !== undefined) out.reviewDeep = patch.reviewDeep === true
  if (patch.reviewEscalation !== undefined) out.reviewEscalation = patch.reviewEscalation === true
  return out
}

/** A target request and background, validated, from the browser's request. */
export function reviewStartInputs(
  request: FreeCodeGoReviewStartRequest | undefined,
  workspace: string,
): { readonly request: ReviewTargetRequest; readonly background?: string } {
  const input = request === null || typeof request !== 'object' ? {} : request
  const mode: ReviewTargetMode = input.mode === 'range' || input.mode === 'commit' ? input.mode : 'workspace'
  // Refs are read only for the mode that uses them: a workspace request that also
  // carried a base ref would describe two different change sets, and whichever the
  // resolver ignored would be a field a caller could believe it had asked for.
  //
  // The validation itself is `reviewRef` from `targets.ts` — the module where a ref
  // becomes a git argument — so the browser path and the tool path are held to one
  // rule instead of two that can drift.
  const from = mode === 'range' ? reviewRef(input.from, 'from ref') : undefined
  const to = mode === 'range' ? reviewRef(input.to, 'to ref') : undefined
  const commit = mode === 'commit' ? reviewRef(input.commit, 'commit') : undefined
  const background = typeof input.background === 'string' && input.background.trim() !== ''
    ? input.background.trim().slice(0, MAX_BACKGROUND_CHARS)
    : undefined
  const exclude = normalizeExclude(input.exclude)
  return {
    request: {
      mode,
      cwd: workspace,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(commit === undefined ? {} : { commit }),
      ...(exclude === undefined ? {} : { exclude }),
    },
    ...(background === undefined ? {} : { background }),
  }
}

/** Exclude patterns, bounded in count and length; an empty list is no list at all. */
function normalizeExclude(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const patterns = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim().slice(0, MAX_REF_CHARS))
    .slice(0, MAX_EXCLUDE_PATTERNS)
  return patterns.length === 0 ? undefined : patterns
}
