import { describe, expect, it } from 'vitest'
import {
  CACHE_COLD_DEFAULTS,
  CLEARED_RESULT_MARKER,
  CacheColdPolicy,
  CacheColdView,
  type MessageLike,
  clearOldToolResults,
  clearedResultMarker,
  describeCacheColdRefusal,
  evaluateCacheColdTrigger,
  selectResultsToClear,
} from '../src/cache-cold.ts'

const HOUR = 60 * 60_000

const result = (seq: number, tool: string, tokens: number): { seq: number; tool: string; tokens: number } => ({ seq, tool, tokens })

describe('cache-cold trigger', () => {
  it('refuses below the threshold because the cache may still be warm', () => {
    // The refusal is the point: clearing early turns a free operation into a
    // billed one by rewriting a prefix the provider still had cached.
    const decision = evaluateCacheColdTrigger({ lastAssistantAt: 1_000, now: 1_000 + HOUR - 1, clearedCount: 0, candidates: [] })
    expect(decision.fire).toBe(false)
    expect(decision.refusal).toBe('gap-below-threshold')
  })

  it('fires at exactly one hour, where the TTL is guaranteed expired', () => {
    const decision = evaluateCacheColdTrigger({ lastAssistantAt: 1_000, now: 1_000 + HOUR, clearedCount: 0, candidates: [] })
    expect(decision.fire).toBe(true)
    expect(decision.gapMs).toBe(HOUR)
  })

  it('names the refusal so the caller knows whether to wait or stop trying', () => {
    const cooldown = evaluateCacheColdTrigger({ lastAssistantAt: 1_000, now: 1_000 + HOUR, clearedCount: 1, lastClearedAt: 1_000 + HOUR - 1_000, candidates: [] })
    expect(cooldown.refusal).toBe('cooldown-active')
    const capped = evaluateCacheColdTrigger({ lastAssistantAt: 1_000, now: 1_000 + HOUR, clearedCount: CACHE_COLD_DEFAULTS.maxPerSession, candidates: [] })
    expect(capped.refusal).toBe('session-cap-reached')
    const none = evaluateCacheColdTrigger({ now: 1_000 + HOUR * 2, clearedCount: 0, candidates: [] })
    expect(none.refusal).toBe('no-assistant-message')
    for (const refusal of ['no-assistant-message', 'gap-below-threshold', 'cooldown-active', 'session-cap-reached', 'nothing-clearable', 'below-reclaim-floor'] as const) {
      expect(describeCacheColdRefusal(refusal)).not.toBe('')
    }
  })
})

describe('what may be cleared', () => {
  it('keeps the newest results whatever they weigh', () => {
    // Selection is by position, not size: the newest result is the one the model
    // is still working against, even when an older one is far bigger.
    const candidates = [result(1, 'read', 90_000), result(2, 'read', 10), result(3, 'read', 10), result(4, 'read', 10), result(5, 'read', 10), result(6, 'read', 10)]
    const selection = selectResultsToClear(candidates, { ...CACHE_COLD_DEFAULTS, keepRecentResults: 5 })
    expect(selection.clearSeqs).toEqual([1])
    expect(selection.keptSeqs).toEqual([2, 3, 4, 5, 6])
    expect(selection.reclaimedTokens).toBe(90_000)
  })

  it('never clears a tool whose result records what changed', () => {
    // Edit and write results are the record of what changed and the surface the
    // model byte-patches against, so they are not candidates at any size.
    const candidates = [result(1, 'edit', 90_000), result(2, 'write', 50_000), result(3, 'read', 3_000), result(4, 'read', 3_000)]
    const selection = selectResultsToClear(candidates, CACHE_COLD_DEFAULTS)
    expect(selection.clearSeqs).toEqual([])
    expect(selection.reclaimedTokens).toBe(0)
  })

  it('orders candidates by sequence rather than by input order', () => {
    const selection = selectResultsToClear([result(9, 'read', 10), result(2, 'read', 10), result(5, 'read', 10)], { ...CACHE_COLD_DEFAULTS, keepRecentResults: 1 })
    expect(selection.clearSeqs).toEqual([2, 5])
    expect(selection.keptSeqs).toEqual([9])
  })

  it('reclaims a shell result on a platform whose shell is not spelled `bash`', () => {
    // The base `cordis.patch.yml` disables `tool-bash` on win32 and enables
    // `tool-pwsh`, so on Windows the only tool whose output grows without bound is
    // spelled `pwsh`. Leaving it off the list meant the one result class this policy
    // exists to reclaim was the one it could never touch there, while the POSIX
    // spelling it does list can never appear.
    const candidates = [result(1, 'pwsh', 90_000), result(2, 'read', 10), result(3, 'read', 10), result(4, 'read', 10), result(5, 'read', 10), result(6, 'read', 10)]
    const selection = selectResultsToClear(candidates, { ...CACHE_COLD_DEFAULTS, keepRecentResults: 5 })
    expect(selection.clearSeqs).toEqual([1])
    expect(selection.reclaimedTokens).toBe(90_000)
  })

  it("reclaims the plugin's own document reader, not only the harness `read`", () => {
    // `read_document` is this plugin's spelling of `read`/`cat`: the harness
    // `read` cannot show a PDF or a notebook, so that tool is where a document's
    // text enters the transcript -- and its cap is the largest in the plugin
    // (60_000 characters by default, 400_000 at most). It is named by every other
    // curated list that has to know it, so leaving it off this one meant the
    // biggest producer of the payload this policy exists to reclaim was the one
    // result class it could never touch, silently.
    const candidates = [result(1, 'read_document', 90_000), result(2, 'read', 10), result(3, 'read', 10), result(4, 'read', 10), result(5, 'read', 10), result(6, 'read', 10)]
    const selection = selectResultsToClear(candidates, { ...CACHE_COLD_DEFAULTS, keepRecentResults: 5 })
    expect(selection.clearSeqs).toEqual([1])
    expect(selection.reclaimedTokens).toBe(90_000)
  })
})

describe('per-conversation clearing state', () => {
  const candidates = [result(1, 'read', 50_000), result(2, 'read', 1_000), result(3, 'read', 1_000), result(4, 'read', 1_000), result(5, 'read', 1_000), result(6, 'read', 1_000)]

  it('produces the span the engine replaces, from the first to the last cleared seq', () => {
    const policy = new CacheColdPolicy()
    const plan = policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, candidates })
    expect(plan.fire).toBe(true)
    expect(plan.span).toEqual({ start: 1, end: 1 })
    expect(plan.reclaimedTokens).toBe(50_000)
  })

  it('does not spend the allowance on a plan that was never applied', () => {
    // Measured but unapplied (no engine mounted, aborted request) must leave the
    // conversation's allowance intact, or it silently loses it without ever
    // being cleared.
    const policy = new CacheColdPolicy()
    expect(policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, candidates }).fire).toBe(true)
    expect(policy.state('s1')).toBeUndefined()
    expect(policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, candidates }).fire).toBe(true)
  })

  it('refuses inside the cooldown after a committed clear', () => {
    const policy = new CacheColdPolicy()
    policy.commit('s1', 1_000 + HOUR)
    const again = policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR + 1_000, candidates })
    expect(again.fire).toBe(false)
    expect(again.refusal).toBe('cooldown-active')
    // Once the gap is genuinely long again, it fires and reports the real reason.
    expect(policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR * 3, candidates }).fire).toBe(true)
  })

  it('stops after the session cap instead of clearing forever', () => {
    const policy = new CacheColdPolicy()
    for (let pass = 0; pass < CACHE_COLD_DEFAULTS.maxPerSession; pass += 1) policy.commit('s1', 1_000 + pass)
    const after = policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR * 10, candidates })
    expect(after.fire).toBe(false)
    expect(after.refusal).toBe('session-cap-reached')
  })

  it('refuses when the eligible results are too small to be worth a replacement', () => {
    const policy = new CacheColdPolicy()
    const tiny = [result(1, 'read', 10), result(2, 'read', 10), result(3, 'read', 10), result(4, 'read', 10), result(5, 'read', 10), result(6, 'read', 10)]
    const plan = policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, candidates: tiny })
    expect(plan.fire).toBe(false)
    expect(plan.refusal).toBe('below-reclaim-floor')
  })

  it('refuses when there is nothing clearable at all', () => {
    const policy = new CacheColdPolicy()
    const plan = policy.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, candidates: [result(1, 'edit', 90_000)] })
    expect(plan.fire).toBe(false)
    expect(plan.refusal).toBe('nothing-clearable')
  })

  it('keeps conversations independent', () => {
    const policy = new CacheColdPolicy()
    policy.commit('s1', 1_000 + HOUR)
    expect(policy.state('s1')?.count).toBe(1)
    expect(policy.state('s2')).toBeUndefined()
    expect(policy.plan('s2', { lastAssistantAt: 1_000, now: 1_000 + HOUR, candidates }).fire).toBe(true)
    policy.forget('s1')
    expect(policy.state('s1')).toBeUndefined()
  })
})

describe('the stable view', () => {
  const call = (id: string, name: string): MessageLike => ({ role: 'assistant', content: [{ type: 'tool-call', id, name }] })
  const result = (callId: string, text: string): MessageLike => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] })
  // The first result has to clear the reclaim floor (2,000 tokens at the default
  // 4-chars-per-token estimate), or the policy correctly refuses to shrink at all.
  const history = [call('c1', 'read'), result('c1', 'x'.repeat(40_000)), call('c2', 'read'), result('c2', 'y'.repeat(100)), call('c3', 'read'), result('c3', 'z'.repeat(100)), call('c4', 'read'), result('c4', 'w'.repeat(100)), call('c5', 'read'), result('c5', 'v'.repeat(100)), call('c6', 'read'), result('c6', 'u'.repeat(100))]

  it('does nothing at all while no shrink is in effect', () => {
    const view = new CacheColdView()
    const applied = view.apply('s1', history)
    // The input array is handed straight back, so a session that never qualifies
    // pays one map lookup and nothing else.
    expect(applied.messages).toBe(history)
    expect(applied.changed).toBe(false)
  })

  it('keeps reproducing the shrink after the gap closes again', () => {
    // The decision fires once; the view must outlive it, or the next step would
    // restore the full transcript and move the cache break to that request.
    const view = new CacheColdView()
    const plan = view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, messages: history })
    expect(plan.fire).toBe(true)
    expect(plan.clearCount).toBe(1)
    expect(view.shrunk('s1')).toBe(true)
    const first = view.apply('s1', history)
    expect(first.clearedCallIds).toEqual(['c1'])
    // Gap is now short; the trigger would refuse, but the view does not shrink back.
    expect(view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR + 1_000, messages: history }).refusal).toBe('cooldown-active')
    const second = view.apply('s1', history)
    expect(second.clearedCallIds).toEqual(['c1'])
    expect(second.reclaimedChars).toBe(first.reclaimedChars)
  })

  it('stops reporting a change once the marker is already in place', () => {
    const view = new CacheColdView()
    view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, messages: history })
    const shrunk = view.apply('s1', history)
    const again = view.apply('s1', shrunk.messages)
    expect(again.changed).toBe(false)
    expect(again.reclaimedChars).toBe(0)
    expect(again.messages).toEqual(shrunk.messages)
  })

  it('keeps sessions independent and forgets on request', () => {
    const view = new CacheColdView()
    view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, messages: history })
    expect(view.shrunk('s1')).toBe(true)
    expect(view.shrunk('s2')).toBe(false)
    expect(view.apply('s2', history).messages).toBe(history)
    view.forget('s1')
    expect(view.shrunk('s1')).toBe(false)
    view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, messages: history })
    view.clear()
    expect(view.shrunk('s1')).toBe(false)
  })
})

describe('the view transform', () => {
  const call = (id: string, name: string): MessageLike => ({ role: 'assistant', content: [{ type: 'tool-call', id, name }] })
  const result = (callId: string, text: string): MessageLike => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] })

  it('clears all but the newest eligible results and leaves the rest by reference', () => {
    const history = [
      call('c1', 'read'), result('c1', 'x'.repeat(4_000)),
      call('c2', 'read'), result('c2', 'y'.repeat(100)),
      call('c3', 'read'), result('c3', 'z'.repeat(100)),
    ]
    const applied = clearOldToolResults(history, { keepRecentResults: 2 })
    expect(applied.clearedCallIds).toEqual(['c1'])
    expect(applied.keptCallIds).toEqual(['c2', 'c3'])
    // Saving is the replaced text minus the marker that replaces it, which is the
    // quantity the model actually sees shrink.
    expect(applied.reclaimedChars).toBe(4_000 - CLEARED_RESULT_MARKER.length)
    const cleared = applied.messages[1] as { content: { content: { text: string }[] }[] }
    expect(cleared.content[0]!.content[0]!.text).toBe(CLEARED_RESULT_MARKER)
    // Untouched messages must not be rebuilt, or the transform would perturb
    // bytes it has no business touching.
    expect(applied.messages[2]).toBe(history[2])
    expect(applied.messages[4]).toBe(history[4])
  })

  it('never clears a result whose tool records what changed', () => {
    // The edit result is the record of the change and the surface the model
    // byte-patches against, so it is not eligible at any size; the read beside it
    // still is, which is what proves the exclusion is by tool and not by position.
    const history = [call('e1', 'edit'), result('e1', 'p'.repeat(5_000)), call('r1', 'read'), result('r1', 'q'.repeat(10)), call('r2', 'read'), result('r2', 'q'.repeat(10))]
    const cleared = clearOldToolResults(history, { keepRecentResults: 1 }).clearedCallIds
    expect(cleared).not.toContain('e1')
    expect(cleared).toEqual(['r1'])
  })

  it('is idempotent, which is what keeps the cache break to one request', () => {
    // A shrink that differed between requests would move the break from the first
    // request to the second, which is worse than not shrinking at all.
    const history = [call('c1', 'read'), result('c1', 'x'.repeat(400)), call('c2', 'read'), result('c2', 'y'.repeat(400)), call('c3', 'read'), result('c3', 'z'.repeat(400))]
    const once = clearOldToolResults(history, { keepRecentResults: 1 })
    const twice = clearOldToolResults(once.messages, { keepRecentResults: 1 })
    expect(twice.clearedCallIds).toEqual([])
    expect(twice.reclaimedChars).toBe(0)
    expect(twice.messages).toEqual(once.messages)
  })

  it('does nothing when the eligible results fit the keep window', () => {
    const history = [call('c1', 'read'), result('c1', 'x'.repeat(10))]
    const applied = clearOldToolResults(history, { keepRecentResults: 5 })
    expect(applied.messages).toBe(history)
    expect(applied.reclaimedChars).toBe(0)
  })

  it('ignores results whose tool it cannot resolve', () => {
    // An unmatched call id is not evidence that the tool is clearable, so it is
    // left alone rather than guessed at — and it does not occupy a keep slot.
    const history = [result('orphan', 'x'.repeat(5_000)), call('c2', 'read'), result('c2', 'y'.repeat(10)), call('c3', 'read'), result('c3', 'z'.repeat(10))]
    const applied = clearOldToolResults(history, { keepRecentResults: 1 })
    expect(applied.clearedCallIds).not.toContain('orphan')
    expect(applied.clearedCallIds).toEqual(['c2'])
    expect(applied.messages[0]).toBe(history[0])
  })

  it('accepts a custom marker and a custom clearable set', () => {
    const history = [call('c1', 'grep'), result('c1', 'x'.repeat(100)), call('c2', 'grep'), result('c2', 'y'.repeat(10))]
    const applied = clearOldToolResults(history, { keepRecentResults: 1, clearableTools: ['grep'], marker: '<gone>' })
    expect(applied.clearedCallIds).toEqual(['c1'])
    expect((applied.messages[1] as { content: { content: { text: string }[] }[] }).content[0]!.content[0]!.text).toBe('<gone>')
  })
})

describe('the retrieval path', () => {
  const call = (id: string, name: string): MessageLike => ({ role: 'assistant', content: [{ type: 'tool-call', id, name }] })
  const result = (callId: string, text: string): MessageLike => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] })
  const markerText = (message: unknown): string => (message as { content: { content: { text: string }[] }[] }).content[0]!.content[0]!.text
  // The first result clears the reclaim floor; the other five fill the keep window.
  const history = [call('c1', 'read'), result('c1', 'x'.repeat(40_000)), call('c2', 'read'), result('c2', 'y'.repeat(100)), call('c3', 'read'), result('c3', 'z'.repeat(100)), call('c4', 'read'), result('c4', 'w'.repeat(100)), call('c5', 'read'), result('c5', 'v'.repeat(100)), call('c6', 'read'), result('c6', 'u'.repeat(100))]
  const shrunk = (): CacheColdView => {
    const view = new CacheColdView()
    view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, messages: history })
    return view
  }

  it('hands back exactly the results it is about to replace, with their text', () => {
    // Parking a set that differs from the cleared set would either leak a locator
    // for content that survives, or clear content with no way back.
    const view = shrunk()
    const targets = view.clearTargets('s1', history)
    expect(targets.map(target => target.callId)).toEqual(view.apply('s1', history).clearedCallIds)
    expect(targets[0]!.text).toBe('x'.repeat(40_000))
    expect(targets[0]!.tool).toBe('read')
  })

  it('offers nothing to park while the view is unshrunk', () => {
    // No replacement is happening, so touching storage would be work with no cause.
    expect(new CacheColdView().clearTargets('s1', history)).toEqual([])
  })

  it('never offers a result that survives the clear', () => {
    const view = shrunk()
    const kept = new Set(view.apply('s1', history).clearedCallIds)
    for (const target of view.clearTargets('s1', history)) expect(kept.has(target.callId)).toBe(true)
    for (const target of view.clearTargets('s1', history)) expect(target.callId).not.toBe('c6')
  })

  it('replaces a result with the marker it was parked under', () => {
    const view = shrunk()
    const locator = clearedResultMarker({ locator: '/spill/c1.txt', retrievalHint: 'grep this path' })
    view.recordMarkers('s1', new Map([['c1', locator]]))
    expect(markerText(view.apply('s1', history).messages[1])).toBe(locator)
  })

  it('stays idempotent when the marker carries a locator', () => {
    // The one property this module cannot lose: a marker variant that the second
    // pass failed to recognize would re-clear the result and move the cache break
    // from the first request to the second.
    const view = shrunk()
    view.recordMarkers('s1', new Map([['c1', clearedResultMarker({ locator: '/spill/c1.txt', retrievalHint: 'grep this path' })]]))
    const once = view.apply('s1', history)
    const twice = view.apply('s1', once.messages)
    expect(twice.changed).toBe(false)
    expect(twice.reclaimedChars).toBe(0)
    expect(twice.messages).toEqual(once.messages)
  })

  it('counts the saving against the marker that actually replaced the text', () => {
    // A locator marker is longer than the plain one, so it saves less. Reusing the
    // plain marker's length here would overstate the reclaim the model will see.
    const plain = new CacheColdView()
    plain.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR, messages: history })
    const plainSaved = plain.apply('s1', history).reclaimedChars
    const located = shrunk()
    const locator = clearedResultMarker({ locator: '/spill/c1.txt', retrievalHint: 'grep this path' })
    located.recordMarkers('s1', new Map([['c1', locator]]))
    expect(located.apply('s1', history).reclaimedChars).toBe(40_000 - locator.length)
    expect(located.apply('s1', history).reclaimedChars).toBeLessThan(plainSaved)
  })

  it('remembers a marker only for the session that recorded it', () => {
    // A parked result belongs to one conversation; a locator must never be reused
    // for another session's identical-looking call id.
    const view = shrunk()
    expect(view.hasMarker('s1', 'c1')).toBe(false)
    view.recordMarkers('s1', new Map([['c1', clearedResultMarker({ locator: '/spill/c1.txt', retrievalHint: 'grep' })]]))
    expect(view.hasMarker('s1', 'c1')).toBe(true)
    expect(view.hasMarker('s1', 'c2')).toBe(false)
    expect(view.hasMarker('s2', 'c1')).toBe(false)
  })

  it('ignores a recorded marker for a session whose view is not shrunk', () => {
    const view = new CacheColdView()
    view.recordMarkers('s1', new Map([['c1', 'anything']]))
    expect(view.hasMarker('s1', 'c1')).toBe(false)
  })

  it('keeps markers across a second firing of the plan', () => {
    // The cooldown lets a plan fire again, and results already parked must not be
    // parked a second time under a second locator.
    const view = shrunk()
    view.recordMarkers('s1', new Map([['c1', clearedResultMarker({ locator: '/spill/c1.txt', retrievalHint: 'grep' })]]))
    const later = [...history, call('c7', 'read'), result('c7', 'q'.repeat(100)), call('c8', 'read'), result('c8', 'r'.repeat(100)), call('c9', 'read'), result('c9', 's'.repeat(100))]
    expect(view.plan('s1', { lastAssistantAt: 1_000, now: 1_000 + HOUR * 2, messages: later }).fire).toBe(true)
    expect(view.hasMarker('s1', 'c1')).toBe(true)
    expect(markerText(view.apply('s1', later).messages[1])).toBe(clearedResultMarker({ locator: '/spill/c1.txt', retrievalHint: 'grep' }))
  })
})
