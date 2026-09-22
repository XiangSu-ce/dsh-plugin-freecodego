/**
 * Two rules the log path used to get wrong, and the shape of each.
 *
 * 1. `content-detector.ts` hardens its search test on purpose — a clock/date
 *    prefix means "log line, and the log compressor extracts far more from it",
 *    and `=`/`<`/`>` prefixes are rejected as fragments. `runtime.ts` then routed
 *    on a *second* predicate, `looksLikeSearchOutput`, which re-derived the shape
 *    from `parseMatchLine` — the extractor's permissive matcher, whose `:digits`
 *    regex has none of those exclusions. Every timestamped log parsed as
 *    `file:line` under it, so the search branch (which sits before the log branch)
 *    claimed them: the payload was summarised by a compressor built for grep
 *    output, `logCompressions` stayed at zero, and fatal lines inside the searched
 *    group budgets were dropped from the model's context.
 *
 * 2. The log branch gated adoption on `cacheKey !== undefined`, the only branch in
 *    the chain that did not ask its compressor's own `applied` signal. `cacheKey`
 *    says whether CCR engaged, and LogCompressor engaged it only under a ratio
 *    threshold of its own (0.5) — so every real saving between that and the
 *    global accept gate was discarded in full while the panel credited nothing.
 *
 * 3. The same two gates also disagreed in the other direction, which no test
 *    looked at because the one written for the band above asserted only that the
 *    error lines survived: a rendering whose ratio landed in (0.5, 0.85] was
 *    *adopted* and delivered carrying `[N lines omitted]`, with no `hash=` to
 *    retrieve them and no original in CCR — the compressor's own "lossy on the
 *    wire, lossless end-to-end" contract broken in the one strip no gate owned.
 *    The compressor now stashes and marks whenever the rendering differs from its
 *    input, which is the predicate the runtime's accept gate already read.
 */

import { describe, expect, it } from 'vitest'
import { CcrStore } from '../src/headroom/ccr.ts'
import { detectContentType } from '../src/headroom/content-detector.ts'
import { LogCompressor } from '../src/headroom/log-compressor.ts'
import { FreeCodeGoHeadroomRuntime, type HeadroomSettings } from '../src/headroom/runtime.ts'
import { looksLikeSearchOutput } from '../src/headroom/search-compressor.ts'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** The `tools/post-execute` seam, with just what the runtime touches. */
function harness(settings: HeadroomSettings): {
  readonly runtime: FreeCodeGoHeadroomRuntime
  readonly run: (name: string, text: string, args?: Readonly<Record<string, unknown>>) => Promise<{ readonly kind: string; readonly content?: readonly { readonly text: string }[] }>
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
    run: async (name, text, args) => {
      const listener = listeners.get('tools/post-execute')
      if (listener === undefined) throw new Error('runtime did not attach the post-execute seam')
      return await listener({ name, arguments: args ?? {} } as never, { content: [{ type: 'text', text }] } as never, async () => ({ kind: 'next' })) as never
    },
  }
}

const settings: HeadroomSettings = { headroomEnabled: true, headroomThresholdChars: 1_200 }

/** Timestamped application log: thin INFO lines, then fat canary-bearing errors with stack frames. */
function timestampedLog(): { readonly text: string; readonly canaries: readonly string[] } {
  const lines: string[] = []
  const canaries: string[] = []
  for (let i = 0; i < 60; i += 1) {
    lines.push(`2026-09-19T09:${String(i % 60).padStart(2, '0')}:01.000Z INFO worker[${i}] request id=req-${i} handled in ${i % 90}ms`)
  }
  for (let e = 0; e < 4; e += 1) {
    const canary = `FATAL_CANARY_${e}`
    canaries.push(canary)
    lines.push(`2026-09-19T09:3${e}:02.000Z ERROR handler[${e}] upstream refused after retrying class=TimeoutException detail=${canary} endpoint=/api/v${e}/items/${e}`)
    for (let frame = 1; frame <= 6; frame += 1) lines.push(`    at com.example.service.Worker${e}.run(Worker${e}.java:${40 + frame})`)
  }
  return { text: lines.join('\n'), canaries }
}

/** Genuine grep output — the shape the search branch must keep claiming. */
const grepOutput = Array.from({ length: 6 }, (_v, f) =>
  Array.from({ length: 10 }, (_w, i) => `src/module${f}/handler.ts:${100 + i}:export const value${f}_${i} = ${i}`),
).flat().join('\n')

const log = timestampedLog()

/** The same lines as a terminal would paint them: SGR colour on every row. */
const colour = (text: string, code: number): string => text.split('\n').map(line => `\u001b[${code}m${line}\u001b[0m`).join('\n')

describe('headroom log routing', () => {
  it('a timestamped log is not claimed by the search detector', () => {
    // The detector's own verdict is the authority, and the exported predicate has
    // to agree with it: a log misread as search is routed to a compressor whose
    // assumptions (per-file grouping, match budgets) do not hold for log lines.
    expect(detectContentType(log.text).contentType).toBe('log')
    expect(looksLikeSearchOutput(log.text)).toBe(false)
  })

  it('still recognises real grep output', () => {
    // Control for the hardening: the exclusions (clock prefixes, `=`/`<`/`>`
    // fragments) must not touch the `path:line:content` shape the branch exists for.
    expect(detectContentType(grepOutput).contentType).toBe('search')
    expect(looksLikeSearchOutput(grepOutput)).toBe(true)
  })

  it('colour does not flip a log into the search compressor', async () => {
    // The guard this file is about is "a line that *starts* with a clock or a date
    // is a log line", and a coloured line starts with `\x1b[32m` — so the escapes
    // have to be read as decoration. Two predicates decide this payload's route and
    // both read raw lines, so each normalises its own input: the detector at its
    // entry point and `looksLikeSearchOutput` before its proportion test. Measured
    // before either did: the coloured log below was typed `search` at confidence
    // 1.0, the predicate said true, and the search branch claimed a payload whose
    // `path:line:` reading was `\x1b[32m2026-09-19T09` — the same misrouting as the
    // cases above, arriving through a spelling none of them carried.
    const coloured = colour(log.text, 32)
    expect(detectContentType(coloured).contentType).toBe('log')
    // Control, so this is a rule about colour and not "ANSI suppresses search":
    // genuine grep output stays search output when it is coloured, because the
    // escapes were never what distinguishes the two shapes.
    const colouredGrep = colour(grepOutput, 35)
    expect(detectContentType(colouredGrep).contentType).toBe('search')
    expect(looksLikeSearchOutput(colouredGrep)).toBe(true)
    // And the route the model sees on that fixture: the log compressor answers,
    // with every fatal line, and the search branch is never reached.
    const h = harness(settings)
    const result = await h.run('bash', coloured, { command: 'cat /var/log/app.log' })
    expect(result.kind).toBe('accept')
    const delivered = result.content?.[0]?.text ?? ''
    const status = h.runtime.status()
    expect(status.logCompressions).toBe(1)
    expect(status.searchCompressions).toBe(0)
    for (const canary of log.canaries) expect(delivered).toContain(canary)
  })

  it('colour does not make a log stream satisfy the search proportion either', async () => {
    // The second predicate, and it needs a fixture without stack frames to show:
    // `looksLikeSearchOutput` asks whether ≥0.8 of the non-empty lines look like
    // `path:line:`, and a plain stream of coloured log records satisfies that
    // reading while the frames above dilute it below the threshold either way. So
    // this is the same payload family the runtime's search branch is dangerous for
    // — every line a match, none of them a match.
    const stream: string[] = []
    for (let i = 0; i < 40; i += 1) stream.push(`2026-09-20T10:${String(i % 60).padStart(2, '0')}:01.000Z INFO worker[${i}] request id=req-${i} handled in ${i % 90}ms`)
    for (let e = 0; e < 4; e += 1) stream.push(`2026-09-20T10:3${e}:02.000Z ERROR handler[${e}] upstream refused after retrying detail=FATAL_CANARY_${e} endpoint=/api/v${e}/items/${e}`)
    const plain = stream.join('\n')
    const coloured = colour(plain, 32)
    expect(detectContentType(plain).contentType).toBe('log')
    expect(detectContentType(coloured).contentType).toBe('log')
    expect(looksLikeSearchOutput(plain)).toBe(false)
    expect(looksLikeSearchOutput(coloured)).toBe(false)
    // Through the seam: the search branch stays out, so the payload the model gets
    // is the log fold's (the compressor refuses this one — the case below) and its
    // fatal lines are present verbatim rather than selected by a grep budget.
    const h = harness(settings)
    const result = await h.run('bash', coloured, { command: 'cat /var/log/app.log' })
    expect(result.kind).toBe('accept')
    const delivered = result.content?.[0]?.text ?? ''
    const status = h.runtime.status()
    expect(status.searchCompressions).toBe(0)
    expect(status.losslessCompressions).toBe(1)
    expect(delivered).not.toContain('\u001b[')
    for (let e = 0; e < 4; e += 1) expect(delivered).toContain(`FATAL_CANARY_${e}`)
  })

  it('routes a timestamped log through the log compressor and keeps every fatal line', async () => {
    const h = harness(settings)
    const result = await h.run('bash', log.text, { command: 'cat /var/log/app.log' })
    expect(result.kind).toBe('accept')
    const delivered = result.content?.[0]?.text ?? ''
    expect(bytes(delivered)).toBeLessThan(bytes(log.text))
    const status = h.runtime.status()
    expect(status.logCompressions).toBe(1)
    // The attribution is not cosmetic: it is how the panel reports which strategy
    // answered, and the search branch used to take this payload every time.
    expect(status.searchCompressions).toBe(0)
    for (const canary of log.canaries) expect(delivered).toContain(canary)
  })

  it('keeps a log whose savings land between the CCR threshold and the accept gate', async () => {
    // Fat error lines with thin INFO lines around them: the selector keeps the
    // errors plus context, which is a small fraction of the LINES but roughly half
    // the BYTES — the band where the compressor saves real context yet needs no CCR.
    const lines: string[] = []
    for (let i = 0; i < 60; i += 1) lines.push(`2026-09-19T09:${String(i % 60).padStart(2, '0')}:01.000Z INFO worker[${i}] task ${'x'.repeat(40)} id=${i}`)
    for (let e = 0; e < 8; e += 1) lines.push(`2026-09-19T09:5${e}:02.000Z ERROR handler[${e}] ${'e'.repeat(600)} FATAL_CANARY_${e}`)
    const text = lines.join('\n')

    const store = new CcrStore()
    const alone = new LogCompressor().compress(text, 1.0, store)
    // The fixture still sits in the band the old gate lost: a real saving, and one
    // above the ratio threshold that used to decide whether the original was kept
    // at all. (That threshold is gone; this assertion keeps the fixture honest.)
    const ratio = bytes(alone.compressed) / bytes(text)
    expect(ratio).toBeGreaterThan(0.5)
    expect(alone.compressed).not.toBe(text)
    // The band no longer decides retrievability. This rendering says it dropped
    // lines, so it has to name where they went — before the fix it delivered
    // `[58 lines omitted: 8 ERROR, 60 INFO]` with no `hash=` and nothing in CCR,
    // i.e. the model was told about an omission it had no way to resolve.
    expect(alone.compressed).toContain('lines omitted')
    expect(alone.cacheKey).toBeDefined()
    expect(alone.compressed).toContain(`hash=${alone.cacheKey}`)
    expect(store.get(alone.cacheKey!)).toBe(text)

    const h = harness(settings)
    const result = await h.run('bash', text, { command: 'cat /var/log/app.log' })
    expect(result.kind).toBe('accept')
    const delivered = result.content?.[0]?.text ?? ''
    // It reached the model, and it is the compressor's rendering — not a re-render,
    // not the original: the marker line is appended by the compressor itself.
    expect(delivered).toBe(alone.compressed)
    expect(bytes(delivered)).toBeLessThan(bytes(text))
    expect(h.runtime.status().logCompressions).toBe(1)
    expect(h.runtime.status().compressions).toBe(1)
    for (let e = 0; e < 8; e += 1) expect(delivered).toContain(`FATAL_CANARY_${e}`)
  })

  it('still refuses a log the compressor leaves untouched', async () => {
    // Below `minLinesForCcr` the compressor returns its input verbatim, so adoption
    // would replace the text with itself and credit a compression that never
    // happened. This is the half the old gate got right by accident.
    const lines = Array.from({ length: 40 }, (_v, i) => `2026-09-19T10:${String(i % 60).padStart(2, '0')}:01.000Z INFO worker[${i}] request id=req-${i} handled in ${i % 90}ms path=/api/items/${i}`)
    const text = lines.join('\n')
    expect(detectContentType(text).contentType).toBe('log')
    const alone = new LogCompressor().compress(text, 1.0, new CcrStore())
    expect(alone.compressed).toBe(text)

    const h = harness(settings)
    const result = await h.run('bash', text, { command: 'cat /var/log/app.log' })
    expect(result.kind).toBe('next')
    expect(h.runtime.status().compressions).toBe(0)
  })
})
