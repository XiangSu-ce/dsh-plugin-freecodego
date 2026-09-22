/**
 * The per-file reviewer: the one stage that reads code rather than text.
 *
 * The port, and the two implementations behind it
 * ----------------------------------------------
 * Reviewing a file is the expensive, open-ended part of the pipeline — the part
 * the upstream tool gives to an agent with search and read tools and multiple
 * rounds. This plugin has two ways to run it: an in-process subagent that can use
 * the harness's own read/search tools (wired in the plugin's adapter layer), and
 * the single-shot model call implemented here. Both satisfy
 * {@link ReviewFilePort}, so the pipeline's coverage, budget, relocation and
 * reporting behaviour is identical whichever one a deployment can afford, and the
 * single-shot one is what makes the engine testable without an agent runtime.
 *
 * What the prompt builder is responsible for
 * -----------------------------------------
 * The reviewer's context is assembled here in one place and in a fixed order:
 * business background, the rule standard for this file, the risk plan, then the
 * other files of the batch as reference. Each is a section a reviewer can tell
 * apart — the alternative, one concatenated blob, is how a reviewer starts
 * treating a loosely related neighbour file as the thing under review.
 *
 * The batch's *other* files are included as context and explicitly marked as
 * reference, because the cross-file finding ("the interface changed and no caller
 * was updated") is precisely the finding a single-file view cannot produce.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/reviewer
 */

import { extractJsonValue, type ReviewModelPort } from './model.ts'
import { REVIEW_MAIN_SYSTEM, REVIEW_MAX_OUTPUT_TOKENS } from './prompts.ts'
import type { ReviewCommentInput } from './comments.ts'
import type { ReviewGroup } from './grouping.ts'
import type { ReviewPlan } from './plan.ts'
import type { ReviewableFile } from './targets.ts'

/** Everything one file review is given. */
export interface ReviewFileTask {
  /** The batch this file belongs to; its neighbours are reference context. */
  readonly group: ReviewGroup
  readonly file: ReviewableFile
  /** The resolved rule text governing this file, with its provenance. */
  readonly rule: { readonly source: string; readonly pattern: string; readonly text: string }
  /** The batch's risk plan, when one was produced. */
  readonly plan?: ReviewPlan
  readonly background?: string
  /** Display name of the model or agent doing the review, for the report. */
  readonly reviewer: string
  /**
   * Whether the reviewer can investigate rather than only read what it is given.
   *
   * Set by a reviewer that runs with tools — a subagent can turn "no caller of
   * this changed signature was updated" from an inference into something it
   * checked. A single-shot model has no tool it could call, so telling it to
   * investigate would be an instruction it cannot follow, and this stays unset.
   */
  readonly investigate?: boolean
  readonly signal?: AbortSignal
}

/** What one file review produced. */
export interface ReviewFileOutcome {
  readonly comments: readonly ReviewCommentInput[]
  /** A reviewer's note about the file, kept for diagnostics rather than reported as a finding. */
  readonly note?: string
  readonly spent: { readonly inputTokens: number; readonly outputTokens: number }
}

/** The reviewer surface the pipeline uses. */
export interface ReviewFilePort {
  /** Review one file. A rejection is a failed file, not a failed run. */
  review(task: ReviewFileTask): Promise<ReviewFileOutcome>
}

/** Read comment contributions out of a reviewer response. */
export function parseFileComments(raw: unknown): ReviewCommentInput[] {
  const container = Array.isArray(raw)
    ? raw
    : (typeof raw === 'object' && raw !== null && Array.isArray((raw as { comments?: unknown }).comments)
        ? (raw as { comments: unknown[] }).comments
        : [])
  const out: ReviewCommentInput[] = []
  for (const entry of container) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    out.push({
      path: record.path,
      content: record.content,
      startLine: record.startLine ?? record.start_line,
      endLine: record.endLine ?? record.end_line,
      category: record.category,
      severity: record.severity,
      suggestionCode: record.suggestionCode ?? record.suggestion_code,
      existingCode: record.existingCode ?? record.existing_code,
    })
  }
  return out
}

/**
 * Compose the system and user messages for one file review.
 *
 * Pure and exported, so the prompt's section order and the fact that neighbours
 * are labelled reference-only are both asserted by a test rather than by reading
 * this file.
 */
export function buildFileReviewPrompt(task: ReviewFileTask): { system: string; user: string } {
  const parts: string[] = []
  if (task.background !== undefined && task.background.trim() !== '') {
    parts.push(`<business_context>\n${task.background.trim()}\n</business_context>`)
  }

  parts.push(
    `<review_rule source="${task.rule.source}" pattern="${task.rule.pattern}">\n${task.rule.text}\n</review_rule>`,
  )

  if (task.plan !== undefined) {
    parts.push(renderPlan(task.plan))
  }

  const neighbours = task.group.files.filter(file => file.path !== task.file.path)
  if (neighbours.length > 0) {
    parts.push(
      `<reference_files>\nThese files are in the same batch and are shown for cross-file reasoning only. Do not report findings against them.\n\n${neighbours.map(renderFile).join('\n\n')}\n</reference_files>`,
    )
  }

  parts.push(`<review_files>\n${renderFile(task.file)}\n</review_files>`)
  if (task.investigate === true) parts.push(REVIEW_INVESTIGATION)
  parts.push(REVIEW_OUTPUT_CONTRACT)
  return { system: REVIEW_MAIN_SYSTEM, user: parts.join('\n\n') }
}

/**
 * What a tool-using reviewer must check before it reports.
 *
 * Placed after the code and *before* the output contract on purpose: the last
 * thing a reviewer reads is how to answer, not what to look at, so the format is
 * the instruction that survives a long context. The third bullet is the one that
 * earns the extra round-trip — it is the only way to tell a test that exercises
 * the change from a test that merely runs alongside it.
 */
const REVIEW_INVESTIGATION = `<investigation>
You have read-only tools available. Use them before you report:
- Read the file itself, not only the diff, so a claim about the code around a change is about the code and not about the window you were shown.
- Search for the callers of any signature this change alters. "The interface changed and no caller was updated" is a real finding — but only if you looked.
- If this change adds or edits a test, read the implementation it covers and ask whether the test would fail against the previous behaviour.
Report only what the code supports, and say which lines you checked. A finding you cannot place on a line is still worth reporting with start_line 0.</investigation>`

/**
 * The output contract appended to every review request.
 *
 * Stated as JSON with the same field names the model already knows from the
 * upstream tool, so a model trained to emit `start_line` is not fighting the
 * format. Unpositioned is spelled out as `0`, because a reviewer that cannot name
 * a line must have a way to say so that is not "omit the field" — an omitted
 * field and a wrong line are indistinguishable downstream.
 */
const REVIEW_OUTPUT_CONTRACT = `Report findings by emitting exactly one JSON object and no other text:
{"comments":[{"path":"<relative path>","content":"<the finding>","start_line":<1-based new-file line, or 0 when you cannot determine it>,"end_line":<last line, or 0>,"category":"bug|security|performance|maintainability|test|style|documentation|other","severity":"critical|high|medium|low","existing_code":"<the original code you are flagging>","suggestion_code":"<a replacement for that code, when you have one>"}]}

If you found nothing worth reporting in this file, emit {"comments":[]}. Do not invent findings to fill the list, and do not report style the project's formatter already enforces.`

/** The user message for one planning-free single-shot review. */
export function renderReviewUser(task: ReviewFileTask): string {
  return buildFileReviewPrompt(task).user
}

/** A single-shot model reviewer. */
export function createModelFileReviewer(model: ReviewModelPort): ReviewFilePort {
  return {
    async review(task: ReviewFileTask): Promise<ReviewFileOutcome> {
      const prompt = buildFileReviewPrompt(task)
      const result = await model.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
        ...(task.signal === undefined ? {} : { signal: task.signal }),
      })
      const parsed = extractJsonValue(result.text)
      // An unreadable response is an empty review with a note rather than a
      // fabricated comment: the run's coverage accounting already reports the
      // file as reviewed, and inventing findings would be strictly worse than
      // reporting none.
      const comments = parsed === undefined ? [] : parseFileComments(parsed)
      return {
        comments,
        ...(parsed === undefined ? { note: 'the reviewer response held no readable comments' } : {}),
        spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      }
    },
  }
}

/** Render the plan as the reviewer's ranked hypothesis list. */
function renderPlan(plan: ReviewPlan): string {
  const lines = [`<risk_plan>\nSummary: ${plan.summary}`, '', 'Issues']
  if (plan.issues.length === 0) {
    lines.push('(none)')
  } else {
    for (const [position, issue] of plan.issues.entries()) {
      lines.push(`${position + 1}. [${issue.severity}] ${issue.description}`)
      for (const suggestion of issue.suggestions) {
        const purpose = suggestion.purpose === '' ? '' : ` — ${suggestion.purpose}`
        lines.push(`   → ${suggestion.tool} ${suggestion.args}${purpose}`)
      }
    }
  }
  lines.push('</risk_plan>')
  return lines.join('\n')
}

/** Render one file's unified diff, reconstructing it from the parsed hunks. */
function renderFile(file: ReviewableFile): string {
  if (file.diff === null) {
    return `<file path="${file.path}" status="UNTRACKED">\n(untracked: every line is new; read the file if you need its full content)\n</file>`
  }
  const lines = [`<file path="${file.path}" status="${file.status.toUpperCase()}">`]
  for (const hunk of file.diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) lines.push(`${line.kind}${line.text}`)
  }
  lines.push('</file>')
  return lines.join('\n')
}
