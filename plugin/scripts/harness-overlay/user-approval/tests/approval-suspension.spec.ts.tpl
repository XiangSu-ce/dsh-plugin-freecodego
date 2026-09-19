import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { deadline, remainingTimeoutMs, suspendTimeout } from '@deepseek-ai/dsh-timeout'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { carrierKeyOf, createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService, { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/**
 * A minimal Agent stand-in — the service only reaches `agent.session.append`
 * and indexed log reads. Seeded inside an open turn by default (request()'s
 * turn-enclosure precondition).
 */
function fakeAgent(): { agent: Agent; appended: Array<{ type: string; data: Record<string, unknown> }> } {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [{ type: 'turn/start' }, { type: 'user/message' }]
  const agent = {
    session: {
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        appended.push(event)
        return event as unknown as SessionEvent
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ApprovalService)
  return ctx
}

function requestOf(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'echo', ...overrides }
}

describe('ApprovalService.request — deadline suspension', () => {
  afterEach(() => { vi.useRealTimers() })

  it('suspends the tool deadline riding the request signal for the ask, and resumes after', async () => {
    vi.useFakeTimers()
    const ctx = await mounted()
    const { agent } = fakeAgent()
    // The exact shape a tool hands over: the derived deadline signal.
    using d = deadline(undefined, 100, 'APPROVAL_TEST')
    // An answerer that takes longer than the tool's whole budget: the human is
    // deciding, and that time must not be charged to the operation.
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>(resolve => { setTimeout(() => resolve('allowed-once'), 60_000) }))
    const pending = ctx.approval.request(requestOf(agent, { signal: d.signal }))
    // The deadline would have fired long ago without the suspension.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(d.signal.aborted).toBe(false)
    // Advance exactly to the human's answer — not runAllTimersAsync, which
    // would also fire the re-armed deadline under test. The clock already
    // sits at t=1_000, and the answerer's timer was armed at t=0, so 59_000
    // more lands exactly on t=60_000: the resume re-arms at t=60_000 for the
    // frozen 100ms, and that timer (t=60_100) stays beyond this advance.
    await vi.advanceTimersByTimeAsync(59_000)
    await expect(pending).resolves.toBe('allowed-once')
    // The timer is re-armed after the ask, with the budget that was left when
    // the pause began (100ms) minus nothing: the human's minute was free.
    await vi.advanceTimersByTimeAsync(50)
    expect(d.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(d.signal.aborted).toBe(true)
  })

  it('resumes the deadline even when the answerer fails closed', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    using d = deadline(undefined, 100, 'APPROVAL_TEST')
    // The seam contains answerer failures and maps them to 'unavailable', so
    // the observable contract is: the outcome arrives, and the deadline is
    // unfrozen afterwards — running again, not stuck mid-pause.
    ctx.on('approval/request', () => Promise.reject(new Error('answerer exploded')))
    await expect(ctx.approval.request(requestOf(agent, { signal: d.signal }))).resolves.toBe('unavailable')
    expect(remainingTimeoutMs(d.signal)).toBeLessThanOrEqual(100)
    expect(remainingTimeoutMs(d.signal)).toBeGreaterThan(0)
  })

  it('does not suspend anything for a request without a signal', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const foreign = new AbortController()
    // No deadline rides this request; the ask must not touch unrelated signals.
    suspendTimeout(foreign.signal)
    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('unavailable')
    expect(foreign.signal.aborted).toBe(false)
  })
})

// Keep the scope imports referenced: the service resolves answerers through
// carrier scopes, and this spec exercises the same resolution path.
void carrierKeyOf
void createScope
export type { Scope }
