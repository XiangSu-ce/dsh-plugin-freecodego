/**
 * A single-route adjudicator.
 *
 * What this is, stated plainly
 * ---------------------------
 * One call to the same configured route, asked to refute the finding. It is *not*
 * an independent model: a claim its own model family is systematically wrong about
 * survives this check. What it does catch is the common case — a reviewer that
 * overstated a claim it cannot support from the diff it was given — and it costs
 * one call per escalated finding rather than one council round.
 *
 * The stronger implementation is this plugin's own multi-engine council, which
 * satisfies the same {@link ReviewEscalationPort} and asks three different vendors.
 * Because quorum is measured against *confirmations*, an implementation with fewer
 * adjudicators than the quorum makes each refutation decisive — which is the
 * correct reading of the rule and the reason the refuted finding is retained in
 * the report with its reason rather than deleted.
 *
 * An unreadable answer is `unavailable`, never `confirm`: treating a parse failure
 * as agreement would let a broken adjudicator silently suppress every escalation.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/escalation-model
 */

import { extractJsonValue, type ReviewModelPort } from './model.ts'
import { ESCALATION_SYSTEM, renderEscalationUser, type EscalationAnswerSet, type EscalationVerdict, type ReviewEscalationPort } from './escalation.ts'

/** Output ceiling for one adjudication; the answer is one small object. */
const ESCALATION_MAX_OUTPUT_TOKENS = 1_024

/** 1K tokens is plenty for a verdict plus a one-sentence reason. */
const MAX_REASON_CHARS = 600

/** Build an adjudicator over one model port. */
export function createModelEscalationPort(model: ReviewModelPort, engineLabel = 'adjudicator'): ReviewEscalationPort {
  return {
    async escalate(request): Promise<EscalationAnswerSet> {
      const result = await model.generate({
        system: ESCALATION_SYSTEM,
        user: renderEscalationUser(request),
        maxOutputTokens: ESCALATION_MAX_OUTPUT_TOKENS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      const parsed = extractJsonValue(result.text)
      const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      const verdict = asVerdict(record.verdict)
      const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, MAX_REASON_CHARS) : ''
      return {
        verdicts: [{
          engine: engineLabel,
          verdict,
          // A refutation with no reason is not a refutation the stage can publish
          // — `resolveEscalation` names the missing reason — so the reason is
          // carried whenever there is one, and the stage's own rule supplies the
          // wording when there is not.
          ...(reason === '' ? {} : { reason }),
        }],
        spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      }
    },
  }
}

/** Coerce an unknown verdict, defaulting to `unavailable` rather than to agreement. */
function asVerdict(value: unknown): EscalationVerdict {
  return value === 'confirm' || value === 'refute' || value === 'unavailable' ? value : 'unavailable'
}
