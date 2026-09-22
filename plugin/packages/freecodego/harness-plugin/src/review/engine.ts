/**
 * The review engine: one run, from a request to a report.
 *
 * The order of stages, and why it is this order
 * --------------------------------------------
 * 1. **Resolve the target** — decide what the change *is*, before any model call.
 * 2. **Apply rule exclusions** — a project's own exclusion is reported before a
 *    size or binary skip could claim the same file with a different reason.
 * 3. **Group** — one bounded call, with a deterministic fallback, so a grouping
 *    failure degrades the run instead of ending it.
 * 4. **Plan, then review each file** — the plan is per batch, the review per file.
 * 5. **Relocate** — a finding is put on a line only with evidence.
 * 6. **Filter** — fail-open, and only after relocation, so the fact-checker sees
 *    the coordinates the report will actually publish.
 * 7. **Assemble** — coverage, budget, and the refused contributions, together.
 *
 * Two invariants the engine enforces rather than documents
 * ------------------------------------------------------
 * **No stage can spend without it being metered.** Every model call's tokens are
 * folded into the budget state before the next decision, so the budget is a real
 * bound and {@link ReviewRunResult.report}'s budget summary is a fact.
 *
 * **Every file that entered leaves with a state.** A group that is refused by the
 * budget marks its files `failed` with the budget's own reason, a reviewer
 * rejection marks its file `failed` with the error, and an excluded file is
 * `skipped` with the layer that excluded it. Nothing is ever simply absent —
 * which is what makes {@link summarizeCoverage}'s arithmetic trustworthy.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/engine
 */

import { randomUUID } from 'node:crypto'
import {
  DEFAULT_REVIEW_BUDGET,
  admitGroup,
  admitRound,
  consumeFinalRound,
  createBudgetState,
  recordSpend,
  summarizeBudget,
  type ReviewBudgetLimits,
  type ReviewBudgetState,
} from './budget.ts'
import { validateReviewComment, type ReviewComment, type ReviewCommentInput } from './comments.ts'
import { missingReasons, summarizeCoverage, type ReviewFileOutcome } from './coverage.ts'
import { filterComments } from './filter.ts'
import {
  DEFAULT_ESCALATION_POLICY,
  escalateFindings,
  type EscalationReport,
  type ReviewEscalationPolicy,
  type ReviewEscalationPort,
} from './escalation.ts'
import { groupByRule, type ReviewRuleResolver } from './rules.ts'
import { groupChanges } from './grouping.ts'
import { planGroup, type ReviewPlanTool } from './plan.ts'
import { applyRelocation, relocateComment } from './relocate.ts'
import { assembleReviewReport, type ReviewReport, type ReviewRunState, type ReviewTargetSummary } from './report.ts'
import { resolveReviewTarget, type ReviewGitPort, type ReviewTarget, type ReviewTargetRequest, type ReviewableFile } from './targets.ts'
import type { ReviewModelPort } from './model.ts'
import type { ReviewFilePort } from './reviewer.ts'
import { REVIEW_PROMPT_ATTRIBUTION } from './prompts.ts'

/**
 * The tools the planning prompt may name.
 *
 * These are the plugin's own read and search surfaces, so a plan's suggested
 * follow-ups are calls a reviewer can actually make rather than plausible-looking
 * names. Kept here rather than in the adapter layer because the plan prompt's
 * legitimacy rests on the list being the real one.
 */
export const DEFAULT_REVIEW_PLAN_TOOLS: readonly ReviewPlanTool[] = [
  { name: 'read', description: 'Read a workspace file, optionally a line range.' },
  { name: 'engineering_codegraph_search', description: 'Search the workspace for a symbol or a text pattern.' },
  { name: 'engineering_codegraph_affected', description: 'List the call sites and dependents of a symbol.' },
  { name: 'engineering_codegraph_path', description: 'Trace a dependency path between two symbols.' },
  { name: 'engineering_repo_map', description: 'Show the repository structure around a path.' },
]

/** The collaborators a run needs, all injected. */
export interface ReviewEngineDeps {
  readonly git: ReviewGitPort
  readonly model: ReviewModelPort
  readonly reviewer: ReviewFilePort
  readonly rules: ReviewRuleResolver
  readonly planTools?: readonly ReviewPlanTool[]
  readonly now?: () => number
  readonly newId?: () => string
}

/** One run's inputs. */
export interface RunReviewOptions {
  readonly request: ReviewTargetRequest
  /**
   * The run's id, when a caller already assigned one.
   *
   * The run manager names a run the moment it accepts it — a status surface has to
   * show something before the first file is read — so it passes that name down
   * rather than letting the engine mint a second one. Two ids for one run is how
   * the id a status lists stops resolving in the report lookup that is supposed to
   * take it, and the user is told their run has no report.
   */
  readonly id?: string
  readonly background?: string
  /** Display name of the model, for the report. */
  readonly modelName?: string
  /** Display name of the reviewer identity, for the report and per-comment provenance. */
  readonly reviewerName?: string
  readonly budget?: ReviewBudgetLimits
  readonly maxFileBytes?: number
  readonly maxFiles?: number
  /** Confine the run to these exact paths; a changed file outside them is skipped, not reviewed. */
  readonly include?: readonly string[]
  /**
   * Adjudicate high-severity findings before publishing them.
   *
   * Off unless a port is supplied, because an adjudicator costs calls per finding
   * and the plugin's stronger implementation — a multi-engine council — is a
   * composition decision, not a default a review should make for every caller.
   */
  readonly escalation?: { readonly port?: ReviewEscalationPort; readonly policy?: ReviewEscalationPolicy }
  readonly signal?: AbortSignal
  /** Called as the run progresses; a throw here is the caller's problem, not a run failure. */
  readonly onEvent?: (event: ReviewEvent) => void
}

/** Progress a status surface can render. */
export type ReviewEvent =
  | { readonly type: 'target'; readonly files: number; readonly excluded: number }
  | { readonly type: 'group'; readonly group: number; readonly groups: number; readonly files: number }
  | { readonly type: 'file'; readonly path: string; readonly state: 'reviewed' | 'failed' | 'skipped'; readonly reason?: string }
  | { readonly type: 'done'; readonly state: ReviewRunState }

/** One run's result. */
export interface ReviewRunResult {
  readonly report: ReviewReport
  readonly target: ReviewTarget
  /** Contributions refused by validation, kept so a malformed reviewer is visible. */
  readonly refused: readonly { readonly path: string; readonly reason: string }[]
  /** Non-fatal degradations: a rejected grouping, a failed filter, an unreadable response. */
  readonly notes: readonly string[]
  /** Attribution for the prompt corpus, carried so a published run can state it. */
  readonly attribution: string
}

/** Run one review end to end. */
export async function runReview(deps: ReviewEngineDeps, options: RunReviewOptions): Promise<ReviewRunResult> {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const limits = options.budget ?? DEFAULT_REVIEW_BUDGET
  const signal = options.signal
  const reviewerName = options.reviewerName ?? 'reviewer'
  const id = options.id ?? newId()
  const startedAt = now()

  const target = await resolveReviewTarget(deps.git, options.request, {
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    ...(options.include === undefined ? {} : { include: options.include }),
  })

  // Rule exclusions are applied before any skip reason is assigned, so a file a
  // project already decided about is reported as excluded and not as, say,
  // binary.
  const excluded = [...target.excluded]
  const files: ReviewableFile[] = []
  for (const file of target.files) {
    const source = deps.rules.excludeSource(file.path)
    if (source !== undefined) {
      excluded.push({ path: file.path, reason: 'excluded', detail: `excluded by the ${source} rule layer` })
      continue
    }
    files.push(file)
  }
  /** Reviewed files by path, which relocation resolves against. */
  const byPath = new Map(files.map(file => [file.path, file]))
  /**
   * Paths a finding named that this run did not review.
   *
   * Kept and reported rather than dropped: a reviewer that names a file outside the
   * change set may have found something real — but its line number is one nobody
   * checked, and a reader has to know which findings those are.
   */
  const unattributed = new Set<string>()
  options.onEvent?.({ type: 'target', files: files.length, excluded: excluded.length })

  const outcomes = new Map<string, ReviewFileOutcome>()
  for (const entry of excluded) {
    outcomes.set(`excluded:${entry.path}`, {
      path: entry.path,
      change: 'excluded',
      state: 'skipped',
      reason: `${entry.reason}: ${entry.detail}`,
      comments: 0,
    })
  }
  for (const file of files) {
    outcomes.set(file.path, { path: file.path, change: changeLabel(file), state: 'pending', comments: 0 })
  }

  const comments: ReviewComment[] = []
  const escalations: EscalationReport[] = []
  const refused: { path: string; reason: string }[] = []
  const notes: string[] = []
  let budget: ReviewBudgetState = createBudgetState()
  let counter = 0

  const spend = (groupId: string, tokens: number): void => {
    budget = recordSpend(budget, groupId, tokens)
  }
  const fail = (path: string, reason: string): void => {
    outcomes.set(path, { ...(outcomes.get(path) as ReviewFileOutcome), state: 'failed', reason })
    options.onEvent?.({ type: 'file', path, state: 'failed', reason })
  }

  if (files.length > 0) {
    const ruleGroups = groupByRule(deps.rules, files.map(file => file.path))
    const grouping = await groupChanges(deps.model, files, ruleGroups, {
      ...(signal === undefined ? {} : { signal }),
    })
    spend('grouping', grouping.spent.inputTokens + grouping.spent.outputTokens)
    if (grouping.grouped.note !== undefined) notes.push(grouping.grouped.note)

    const groups = grouping.grouped.groups
    for (const group of groups) {
      if (signal?.aborted === true) {
        for (const file of group.files) fail(file.path, 'the run was cancelled')
        continue
      }
      options.onEvent?.({ type: 'group', group: group.id, groups: groups.length, files: group.files.length })

      const admission = admitGroup(budget, limits)
      if (!admission.ok) {
        for (const file of group.files) fail(file.path, admission.reason)
        continue
      }
      const groupKey = `g${group.id}`
      const round = admitRound(budget, groupKey, limits)
      if (!round.ok) {
        for (const file of group.files) fail(file.path, round.reason)
        continue
      }
      if (round.final) {
        budget = consumeFinalRound(budget, groupKey)
        notes.push(`group ${group.id} was over its budget and ran its final round`)
      }

      const planned = await planGroup(deps.model, group, deps.planTools ?? DEFAULT_REVIEW_PLAN_TOOLS, {
        ...(options.background === undefined ? {} : { background: options.background }),
        ...(signal === undefined ? {} : { signal }),
      })
      spend(`plan${group.id}`, planned.spent.inputTokens + planned.spent.outputTokens)
      if (planned.outcome.kind === 'unavailable') notes.push(`group ${group.id}: ${planned.outcome.reason}`)
      const plan = planned.outcome.kind === 'planned' ? planned.outcome.plan : undefined

      const batch: ReviewComment[] = []
      // The rule text each file was reviewed under, so an adjudicator judges a
      // finding against the standard that produced it rather than a reconstruction.
      const ruleText = new Map<string, string>()
      for (const file of group.files) {
        const resolved = deps.rules.resolve(file.path)
        ruleText.set(file.path, resolved.mergedRule === undefined ? resolved.rule : `${resolved.rule}\n\n${resolved.mergedRule}`)
        try {
          const outcome = await deps.reviewer.review({
            group,
            file,
            rule: {
              source: resolved.source,
              pattern: resolved.pattern,
              text: resolved.mergedRule === undefined ? resolved.rule : `${resolved.rule}\n\n${resolved.mergedRule}`,
            },
            ...(plan === undefined ? {} : { plan }),
            ...(options.background === undefined ? {} : { background: options.background }),
            reviewer: reviewerName,
            ...(signal === undefined ? {} : { signal }),
          })
          spend(groupKey, outcome.spent.inputTokens + outcome.spent.outputTokens)
          if (outcome.note !== undefined) notes.push(`${file.path}: ${outcome.note}`)

          let accepted = 0
          for (const input of outcome.comments) {
            counter += 1
            const verdict = validateReviewComment(
              { ...(input as ReviewCommentInput), path: input.path ?? file.path, reviewer: reviewerName },
              `${id}-c${counter}`,
            )
            if (!verdict.ok) {
              refused.push({ path: file.path, reason: verdict.reason })
              continue
            }
            batch.push(verdict.comment)
            accepted += 1
          }
          outcomes.set(file.path, { ...(outcomes.get(file.path) as ReviewFileOutcome), state: 'reviewed', comments: accepted })
          options.onEvent?.({ type: 'file', path: file.path, state: 'reviewed' })
        } catch (error) {
          fail(file.path, `the reviewer failed: ${(error as Error).message}`)
        }
      }

      // Relocation before filtering: the fact-checker must see the coordinates
      // the report will publish, not the ones the reviewer guessed.
      //
      // The lookup is over the whole change set rather than this batch, because a
      // reviewer shown neighbouring files as reference can name one of them and that
      // file's diff may belong to another group. A path in neither is a finding this
      // run cannot verify at all — kept, at the reviewer's own coordinates, and
      // counted so the report says so.
      const relocated = batch.map(comment => {
        const file = byPath.get(comment.path)
        if (file === undefined) {
          unattributed.add(comment.path)
          return comment
        }
        if (file.diff === null) return comment
        return applyRelocation(comment, relocateComment(comment, file.diff))
      })

      // Built once: the fact-checker and the adjudicator are asked about the same
      // change, and reconstructing the same text twice is the same work twice.
      const batchDiff = renderBatchDiff(group.files)
      const filtered = await filterComments(deps.model, relocated, batchDiff, {
        ...(signal === undefined ? {} : { signal }),
      })
      spend(`filter${group.id}`, filtered.spent.inputTokens + filtered.spent.outputTokens)
      if (filtered.failedOpen && filtered.reason !== undefined) notes.push(`group ${group.id}: ${filtered.reason}`)

      // Adjudication runs after the fact-checker, over what the fact-checker kept:
      // escalating a finding the diff already disproved would spend calls on a
      // question that has been answered.
      const policy = options.escalation?.policy ?? DEFAULT_ESCALATION_POLICY
      const adjudicated = await escalateFindings(options.escalation?.port, filtered.kept, policy, {
        diffFor: () => batchDiff,
        ruleFor: comment => ruleText.get(comment.path) ?? '',
        ...(signal === undefined ? {} : { signal }),
      }).catch(() => undefined)
      if (adjudicated === undefined) {
        notes.push(`group ${group.id}: adjudication failed, the findings were published unadjudicated`)
        comments.push(...filtered.kept, ...filtered.removed)
        continue
      }
      for (const note of adjudicated.notes) notes.push(`group ${group.id}: ${note}`)
      escalations.push(...adjudicated.reports)
      spend(`escalation${group.id}`, adjudicated.spent.inputTokens + adjudicated.spent.outputTokens)
      comments.push(...adjudicated.kept, ...adjudicated.refuted, ...filtered.removed)
    }
  }

  if (unattributed.size > 0) {
    const named = [...unattributed].slice(0, 5).join(', ')
    const rest = unattributed.size > 5 ? ` and ${unattributed.size - 5} more` : ''
    notes.push(`finding(s) named file(s) outside this run's change set (${named}${rest}); their lines are as the reviewer reported them, unverified against any diff`)
  }

  for (const missing of missingReasons([...outcomes.values()])) {
    // A state that requires a reason and has none is a bug here, not user input;
    // recording it keeps the report's skip list from rendering an empty string.
    notes.push(`outcome for ${missing} carries no reason`)
  }

  const coverage = summarizeCoverage([...outcomes.values()])
  const state: ReviewRunState = signal?.aborted === true
    ? 'cancelled'
    : coverage.failedFiles > 0 || coverage.pendingFiles > 0
      ? (coverage.reviewedFiles > 0 ? 'partial' : 'failed')
      : 'completed'

  const report = assembleReviewReport({
    id,
    state,
    target: targetSummary(target, options.request),
    ...(options.background === undefined ? {} : { background: options.background }),
    ...(options.modelName === undefined ? {} : { model: options.modelName }),
    reviewers: coverage.reviewedFiles > 0 ? [reviewerName] : [],
    createdAt: startedAt,
    completedAt: now(),
    coverage,
    files: [...outcomes.values()],
    comments,
    escalations,
    budget: summarizeBudget(budget, limits),
  })
  options.onEvent?.({ type: 'done', state })

  return { report, target, refused, notes, attribution: REVIEW_PROMPT_ATTRIBUTION }
}

/** Map the resolved target onto the report's summary shape. */
function targetSummary(target: ReviewTarget, request: ReviewTargetRequest): ReviewTargetSummary {
  return {
    mode: target.mode,
    cwd: request.cwd,
    ...(target.from === undefined ? {} : { from: target.from }),
    ...(target.to === undefined ? {} : { to: target.to }),
    ...(target.commit === undefined ? {} : { commit: target.commit }),
    ...(target.mergeBase === undefined ? {} : { mergeBase: target.mergeBase }),
  }
}

/** The `change` label a coverage outcome shows for one file. */
function changeLabel(file: ReviewableFile): string {
  return file.untracked ? 'untracked' : file.status
}

/** Reconstruct one batch's unified diff, for the fact-checker. */
function renderBatchDiff(files: readonly ReviewableFile[]): string {
  const parts: string[] = []
  for (const file of files) {
    parts.push(`diff --git a/${file.path} b/${file.path}`)
    if (file.diff === null) {
      parts.push('(untracked file; not diffed)')
      continue
    }
    if (file.diff.binary) {
      parts.push('Binary files differ')
      continue
    }
    for (const hunk of file.diff.hunks) {
      parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
      for (const line of hunk.lines) parts.push(`${line.kind}${line.text}`)
    }
  }
  return parts.join('\n')
}
