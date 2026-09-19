import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CLEARED_RESULT_PREFIX, clearedResultMarker } from '../src/cache-cold.ts'
import { spillClearedResults, type SpillWriter } from '../src/result-spill.ts'

const SESSION = 'session-1' as SessionId

/** A spill backend that records what it was asked to save, and can be told to fail. */
const backend = (failFor: readonly string[] = []): { readonly store: SpillWriter; readonly saved: { readonly kind: string; readonly toolName: string; readonly callId: string; readonly content: string; readonly suggestedName: string; readonly sessionId: string }[] } => {
  const saved: { kind: string; toolName: string; callId: string; content: string; suggestedName: string; sessionId: string }[] = []
  const store: SpillWriter = {
    async saveText(input) {
      if (failFor.includes(input.source.callId)) throw new Error('disk full')
      saved.push({
        kind: input.source.kind,
        toolName: input.source.toolName,
        callId: input.source.callId,
        content: input.content,
        suggestedName: input.suggestedName,
        sessionId: input.owner.sessionId,
      })
      return { locator: `/spill/${input.source.callId}.txt`, bytes: input.content.length, retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  }
  return { store, saved }
}

describe('parking a cleared result', () => {
  it('returns a marker that leads to the artifact instead of a dead end', async () => {
    // This is the whole reason the module exists: the cleared marker used to say the
    // content was "not recoverable from this view", which left re-running the tool
    // as the only way back — spending the tokens the clear had just saved.
    const { store } = backend()
    const markers = await spillClearedResults(store, SESSION, [{ callId: 'c1', tool: 'read', text: 'file body' }])
    const marker = markers.get('c1')
    expect(marker).toBeDefined()
    expect(marker).toContain('/spill/c1.txt')
    expect(marker).toContain('grep this path')
    expect(marker).not.toContain('not recoverable')
  })

  it('keeps the shared prefix so the transform still recognizes it as cleared', () => {
    // A locator marker that did not start with the prefix would not be seen as
    // cleared on the next request, and the transform would re-clear the result —
    // moving the cache break from the first request to the second.
    expect(clearedResultMarker({ locator: '/x', retrievalHint: 'read it' })).toMatch(/^\[Old tool result content cleared to reclaim context;/)
    expect(clearedResultMarker({ locator: '/x', retrievalHint: 'read it' }).startsWith(CLEARED_RESULT_PREFIX)).toBe(true)
  })

  it('sends the backend the source it records, under the owning session', async () => {
    // `kind` is the discriminator Harness 0.1.6 added when `SpillSource` became a
    // union; sending the old undiscriminated source still satisfies today's local
    // backend, which reads none of it, so only an assertion can hold the contract.
    const { store, saved } = backend()
    await spillClearedResults(store, SESSION, [{ callId: 'c7', tool: 'shell', text: 'stdout' }])
    expect(saved).toEqual([{ kind: 'tool', toolName: 'shell', callId: 'c7', content: 'stdout', suggestedName: 'shell-result.txt', sessionId: 'session-1' }])
  })

  it('parks what it can when one artifact cannot be written', async () => {
    // A per-result map rather than a boolean: one unwritable artifact must not cost
    // the locators of the results that did get saved.
    const { store, saved } = backend(['c2'])
    const markers = await spillClearedResults(store, SESSION, [
      { callId: 'c1', tool: 'read', text: 'one' },
      { callId: 'c2', tool: 'read', text: 'two' },
      { callId: 'c3', tool: 'read', text: 'three' },
    ])
    expect([...markers.keys()]).toEqual(['c1', 'c3'])
    expect(saved.map(entry => entry.callId)).toEqual(['c1', 'c3'])
  })

  it('reports a failure without letting the report abandon the rest', async () => {
    const { store } = backend(['c1'])
    const failures: string[] = []
    const markers = await spillClearedResults(
      store,
      SESSION,
      [{ callId: 'c1', tool: 'read', text: 'one' }, { callId: 'c2', tool: 'read', text: 'two' }],
      (target) => {
        failures.push(target.callId)
        throw new Error('the reporter itself is broken')
      },
    )
    expect(failures).toEqual(['c1'])
    // c2 is still parked even though the reporter threw while handling c1.
    expect([...markers.keys()]).toEqual(['c2'])
  })

  it('does not point at an empty artifact', async () => {
    // A locator for whitespace is a longer marker that helps no one, so the plain
    // marker is the better outcome and the caller falls back to it.
    const { store, saved } = backend()
    const markers = await spillClearedResults(store, SESSION, [{ callId: 'c1', tool: 'read', text: '   \n  ' }])
    expect(markers.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('does nothing when the composition mounted no spill backend', async () => {
    // Clearing must still happen in a deployment without a spill backend: the
    // fallback is the plain marker, which is what it got before.
    const markers = await spillClearedResults(undefined, SESSION, [{ callId: 'c1', tool: 'read', text: 'body' }])
    expect(markers.size).toBe(0)
  })
})
