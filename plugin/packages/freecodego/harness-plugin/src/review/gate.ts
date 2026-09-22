/**
 * The stop-time review: one pass, two delivery channels.
 *
 * Why "every turn" and "a stop gate" are the same hook
 * ---------------------------------------------------
 * They sound like two features and they are one review. A per-turn reviewer that
 * runs at `turn/end` and a gate that runs at `turn-stopping` would each read the
 * same diff of the same change set and pay for it twice, and the two results
 * could disagree about the same tree — the same failure this plugin refuses
 * everywhere else. So there is one pass, run when the turn is about to end, and
 * two ways its result is used:
 *
 * - **record** — always. The findings become durable session events, so what a
 *   review said is answerable later without re-running it.
 * - **deliver** — only when a finding is at or above the configured threshold and
 *   the cooldown has elapsed. Delivery is an injected message, which is the
 *   mechanism the harness gives at stop time: it continues the turn, so the agent
 *   has to answer the finding before it can finish. That is what makes this a gate
 *   rather than a notification, and it is the same shape `verify-on-stop` uses.
 *
 * Three rules keep the cost bounded, and each one is a test
 * -------------------------------------------------------
 * 1. **A turn that changed nothing is never reviewed.** The pass runs only after a
 *    mutating tool actually ran, so a conversation turn costs no git call.
 * 2. **A change set is reviewed once.** The latch is keyed on the fingerprint of
 *    the changed paths *and* the workspace revision, because a second edit of an
 *    already-modified file changes no path — the path list alone would call two
 *    different states the same state.
 * 3. **A run is confined to what the turn touched.** `include` carries the turn's
 *    own changed paths, so files that were already dirty are not re-reviewed and
 *    their findings are not reported as this turn's. The turn's paths come from the
 *    Host's own per-turn record where one exists, and fall back to the workspace's
 *    uncommitted change set where it does not — see `turn-scope.ts`, which owns both
 *    rules and the reasons a narrowing is refused.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/gate
 */

import { createHash } from 'node:crypto'
import { REVIEW_SEVERITIES, type ReviewComment, type ReviewSeverity } from './comments.ts'
import type { ReviewReport, ReviewRunState } from './report.ts'
import type { ReviewRunPort } from './runs.ts'
import { WORKSPACE_MUTATING_TOOLS } from '../verify-on-stop.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The durable summary of one stop-time review.
     *
     * A summary rather than the report itself: a report carries every finding and
     * every skipped file, and a session event is replayed on every resume. The full
     * report stays in the run manager, which is what `engineering_review_report`
     * reads — so a session that records "2 findings, one blocking" can still answer
     * *which* two, for as long as the manager retains the run.
     */
    'freecodego/review': ReviewGateRecord
  }
}

/** What one stop-time review writes to the session. */
export interface ReviewGateRecord {
  readonly id: string
  readonly state: ReviewRunState
  readonly sequence: number
  readonly files: number
  readonly reviewed: number
  readonly findings: number
  readonly blocking: number
  readonly worst?: ReviewSeverity
  readonly delivered: boolean
  readonly suppressed?: ReviewGateDelivery['suppressed']
}

/** How the stop-time review behaves. */
export type ReviewGateMode =
  /** Off: no pass, no cost. */
  | 'off'
  /** Record findings on the session without ever injecting them. */
  | 'record'
  /** Record, and inject when a finding reaches the threshold. */
  | 'gate'

/** The gate's configuration. */
export interface ReviewGateSettings {
  readonly mode: ReviewGateMode
  /** The least severe finding that is delivered rather than only recorded. */
  readonly threshold: ReviewSeverity
  /** Turns to wait after a delivery before delivering again, so a repeating finding is not repeated. */
  readonly cooldownTurns: number
}

/**
 * Shipped defaults: off, and — once switched on — gate at `high` without nagging
 * about the same class of finding every stop.
 *
 * `off` rather than `gate` or `record` because this value is the fallback for a
 * composition with no settings service, and a review that runs when nothing asked
 * it to is the one behaviour a plugin must not choose on a user's behalf. The
 * threshold and cooldown still carry the values the modes use, so switching the
 * mode on is the only decision left.
 */
export const DEFAULT_REVIEW_GATE_SETTINGS: ReviewGateSettings = {
  mode: 'off',
  threshold: 'high',
  cooldownTurns: 3,
}

/** What one pass delivered, which a status surface and the tests both read. */
export interface ReviewGateDelivery {
  /**
   * Which stop this pass was, counted per agent from one.
   *
   * A stop counter rather than the harness's turn number: the `turn-stopping`
   * payload does not carry one, and the two uses here — the cooldown and the
   * message's "which review is this" — need a monotonic sequence, not the
   * conversation's own numbering. Naming it `turn` would be a claim about the
   * session that this value cannot support.
   */
  readonly sequence: number
  /** Every finding the review produced, filtered ones excluded. */
  readonly findings: number
  /** Findings at or above the threshold. */
  readonly blocking: number
  /** The worst severity present, absent when there were no findings. */
  readonly worst?: ReviewSeverity
  /** Whether a message was injected. */
  readonly delivered: boolean
  /**
   * Why nothing was delivered, when nothing was.
   *
   * Three distinct facts, and they are not interchangeable. `below-threshold`
   * means the run found nothing severe enough. `recording-only` means the mode
   * deliberately does not inject — findings may be as severe as they like. Only
   * `cooldown` is about timing. Reporting a `record`-mode pass full of critical
   * findings as "already reviewed" would put a false statement about the run into
   * a durable session event, where it is read by a surface that cannot tell.
   */
  readonly suppressed?: 'below-threshold' | 'cooldown' | 'recording-only'
}

/** One pass's outcome. */
export type ReviewGateOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'ran'; readonly delivery: ReviewGateDelivery }
  | { readonly kind: 'failed'; readonly reason: string }

/** The collaborators the gate needs. */
export interface ReviewGatePorts {
  /** The current settings, read per pass so a change takes effect without a reload. */
  settings(): ReviewGateSettings
  /** The workspace an agent is in. */
  workspaceOf(agentId: string): string
  /**
   * The paths the turn changed, or `undefined` when git could not answer.
   *
   * `turn` is the stopping turn, which the reader uses to prefer the Host's own
   * per-turn record over the workspace's whole uncommitted set. See
   * {@link import('./turn-scope.ts')} for why that narrowing is guarded.
   */
  readChangedPaths(agentId: string, turn: number | undefined): Promise<readonly string[] | undefined>
  /** The current workspace revision, or `undefined` when it could not be read. */
  readChangeRevision(agentId: string): Promise<string | undefined>
  /** The review surface for one workspace. */
  portFor(workspace: string): Promise<ReviewRunPort>
  /** Record a finished pass on the session. */
  record(agentId: string, report: ReviewReport, delivery: ReviewGateDelivery): void
  /** Inject a message the agent must answer; returning false means the agent is gone. */
  inject(agentId: string, text: string): boolean
}

/** Per-agent state the gate keeps between turns. */
interface AgentState {
  /** Tool names seen since the last pass, to decide whether anything was touched. */
  mutating: boolean
  /** The fingerprint of the change set the last pass reviewed. */
  fingerprint?: string
  /** The stop the last delivery happened on. */
  deliveredSequence?: number
  /** How many times this agent has stopped, which is what the sequence counts. */
  stops: number
}

/** The stop-time review gate. */
export class FreeCodeGoReviewGate {
  private readonly states = new Map<string, AgentState>()

  constructor(private readonly ports: ReviewGatePorts) {}

  /** Note that a tool ran, which is what makes a turn eligible for a pass. */
  noteToolCall(agentId: string, toolName: string): void {
    if (!WORKSPACE_MUTATING_TOOLS.has(toolName)) return
    const state = this.stateOf(agentId)
    state.mutating = true
  }

  /** Drop everything remembered about one agent. */
  forget(agentId: string): void {
    this.states.delete(agentId)
  }

  /** Drop every agent, for a plugin unload. */
  clear(): void {
    this.states.clear()
  }

  /**
   * Run the pass for one agent about to end a turn.
   *
   * Never throws: a review is an addition to a turn, and a turn that could not be
   * reviewed must still be able to end. A failure is `failed` with its reason, and
   * the caller decides whether to log it.
   */
  async onTurnStopping(
    agentId: string,
    options: { readonly turn?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ReviewGateOutcome> {
    const settings = this.ports.settings()
    const state = this.stateOf(agentId)
    state.stops += 1
    const sequence = state.stops
    if (settings.mode === 'off') return { kind: 'skipped', reason: 'the stop-time review is off' }
    if (!state.mutating) return { kind: 'skipped', reason: 'the turn changed nothing' }

    try {
      const paths = await this.ports.readChangedPaths(agentId, options.turn)
      if (paths === undefined) return { kind: 'skipped', reason: 'the change set could not be read' }
      if (paths.length === 0) {
        // A mutating tool that changed nothing — a write of identical content, an
        // edit reverted in the same turn — leaves the flag set, and every later
        // stop would then re-read the change set to learn again that it is empty.
        // git answered, so the answer is known rather than unknown: clear the flag.
        // A *failed* read is left set, because that one may well have missed a change.
        state.mutating = false
        return { kind: 'skipped', reason: 'the turn changed nothing' }
      }

      const revision = await this.ports.readChangeRevision(agentId)
      const fingerprint = changeFingerprint(paths, revision)
      if (state.fingerprint === fingerprint) {
        return { kind: 'skipped', reason: 'this change set was already reviewed' }
      }

      const workspace = this.ports.workspaceOf(agentId)
      const port = await this.ports.portFor(workspace)
      const result = await port.review({
        request: { mode: 'workspace', cwd: workspace },
        include: paths,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })

      // The latch is set before delivery, not after: a delivery that throws, or
      // an agent that is already gone, must still not cause the same change set to
      // be reviewed again on the next stop.
      state.mutating = false
      state.fingerprint = fingerprint

      const published = result.report.comments.filter(comment => comment.state !== 'filtered')
      const blocking = published.filter(comment => severityRank(comment.severity) <= severityRank(settings.threshold))
      const worst = worstSeverity(published)

      const cooled = state.deliveredSequence === undefined || sequence - state.deliveredSequence >= settings.cooldownTurns
      const deliverable = settings.mode === 'gate' && blocking.length > 0
      let delivered = false
      let suppressed: ReviewGateDelivery['suppressed']
      if (!deliverable) {
        // Which of the two reasons it is depends on the mode, not on the findings:
        // a `record` pass never injects, however severe what it found.
        suppressed = settings.mode === 'record' ? 'recording-only' : 'below-threshold'
      } else if (!cooled) {
        suppressed = 'cooldown'
      } else {
        delivered = this.ports.inject(agentId, renderGateMessage(result.report, blocking, sequence))
        if (delivered) state.deliveredSequence = sequence
      }

      const delivery: ReviewGateDelivery = {
        sequence,
        findings: published.length,
        blocking: blocking.length,
        delivered,
        ...(worst === undefined ? {} : { worst }),
        ...(suppressed === undefined ? {} : { suppressed }),
      }
      this.ports.record(agentId, result.report, delivery)
      return { kind: 'ran', delivery }
    } catch (error) {
      // A review failure must not read as "the change is clean": the reason is
      // returned and the caller logs it, and nothing is injected.
      state.mutating = false
      return { kind: 'failed', reason: (error as Error).message }
    }
  }

  private stateOf(agentId: string): AgentState {
    const existing = this.states.get(agentId)
    if (existing !== undefined) return existing
    const created: AgentState = { mutating: false, stops: 0 }
    this.states.set(agentId, created)
    return created
  }
}

/** Build the durable summary of one pass. */
export function reviewGateRecord(report: ReviewReport, delivery: ReviewGateDelivery): ReviewGateRecord {
  return {
    id: report.id,
    state: report.state,
    sequence: delivery.sequence,
    files: report.coverage.totalFiles,
    reviewed: report.coverage.reviewedFiles,
    findings: delivery.findings,
    blocking: delivery.blocking,
    delivered: delivery.delivered,
    ...(delivery.worst === undefined ? {} : { worst: delivery.worst }),
    ...(delivery.suppressed === undefined ? {} : { suppressed: delivery.suppressed }),
  }
}

/**
 * The fingerprint of one change set: its paths and the workspace revision.
 *
 * The revision is not decoration. Two turns can touch the same path with
 * different content, and a fingerprint over paths alone would treat the second
 * turn's edit as already reviewed — the exact bug a path-list latch produced
 * before `verify-on-stop` started including content.
 */
export function changeFingerprint(paths: readonly string[], revision: string | undefined): string {
  const hash = createHash('sha256')
  hash.update([...paths].sort().join('\n'))
  hash.update('\u0000')
  hash.update(revision ?? '')
  return hash.digest('hex').slice(0, 32)
}

/** Rank of a severity, lowest number being most severe. */
function severityRank(severity: ReviewSeverity): number {
  return REVIEW_SEVERITIES.indexOf(severity)
}

/** The worst severity present among comments, or undefined for none. */
export function worstSeverity(comments: readonly ReviewComment[]): ReviewSeverity | undefined {
  let worst: ReviewSeverity | undefined
  for (const comment of comments) {
    if (worst === undefined || severityRank(comment.severity) < severityRank(worst)) worst = comment.severity
  }
  return worst
}

/**
 * The message injected at stop time.
 *
 * Names each finding with its location and severity, so the agent can act without
 * asking which one was meant, and states that the review ran on this turn's own
 * change set, so a finding about a file the turn did not touch is not implied.
 */
export function renderGateMessage(report: ReviewReport, blocking: readonly ReviewComment[], sequence: number): string {
  const lines = [`The stop-time review of this turn's change set (review #${sequence}) found ${blocking.length} finding(s) at or above the reporting threshold:`]
  for (const comment of blocking) {
    const at = comment.startLine > 0
      ? `${comment.path}:${comment.startLine}`
      : `${comment.path} (position not determined)`
    lines.push(`- [${comment.severity}/${comment.category}] ${at} — ${comment.content.split('\n')[0] ?? ''}`)
  }
  lines.push('')
  lines.push(`The full report for run \`${report.id}\` is available through engineering_review_report, which also renders it as JSON or SARIF. Address each finding, or state why it is not actionable, before ending the turn.`)
  return lines.join('\n')
}
