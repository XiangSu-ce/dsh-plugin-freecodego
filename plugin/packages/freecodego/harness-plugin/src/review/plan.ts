/**
 * The risk plan: what to look for, decided before looking.
 *
 * Why a plan phase exists
 * ----------------------
 * An agentic reviewer spends its budget where it happens to look first. A short
 * planning pass turns a diff into a ranked list of suspicions with the *reason*
 * each one is suspicious, which the reviewer then confirms or drops with tools.
 * The cost is one extra call per batch; the benefit is that the reviewer arrives
 * with a hypothesis instead of browsing.
 *
 * Why it is thresholded
 * ---------------------
 * Planning a two-line change is pure overhead, so the call only runs when the
 * batch is large enough to deserve it — a single file at or above
 * {@link REVIEW_PLAN_THRESHOLDS}.singleFileLines, or a multi-file batch at or
 * above `groupLines` combined. The thresholds are the upstream ones and are
 * exported so a test can state the boundary rather than restate the numbers.
 *
 * Why parsing is tolerant but ranking is not
 * -----------------------------------------
 * The plan is advisory input to a reviewer, so an extra `#` heading or a missing
 * arrow must not abort a run. What *is* enforced is the contract the reviewer
 * depends on: issues are ordered by severity so a truncated plan loses the least
 * important work rather than a random slice of it. Ranking happens here, in code,
 * because a model that lists a `low` before a `high` has still told us both and
 * the order is not a judgement it needs to get right.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/plan
 */

import { extractJsonValue, type ReviewModelPort, type ReviewModelResult } from './model.ts'
import { REVIEW_PLAN_SYSTEM, REVIEW_PLAN_THRESHOLDS, renderPlanTools } from './prompts.ts'
import type { ReviewGroup } from './grouping.ts'

/** One planned risk point. */
export interface ReviewPlanIssue {
  readonly severity: 'high' | 'medium' | 'low'
  /** Location, nature and impact, as the prompt requires. */
  readonly description: string
  /** Tool calls the reviewer is expected to make to confirm this point. */
  readonly suggestions: readonly ReviewPlanSuggestion[]
}

/** One planned tool call. */
export interface ReviewPlanSuggestion {
  readonly tool: string
  readonly args: string
  readonly purpose: string
}

/** A parsed risk plan. */
export interface ReviewPlan {
  readonly summary: string
  readonly issues: readonly ReviewPlanIssue[]
}

/** A reviewer tool the plan prompt may name. */
export interface ReviewPlanTool {
  readonly name: string
  readonly description: string
}

/** Severity order used for the sort, highest first. */
const PLAN_SEVERITY_ORDER: readonly ReviewPlanIssue['severity'][] = ['high', 'medium', 'low']

/**
 * Whether a batch earns a planning call.
 *
 * Two independent triggers, matching the upstream rule: one file large enough to
 * be risky on its own, or a batch large enough collectively.
 */
export function shouldPlan(
  group: ReviewGroup,
  thresholds: { readonly singleFileLines: number; readonly groupLines: number } = REVIEW_PLAN_THRESHOLDS,
): boolean {
  const largest = group.files.reduce((max, file) => Math.max(max, file.added + file.deleted), 0)
  if (largest >= thresholds.singleFileLines) return true
  return group.files.length >= 2 && group.changedLines >= thresholds.groupLines
}

/**
 * Parse a plan response.
 *
 * Returns an empty plan rather than throwing for input it cannot read: the plan
 * is an aid, and a reviewer that proceeds without one still reviews. The
 * `(none)` sentinel the prompt specifies is recognized so "no identifiable risk"
 * does not read as a parse failure.
 */
export function parseReviewPlan(text: string): ReviewPlan {
  const summary = /^Summary:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? ''
  const afterIssues = text.split(/^Issues\s*$/m)[1]
  if (afterIssues === undefined || /^\s*\(none\)\s*$/m.test(afterIssues) || afterIssues.trim() === '') {
    return { summary, issues: [] }
  }

  const issues: ReviewPlanIssue[] = []
  for (const raw of afterIssues.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const heading = /^(\d+)\.\s*\[(high|medium|low)\]\s*(.*)$/i.exec(line)
    if (heading !== null) {
      const severity = (heading[2] as string).toLowerCase() as ReviewPlanIssue['severity']
      issues.push({ severity, description: (heading[3] as string).trim(), suggestions: [] })
      continue
    }
    // An arrow line belongs to the issue above it; a stray one with no issue is
    // dropped rather than attached to a plan entry that does not exist.
    const arrow = /^[→>-]\s*(.+)$/.exec(line)
    const current = issues[issues.length - 1]
    if (arrow !== null && current !== undefined) {
      const [tool, ...rest] = (arrow[1] as string).split(/\s+/)
      const remainder = rest.join(' ')
      const emDash = remainder.indexOf('—')
      ;(current.suggestions as ReviewPlanSuggestion[]).push({
        tool: tool ?? '',
        args: emDash === -1 ? remainder : remainder.slice(0, emDash).trim(),
        purpose: emDash === -1 ? '' : remainder.slice(emDash + 1).trim(),
      })
    }
  }

  issues.sort(
    (left, right) => PLAN_SEVERITY_ORDER.indexOf(left.severity) - PLAN_SEVERITY_ORDER.indexOf(right.severity),
  )
  return { summary, issues }
}

/** The outcome of a planning call. */
export type PlanOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'planned'; readonly plan: ReviewPlan }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Plan one batch, if it is large enough to deserve it.
 *
 * A planning failure is `unavailable`, never a throw: the reviewer is told no plan
 * exists and reviews anyway, which is exactly the behaviour a run wants when a
 * cheap-but-optional stage is down.
 */
export async function planGroup(
  model: ReviewModelPort,
  group: ReviewGroup,
  tools: readonly ReviewPlanTool[],
  options: { readonly background?: string; readonly signal?: AbortSignal } = {},
): Promise<{ readonly outcome: PlanOutcome; readonly spent: { inputTokens: number; outputTokens: number } }> {
  const nothing = { inputTokens: 0, outputTokens: 0 }
  if (!shouldPlan(group)) {
    return { outcome: { kind: 'skipped', reason: 'the batch is below the planning threshold' }, spent: nothing }
  }

  let result: ReviewModelResult
  try {
    result = await model.generate({
      system: REVIEW_PLAN_SYSTEM.replace('{{plan_tools}}', renderPlanTools(tools)),
      user: renderPlanUser(group, options.background),
      maxOutputTokens: 4_096,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    return {
      outcome: { kind: 'unavailable', reason: `the planning call failed: ${(error as Error).message}` },
      spent: nothing,
    }
  }

  // A plan that parses to nothing useful is reported as unavailable rather than
  // as an empty plan, so a reviewer is not told "no risks were identified" when
  // the truth is that the answer could not be read. The `(none)` sentinel is the
  // exception and the whole reason this is not a simple emptiness test: it is how
  // the prompt spells "I looked and there is nothing", which is an answer.
  const plan = parseReviewPlan(result.text)
  if (plan.summary === '' && plan.issues.length === 0 && !NONE_SENTINEL.test(result.text)) {
    if (result.text.trim() === '') {
      return {
        outcome: { kind: 'unavailable', reason: 'the planning response was empty' },
        spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      }
    }
    const structured = extractJsonValue(result.text)
    if (structured === undefined) {
      return {
        outcome: { kind: 'unavailable', reason: 'the planning response held no readable plan' },
        spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      }
    }
  }

  return {
    outcome: { kind: 'planned', plan },
    spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
  }
}

/** The prompt's spelling of "I looked and found no identifiable risk". */
const NONE_SENTINEL = /^\s*\(none\)\s*$/m

/** The user message handed to the planning call. */
function renderPlanUser(group: ReviewGroup, background: string | undefined): string {
  const parts: string[] = []
  if (background !== undefined && background.trim() !== '') {
    parts.push(`Business context:\n${background.trim()}`)
  }
  parts.push(`Changed files in this batch:\n\n${group.files.map(renderFileHeader).join('\n')}`)
  parts.push(group.files.map(renderFileDiff).join('\n\n'))
  return parts.join('\n\n')
}

/** One file's header line in the plan request. */
function renderFileHeader(file: ReviewGroup['files'][number]): string {
  const status = file.untracked ? 'UNTRACKED' : file.status.toUpperCase()
  return `- ${status} ${file.path} (+${file.added}/-${file.deleted})`
}

/** One file's unified diff, reconstructed from the parsed hunks. */
function renderFileDiff(file: ReviewGroup['files'][number]): string {
  if (file.diff === null) return `<file path="${file.path}">\n(untracked; read the whole file)\n</file>`
  const lines = [`<file path="${file.path}">`]
  for (const hunk of file.diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) lines.push(`${line.kind}${line.text}`)
  }
  lines.push('</file>')
  return lines.join('\n')
}
