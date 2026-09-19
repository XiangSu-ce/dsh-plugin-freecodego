import { describe, expect, it } from 'vitest'
import {
  ACTION_REVIEW_LIMITS,
  ActionReviewState,
  approximateTokens,
  capToTokens,
  composeReviewInput,
  describeReviewOutcome,
  type ActionReviewRequest,
  type Reviewer,
} from '../src/action-review.ts'

function request(overrides: Partial<ActionReviewRequest> = {}): ActionReviewRequest {
  return {
    sessionId: 's1',
    action: { tool: 'bash', summary: 'bash: rm -rf build', argumentsText: '{"command":"rm -rf build"}' },
    reason: 'the command policy returned prompt',
    transcript: [
      { index: 0, text: 'user: clean the build directory' },
      { index: 1, text: 'assistant: I will remove build/' },
      { index: 2, text: 'tool: rm refused by policy' },
    ],
    historyVersion: 4,
    ...overrides,
  }
}

describe('review input composition', () => {
  it('reads the whole transcript when there is no cursor', () => {
    const input = composeReviewInput(request())
    expect(input.mode).toBe('full')
    expect(input.transcriptText).toContain('clean the build directory')
    expect(input.reviewedThrough).toBe(3)
  })

  it('reads only what is new when the cursor still matches', () => {
    const input = composeReviewInput(request(), { historyVersion: 4, entryCount: 3 })
    expect(input.mode).toBe('delta')
    expect(input.transcriptText).toBe('')
  })

  it('re-reads everything when the history generation moved', () => {
    // A compacted or rolled-back history invalidates the cursor; reviewing the
    // wrong slice is worse than paying for a right one.
    const input = composeReviewInput(request({ historyVersion: 5 }), { historyVersion: 4, entryCount: 3 })
    expect(input.mode).toBe('full')
    expect(input.transcriptText).toContain('clean the build directory')
  })

  it('re-reads everything when the cursor is past the end of the transcript', () => {
    const input = composeReviewInput(request(), { historyVersion: 4, entryCount: 99 })
    expect(input.mode).toBe('full')
  })

  it('keeps reading a delta when the window sits at high event positions', () => {
    // `index` is a position in the session snapshot, not a row number: a long
    // session's window holds a couple of hundred rows whose positions run into
    // the hundreds. Comparing the position against the row count called every
    // such cursor stale, so the delta was never taken in the sessions that need
    // it most and the reviewer re-read the entire window on every prompt.
    const transcript = Array.from({ length: 200 }, (_entry, offset) => ({ index: 800 + offset, text: `entry ${String(800 + offset)}` }))
    const input = composeReviewInput(request({ transcript }), { historyVersion: 4, entryCount: 999 })
    expect(input.mode).toBe('delta')
    expect(input.transcriptText).toBe('entry 999')
    expect(input.reviewedThrough).toBe(1_000)
  })

  it('advances the cursor only through the entries the reviewer actually read', () => {
    // The caps stop the loop partway through a long window. Advancing to the end
    // of the *requested* delta marked that dropped tail reviewed, and the next
    // delta began after it — so those entries were never shown to the reviewer at
    // all, for the rest of the session.
    const transcript = Array.from({ length: 60 }, (_entry, index) => ({ index, text: `${String(index)}: ${'y'.repeat(900)}` }))
    const input = composeReviewInput(request({ transcript }))
    const included = input.transcriptText.split('\n---\n').length
    expect(input.truncated).toBe(true)
    expect(included).toBeLessThan(transcript.length)
    expect(input.reviewedThrough).toBe(included)
  })

  it('caps the action and says it was capped instead of pretending it fits', () => {
    const input = composeReviewInput(request({ action: { tool: 'write', summary: 'write', argumentsText: 'x'.repeat(ACTION_REVIEW_LIMITS.actionTokens * 8) } }))
    expect(input.truncated).toBe(true)
    expect(input.actionText).toContain('truncated to fit the review budget')
  })

  it('keeps the total review under the overall cap', () => {
    const transcript = Array.from({ length: 200 }, (_entry, index) => ({ index, text: 'y'.repeat(4_000) }))
    const input = composeReviewInput(request({ transcript }))
    expect(approximateTokens(input.actionText) + approximateTokens(input.reasonText) + approximateTokens(input.transcriptText))
      .toBeLessThanOrEqual(ACTION_REVIEW_LIMITS.totalTokens)
    expect(input.truncated).toBe(true)
  })

  it('caps text at a token budget and announces the cut', () => {
    const capped = capToTokens('z'.repeat(100), 5)
    expect(capped.truncated).toBe(true)
    expect(capped.text.length).toBeLessThanOrEqual(20)
    expect(capToTokens('short', 10)).toEqual({ text: 'short', truncated: false })
  })
})

describe('review outcomes', () => {
  it('asks the user when no reviewer is configured, never allowing implicitly', async () => {
    const state = new ActionReviewState()
    const { outcome } = await state.review(request(), undefined)
    expect(outcome).toEqual({ kind: 'ask-user', why: 'no-reviewer' })
    expect(describeReviewOutcome(outcome)).toContain('no automated reviewer is configured')
  })

  it('treats a throwing reviewer as a missing verdict, not as an approval', async () => {
    const state = new ActionReviewState()
    const reviewer: Reviewer = { review: () => { throw new Error('provider down') } }
    const { outcome } = await state.review(request(), reviewer)
    expect(outcome).toEqual({ kind: 'ask-user', why: 'reviewer-failed' })
  })

  it('returns a verdict and advances the cursor only when one was given', async () => {
    const state = new ActionReviewState()
    const reviewer: Reviewer = { review: async () => ({ kind: 'allow', rationale: 'matches the user request' }) }
    const { outcome } = await state.review(request(), reviewer)
    expect(outcome.kind).toBe('allow')
    expect(state.cursor('s1')).toEqual({ historyVersion: 4, entryCount: 3 })
    const second = await state.review(request({ transcript: [...request().transcript, { index: 3, text: 'tool: ok' }] }), reviewer)
    expect(second.input.mode).toBe('delta')
    expect(second.input.transcriptText).toBe('tool: ok')
  })

  it('does not advance the cursor when the reviewer asked for the user', async () => {
    const state = new ActionReviewState()
    const reviewer: Reviewer = { review: async () => ({ kind: 'ask-user', why: 'reviewer-failed' }) }
    await state.review(request(), reviewer)
    expect(state.cursor('s1')).toBeUndefined()
  })

  it('stops reviewing once the session budget is spent and says why', async () => {
    const state = new ActionReviewState(2)
    const reviewer: Reviewer = { review: async () => ({ kind: 'deny', rationale: 'no' }) }
    await state.review(request(), reviewer)
    await state.review(request(), reviewer)
    const third = await state.review(request(), reviewer)
    expect(third.outcome).toEqual({ kind: 'ask-user', why: 'budget-exhausted' })
    expect(state.budget('s1')).toEqual({ used: 2, limit: 2, exhausted: true })
    expect(describeReviewOutcome(third.outcome)).toContain('review budget is exhausted')
  })

  it('forgets a cursor when the caller invalidates it', async () => {
    const state = new ActionReviewState()
    await state.review(request(), { review: async () => ({ kind: 'allow' }) })
    state.invalidate('s1')
    expect(state.cursor('s1')).toBeUndefined()
    const next = await state.review(request(), { review: async () => ({ kind: 'allow' }) })
    expect(next.input.mode).toBe('full')
  })

  it('releases both per-session records when a conversation is forgotten', async () => {
    const state = new ActionReviewState(1)
    await state.review(request(), { review: async () => ({ kind: 'allow' }) })
    // Spend the one budgeted review so the counter, not just the cursor, is set.
    await state.review(request(), { review: async () => ({ kind: 'allow' }) })
    expect(state.budget('s1').used).toBe(1)
    expect(state.cursor('s1')).toBeDefined()

    state.forget('s1')
    expect(state.cursor('s1')).toBeUndefined()
    // The budget must go with the cursor: a disposed conversation that came back
    // later is a new conversation, and a survivor would silently deny it reviews.
    expect(state.budget('s1')).toEqual({ used: 0, limit: 1, exhausted: false })
    const next = await state.review(request(), { review: async () => ({ kind: 'allow' }) })
    expect(next.outcome.kind).not.toBe('ask-user')
  })

  it('explains a denial and a clear verdict in words an approval prompt can show', () => {
    expect(describeReviewOutcome({ kind: 'deny', rationale: 'destructive without a backup' })).toContain('destructive without a backup')
    expect(describeReviewOutcome({ kind: 'allow' })).toContain('cleared this action')
  })

  it('names the reason a review fell back to the user', () => {
    // `ask-user` is what every failure degrades to, so its wording is the one a
    // reader meets most often and the one that has to say why.
    expect(describeReviewOutcome({ kind: 'ask-user', why: 'no-reviewer' })).toContain('no automated reviewer is configured')
    expect(describeReviewOutcome({ kind: 'ask-user', why: 'budget-exhausted' })).toContain('budget is exhausted')
    expect(describeReviewOutcome({ kind: 'ask-user', why: 'reviewer-failed' })).toContain('did not return a verdict')
  })
})
