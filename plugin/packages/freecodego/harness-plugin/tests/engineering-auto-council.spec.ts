import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COUNCIL_ENGINES, COUNCIL_MAX_PLAN_CHARS, MAX_AUTO_COUNCIL_ATTEMPTS, autoCouncilSkipReason, councilCanReviewPlan, councilPeersFor, latestSessionEngine, normalizeEngineeringCouncilRequest } from '../src/engineering-remote-utils.ts'

describe('automatic engineering council guard', () => {
  const PLAN = '# Plan A'
  const attempt = (id: string, plan: string = PLAN) => ({
    type: 'freecodego/council-task',
    data: { job: { id }, request: { objective: 'review', plan } },
  })
  const task = (plan: string) => attempt('council_1234567890abcdef1234567890abcdef', plan)
  const state = (id: string, value: string) => ({ type: 'freecodego/council-state', data: { id, state: value, updatedAt: 1 } })
  const report = (id: string, value: string) => ({ type: 'freecodego/council', data: { id, state: value } })

  it('accepts exactly the engines the council tool offers, and no others', () => {
    // One list, one decision. The validator used to carry its own inline chain of
    // comparisons next to a hand-written `> 3`, while the tool schema carried a
    // third copy — so a boundary could offer one set of engines and accept
    // another, silently in both directions.
    for (const engine of COUNCIL_ENGINES) {
      expect(normalizeEngineeringCouncilRequest({ objective: 'o', plan: 'p', engines: [engine] }).engines).toEqual([engine])
    }
    // `'freecodego'` is the root Agent's own engine: a member of the engine-id type
    // on purpose, and not a delegation target. A convergence that read the wider
    // type here would accept a child Agent the council cannot start.
    expect(COUNCIL_ENGINES).not.toContain('freecodego')
    expect(() => normalizeEngineeringCouncilRequest({ objective: 'o', plan: 'p', engines: ['freecodego' as never] })).toThrow(/engines are invalid/)
    expect(() => normalizeEngineeringCouncilRequest({ objective: 'o', plan: 'p', engines: ['unknown' as never] })).toThrow(/engines are invalid/)
  })

  it('does not start a plan that was actually reviewed, with or without blockers', () => {
    for (const outcome of ['completed', 'partial', 'blocked']) {
      const id = 'council_reviewed'
      expect(autoCouncilSkipReason([attempt(id), state(id, 'awaiting_approval'), report(id, outcome)], PLAN)).toBe('reviewed')
    }
    // A different plan is unaffected: the guard is per approved plan.
    expect(autoCouncilSkipReason([task('# Plan A')], '# Plan B')).toBeUndefined()
  })

  it('ignores unrelated session events', () => {
    expect(autoCouncilSkipReason([{ type: 'turn/start', data: { turn: 1 } }], PLAN)).toBeUndefined()
    expect(autoCouncilSkipReason([{ type: 'freecodego/council', data: { id: 'council_other', state: 'completed' } }], PLAN)).toBeUndefined()
  })

  it('retries once when the attempt established nothing, and never after that', () => {
    // The council's own deadline ends an attempt as 'failed' with no review to
    // show for it. The plan was never reviewed, so the automatic path gets one
    // more try — the bound is what keeps a failing council from spending on every
    // turn boundary.
    const first = 'council_deadline'
    const failed = [attempt(first), state(first, 'failed'), report(first, 'failed')]
    expect(autoCouncilSkipReason(failed, PLAN)).toBeUndefined()
    const second = 'council_deadline_2'
    expect(autoCouncilSkipReason([...failed, attempt(second), state(second, 'failed'), report(second, 'failed')], PLAN)).toBe('exhausted')
    expect(MAX_AUTO_COUNCIL_ATTEMPTS).toBe(2)
    // A Host restart mid-review leaves the same kind of record — an attempt with
    // no outcome at all — and is retryable for the same reason.
    expect(autoCouncilSkipReason([attempt('council_orphan'), state('council_orphan', 'stale')], PLAN)).toBeUndefined()
    // A task whose state event never landed (the process died between the two
    // appends) is the same case one crash earlier.
    expect(autoCouncilSkipReason([attempt('council_truncated')], PLAN)).toBeUndefined()
  })

  it('never retries a council the user cancelled, and never races a running one', () => {
    // A cancellation is the user's decision, so it stays off like an in-flight
    // attempt. Telling it apart from the deadline above is the whole point: the
    // council reports an expired deadline as 'failed', not as 'cancelled'.
    const cancelled = 'council_cancelled'
    expect(autoCouncilSkipReason([attempt(cancelled), state(cancelled, 'cancelled'), report(cancelled, 'cancelled')], PLAN)).toBe('cancelled')
    const running = 'council_running'
    expect(autoCouncilSkipReason([attempt(running), state(running, 'running')], PLAN)).toBe('in-flight')
    // Waiting on the user's decision is not a moment to start a second review.
    expect(autoCouncilSkipReason([attempt('council_waiting'), state('council_waiting', 'awaiting_approval')], PLAN)).toBe('in-flight')
  })

  it('delegates to the two engines other than the current parent engine', () => {
    expect(latestSessionEngine([{ type: 'agent-engine/selected', data: { engineId: 'codex' } }])).toBe('codex')
    expect(latestSessionEngine([{ type: 'freecodego/engine-executor', data: { engine: 'claude' } }])).toBe('claude')
    // The roster the automatic review starts, read from the function that builds
    // it rather than from a literal restated here. The previous form filtered its
    // own copy of `['deepseek', 'codex', 'claude']`, so it asserted on the test's
    // spelling and passed whichever engines `index.ts` actually handed to
    // `engineCouncil.start` — a reader is not less of one for being missed.
    expect(councilPeersFor('claude')).toEqual(['deepseek', 'codex'])
    expect(councilPeersFor('codex')).toEqual(['deepseek', 'claude'])
    // A session that has recorded no engine yet excludes nobody.
    expect(councilPeersFor(undefined)).toEqual(['deepseek', 'codex', 'claude'])
    expect(councilPeersFor('deepseek')).not.toContain('deepseek')
  })

  it('has no second spelling of the roster at the call site', () => {
    // The unit above proves the derivation excludes the parent. This one proves
    // the automatic path *uses* it: `index.ts` is the caller, and a literal
    // restored there would leave the derivation correct and unused — the exact
    // state that made an engine added to `COUNCIL_ENGINES` reachable by the
    // explicit council tool and invisible to the automatic one.
    const index = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(index).toContain('councilPeersFor(parentEngine)')
    expect(index).not.toMatch(/\[['"]deepseek['"],\s*['"]codex['"]/)
  })

  it('reviews a plan of exactly the request bound and refuses one character more', () => {
    expect(councilCanReviewPlan('x'.repeat(COUNCIL_MAX_PLAN_CHARS))).toBe(true)
    expect(councilCanReviewPlan('x'.repeat(COUNCIL_MAX_PLAN_CHARS + 1))).toBe(false)
  })

  it('agrees with the remote validator about the largest plan it accepts', () => {
    // One bound, two readers. The automatic path asks the predicate before it
    // starts a review, so a plan the predicate clears must not then be refused by
    // the validator that fronts the council: that mismatch is what turned a long
    // plan into an exception on every turn instead of one decision.
    const atLimit = 'x'.repeat(COUNCIL_MAX_PLAN_CHARS)
    expect(() => normalizeEngineeringCouncilRequest({ objective: 'review', plan: atLimit })).not.toThrow()
    expect(councilCanReviewPlan(atLimit)).toBe(true)
    const overLimit = 'x'.repeat(COUNCIL_MAX_PLAN_CHARS + 1)
    expect(() => normalizeEngineeringCouncilRequest({ objective: 'review', plan: overLimit })).toThrow(/plan is invalid/)
    expect(councilCanReviewPlan(overLimit)).toBe(false)
  })
})
