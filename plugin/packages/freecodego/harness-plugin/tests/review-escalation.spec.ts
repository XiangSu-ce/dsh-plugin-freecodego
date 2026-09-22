import { describe, expect, it } from 'vitest'
import {
  bySeverity,
  DEFAULT_ESCALATION_POLICY,
  escalateFindings,
  isEscalated,
  renderEscalationUser,
  resolveEscalation,
  type EscalationAnswerSet,
  type ReviewEscalationPort,
} from '../src/review/escalation.ts'
import { validateReviewComment, type ReviewComment } from '../src/review/comments.ts'
import { runReview } from '../src/review/engine.ts'
import { createModelEscalationPort } from '../src/review/escalation-model.ts'
import { createReviewRuleResolver, SYSTEM_REVIEW_RULE } from '../src/review/rules.ts'
import { renderReviewText } from '../src/review/report.ts'
import type { ReviewGitPort } from '../src/review/targets.ts'
import type { ReviewModelPort } from '../src/review/model.ts'

const comment = (id: string, severity = 'high', path = 'src/app.ts'): ReviewComment =>
  (validateReviewComment({ path, content: `finding ${id}`, severity, startLine: 3, endLine: 3 }, id) as { ok: true; comment: ReviewComment }).comment

const SINGLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1..2 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 3
 const c = 6
`

const git: ReviewGitPort = {
  async run(args) {
    const line = args.join(' ')
    if (line.includes('ls-files')) return { exitCode: 0, stdout: '', stderr: '' }
    if (line.includes('--numstat')) return { exitCode: 0, stdout: '1\t0\tsrc/app.ts\n', stderr: '' }
    if (line.includes('--name-status')) return { exitCode: 0, stdout: 'M\tsrc/app.ts\n', stderr: '' }
    return { exitCode: 0, stdout: SINGLE_DIFF, stderr: '' }
  },
  async readFileSize() {
    return undefined
  },
}

const rules = createReviewRuleResolver([{ source: 'system', defaultRule: SYSTEM_REVIEW_RULE, entries: [] }])

const quietModel: ReviewModelPort = { async generate() { return { text: '{"verdicts":[]}', inputTokens: 0, outputTokens: 0 } } }

/** An adjudicator that answers with a fixed set, optionally reporting cost. */
function adjudicator(answer: EscalationAnswerSet | (() => EscalationAnswerSet)): ReviewEscalationPort {
  return {
    async escalate() {
      return typeof answer === 'function' ? answer() : answer
    },
  }
}

describe('escalation resolution', () => {
  it('publishes an escalated finding when nobody refuted it', () => {
    expect(resolveEscalation([{ engine: 'a', verdict: 'confirm' }])).toEqual({ resolution: 'confirmed' })
    expect(resolveEscalation([{ engine: 'a', verdict: 'unavailable' }, { engine: 'b', verdict: 'unavailable' }]))
      .toEqual({ resolution: 'undecided' })
    expect(resolveEscalation([])).toEqual({ resolution: 'undecided' })
  })

  it('lets a quorum of confirmations override a refutation', () => {
    expect(resolveEscalation([
      { engine: 'a', verdict: 'confirm' },
      { engine: 'b', verdict: 'confirm' },
      { engine: 'c', verdict: 'refute', reason: 'the guard already exists' },
    ])).toEqual({ resolution: 'confirmed' })

    const refuted = resolveEscalation([
      { engine: 'a', verdict: 'confirm' },
      { engine: 'b', verdict: 'refute', reason: 'the guard already exists' },
      { engine: 'c', verdict: 'refute', reason: 'the line is deleted code' },
    ])
    expect(refuted.resolution).toBe('refuted')
    expect(refuted.reason).toContain('fewer than 2 confirmations')
    expect(refuted.reason).toContain('the guard already exists')
    expect(refuted.reason).toContain('the line is deleted code')
  })

  it('names an adjudicator that refuted without stating why', () => {
    const refuted = resolveEscalation([{ engine: 'a', verdict: 'refute' }])
    expect(refuted.reason).toContain('refuted without a stated reason')
  })

  it('escalates only the configured severities by default', () => {
    expect(isEscalated('critical')).toBe(true)
    expect(isEscalated('high')).toBe(true)
    expect(isEscalated('medium')).toBe(false)
    expect(isEscalated('medium', { severities: ['medium'], quorum: 1 })).toBe(true)
    expect(DEFAULT_ESCALATION_POLICY.quorum).toBeGreaterThan(1)
  })

  it('sorts findings worst-first', () => {
    expect(bySeverity([comment('c1', 'low'), comment('c2', 'critical'), comment('c3', 'medium')]).map(entry => entry.id))
      .toEqual(['c2', 'c3', 'c1'])
  })
})

describe('escalation stage', () => {
  const context = { diffFor: () => SINGLE_DIFF, ruleFor: () => 'check nulls' }

  it('publishes everything unchanged when no adjudicator is configured', async () => {
    const outcome = await escalateFindings(undefined, [comment('c1', 'critical')], DEFAULT_ESCALATION_POLICY, context)
    expect(outcome.kept.map(entry => entry.id)).toEqual(['c1'])
    expect(outcome.reports).toEqual([])
    expect(outcome.spent).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('leaves a finding below the severity floor untouched and unqueried', async () => {
    let asked = 0
    const port: ReviewEscalationPort = { async escalate() { asked += 1; return { verdicts: [] } } }
    const outcome = await escalateFindings(port, [comment('c1', 'low')], DEFAULT_ESCALATION_POLICY, context)
    expect(asked).toBe(0)
    expect(outcome.kept.map(entry => entry.id)).toEqual(['c1'])
    expect(outcome.reports).toEqual([])
  })

  it('keeps a confirmed finding and records who confirmed it', async () => {
    const outcome = await escalateFindings(
      adjudicator({ verdicts: [{ engine: 'a', verdict: 'confirm' }, { engine: 'b', verdict: 'confirm' }], spent: { inputTokens: 10, outputTokens: 4 } }),
      [comment('c1', 'critical')],
      DEFAULT_ESCALATION_POLICY,
      context,
    )
    expect(outcome.kept.map(entry => entry.id)).toEqual(['c1'])
    expect(outcome.refuted).toEqual([])
    expect(outcome.reports[0]).toMatchObject({ id: 'c1', resolution: 'confirmed', confirmed: ['a', 'b'] })
    expect(outcome.spent).toEqual({ inputTokens: 10, outputTokens: 4 })
  })

  it('retains a refuted finding as filtered with the refutation as its reason', async () => {
    const outcome = await escalateFindings(
      adjudicator({ verdicts: [{ engine: 'a', verdict: 'refute', reason: 'the flag is set two lines above' }] }),
      [comment('c1', 'high')],
      DEFAULT_ESCALATION_POLICY,
      context,
    )
    expect(outcome.kept).toEqual([])
    expect(outcome.refuted[0]).toMatchObject({ id: 'c1', state: 'filtered' })
    expect(outcome.refuted[0]?.filteredReason).toContain('the flag is set two lines above')
    expect(outcome.reports[0]?.resolution).toBe('refuted')
  })

  it('publishes a finding unchanged when the adjudicator could not run', async () => {
    const port: ReviewEscalationPort = { async escalate() { throw new Error('council unreachable') } }
    const outcome = await escalateFindings(port, [comment('c1', 'critical')], DEFAULT_ESCALATION_POLICY, context)
    expect(outcome.kept.map(entry => entry.id)).toEqual(['c1'])
    expect(outcome.notes[0]).toContain('council unreachable')
    expect(outcome.reports[0]?.resolution).toBe('undecided')
  })

  it('treats an all-unavailable answer as undecided, not as a refutation', async () => {
    const outcome = await escalateFindings(
      adjudicator({ verdicts: [{ engine: 'a', verdict: 'unavailable', reason: 'no diff for the file' }] }),
      [comment('c1', 'high')],
      DEFAULT_ESCALATION_POLICY,
      context,
    )
    expect(outcome.kept.map(entry => entry.id)).toEqual(['c1'])
    expect(outcome.reports[0]).toMatchObject({ resolution: 'undecided', unavailable: ['a'] })
  })

  it('asks the adjudicator about the finding, its rule, and the diff', () => {
    const text = renderEscalationUser({
      comment: comment('c1', 'critical'),
      diff: SINGLE_DIFF,
      rule: 'check nulls',
    })
    expect(text).toContain('location="src/app.ts:3-3"')
    expect(text).toContain('finding c1')
    expect(text).toContain('<review_rule>')
    expect(text).toContain('<diff>')
  })
})

describe('model adjudicator', () => {
  const adjudicate = async (text: string, tokens = { inputTokens: 7, outputTokens: 3 }) => {
    const port = createModelEscalationPort({ async generate() { return { text, ...tokens } } }, 'route-a')
    return port.escalate({ comment: comment('c1', 'critical'), diff: SINGLE_DIFF, rule: 'check nulls' })
  }

  it('reads a verdict and carries it with the adjudicator identity', async () => {
    const answer = await adjudicate('{"verdict":"refute","reason":"the guard is three lines above"}')
    expect(answer.verdicts).toEqual([{ engine: 'route-a', verdict: 'refute', reason: 'the guard is three lines above' }])
    expect(answer.spent).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  it('treats an unreadable or unknown answer as unavailable, never as agreement', async () => {
    for (const text of ['I would keep this.', '{"verdict":"maybe"}', '{"verdict":"confirm",}']) {
      const answer = await adjudicate(text)
      expect(answer.verdicts[0]?.verdict).toBe('unavailable')
    }
  })

  it('omits an empty reason rather than publishing an empty one', async () => {
    const answer = await adjudicate('{"verdict":"confirm","reason":"   "}')
    expect(answer.verdicts[0]).toEqual({ engine: 'route-a', verdict: 'confirm' })
  })
})

describe('escalation in the engine', () => {
  const reviewer = {
    async review() {
      return {
        comments: [
          { path: 'src/app.ts', content: 'drops the tenant', startLine: 2, endLine: 2, severity: 'critical', category: 'bug' },
          { path: 'src/app.ts', content: 'naming nit', startLine: 2, endLine: 2, severity: 'low', category: 'style' },
        ],
        spent: { inputTokens: 0, outputTokens: 0 },
      }
    },
  }
  const run = async (port?: ReviewEscalationPort) => runReview(
    { git, model: quietModel, reviewer, rules, newId: () => 'run-esc' },
    { request: { mode: 'workspace', cwd: '/repo' }, ...(port === undefined ? {} : { escalation: { port } }) },
  )

  it('leaves the report unadjudicated when escalation is off', async () => {
    const { report } = await run()
    expect(report.escalations).toEqual([])
    expect(report.comments).toHaveLength(2)
    expect(renderReviewText(report)).not.toContain('Adjudicated')
  })

  it('records the adjudication and drops a refuted finding while keeping the rest', async () => {
    const { report } = await run(adjudicator({
      verdicts: [{ engine: 'council', verdict: 'refute', reason: 'the tenant is passed by the caller' }],
    }))
    expect(report.escalations).toHaveLength(1)
    expect(report.escalations[0]).toMatchObject({ resolution: 'refuted', refuted: ['council'] })
    expect(report.comments).toHaveLength(2)
    const dropped = report.comments.find(entry => entry.state === 'filtered')
    expect(dropped?.content).toBe('drops the tenant')
    expect(dropped?.filteredReason).toContain('the tenant is passed by the caller')
    expect(report.filteredCount).toBe(1)
    expect(renderReviewText(report)).toContain('Adjudicated: 1 high-severity finding(s), 1 refuted, 0 upheld')
  })

  it('meters the adjudicator against the run budget', async () => {
    const { report } = await run(adjudicator({
      verdicts: [{ engine: 'council', verdict: 'confirm' }],
      spent: { inputTokens: 120, outputTokens: 30 },
    }))
    expect(report.budget.spentTotal).toBe(150)
  })

  it('publishes the finding and notes the failure when adjudication throws', async () => {
    const port: ReviewEscalationPort = { async escalate() { throw new Error('council unreachable') } }
    const result = await run(port)
    expect(result.report.comments.find(entry => entry.content === 'drops the tenant')?.state).toBe('kept')
    expect(result.notes.some(note => note.includes('council unreachable'))).toBe(true)
    expect(result.report.escalations[0]?.resolution).toBe('undecided')
  })
})
