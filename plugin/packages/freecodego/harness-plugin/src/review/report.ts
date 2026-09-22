/**
 * The review report and the three ways it is rendered.
 *
 * Why one report and not one per format
 * -------------------------------------
 * `text` is for a person, `json` is for an agent, and `sarif` is for a code
 * scanning integration. Three renderers over one assembled report is what keeps
 * them from disagreeing: the same run cannot report a finding in text that its
 * SARIF omits, or count coverage differently per format. The report is plain
 * data — no instances, no functions — because it crosses this plugin's Remote
 * boundary to the UI, where only {@link JsonValue}-shaped data exists.
 *
 * The one thing withheld from two renderers, and why it is counted anyway
 * ----------------------------------------------------------------------
 * A finding the fact-checker disproved, or that adjudication refuted, is not
 * published by `text` or by `sarif` — annotation formats that cannot carry the
 * argument for dropping it — and stays in `json` with the reason it was dropped.
 * `text` therefore *states the count* it withheld: a report that silently omits
 * findings teaches its reader that the count is the whole truth.
 *
 * Every severity is rendered, including `low`. Upstream's CLI does the same and
 * its skill asks the *presenting agent* to discard nitpicks; this renderer is the
 * presentation, and dropping a finding on the reader's behalf is not a decision a
 * report gets to make quietly.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/report
 */

import { REVIEW_SEVERITIES, compareComments, type ReviewCategory, type ReviewComment, type ReviewSeverity } from './comments.ts'
import type { ReviewBudgetSummary } from './budget.ts'
import type { ReviewCoverage, ReviewFileOutcome } from './coverage.ts'
import type { EscalationReport } from './escalation.ts'

/** How a review was scoped. */
export type ReviewMode = 'workspace' | 'range' | 'commit'

/** How a run ended. */
export type ReviewRunState = 'completed' | 'partial' | 'failed' | 'cancelled'

/** The refs a run reviewed, as they were resolved. */
export interface ReviewTargetSummary {
  readonly mode: ReviewMode
  /** Range mode: the source ref. */
  readonly from?: string
  /** Range mode: the target ref. */
  readonly to?: string
  /** Commit mode: the commit under review. */
  readonly commit?: string
  /** The merge base the range was diffed from, when it differs from `from`. */
  readonly mergeBase?: string
  /** The working directory every path is relative to. */
  readonly cwd: string
}

/** One assembled review run. */
export interface ReviewReport {
  readonly id: string
  readonly state: ReviewRunState
  readonly target: ReviewTargetSummary
  /** Business context the run was given, echoed so a reader can judge relevance. */
  readonly background?: string
  /** Display name of the model every reviewer in this run used. */
  readonly model?: string
  /** Reviewer identities that contributed, in the order they ran. */
  readonly reviewers: readonly string[]
  readonly createdAt: number
  readonly completedAt?: number
  readonly coverage: ReviewCoverage
  readonly files: readonly ReviewFileOutcome[]
  /** Findings kept for publication, sorted by severity then position. */
  readonly comments: readonly ReviewComment[]
  /**
   * How many findings were withheld from publication, and why the count is not zero.
   *
   * Both stages that can withhold one land here — the fact-checker disproving a
   * finding, and adjudication refuting it — because a reader wants the number of
   * findings their report does not show, not a breakdown by which stage dropped it.
   */
  readonly filteredCount: number
  /**
   * What adjudication decided about each escalated finding. Empty when escalation
   * was off, which is a different fact from "every finding was confirmed".
   */
  readonly escalations: readonly EscalationReport[]
  readonly budget: ReviewBudgetSummary
  /** Present when the run failed or was cancelled, naming the reason. */
  readonly error?: string
}

/** Everything {@link assembleReviewReport} needs, with the derived fields left out. */
export interface ReviewReportInput {
  readonly id: string
  readonly state: ReviewRunState
  readonly target: ReviewTargetSummary
  readonly background?: string
  readonly model?: string
  readonly reviewers: readonly string[]
  readonly createdAt: number
  readonly completedAt?: number
  readonly coverage: ReviewCoverage
  readonly files: readonly ReviewFileOutcome[]
  readonly comments: readonly ReviewComment[]
  readonly escalations?: readonly EscalationReport[]
  readonly budget: ReviewBudgetSummary
  readonly error?: string
}

/** Assemble a report, sorting comments and counting what the filter dropped. */
export function assembleReviewReport(input: ReviewReportInput): ReviewReport {
  const comments = [...input.comments].sort(compareComments)
  const filteredCount = comments.filter(comment => comment.state === 'filtered').length
  return {
    id: input.id,
    state: input.state,
    target: input.target,
    coverage: input.coverage,
    files: input.files,
    comments,
    filteredCount,
    escalations: input.escalations ?? [],
    budget: input.budget,
    reviewers: input.reviewers,
    createdAt: input.createdAt,
    ...(input.background === undefined ? {} : { background: input.background }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

/** Human-readable severity headings, in report order. */
const SEVERITY_LABEL: Readonly<Record<ReviewSeverity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/**
 * Render the report for a person.
 *
 * Findings the run deliberately kept unpositioned (line `0`) are labelled rather
 * than dropped, because "I could not name the line" is information the reader
 * needs in order to act.
 */
export function renderReviewText(report: ReviewReport): string {
  const published = report.comments.filter(comment => comment.state !== 'filtered')
  const lines: string[] = []
  lines.push('# Code Review Results')
  lines.push('')
  lines.push(`Run \`${report.id}\` — ${report.state}`)
  lines.push(`Files reviewed: ${report.coverage.reviewedFiles} / ${report.coverage.totalFiles} (${formatRate(report.coverage.coverageRate)})`)
  if (report.coverage.skippedFiles > 0) lines.push(`Skipped: ${report.coverage.skippedFiles}`)
  if (report.coverage.failedFiles > 0) lines.push(`Failed: ${report.coverage.failedFiles}`)
  if (report.filteredCount > 0) lines.push(`Filtered out: ${report.filteredCount} (see json/sarif for what was dropped and why)`)
  if (report.escalations.length > 0) {
    const refuted = report.escalations.filter(entry => entry.resolution === 'refuted').length
    lines.push(`Adjudicated: ${report.escalations.length} high-severity finding(s), ${refuted} refuted, ${report.escalations.length - refuted} upheld`)
  }
  lines.push('')

  const counted = REVIEW_SEVERITIES
    .map(severity => ({ severity, count: published.filter(comment => comment.severity === severity).length }))
    .filter(entry => entry.count > 0)
  if (counted.length > 0) {
    lines.push(counted.map(entry => `${entry.count} ${entry.severity}`).join(', '))
    lines.push('')
  }

  let wroteAnything = false
  for (const severity of REVIEW_SEVERITIES) {
    const group = published.filter(comment => comment.severity === severity)
    if (group.length === 0) continue
    wroteAnything = true
    lines.push(`## ${SEVERITY_LABEL[severity]}`)
    lines.push('')
    for (const comment of group) {
      lines.push(`- **\`${location(comment)}\`** [${comment.category}] — ${firstLine(comment.content)}`)
      const body = restOf(comment.content)
      if (body !== '') lines.push(`  > ${body.replace(/\n/g, '\n  > ')}`)
      if (comment.suggestionCode !== undefined) {
        lines.push('  > Suggested change:')
        lines.push('  ```')
        for (const codeLine of comment.suggestionCode.split('\n')) lines.push(`  ${codeLine}`)
        lines.push('  ```')
      }
    }
    lines.push('')
  }

  if (!wroteAnything) {
    lines.push(`Review complete — no findings at or above the reporting threshold in ${report.coverage.reviewedFiles} file(s).`)
    lines.push('')
  }

  lines.push('## Unreviewed')
  lines.push('')
  const unattended = report.files.filter(file => file.state === 'skipped' || file.state === 'failed')
  if (unattended.length === 0) {
    lines.push('Every changed file was reviewed.')
  } else {
    for (const file of unattended) {
      lines.push(`- \`${file.path}\` — ${file.state}: ${file.reason ?? 'no reason recorded'}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** Render the report as stable, pretty-printed JSON. */
export function renderReviewJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** The SARIF level for one severity. */
function sarifLevel(severity: ReviewSeverity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error'
  return severity === 'medium' ? 'warning' : 'note'
}

/**
 * Render the report as SARIF 2.1.0.
 *
 * An unpositioned finding keeps its result and carries no `locations`, which is
 * what SARIF means by a result without a location — attaching an approximate
 * region would put a code-scanning annotation on a line the reviewer never named.
 */
export function renderReviewSarif(report: ReviewReport): string {
  const rules = (['critical', 'high', 'medium', 'low'] as const).map(severity => ({
    id: `review/${severity}`,
    name: SEVERITY_LABEL[severity],
    shortDescription: { text: `${SEVERITY_LABEL[severity]} severity review finding` },
  }))
  const published = report.comments.filter(comment => comment.state !== 'filtered')
  const results = published.map(comment => ({
    ruleId: `review/${comment.severity}`,
    level: sarifLevel(comment.severity),
    message: { text: `${comment.content}${comment.category === 'other' ? '' : ` (${comment.category})`}` },
    locations: comment.startLine > 0
      ? [{
          physicalLocation: {
            artifactLocation: { uri: comment.path },
            region: { startLine: comment.startLine, endLine: Math.max(comment.startLine, comment.endLine) },
          },
        }]
      : [],
    properties: {
      category: comment.category satisfies ReviewCategory,
      ...(comment.reviewer === undefined ? {} : { reviewer: comment.reviewer }),
    },
  }))
  const payload = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'dsh-freecodego-review',
          informationUri: 'https://github.com/alibaba/open-code-review',
          rules,
        },
      },
      results,
    }],
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** `path:line` or `path` for an unpositioned finding. */
function location(comment: ReviewComment): string {
  if (comment.startLine <= 0) return `${comment.path} (position not determined)`
  if (comment.endLine > comment.startLine) return `${comment.path}:${comment.startLine}-${comment.endLine}`
  return `${comment.path}:${comment.startLine}`
}

/** The first line of a finding, for the bullet. */
function firstLine(content: string): string {
  const index = content.indexOf('\n')
  return index === -1 ? content : content.slice(0, index)
}

/** Everything after the first line, or the empty string. */
function restOf(content: string): string {
  const index = content.indexOf('\n')
  return index === -1 ? '' : content.slice(index + 1).trim()
}

/** Format a coverage rate as a whole percentage. */
function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`
}
