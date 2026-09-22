/**
 * Escalation: a second, adversarial reading of the findings that matter.
 *
 * What this adds that the upstream pipeline does not have
 * ------------------------------------------------------
 * open-code-review has one reviewer and one fact-checker, and its fact-checker is
 * deliberately weak — it may only remove what the diff *proves* wrong. That is the
 * right trade for a general comment, and the wrong one for the two findings a
 * reviewer is least able to judge about itself: a `critical` or a `high`. Those are
 * the findings that change what a person does next, and the reviewer that produced
 * them is the worst available judge of whether they are real.
 *
 * So findings at or above a configured severity are re-checked by an independent
 * adjudicator, which is asked to **refute** rather than to agree — a question whose
 * answers are not symmetric, because "confirm" is the default a lazy answer gives
 * and "refute" is not. The adjudication decides three things:
 *
 * - **Refuted** — an adjudicator named diff evidence against the finding, and the
 *   confirmations did not reach quorum. The finding is retained with `filtered`
 *   state and the refutation as its reason, so the report still says what was
 *   dropped and why. This is the only path that removes a finding, and it requires
 *   a stated reason — unlike the fact-checker, which fails open, this stage fails
 *   *toward keeping* by requiring a quorum to override a refutation.
 * - **Confirmed** — enough adjudicators agreed. The finding is published with its
 *   adjudication recorded.
 * - **Undecided** — nobody could answer, or the answers split below quorum. The
 *   finding is published unchanged, because an inconclusive check is not evidence
 *   against a finding.
 *
 * The port, and the honest state of it
 * ------------------------------------
 * {@link ReviewEscalationPort} is deliberately one method, so the strong
 * implementation — this plugin's own multi-engine council, where three different
 * vendors answer the same question — and a cheaper single-route adversarial pass
 * are interchangeable. The single-route pass is *not* an independent model, and
 * saying so here matters: it catches a reviewer's careless claims, and it cannot
 * catch a claim its own model family is systematically wrong about.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/escalation
 */

import { REVIEW_SEVERITIES, type ReviewComment, type ReviewSeverity } from './comments.ts'

/** One adjudicator's answer about one finding. */
export type EscalationVerdict = 'confirm' | 'refute' | 'unavailable'

/** One adjudicator's answer, with the identity that gave it. */
export interface EscalationAnswer {
  readonly engine: string
  readonly verdict: EscalationVerdict
  /** Required when the verdict is `refute`; states what is missing when `unavailable`. */
  readonly reason?: string
}

/** Every adjudicator's answers about one finding. */
export interface EscalationAnswerSet {
  readonly verdicts: readonly EscalationAnswer[]
  /**
   * Tokens this adjudication spent, when the implementation can meter them.
   *
   * Part of the answer rather than a side channel so the pipeline's rule — no
   * stage spends without the spend being recorded — holds for this one too. An
   * implementation that cannot meter reports nothing, and the run's budget is then
   * short by exactly that amount, which is why the field is documented instead of
   * silently defaulted.
   */
  readonly spent?: { readonly inputTokens: number; readonly outputTokens: number }
}

/** What one escalation asks about. */
export interface ReviewEscalationRequest {
  readonly comment: ReviewComment
  /** The batch's diff, which is the evidence an adjudicator may cite. */
  readonly diff: string
  /** The rule text that governed the file, so the standard is not re-invented. */
  readonly rule: string
  readonly signal?: AbortSignal
}

/** The adjudicator surface. */
export interface ReviewEscalationPort {
  /** Ask every available adjudicator about one finding. */
  escalate(request: ReviewEscalationRequest): Promise<EscalationAnswerSet>
}

/** When to escalate, and how many confirmations override a refutation. */
export interface ReviewEscalationPolicy {
  /** Severities that are re-checked. Defaults to `critical` and `high`. */
  readonly severities: readonly ReviewSeverity[]
  /** Confirmations needed to publish a finding an adjudicator refuted. */
  readonly quorum: number
}

/** Shipped policy: the two severities a person acts on, and a simple majority of three. */
export const DEFAULT_ESCALATION_POLICY: ReviewEscalationPolicy = {
  severities: ['critical', 'high'],
  quorum: 2,
}

/** One finding's adjudication, as the report states it. */
export interface EscalationReport {
  readonly id: string
  readonly path: string
  readonly severity: ReviewSeverity
  readonly confirmed: readonly string[]
  readonly refuted: readonly string[]
  readonly unavailable: readonly string[]
  /** How the adjudication resolved: `confirmed`, `refuted`, or `undecided`. */
  readonly resolution: 'confirmed' | 'refuted' | 'undecided'
}

/** The outcome of adjudicating a batch's findings. */
export interface EscalationOutcome {
  /** Findings to publish, with `state` set to `kept`. */
  readonly kept: readonly ReviewComment[]
  /** Findings an adjudicator refuted below quorum, retained as `filtered`. */
  readonly refuted: readonly ReviewComment[]
  readonly reports: readonly EscalationReport[]
  /** Adjudicator failures, named, so a run can say its escalation was partial. */
  readonly notes: readonly string[]
  /** Tokens every adjudication in this batch reported. */
  readonly spent: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Whether a severity is escalated under a policy. */
export function isEscalated(severity: ReviewSeverity, policy: ReviewEscalationPolicy = DEFAULT_ESCALATION_POLICY): boolean {
  return policy.severities.includes(severity)
}

/**
 * Resolve one finding's adjudication.
 *
 * The decision rule, stated once because it is the whole stage: a finding is
 * refuted only when somebody named evidence against it *and* fewer than `quorum`
 * adjudicators confirmed it. Every other combination publishes it. An unavailable
 * adjudicator is not a refutation — the engines that did not answer are counted as
 * neither, which is why `quorum` is measured against confirmations rather than
 * against the number of engines asked.
 */
export function resolveEscalation(
  verdicts: readonly EscalationAnswer[],
  policy: ReviewEscalationPolicy = DEFAULT_ESCALATION_POLICY,
): { readonly resolution: EscalationReport['resolution']; readonly reason?: string } {
  const confirmed = verdicts.filter(entry => entry.verdict === 'confirm')
  const refuted = verdicts.filter(entry => entry.verdict === 'refute')
  if (refuted.length === 0) {
    return confirmed.length > 0 ? { resolution: 'confirmed' } : { resolution: 'undecided' }
  }
  if (confirmed.length >= policy.quorum) return { resolution: 'confirmed' }
  const reasons = refuted.map(entry => `${entry.engine}: ${entry.reason ?? 'refuted without a stated reason'}`)
  return { resolution: 'refuted', reason: `refuted by ${refuted.length} adjudicator(s) with fewer than ${policy.quorum} confirmations — ${reasons.join('; ')}` }
}

/**
 * Adjudicate the findings worth adjudicating.
 *
 * Findings below the policy's severities pass through untouched, and their
 * `state` is left as the caller set it — this stage does not re-decide what the
 * fact-checker already kept. A finding whose adjudication *throws* is published
 * unchanged and the failure is noted, because an adjudicator that could not run is
 * not evidence against a finding.
 */
export async function escalateFindings(
  port: ReviewEscalationPort | undefined,
  comments: readonly ReviewComment[],
  policy: ReviewEscalationPolicy,
  context: { readonly diffFor: (comment: ReviewComment) => string; readonly ruleFor: (comment: ReviewComment) => string; readonly signal?: AbortSignal },
): Promise<EscalationOutcome> {
  if (port === undefined) {
    return { kept: comments.map(comment => ({ ...comment, state: 'kept' })), refuted: [], reports: [], notes: [], spent: { inputTokens: 0, outputTokens: 0 } }
  }

  const kept: ReviewComment[] = []
  const refuted: ReviewComment[] = []
  const reports: EscalationReport[] = []
  const notes: string[] = []
  let inputTokens = 0
  let outputTokens = 0

  for (const comment of comments) {
    if (!isEscalated(comment.severity, policy)) {
      kept.push({ ...comment, state: 'kept' })
      continue
    }

    let verdicts: readonly EscalationAnswer[]
    try {
      const answer = await port.escalate({
        comment,
        diff: context.diffFor(comment),
        rule: context.ruleFor(comment),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      verdicts = answer.verdicts
      inputTokens += answer.spent?.inputTokens ?? 0
      outputTokens += answer.spent?.outputTokens ?? 0
    } catch (error) {
      notes.push(`escalation for ${comment.id} could not run: ${(error as Error).message}`)
      kept.push({ ...comment, state: 'kept' })
      reports.push({
        id: comment.id,
        path: comment.path,
        severity: comment.severity,
        confirmed: [],
        refuted: [],
        unavailable: [],
        resolution: 'undecided',
      })
      continue
    }

    const resolution = resolveEscalation(verdicts, policy)
    reports.push({
      id: comment.id,
      path: comment.path,
      severity: comment.severity,
      confirmed: verdicts.filter(entry => entry.verdict === 'confirm').map(entry => entry.engine),
      refuted: verdicts.filter(entry => entry.verdict === 'refute').map(entry => entry.engine),
      unavailable: verdicts.filter(entry => entry.verdict === 'unavailable').map(entry => entry.engine),
      resolution: resolution.resolution,
    })

    if (resolution.resolution === 'refuted') {
      refuted.push({
        ...comment,
        state: 'filtered',
        filteredReason: resolution.reason ?? 'refuted by adjudication',
      })
      continue
    }
    kept.push({ ...comment, state: 'kept' })
  }

  return { kept, refuted, reports, notes, spent: { inputTokens, outputTokens } }
}

/** The adjudication prompt, shared by every port implementation so the question is one question. */
export const ESCALATION_SYSTEM = `You are adjudicating one high-severity code review finding. Your job is to try to REFUTE it, not to agree with it.

A reviewer that produced a finding is the worst available judge of whether it is real, which is why this asks the opposite question. Answer "refute" only when you can point at the supplied diff or rule and say concretely why the finding does not hold: the flagged code is correct, the claimed effect cannot occur, the finding addresses deleted or unchanged code, or the rule it invokes is not the rule that applies.

Answer "confirm" when the finding holds against the diff you were given. Answer "unavailable" when the diff is not enough to decide either way — an honest "I cannot tell" is worth more here than a guess in either direction.

Return exactly one JSON object and no other text:
{"verdict":"confirm"|"refute"|"unavailable","reason":"<required for refute, and for unavailable state what is missing>"}`

/** The user message for one adjudication. */
export function renderEscalationUser(request: ReviewEscalationRequest): string {
  const comment = request.comment
  const at = comment.startLine > 0 ? `${comment.path}:${comment.startLine}-${comment.endLine}` : comment.path
  return [
    `<finding severity="${comment.severity}" category="${comment.category}" location="${at}">`,
    comment.content,
    comment.existingCode === undefined ? '' : `\nFlagged code:\n${comment.existingCode}`,
    '</finding>',
    '',
    `<review_rule>`,
    request.rule,
    '</review_rule>',
    '',
    '<diff>',
    request.diff,
    '</diff>',
  ].join('\n')
}

/** Severity rank, for sorting findings worst-first before adjudication. */
export function bySeverity(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (left, right) => REVIEW_SEVERITIES.indexOf(left.severity) - REVIEW_SEVERITIES.indexOf(right.severity),
  )
}
