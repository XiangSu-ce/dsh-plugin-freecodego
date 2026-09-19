/**
 * Reviewing a plan: the surface, and the rework message.
 *
 * Why comments are addressed by line
 * ----------------------------------
 * "I don't like section 2" and "this line is wrong because the helper already exists"
 * are different messages, and only the second one is actionable without a
 * conversation. Line addressing makes the user's remark carry its own context, so a
 * rework pass can be answered in one turn instead of by asking which part was meant.
 *
 * Why an empty plan still opens the surface
 * -----------------------------------------
 * The alternative is worse than it looks. A surface that refuses to open until there
 * is something to review gives the user no way to answer "where is it?", and the
 * failure is invisible from the outside: plan mode looks active, the approval action
 * looks missing, and the only way forward is to guess that a file has to exist first.
 * So an absent or empty plan produces a *reviewable* surface whose body states that
 * plainly — approvable, because approving an empty plan is a legitimate way to say
 * "stop planning and proceed".
 *
 * Rejection rather than repair, again
 * -----------------------------------
 * A comment with an impossible line range, or one with no text, is refused instead of
 * dropped. A dropped comment is a remark the user believes they sent, which is the
 * one outcome a review step must not produce.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plan/plan-review
 */

import { inspectPlanSections } from './plan-sections.ts'
import type { PlanSectionReport } from './plan-sections.ts'

/** One user remark attached to one or more lines of the plan. */
export interface PlanLineComment {
  /** First line the remark applies to, 1-based and inclusive. */
  readonly startLine: number
  /** Last line, inclusive; equal to `startLine` for a single-line remark. */
  readonly endLine: number
  /** The remark itself. */
  readonly text: string
}

/** What the review surface shows for one plan. */
export interface PlanReviewSurface {
  /** The plan text, or the empty-state body when there is none. */
  readonly body: string
  /** Whether there is no plan to review, which the surface must say out loud. */
  readonly empty: boolean
  /** Structural findings, which inform the reviewer without blocking them. */
  readonly sections: PlanSectionReport
  /** Lines in the body, so the overlay can address them without re-deriving. */
  readonly lineCount: number
}

/**
 * Build the review surface for a plan.
 *
 * Takes the text rather than reading it, so the caller decides when the file is read
 * and this function stays pure — the same reason this plugin's other judging code
 * takes its inputs as arguments.
 * @param text - the plan text, or `undefined` when nothing was written.
 * @returns the body to render, whether it is empty, and the structural findings.
 */
export function planReviewSurface(text: string | undefined): PlanReviewSurface {
  const sections = inspectPlanSections(text)
  if (text === undefined || text.trim() === '') {
    // Approvable, and it says why it is empty: the user needs one action, not a
    // mystery about a file that was never created.
    return {
      body: 'No plan has been written yet. Approving this ends Plan Mode and lets the agent proceed; requesting changes asks it to draft one first.',
      empty: true,
      sections,
      lineCount: 1,
    }
  }
  const normalized = text.endsWith('\n') ? text : `${text}\n`
  return { body: normalized, empty: false, sections, lineCount: normalized.split('\n').length }
}

/**
 * Compose the rework message from a review submission.
 *
 * The message is written as instructions to the agent rather than as a report about
 * the user: it is read by a model deciding what to do next, and a summary of what the
 * user clicked is not something it can act on.
 * @param input - the plan's path, the remarks, and any overall notes.
 * @returns the message, or why the submission could not be sent.
 */
export function composePlanReworkMessage(input: {
  readonly planPath: string
  readonly comments?: readonly PlanLineComment[]
  readonly notes?: string
}): { readonly message: string } | { readonly rejected: string } {
  const notes = input.notes?.trim() ?? ''
  const comments = input.comments ?? []
  const invalid = comments.find(comment => !Number.isInteger(comment.startLine) || !Number.isInteger(comment.endLine)
    || comment.startLine < 1 || comment.endLine < comment.startLine)
  if (invalid !== undefined) {
    return { rejected: `a comment addresses lines ${invalid.startLine}-${invalid.endLine}, which is not a valid range` }
  }
  const blank = comments.find(comment => comment.text.trim() === '')
  // Refused, not skipped: a dropped remark is one the user believes they sent.
  if (blank !== undefined) return { rejected: `the comment on line ${blank.startLine} has no text` }
  if (comments.length === 0 && notes === '') {
    return { rejected: 'a rework request needs at least one comment or a note' }
  }
  // Sorted by position so the agent reads the plan in order and can answer it in one
  // pass instead of jumping around the file.
  const ordered = [...comments].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
  const lines = ordered.map(comment => comment.startLine === comment.endLine
    ? `- line ${comment.startLine}: ${comment.text.trim()}`
    : `- lines ${comment.startLine}-${comment.endLine}: ${comment.text.trim()}`)
  const parts = [
    `The plan at ${input.planPath} needs changes before it can be approved.`,
    ...(lines.length === 0 ? [] : ['', 'Line remarks:', ...lines]),
    ...(notes === '' ? [] : ['', `Overall: ${notes}`]),
    '',
    `Revise the plan in ${input.planPath} and keep the same section headings.`,
  ]
  return { message: parts.join('\n') }
}
