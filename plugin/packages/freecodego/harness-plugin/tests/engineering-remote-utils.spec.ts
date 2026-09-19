/**
 * Readers of the durable session log go through a cast — the record types are
 * declared in the packages that mint them, so TypeScript sees `unknown` and a
 * field nobody writes compiles. This spec pins the two locations that cast hides
 * for `tool/result`: the call id is `message.source.callId`, and the failure flag
 * is on the tool-result **content block** (`message.content[i].isError`), which is
 * where `createToolResultMessage` puts it and where the session invariant reads it
 * back.
 *
 * Both were read from the top level here, which found nothing on any live event
 * and left {@link latestApprovedPlan}'s failure guard unreachable: a plan-mode exit
 * the tool reported as failed was still handed back as the approved plan.
 */

import { describe, expect, it } from 'vitest'
import { latestApprovedPlan } from '../src/engineering-remote-utils.ts'

const PLAN = '# Ship plan\n\n1. Do the thing'

function toolCall(callId: string, plan: string): { readonly type: string; readonly data: unknown } {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) } }
}

function toolResult(callId: string, isError = false, extra: Record<string, unknown> = {}): { readonly type: string; readonly data: unknown } {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }],
      },
      ...extra,
    },
  }
}

describe('latestApprovedPlan', () => {
  it('returns the plan an exit_plan_mode call ended successfully with', () => {
    expect(latestApprovedPlan([toolCall('p-1', PLAN), toolResult('p-1')])).toBe(PLAN)
  })

  it('refuses a plan whose own result reported a failure on its block', () => {
    // No `error` field, so the block flag is the only signal — and the block is the
    // only place `message` carries it.
    expect(latestApprovedPlan([toolCall('p-1', PLAN), toolResult('p-1', true)])).toBeUndefined()
  })

  it('refuses a plan whose own result carried a structured error', () => {
    expect(latestApprovedPlan([toolCall('p-1', PLAN), toolResult('p-1', true, { error: { name: 'PlanRejected', code: 'PLAN_REJECTED' } })])).toBeUndefined()
  })

  it('does not let a sibling call failure cancel the plan', () => {
    // Matching is by call id, so a failure that belongs to another tool is not this
    // plan's; loosening the match instead of fixing it would have made that
    // indistinguishable from the case above.
    expect(latestApprovedPlan([toolCall('p-1', PLAN), toolResult('other-1', true), toolResult('p-1')])).toBe(PLAN)
  })

  it('refuses a plan that is not a markdown heading', () => {
    expect(latestApprovedPlan([toolCall('p-1', 'just prose'), toolResult('p-1')])).toBeUndefined()
  })
})
