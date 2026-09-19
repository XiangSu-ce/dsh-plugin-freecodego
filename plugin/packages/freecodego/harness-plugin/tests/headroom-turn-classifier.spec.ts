import { describe, expect, it } from 'vitest'
import { classifyTurnFromTail, routeEffort, ERROR_OUTPUT_EVENT_KIND } from '../src/headroom/output-shaper.ts'

/**
 * The turn classifier reads session event kinds, so it is only correct if the
 * kinds it names are ones this Harness actually writes.
 *
 * It was ported with the upstream project's vocabulary — `tool/text` and
 * `tool/code-dispatch` — and neither is a live event here (`tool/code-dispatch`
 * is the pre-v1 spelling migrated to `tool/ptc-dispatch`), while the loop appends
 * `step/start` immediately before the `agent/request` waterfall that consumes
 * this answer. Both facts together made `mechanical-continuation` unreachable, so
 * the effort clamp `headroomOutputShaper` advertises never fired. These cases
 * pin the real names and the framing skip, using the event order
 * `packages/core/agent-loop/src/agent.ts` appends.
 */
describe('headroom turn classification', () => {
  it('classifies a tool continuation as mechanical when the step frame is newest', () => {
    // Exactly what the 8-kind window holds when the second step of a turn
    // requests: the loop appended step/end then step/start after the tool result.
    const tail = ['user/message', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'step/start']
    expect(classifyTurnFromTail(tail)).toBe('mechanical-continuation')
  })

  it('classifies the first request of a turn as a fresh ask', () => {
    expect(classifyTurnFromTail(['turn/start', 'user/message', 'step/start'])).toBe('new-user-ask')
  })

  it('does not recognise the ported vocabulary, so the old names cannot read as green', () => {
    // If someone reintroduces `tool/text`, this case still passes (it is not a live
    // event) while the case above fails — which is the pairing that makes the
    // regression visible instead of invisible.
    expect(classifyTurnFromTail(['tool/text', 'tool/text'])).toBe('unknown')
    expect(classifyTurnFromTail(['tool/code-dispatch'])).toBe('unknown')
    expect(classifyTurnFromTail(['user/text'])).toBe('unknown')
  })

  it('leaves a tail whose latest substantive event is model output unknown', () => {
    // No tool result: the turn is not mechanically continuing, and guessing so
    // would lower the effort of an answer the model is still composing.
    expect(classifyTurnFromTail(['step/start', 'assistant/message'])).toBe('unknown')
    expect(classifyTurnFromTail([])).toBe('unknown')
  })

  it('does not call a turn that failed mechanical, so a debugging turn is never clamped', () => {
    // A failed tool call reaches the model as an ordinary `tool/result` — this
    // Harness writes no `tool/error` event — so the caller records it under
    // ERROR_OUTPUT_EVENT_KIND and the failure is visible in the tail only through
    // that token. Without it, `'error-continuation'` was a TurnKind nothing could
    // return and this tail clamped: the move the eval case calls "exactly the
    // wrong one".
    const tail = ['tool/call', ERROR_OUTPUT_EVENT_KIND, 'step/end', 'step/start']
    expect(classifyTurnFromTail(tail)).toBe('error-continuation')
    expect(routeEffort('high', classifyTurnFromTail(tail), true)).toBe('high')
  })

  it('clamps again once a later tool call succeeds', () => {
    // The run's newest member decides it, so a model that recovers on its own is
    // back to a mechanical continuation rather than exempt for the rest of the
    // turn.
    expect(classifyTurnFromTail([ERROR_OUTPUT_EVENT_KIND, 'tool/result', 'step/start'])).toBe('mechanical-continuation')
    expect(routeEffort('high', classifyTurnFromTail([ERROR_OUTPUT_EVENT_KIND, 'tool/result', 'step/start']), true)).toBe('medium')
  })

  it('clamps effort for the continuation it classifies from a real tail', () => {
    // The two halves of the advertised behavior, end to end: classification is
    // only worth anything if the value it returns reaches the clamp.
    const tail = ['tool/call', 'tool/result', 'step/end', 'step/start']
    expect(routeEffort('high', classifyTurnFromTail(tail), true)).toBe('medium')
    expect(routeEffort('high', classifyTurnFromTail(['user/message', 'step/start']), true)).toBe('high')
  })
})
