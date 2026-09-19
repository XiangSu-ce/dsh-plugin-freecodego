/**
 * The reader that decides which bytes of a wrapped payload are "the JSON body".
 *
 * `json-span.ts` exists because the detector and the crusher disagreed about the
 * same payload — "the work is done and thrown away, and the routing looks
 * nondeterministic". They had been unified on the *span* rules, but the detector's
 * wrapped path still took the payload's FIRST bracket, so a bracketed word in a
 * wrapper line decided the answer for everything:
 *
 *   `warning: [deprecated] use --new-flag instead\n{ 120-row array }`
 *
 * `[deprecated]` is balanced, so it looks like a container; it does not parse, so
 * the detector gave up on the payload. The warning line matches the log patterns,
 * so the payload was reported as `log`, the JSON branch (the only stage that
 * handles a body behind a wrapper) was never asked, and the model received all
 * 8398 bytes verbatim while a ready 50% rendering existed. The same status word
 * at the END of the payload cost nothing, which is what made this a shape bug
 * rather than a compression-quality judgement.
 */

import { describe, expect, it } from 'vitest'
import { detectContentType } from '../src/headroom/content-detector.ts'
import { findBulkJsonSpan, findJsonSpan } from '../src/headroom/json-span.ts'
import { FreeCodeGoHeadroomRuntime, type HeadroomSettings } from '../src/headroom/runtime.ts'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

const body = JSON.stringify(Array.from({ length: 120 }, (_v, i) => ({ id: i, name: `entity-${i}`, status: i % 9 === 0 ? 'error' : 'ok', note: `row ${i} processed` })))

/** Wrapper lines whose bracketed word is a balanced span that is not JSON. */
const wrappers = [
  'warning: [deprecated] use --new-flag instead',
  '[WARN] config fallback in use',
  'note: retrying {1} of 3 attempts',
]

/** The `tools/post-execute` seam, with just what the runtime touches. */
function harness(settings: HeadroomSettings): {
  readonly runtime: FreeCodeGoHeadroomRuntime
  readonly run: (name: string, text: string) => Promise<{ readonly kind: string; readonly content?: readonly { readonly text: string }[] }>
} {
  const listeners = new Map<string, (exec: never, result: never, next: () => Promise<unknown>) => Promise<unknown>>()
  const ctx = {
    effect: (callback: () => unknown) => { callback() },
    on: (event: string, handler: unknown) => { listeners.set(event, handler as never); return () => undefined },
    get: () => undefined,
  }
  const runtime = new FreeCodeGoHeadroomRuntime(ctx as never, { get: () => settings })
  runtime.start()
  return {
    runtime,
    run: async (name, text) => {
      const listener = listeners.get('tools/post-execute')
      if (listener === undefined) throw new Error('runtime did not attach the post-execute seam')
      return await listener({ name, arguments: {} } as never, { content: [{ type: 'text', text }] } as never, async () => ({ kind: 'next' })) as never
    },
  }
}

describe('headroom bulk JSON span', () => {
  it('finds the body behind a bracketed wrapper word, and reports its exact bytes', () => {
    for (const wrapper of wrappers) {
      const text = `${wrapper}\n${body}`
      const found = findBulkJsonSpan(text)
      expect(found).toBeDefined()
      // The span must be the body itself: the crusher splices `text.slice(0, a)`
      // back in front of its rendering, so an off-by-one here would eat a byte of
      // the wrapper line.
      expect(text.slice(found!.span[0], found!.span[1])).toBe(body)
      expect(found!.value).toEqual(JSON.parse(body))
      // ...and the span the old code would have taken really is a different one.
      const naive = findJsonSpan(text)
      expect(naive![0]).toBeLessThan(found!.span[0])
      expect(() => JSON.parse(text.slice(naive![0], naive![1]))).toThrow()
    }
  })

  it('keeps the fraction rule and declines a body that is not the bulk', () => {
    expect(findBulkJsonSpan('[WARN] config fallback in use\n{"a":1}')).toBeUndefined()
    expect(findBulkJsonSpan('[WARN] nothing but prose in this payload at all')).toBeUndefined()
  })

  it('still reads an ordinary harness wrapper', () => {
    const text = `Exit code: 1\n${body}`
    expect(findBulkJsonSpan(text)?.value).toEqual(JSON.parse(body))
  })

  it('declines when the first bracket never balances (documented boundary)', () => {
    // Chasing later brackets after an unbalanced one would re-scan the tail per
    // candidate; the callers can read such a payload another way, so the scan
    // stops at the first span it cannot balance.
    expect(findBulkJsonSpan(`[unclosed wrapper\n${body}`)).toBeUndefined()
  })

  it('routes the wrapped payload as json and keeps the wrapper line verbatim', async () => {
    for (const wrapper of wrappers) {
      const text = `${wrapper}\n${body}`
      expect(detectContentType(text).contentType).toBe('json')

      const h = harness({ headroomEnabled: true, headroomThresholdChars: 1_200 })
      const result = await h.run('bash', text)
      expect(result.kind).toBe('accept')
      const delivered = result.content?.[0]?.text ?? ''
      // Nothing is traded away for the saving: the wrapper line is byte-for-byte
      // what the tool printed, and the body still carries its first and last rows.
      expect(delivered.startsWith(wrapper)).toBe(true)
      expect(delivered).toContain('entity-119')
      expect(bytes(delivered)).toBeLessThan(bytes(text) * 0.6)
      const status = h.runtime.status()
      expect(status.jsonCompressions).toBe(1)
      expect(status.logCompressions).toBe(0)
    }
  })

  it('leaves the controls where they were', () => {
    // A bracket AFTER the body never disturbed the span search; a plain body and
    // an `Exit code:` wrapper are the shapes the branch was built for.
    expect(findBulkJsonSpan(body)?.span[0]).toBe(0)
    expect(detectContentType(body).contentType).toBe('json')
    expect(detectContentType(`Exit code: 1\n${body}`).contentType).toBe('json')
    expect(detectContentType(`${body}\nwarning: [deprecated] flag`).contentType).toBe('json')
  })
})
