/**
 * The run manager: the one place that owns in-flight reviews.
 *
 * Why the tools do not call the engine directly
 * -------------------------------------------
 * A review is long, cancellable, and observable, and all three of those are
 * properties *of the run*, not of the pipeline. Without a manager each caller —
 * the tool, the Remote behind the UI, the stop-time gate, the per-turn reviewer —
 * would keep its own map of what is running, and the second reader of that map is
 * how a UI shows a review that has already finished or fails to show one that has
 * not. So the registry lives here once, and every surface reads the same
 * snapshots.
 *
 * Why `preview` is not a "dry run" of the engine
 * ---------------------------------------------
 * `preview` answers *what would be reviewed and under which rule* — the two
 * questions that are pure git and pure glob, with no model call. It is exposed as
 * a first-class operation rather than a flag because it is also the LLM-free half
 * the upstream tool ships as delegation mode: a host agent that wants to do the
 * reviewing itself needs exactly this and nothing else.
 *
 * Concurrency is bounded and refusals are loud
 * --------------------------------------------
 * A review spawns model calls; two concurrent workspace reviews of the same tree
 * spend twice the budget to find the same findings. So the manager admits up to
 * `maxConcurrent` runs (one by default) and a further start is refused with a
 * reason naming the run that holds the slot — a refusal the caller can act on,
 * rather than a silent queue that looks like a hang.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/runs
 */

import { createReviewGitPort } from './git-port.ts'
import { groupByRule, type ReviewRuleGroup, type ReviewRuleResolver } from './rules.ts'
import { resolveReviewTarget, type ReviewGitPort, type ReviewTarget, type ReviewTargetRequest } from './targets.ts'
import { runReview, type ReviewEngineDeps } from './engine.ts'
import type { ReviewReport, ReviewRunState } from './report.ts'
import type { ReviewFilePort } from './reviewer.ts'
import type { ReviewEscalationPolicy, ReviewEscalationPort } from './escalation.ts'

/** A run's lifecycle, as a status surface renders it. */
export type ReviewRunPhase = 'resolving' | 'reviewing' | 'done'

/** One run's observable state. */
export interface ReviewRunSnapshot {
  readonly id: string
  readonly phase: ReviewRunPhase
  readonly state?: ReviewRunState
  readonly mode: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly files: number
  readonly reviewed: number
  readonly failed: number
  readonly skipped: number
  readonly findings: number
  readonly error?: string
}

/** What one review call is given, beyond the engine's own options. */
export interface ReviewRunInputs {
  readonly request: ReviewTargetRequest
  readonly background?: string
  readonly modelName?: string
  readonly reviewerName?: string
  readonly maxFiles?: number
  /** Confine the run to these exact paths, which is how a per-turn review stays cheap. */
  readonly include?: readonly string[]
  /**
   * Replace the per-file reviewer for this run only.
   *
   * Per run rather than per manager because the deeper reviewer is built from the
   * agent that asked for the review — a subagent reviewer opens a child in that
   * agent's session — and the manager serves every session in a workspace. The
   * default stays the installed one, so a caller that has nothing deeper to offer
   * simply omits this.
   */
  readonly reviewer?: ReviewFilePort
  readonly signal?: AbortSignal
}

/** The deterministic half: what would be reviewed, and under which rule. */
export interface ReviewPreview {
  readonly target: ReviewTarget
  readonly ruleGroups: readonly ReviewRuleGroup[]
}

/** The surface the review tools are written against. */
export interface ReviewRunPort {
  /** Run a review to completion. */
  review(inputs: ReviewRunInputs): Promise<{ readonly report: ReviewReport; readonly refused: readonly { readonly path: string; readonly reason: string }[]; readonly notes: readonly string[]; readonly attribution: string }>
  /** Resolve the change set and its rules without calling a model. */
  preview(request: ReviewTargetRequest, options?: { readonly maxFileBytes?: number; readonly maxFiles?: number; readonly include?: readonly string[] }): Promise<ReviewPreview>
  /** The run in flight, the last finished run, or a named one. */
  status(id?: string): ReviewRunSnapshot | undefined
  /** Every run the manager still remembers, most recent first. */
  list(): readonly ReviewRunSnapshot[]
  /** The last published report, or a named one. */
  report(id?: string): ReviewReport | undefined
  /** Abort a run by id, or the run in flight when no id is given. */
  cancel(id?: string): boolean
}

/** Manager construction inputs. */
export interface ReviewRunsOptions {
  readonly git?: ReviewGitPort
  /**
   * Everything the engine needs except git and the rule resolver, both of which
   * the manager supplies: a caller that had to pass the resolver twice could pass
   * two that disagree, and `preview` and `review` would then answer differently
   * about the same file.
   */
  readonly engine: Omit<ReviewEngineDeps, 'git' | 'rules'>
  /** How many reviews may be in flight at once; one by default. */
  readonly maxConcurrent?: number
  /** How many finished runs are remembered; the reports are kept with them. */
  readonly keep?: number
  readonly rules: ReviewRuleResolver
  readonly now?: () => number
  /**
   * Adjudication for each run, resolved per run.
   *
   * A function rather than a value because the setting behind it can change while
   * a workspace's install is cached: a value bound at construction would leave a
   * user who turns adjudication on reviewing without it until a reload.
   */
  readonly escalation?: () => { readonly port?: ReviewEscalationPort; readonly policy?: ReviewEscalationPolicy }
}

/** The in-flight and recent runs. */
export class ReviewRuns implements ReviewRunPort {
  private readonly git: ReviewGitPort
  private readonly deps: ReviewEngineDeps
  private readonly maxConcurrent: number
  private readonly keep: number
  private readonly rules: ReviewRuleResolver
  private readonly now: () => number
  private readonly escalation: (() => { readonly port?: ReviewEscalationPort; readonly policy?: ReviewEscalationPolicy }) | undefined
  private readonly snapshots: ReviewRunSnapshot[] = []
  private readonly reports = new Map<string, ReviewReport>()
  private readonly controllers = new Map<string, AbortController>()
  /**
   * Runs started, ever.
   *
   * Part of every id, because the other two components cannot make one unique: the
   * clock is not guaranteed to advance between two runs, and the retained-count
   * component *cycles* as finished runs are trimmed — so within one millisecond
   * two runs could be named the same thing. A repeated id does not merely read
   * oddly: `push` finds the existing snapshot and replaces it, and the report map
   * is keyed the same way, so the newer run would overwrite the older one's
   * history and its report.
   */
  private started = 0

  constructor(options: ReviewRunsOptions) {
    this.git = options.git ?? createReviewGitPort()
    this.deps = { ...options.engine, git: this.git, rules: options.rules }
    this.rules = options.rules
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
    this.keep = Math.max(1, options.keep ?? 5)
    this.now = options.now ?? Date.now
    this.escalation = options.escalation
  }

  /** Whether a review is in flight. */
  get busy(): boolean {
    return this.snapshots.some(snapshot => snapshot.phase !== 'done')
  }

  async review(inputs: ReviewRunInputs) {
    const active = this.snapshots.filter(snapshot => snapshot.phase !== 'done')
    if (active.length >= this.maxConcurrent) {
      const holder = active[0] as ReviewRunSnapshot
      throw new Error(`a review is already running (${holder.id}, ${holder.mode}); cancel it or wait for it to finish`)
    }

    const controller = new AbortController()
    this.started += 1
    const id = `review-${this.now().toString(36)}-${this.started.toString(36)}`
    const startedAt = this.now()
    // The caller's signal and the manager's own both abort the run: the caller
    // may give up, and the manager may be asked to cancel, and neither should
    // have to know about the other.
    const signal = combineSignals(controller, inputs.signal)

    let snapshot: ReviewRunSnapshot = {
      id,
      phase: 'resolving',
      mode: inputs.request.mode,
      startedAt,
      files: 0,
      reviewed: 0,
      failed: 0,
      skipped: 0,
      findings: 0,
    }
    this.push(snapshot)
    this.controllers.set(id, controller)

    try {
      const result = await runReview(
        inputs.reviewer === undefined ? this.deps : { ...this.deps, reviewer: inputs.reviewer },
        {
          request: inputs.request,
          // The id the manager already published, so a status entry and a report are
          // reachable by the same name.
          id,
          ...(inputs.background === undefined ? {} : { background: inputs.background }),
          ...(inputs.modelName === undefined ? {} : { modelName: inputs.modelName }),
          ...(inputs.reviewerName === undefined ? {} : { reviewerName: inputs.reviewerName }),
          ...(inputs.maxFiles === undefined ? {} : { maxFiles: inputs.maxFiles }),
          ...(inputs.include === undefined ? {} : { include: inputs.include }),
          ...(this.escalation === undefined ? {} : { escalation: this.escalation() }),
          signal,
          onEvent: event => {
            snapshot = applyEvent(snapshot, event)
            this.push(snapshot)
          },
        },
      )
      this.reports.set(result.report.id, result.report)
      snapshot = {
        ...snapshot,
        phase: 'done',
        state: result.report.state,
        finishedAt: this.now(),
        reviewed: result.report.coverage.reviewedFiles,
        failed: result.report.coverage.failedFiles,
        skipped: result.report.coverage.skippedFiles,
        files: result.report.coverage.totalFiles,
        findings: result.report.comments.filter(comment => comment.state !== 'filtered').length,
      }
      this.push(snapshot)
      return result
    } catch (error) {
      snapshot = { ...snapshot, phase: 'done', state: 'failed', finishedAt: this.now(), error: (error as Error).message }
      this.push(snapshot)
      throw error
    } finally {
      this.controllers.delete(id)
      this.trim()
    }
  }

  async preview(request: ReviewTargetRequest, options: { readonly maxFileBytes?: number; readonly maxFiles?: number; readonly include?: readonly string[] } = {}): Promise<ReviewPreview> {
    const target = await resolveReviewTarget(this.git, request, {
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
      ...(options.include === undefined ? {} : { include: options.include }),
    })
    const reviewable = target.files.filter(file => this.rules.excludeSource(file.path) === undefined)
    return { target, ruleGroups: groupByRule(this.rules, reviewable.map(file => file.path)) }
  }

  status(id?: string): ReviewRunSnapshot | undefined {
    if (id !== undefined) return this.snapshots.find(snapshot => snapshot.id === id)
    return this.snapshots.find(snapshot => snapshot.phase !== 'done') ?? this.snapshots[0]
  }

  list(): readonly ReviewRunSnapshot[] {
    return this.snapshots
  }

  report(id?: string): ReviewReport | undefined {
    // A named lookup answers about that run or not at all. Falling back to another
    // run's report would answer a question about run X with run Y's findings, which
    // is the one thing a report must never do.
    if (id !== undefined) return this.reports.get(id)
    const latest = this.status()
    if (latest === undefined) return undefined
    // The most recent *published* report: the newest run may still be in flight,
    // and a run that failed before publishing has none at all.
    return this.reports.get(latest.id) ?? [...this.reports.values()].at(-1)
  }

  cancel(id?: string): boolean {
    const target = id ?? this.status()?.id
    if (target === undefined) return false
    const controller = this.controllers.get(target)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** Fold one engine event into a snapshot. */
  private push(snapshot: ReviewRunSnapshot): void {
    const at = this.snapshots.findIndex(entry => entry.id === snapshot.id)
    if (at === -1) this.snapshots.unshift(snapshot)
    else this.snapshots[at] = snapshot
  }

  /** Forget the oldest finished runs past the retention count. */
  private trim(): void {
    const finished = this.snapshots.filter(snapshot => snapshot.phase === 'done')
    for (const stale of finished.slice(this.keep)) {
      this.snapshots.splice(this.snapshots.indexOf(stale), 1)
      this.reports.delete(stale.id)
    }
  }
}

/** Fold one engine event into the running snapshot. */
function applyEvent(snapshot: ReviewRunSnapshot, event: { readonly type: string; readonly files?: number; readonly state?: string; readonly group?: number; readonly groups?: number }): ReviewRunSnapshot {
  switch (event.type) {
    case 'target':
      return { ...snapshot, phase: 'reviewing', files: event.files ?? snapshot.files }
    case 'file':
      return snapshot
    case 'done': {
      const state = event.state as ReviewRunState | undefined
      return { ...snapshot, phase: 'done', ...(state === undefined ? {} : { state }) }
    }
    default:
      return snapshot
  }
}

/**
 * Abort the manager's controller when the caller's signal aborts.
 *
 * Takes the controller rather than its signal because a signal cannot abort
 * itself: dispatching an `abort` event on one leaves `signal.aborted` false, so a
 * downstream `signal?.aborted` check would disagree with the listener that fired.
 */
function combineSignals(controller: AbortController, caller: AbortSignal | undefined): AbortSignal {
  if (caller === undefined) return controller.signal
  if (caller.aborted) {
    controller.abort()
    return controller.signal
  }
  caller.addEventListener('abort', () => controller.abort(), { once: true })
  return controller.signal
}

/** The port shape a tool factory needs, so a test can supply a fake. */
export type ReviewToolPort = ReviewRunPort
