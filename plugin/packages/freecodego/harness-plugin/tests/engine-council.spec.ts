import { describe, expect, it } from 'vitest'
import { councilFindingsFromParticipants, councilJobFromEvents, councilJobFromReport, councilReportsFromEvents, mergeCouncilFindings } from '../src/engine-council.ts'
import type { FreeCodeGoEngineeringCouncilReport } from '../src/types.ts'

describe('FreeCodeGo engine council', () => {
  it('extracts only durable council reports from a parent session log', () => {
    const report = { id: 'council_1', sessionId: 'parent', projectId: 'project', state: 'completed', createdAt: 1, objective: 'objective', plan: '# plan', rounds: 2, quorum: 2, participants: [], consensus: 'consensus', dissent: 'none', finalRecommendation: 'recommendation' } as unknown as FreeCodeGoEngineeringCouncilReport
    const events = [
      { type: 'user/message', seq: 0, time: 0, data: {} },
      { type: 'freecodego/council-state', seq: 1, time: 1, data: { id: report.id, state: 'running' } },
      { type: 'freecodego/council', seq: 2, time: 2, data: report },
    ] as never
    expect(councilReportsFromEvents(events)).toEqual([report])
  })

  it('folds a later user decision and verification into the durable report', () => {
    const report = { id: 'council_2', sessionId: 'parent', projectId: 'project', state: 'partial', createdAt: 1, objective: 'objective', plan: '# plan', rounds: 2, quorum: 2, participants: [], consensus: 'consensus', dissent: 'one unavailable', finalRecommendation: 'recommendation' } as unknown as FreeCodeGoEngineeringCouncilReport
    const verification = { id: 'verify_1', checkedAt: 3, stages: [{ id: 'scope', state: 'pass', durationMs: 1, summary: 'clean' }] }
    const events = [
      { type: 'freecodego/council', seq: 0, time: 1, data: report },
      { type: 'freecodego/council-decision', seq: 1, time: 2, data: { id: report.id, state: 'approved', decidedAt: 2 } },
      { type: 'freecodego/council-implementation', seq: 2, time: 3, data: { id: report.id, completedAt: 3, summary: 'implemented' } },
      { type: 'freecodego/council-verification', seq: 3, time: 4, data: { id: report.id, result: verification } },
    ] as never
    expect(councilReportsFromEvents(events)).toEqual([{
      ...report,
      decision: { id: report.id, state: 'approved', decidedAt: 2 },
      implementation: { id: report.id, completedAt: 3, summary: 'implemented' },
      verification,
    }])
  })

  it('restores an approval lifecycle state and marks orphaned active work stale', () => {
    const report = { id: 'council_3', sessionId: 'parent', projectId: 'project', state: 'completed', createdAt: 1, objective: 'objective', plan: '# plan', rounds: 1, quorum: 1, participants: [], consensus: 'consensus', dissent: 'none', finalRecommendation: 'recommendation', decision: { id: 'council_3', state: 'approved', decidedAt: 2, expiresAt: Date.now() + 10000 } } as unknown as FreeCodeGoEngineeringCouncilReport
    expect(councilJobFromReport(report).state).toBe('implementing')
    const events = [{ type: 'freecodego/council-task', seq: 0, time: 1, data: { job: { id: 'council_4', sessionId: 'parent', projectId: 'project', state: 'running', createdAt: 1 }, request: { objective: 'o', plan: 'p' }, policyDigest: 'digest' } }, { type: 'freecodego/council-state', seq: 1, time: 2, data: { id: 'council_4', state: 'running', updatedAt: 2 } }] as never
    expect(councilJobFromEvents(events, 'council_4')).toMatchObject({ id: 'council_4', state: 'stale' })
  })

  it('uses only structured findings for the risk gate input', () => {
    const findings = councilFindingsFromParticipants([{ engine: 'codex', provider: 'codex', model: 'codex-auto', state: 'completed', durationMs: 1, output: 'Verdict: block\nFINDING: blocker | Missing authorization | src/api.ts:42 accepts an unscoped update\nwarning: unstructured text is ignored' }])
    expect(findings).toEqual([{ id: 'finding_1', engine: 'codex', severity: 'blocker', title: 'Missing authorization', evidence: 'src/api.ts:42 accepts an unscoped update' }])
  })

  it('keeps the highest severity when two engines report the same issue', () => {
    const merged = mergeCouncilFindings([
      { id: 'f1', engine: 'codex', severity: 'info', title: 'Unbounded retry loop', evidence: 'src/retry.ts:12' },
      { id: 'f2', engine: 'claude', severity: 'blocker', title: 'unbounded retry loop', evidence: 'src/retry.ts:12 no attempt cap' },
    ], 3)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.severity).toBe('blocker')
    expect(merged[0]?.evidence).toBe('src/retry.ts:12 no attempt cap')
  })

  it('annotates agreement against the peer engine count, not the cluster size', () => {
    const merged = mergeCouncilFindings([
      { id: 'f1', engine: 'codex', severity: 'warning', title: 'Missing test coverage', evidence: 'src/a.ts' },
      { id: 'f2', engine: 'claude', severity: 'warning', title: 'Missing test coverage', evidence: 'src/a.ts' },
    ], 3)
    // Two of three peers agreed — not the tautological "2/2" a cluster-only
    // denominator produced.
    expect(merged[0]?.title).toBe('Missing test coverage (2/3 engines flagged this)')
  })

  it('counts distinct engines, so one engine repeating itself is not agreement', () => {
    const merged = mergeCouncilFindings([
      { id: 'f1', engine: 'codex', severity: 'warning', title: 'Missing test coverage', evidence: 'src/a.ts' },
      { id: 'f2', engine: 'codex', severity: 'warning', title: 'Missing test coverage', evidence: 'src/a.ts again' },
    ], 3)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.title).toBe('Missing test coverage (1/3 engines flagged this)')
  })

  it('falls back to a count-only annotation when the peer count is unknown', () => {
    const merged = mergeCouncilFindings([
      { id: 'f1', engine: 'deepseek', severity: 'info', title: 'Duplicated helper', evidence: 'src/h.ts' },
      { id: 'f2', engine: 'claude', severity: 'info', title: 'Duplicated helper', evidence: 'src/h.ts' },
    ])
    expect(merged[0]?.title).toBe('Duplicated helper (2 engines flagged this)')
  })

  it('orders merged findings by severity and renumbers them densely', () => {
    const merged = mergeCouncilFindings([
      { id: 'a', engine: 'codex', severity: 'info', title: 'Style nit', evidence: 'x' },
      { id: 'b', engine: 'claude', severity: 'blocker', title: 'Data loss path', evidence: 'y' },
      { id: 'c', engine: 'deepseek', severity: 'warning', title: 'Slow query', evidence: 'z' },
    ], 3)
    expect(merged.map(finding => finding.severity)).toEqual(['blocker', 'warning', 'info'])
    expect(merged.map(finding => finding.id)).toEqual(['finding_1', 'finding_2', 'finding_3'])
  })

  it('drops findings whose title normalizes to nothing', () => {
    const merged = mergeCouncilFindings([{ id: 'a', engine: 'codex', severity: 'info', title: '///', evidence: 'x' }], 1)
    expect(merged).toHaveLength(0)
  })
})
