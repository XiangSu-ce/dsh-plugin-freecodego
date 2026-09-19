import { describe, expect, it } from 'vitest'
import { CcrStore, computeKey } from '../src/headroom/ccr.ts'
import { SMART_CRUSHER_DEFAULTS, analyzeCrushability, lossySampleArray } from '../src/headroom/smart-crusher.ts'
import { detectContentType } from '../src/headroom/content-detector.ts'
import { compactLossless, pathHeading, pathUnheading, searchDirHeading, searchDirUnheading, searchHeading, searchUnheading } from '../src/headroom/lossless-compaction.ts'
import { contextWords, scoreBatch } from '../src/headroom/relevance.ts'
import { CrossTurnDedup } from '../src/headroom/cross-turn-dedup.ts'
import { compressTabular, detectTabular } from '../src/headroom/tabular-ingest.ts'
import { compressConfig } from '../src/headroom/config-compressor.ts'
import { compressHtml } from '../src/headroom/html-extractor.ts'
import { DIFF_COMPRESSOR_DEFAULTS, compressDiff } from '../src/headroom/diff-compressor.ts'
import { isMixedContent, splitIntoSections } from '../src/headroom/mixed-content.ts'
import { protectTags, restoreTags } from '../src/headroom/tag-protector.ts'
import { routeEffort, steeringText } from '../src/headroom/output-shaper.ts'
import { FreeCodeGoHeadroomRuntime, type HeadroomSettings } from '../src/headroom/runtime.ts'

describe('headroom content detector', () => {
  it('claims parse-confirmed JSON including wrapped payloads', () => {
    expect(detectContentType('{"a":1}').contentType).toBe('json')
    // A small structural wrapper around a JSON body still claims (≥60% bulk).
    expect(detectContentType('ok\n{"results":[1,2,3],"items":[4,5,6],"meta":[7,8,9]}').contentType).toBe('json')
    expect(detectContentType('{"title":1} {"title":2}').contentType).toBe('json')
  })

  it('classifies grep output, logs, and diffs by shape', () => {
    const grep = Array.from({ length: 12 }, (_, i) => `src/app/file${i}.ts:${i + 1}:export const x${i} = ${i}`).join('\n')
    expect(detectContentType(grep).contentType).toBe('search')
    const log = Array.from({ length: 20 }, (_, i) => `2026-09-09 10:00:${String(i % 60).padStart(2, '0')} INFO ok ${i}`).join('\n')
    expect(detectContentType(log).contentType).toBe('log')
    expect(detectContentType('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context').contentType).toBe('diff')
  })

  it('classifies dense source code as code, not mixed noise', () => {
    const python = Array.from({ length: 30 }, (_, i) => `def handler_${i}(input):\n    return {"key": ${i}}`).join('\n')
    expect(detectContentType(python).contentType).toBe('code')
  })

  it('routes timestamped log lines to log, not search', () => {
    // Regression: `09:57:00` satisfies `^[^\s:]+:\d+:` — the same shape as
    // `path:line:`. A clock or ISO prefix is a log line, and the log compressor
    // extracts far more from it than the search fold would.
    const clocked = Array.from({ length: 20 }, (_, i) => `09:57:${String(i).padStart(2, '0')} [INFO] tick`).join('\n')
    expect(detectContentType(clocked).contentType).toBe('log')
    const isoTs = Array.from({ length: 20 }, (_, i) => `2024-01-01T09:57:${String(i).padStart(2, '0')}Z [ERROR] boom`).join('\n')
    expect(detectContentType(isoTs).contentType).toBe('log')
    // The guard must not swallow genuine grep output.
    const grep = Array.from({ length: 20 }, (_, i) => `src/m${i}.ts:${10 + i}: const v = f()`).join('\n')
    expect(detectContentType(grep).contentType).toBe('search')
  })
})

describe('headroom lossless compaction folds', () => {
  it('round-trips search file-heading exactly', () => {
    const text = ['src/a.ts:1:alpha', 'src/a.ts:2:beta', 'src/a.ts:3:gamma', 'other.txt:9:delta'].join('\n')
    const folded = searchHeading(text)
    expect(folded.length).toBeLessThan(text.length)
    expect(searchUnheading(folded)).toBe(text)
    expect(compactLossless(text, 'search').applied).toBe(true)
  })

  it('round-trips search directory-heading for grep -rn output', () => {
    const text = ['src/a.ts:1:one', 'src/b.ts:5:two', 'lib/c.ts:2:three'].join('\n')
    const folded = searchDirHeading(text)
    expect(folded).toContain('src/')
    expect(searchDirUnheading(folded)).toBe(text)
  })

  it('round-trips path-listing heading for find/ls output', () => {
    const text = ['src/app/main.ts', 'src/app/util.ts', 'src/core/index.ts'].join('\n')
    const folded = pathHeading(text)
    expect(folded).toContain('src/app/')
    expect(pathUnheading(folded)).toBe(text)
    expect(compactLossless(text, 'paths').applied).toBe(true)
  })

  it('folds log runs reversibly and strips ANSI first', () => {
    const ansi = '[31mERROR boom happened[0m with the worker'
    const text = Array.from({ length: 10 }, () => ansi).join('\n')
    const result = compactLossless(text, 'log')
    expect(result.applied).toBe(true)
    expect(result.output).toContain('repeated 10 times')
    expect(result.output).not.toContain('[')
  })

  it('declines a fold when nothing repeats', () => {
    expect(compactLossless('single unique line only', 'log').applied).toBe(false)
  })

  it('folds repeated config stanzas reversibly, not just single-line runs', () => {
    // Regression: the config branch used to compute each marker's "distance back"
    // in folded coordinates while the inverse consumes unfolded coordinates, so
    // every fold after the first mis-targeted its span and the round-trip guard
    // rejected the whole candidate. A stanza repeated three times needs two folds.
    const stanza = ['name = "worker"', 'mode = "batch"', 'retry = 3']
    const text = [...stanza, ...stanza, ...stanza].join('\n')
    const result = compactLossless(text, 'config')
    expect(result.applied).toBe(true)
    expect(result.output.match(/lines back\)/gu) ?? []).toHaveLength(2)
    expect(result.output.length).toBeLessThan(text.length)
  })

  it('folds a repeated single-line run in config too', () => {
    const text = Array.from({ length: 20 }, () => 'enable = true').join('\n')
    const result = compactLossless(text, 'config')
    expect(result.applied).toBe(true)
    expect(result.output).toContain('repeated 20 times')
  })
})

describe('headroom BM25 relevance', () => {
  it('scores query-matching records above non-matching ones', () => {
    const query = 'payment webhook timeout'
    const records = [
      'payment webhook timed out after 30s',
      'the weather is nice today',
      'webhook handler for billing events',
      'random noise content here',
    ]
    const scores = scoreBatch(records, query)
    expect(scores[0]!.score).toBeGreaterThan(scores[1]!.score)
    expect(scores[2]!.score).toBeGreaterThan(scores[3]!.score)
  })

  it('pins UUID matches with the long-token bonus', () => {
    const scores = scoreBatch(['request id 550e8400-e29b-41d4-a716-446655440000 failed', 'nothing relevant anywhere'], '550e8400-e29b-41d4-a716-446655440000')
    expect(scores[0]!.score).toBeGreaterThanOrEqual(0.3)
    expect(scores[1]!.score).toBe(0)
  })

  it('extracts context words for the search compressor', () => {
    const words = contextWords('rg payment_webhook_timeout src/payments')
    expect(words).toContain('payment_webhook_timeout')
    expect(words).toContain('payments')
  })
})

describe('headroom cross-turn dedup fold', () => {
  it('folds a repeated run against a remembered earlier output', () => {
    const dedup = new CrossTurnDedup()
    const original = ['function computeTotal(items) {', '  const total = items.reduce((sum, item) => sum + item.price, 0);', '  return total * 1.2;', '}', 'export { computeTotal }'].join('\n')
    dedup.remember(original)
    const later = ['Some preamble line about the file.', ...original.split('\n'), 'Trailing commentary.'].join('\n')
    const folded = dedup.fold(later)
    expect(folded.applied).toBe(true)
    expect(folded.output).toContain('same as earlier tool result')
    expect(folded.output.length).toBeLessThan(later.length)
  })

  it('never folds the first sighting', () => {
    const dedup = new CrossTurnDedup()
    const text = ['line one of output', 'line two of output', 'line three of output'].join('\n')
    expect(dedup.fold(text).applied).toBe(false)
    dedup.remember(text)
  })

  it('declines a fold that would grow the text', () => {
    // The pointer line carries a ~60-byte prefix and a quoted anchor, so folding
    // three short lines costs more than it saves. `applied` is what both callers
    // read as "use this instead of the original", so it may not mean "a run
    // matched" when the run was tiny.
    const dedup = new CrossTurnDedup()
    const text = ['aaaa', 'bbbb', 'cccc'].join('\n')
    dedup.remember(text)
    const folded = dedup.fold(text)
    expect(folded.applied).toBe(false)
    expect(folded.output).toBe(text)
  })
})

describe('headroom cross-turn dedup reaches the model', () => {
  /** The `tools/post-execute` seam, with just what the runtime touches. */
  function harness(settings: HeadroomSettings): {
    readonly runtime: FreeCodeGoHeadroomRuntime
    readonly run: (name: string, text: string, args?: Readonly<Record<string, unknown>>) => Promise<{ readonly kind: string; readonly content?: readonly { readonly text: string }[] } | undefined>
    /** The same seam for a result that carries more than one text block. */
    readonly runBlocks: (name: string, blocks: readonly string[], args?: Readonly<Record<string, unknown>>) => Promise<{ readonly kind: string; readonly content?: readonly { readonly text: string }[] } | undefined>
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
        if (listener === undefined) return undefined
        // `arguments` is passed through because the shell branch reads
        // `exec.arguments.command`. A harness that omits it makes every shell look
        // like it ran an empty command, which is exactly why `BASH_TOOL_NAMES` had
        // no coverage on that branch: any case written against this seam agreed with
        // whatever the set said.
        return await listener({ name, arguments: args ?? {} } as never, { content: [{ type: 'text', text }] } as never, async () => ({ kind: 'next' })) as never
      },
      runBlocks: async (name, blocks, args) => {
        const listener = listeners.get('tools/post-execute')
        if (listener === undefined) return undefined
        return await listener({ name, arguments: args ?? {} } as never, { content: blocks.map(text => ({ type: 'text', text })) } as never, async () => ({ kind: 'next' })) as never
      },
    }
  }

  it('replaces a repeat with the pointer and counts that one compression', async () => {
    // Repeated source is the case the stage exists for, and it is also the case
    // no other compressor touches. The fold used to be computed and then dropped
    // (the pipeline returned undefined and the caller kept the original block)
    // while the panel credited a dedup compression that never reached anyone.
    const runtime = harness({ headroomEnabled: true, headroomThresholdChars: 1_200 })
    // Numbered source: detected as code and passed through unmangled, so the only
    // thing that can replace a repeat of it is the dedup fold.
    const body = Array.from({ length: 120 }, (_value, index) => `${index}: const value${index} = compute(${index})`).join('\n')
    const first = await runtime.run('bash', body)
    expect(first?.kind).toBe('next')
    expect(runtime.runtime.status().compressions).toBe(0)

    const second = await runtime.run('bash', body)
    expect(second?.kind).toBe('accept')
    const replacement = second?.content?.[0]?.text ?? ''
    expect(replacement).toContain('same as earlier tool result')
    expect(replacement.length).toBeLessThan(body.length)
    const status = runtime.runtime.status()
    expect(status.compressions).toBe(1)
    expect(status.dedupCompressions).toBe(1)
    expect(status.originalBytes).toBe(Buffer.byteLength(body, 'utf8'))
    expect(status.compressedBytes).toBe(Buffer.byteLength(replacement, 'utf8'))
  })

  it('never points a repeat at an earlier output the model was not given verbatim', async () => {
    // The fold's whole safety argument is that the lines it elides are still in
    // context: the pointer line carries no `hash=`, so "look at the earlier tool
    // result" is only recoverable while that result is actually there. Indexing
    // the text *before* the lossy stage ran broke that — a repeat of a crushed
    // output folded to a pointer over lines the crush had already dropped.
    const runtime = harness({ headroomEnabled: true, headroomThresholdChars: 1_200 })
    const paragraphs = Array.from({ length: 40 }, (_value, index) =>
      `Paragraph ${index} explains in detail how the deployment pipeline reassembles the artifacts after the cache miss, and then records what the operator should check before the next release window closes.`).join('\n')
    const first = await runtime.run('curl', paragraphs)
    const firstText = first?.content?.[0]?.text ?? ''
    // The premise: the first result is a summary, not the text, so its lines are
    // absent from the transcript the pointer would refer to.
    expect(first?.kind).toBe('accept')
    expect(runtime.runtime.status().proseCompressions).toBe(1)
    expect(firstText.length).toBeLessThan(paragraphs.length)

    const second = await runtime.run('curl', paragraphs)
    const secondText = second?.content?.[0]?.text ?? ''
    expect(secondText).not.toContain('same as earlier tool result')
    expect(runtime.runtime.status().dedupCompressions).toBe(0)
    // A repeat is compressed again, on its own hash — which is what makes the
    // omission recoverable — rather than collapsed into a dangling pointer.
    expect(runtime.runtime.status().proseCompressions).toBe(2)
  })

  it('leaves a multi-block result alone rather than folding every block into the first', async () => {
    // The fold is a projection of the whole result, so a result of two text
    // blocks used to come back as the fold of both in block one *plus* block two
    // verbatim: the model received the second block twice, and the saving the
    // panel recorded was measured against a projection that had grown. A
    // multi-part MCP answer is the shape that reaches this.
    const args = { command: 'rg compute' }
    const block = (file: string, from: number): string =>
      Array.from({ length: 20 }, (_value, index) => `src/${file}.ts:${from + index}:const value${from + index} = compute(${from + index})`).join('\n')
    const alpha = block('alpha', 100)
    const beta = block('beta', 900)
    const runtime = harness({ headroomEnabled: true, headroomThresholdChars: 1_200 })
    const untouched = await runtime.runBlocks('bash', [alpha, beta], args)
    expect(untouched?.kind).toBe('next')
    expect(runtime.runtime.status().losslessCompressions).toBe(0)
    // One block still folds, so this is a rule about the shape and not the
    // branch having been disabled.
    const single = harness({ headroomEnabled: true, headroomThresholdChars: 1_200 })
    const folded = await single.run('bash', alpha, args)
    expect(folded?.kind).toBe('accept')
    expect(single.runtime.status().losslessCompressions).toBe(1)
  })

  it('folds a read-only search under every shell spelling a session can arrive under', async () => {
    // This branch's floor is 200 characters and the generic stage's is
    // `MIN_COMPRESSIBLE_CHARS`, so between the two floors `BASH_TOOL_NAMES` is the
    // only gate — and which shell exists at all is decided elsewhere: the base
    // `cordis.patch.yml` disables `tool-bash` on win32 and enables `tool-pwsh`,
    // while a native Codex session's shell approvals arrive as `shell`/`exec_command`.
    // The body is sized to stay *under* the generic floor, so the shell branch is
    // what answers; a fresh runtime is used per spelling so cross-turn dedup cannot
    // stand in for the fold and make the comparison pass for the wrong reason.
    const args = { command: 'rg compute' }
    const body = Array.from({ length: 20 }, (_value, index) => `src/headroom/runtime.ts:${100 + index}:const value${index} = compute(${index})`).join('\n')
    expect(body.length).toBeGreaterThan(200)
    expect(body.length).toBeLessThan(1_200)
    const posix = await harness({ headroomEnabled: true, headroomThresholdChars: 1_200 }).run('bash', body, args)
    // Asserting the fold happened, not merely that the text got shorter: a
    // non-lossless fold also shortens, and the point of this branch is that the
    // shortening is reversible.
    expect(posix?.kind).toBe('accept')
    expect((posix?.content?.[0]?.text ?? '').length).toBeLessThan(body.length)
    // Every other spelling the branch has to reach, each asserted against `bash`
    // rather than against a literal so the claim is "these are the same fold" and
    // not "this spelling folded somehow".
    for (const spelling of ['pwsh', 'shell', 'exec_command']) {
      const other = await harness({ headroomEnabled: true, headroomThresholdChars: 1_200 }).run(spelling, body, args)
      expect(other?.kind, spelling).toBe(posix?.kind)
      expect(other?.content?.[0]?.text, spelling).toBe(posix?.content?.[0]?.text)
    }
  })
})

describe('headroom tabular, config, html routing', () => {
  it('compresses a markdown table with long field names through csv-schema', () => {
    const header = '| identifier_string    | current_status_value | assigned_owner_name |'
    const sep = '|----------------------|----------------------|---------------------|'
    const rows = Array.from({ length: 40 }, (_, i) => `| user_${i}              | active               | owner_${i % 5}       |`)
    const table = [header, sep, ...rows].join('\n')
    const detection = detectTabular(table)
    expect(detection).toBeDefined()
    const result = compressTabular(table, detection!, SMART_CRUSHER_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    // Fields are sorted by frequency then name; the declaration carries each name once.
    expect(result.output).toContain('[40]{assigned_owner_name:string,current_status_value:string,identifier_string:string}')
  })

  it('keeps the caption above a markdown table instead of discarding it', () => {
    const caption = 'Deployment summary for the release candidate run:'
    const header = '| service | status | latency |'
    const sep = '|---|---|---|'
    const rows = Array.from({ length: 40 }, (_, i) => `| service-${i} | ${i % 7 === 0 ? 'degraded' : 'ok'} | ${120 + i}ms |`)
    const table = [caption, header, sep, ...rows].join('\n')
    const detection = detectTabular(table)
    expect(detection).toMatchObject({ format: 'markdown' })
    const result = compressTabular(table, detection!, SMART_CRUSHER_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    expect(result.output.length).toBeLessThan(table.length)
    // Regression: the leading lines were filtered out of the record set and
    // never rendered, so the caption the caller sent vanished from the output.
    expect(result.output).toContain(caption)
  })

  it('reports the delimiter the ingest will actually parse the table with', () => {
    // The detector routes the payload and the ingest parses it, so both must
    // read one set of rules. They used to carry separate copies that had
    // drifted: on a tie the detector listed ';' first (announcing a semicolon
    // table) while the parser preferred ','.
    const cases = [
      // One comma and one semicolon per row: an exact tie in delimiter signal.
      ['a1,b1;c1', 'a2,b2;c2', 'a3,b3;c3'].join('\n'),
      ['name,qty,owner', 'alpha,2,sam', 'beta,7,lee'].join('\n'),
      ['name\tqty\towner', 'alpha\t2\tsam', 'beta\t7\tlee'].join('\n'),
      ['| name | qty |', '| --- | --- |', '| alpha | 2 |'].join('\n'),
    ]
    for (const content of cases) {
      const verdict = detectContentType(content)
      expect(verdict.contentType).toBe('tabular')
      const detection = detectTabular(content)
      expect(detection).toBeDefined()
      expect(detection!.format).toBe(verdict.metadata.format)
      expect(detection!.delimiter).toBe(verdict.metadata.format === 'markdown' ? '|' : verdict.metadata.delimiter)
    }
  })

  it('elides comments in safe config flavors', () => {
    const lines = ['# build configuration', '# generated by the toolchain, do not edit', '# source: repo config', 'title = "demo"']
    lines.push(...Array.from({ length: 40 }, (_, i) => `# annotation ${i} for reviewers`))
    lines.push('[server]', 'port = 8080', 'host = "localhost"')
    const toml = lines.join('\n')
    const result = compressConfig(toml, 'toml', new CcrStore())
    expect(result.applied).toBe(true)
    expect(result.output).toContain('title = "demo"')
    expect(result.output).not.toContain('annotation 4 for reviewers')
  })

  it('stashes a config original only on the path that publishes its hash', () => {
    // Elision used to stash the original before the size test, so a declined
    // call still consumed a capacity slot under a hash no marker ever named.
    // Capacity is shared, so enough of those evicted an original that a live
    // `hash=` marker still pointed at: the model losing a retrieval it had
    // been told it held.
    const small = ['# top comment', 'service:', '  # inner comment', '  name: api', '', '', '  ports:', '    - 8080'].join('\n')
    const store = new CcrStore()
    expect(compressConfig(small, 'yaml', store).applied).toBe(false)
    expect(store.get(computeKey(small))).toBeUndefined()
  })

  it('stashes nothing when the accepted rendering carries no retrieval marker', () => {
    // The other half of the same rule: the stashing moved to the accepting path,
    // but folding alone accepts without emitting a `hash=` marker, so that path
    // still held an original nothing names. A test of the declined path alone
    // cannot see it, because there the two rules agree.
    const repeated = [
      'service: checkout',
      '  image: registry.example.com/checkout:1.2.3',
      '  replicas: 4',
      'service: checkout',
      '  image: registry.example.com/checkout:1.2.3',
      '  replicas: 4',
    ].join('\n')
    const store = new CcrStore()
    const result = compressConfig(repeated, 'yaml', store)
    expect(result.applied).toBe(true)
    expect(result.output).not.toContain('hash=')
    expect(store.get(computeKey(repeated))).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('extracts readable text from tag-heavy HTML', () => {
    const chrome = '<div class="nav"><ul><li>Home</li><li>About</li><li>Contact</li><li>Blog</li><li>Careers</li><li>Docs</li></ul></div><footer><small>copyright notice</small></footer><aside><div>sidebar widget content</div></aside><div class="breadcrumbs"><a href="/">root</a><a href="/docs">docs</a><a href="/docs/guide">guide</a></div><div class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=3">3</a><a href="?page=4">4</a><a href="?page=5">5</a></div><script>var x=1;function y(){return 2}</script><style>.a{color:red}.b{margin:0}</style>'
    const body = '<main>' + '<h2>Section</h2><p>Substantive paragraph with the actual content the reader needs.</p>'.repeat(10) + '</main>'
    const html = `<!DOCTYPE html><html><head><title>Report</title><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="a.css"><link rel="icon" href="f.ico"><style>body{color:red}</style></head><body>${chrome}${body}</body></html>`
    const result = compressHtml(html)
    expect(result.applied).toBe(true)
    expect(result.output).toContain('# Report')
    expect(result.output).not.toContain('<script>')
    expect(result.output).not.toContain('<footer>')
  })
})

describe('headroom crushability gate', () => {
  it('accepts repetitive content with IDs', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: i, status: 'ok', region: 'us-east' }))
    expect(analyzeCrushability(items, SMART_CRUSHER_DEFAULTS).crushable).toBe(true)
  })

  it('refuses fully-unique entity arrays with no signal', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `person_${i}_meta_key`,
      name: `Person Number ${i} Fullname`,
      email: `person${i}@example-domain.com`,
      phone: `+1-555-${String(1000000 + i * 7)}`,
    }))
    expect(analyzeCrushability(items, SMART_CRUSHER_DEFAULTS).crushable).toBe(false)
  })

  it('always survives error rows through the lossy sampler', () => {
    const store = new CcrStore()
    const items = Array.from({ length: 60 }, (_, i) => ({ id: i, kind: `kind_${i % 3}`, blob: `payload ${i} ${'y'.repeat(30)}` }))
    items[42] = { id: 42, kind: 'fatal', blob: 'ERROR: catastrophic failure in worker' }
    const result = lossySampleArray(items, SMART_CRUSHER_DEFAULTS, store)
    expect(result).toBeDefined()
    expect(result!.output).toContain('catastrophic failure')
  })

  it('spends the sampling budget on distinct rows before repeating one', () => {
    const store = new CcrStore()
    // A hundred identical rows, then a hundred distinct ones. The budget is
    // twelve, and the first/last anchors can only account for a handful of
    // rows, so a budget that is spent in index order lands almost entirely on
    // copies of the first row.
    const items = [
      ...Array.from({ length: 100 }, () => ({ id: 'noop', kind: 'heartbeat', payload: 'identical row repeating forever' })),
      ...Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, kind: `kind-${i}`, payload: `unique payload number ${i}` })),
    ]
    const result = lossySampleArray(items, { ...SMART_CRUSHER_DEFAULTS, maxItemsAfterCrush: 12 }, store)
    expect(result).toBeDefined()
    const rows = (JSON.parse(result!.output) as unknown[])
      .filter(entry => entry !== null && typeof entry === 'object' && !('_ccr_dropped' in entry))
    expect(rows).toHaveLength(result!.kept)
    expect(result!.kept + result!.dropped).toBe(items.length)
    // Regression: filling from index 0 produced three distinct rows out of the
    // twelve kept, nine of them byte-identical copies of the first.
    expect(new Set(rows.map(row => JSON.stringify(row))).size).toBeGreaterThanOrEqual(8)
    expect(rows.some(row => String((row as { readonly id?: unknown }).id).startsWith('row-'))).toBe(true)
  })

  it('fills the whole budget with duplicates rather than under-filling it', () => {
    const store = new CcrStore()
    // Sixty copies of one row: there is no distinct row to prefer, so the dedup
    // must not collapse to "keep one". The budget for a single content group is
    // the sizer's minimum.
    const items = Array.from({ length: 60 }, () => ({ id: 'same', status: 'ok', payload: 'identical row' }))
    const result = lossySampleArray(items, { ...SMART_CRUSHER_DEFAULTS, maxItemsAfterCrush: 12 }, store)
    expect(result).toBeDefined()
    expect(result!.kept + result!.dropped).toBe(items.length)
    expect(result!.kept).toBe(3)
  })
})

describe('headroom mixed content and tag protection', () => {
  it('splits interleaved prose and JSON into typed sections', () => {
    const text = [
      'Here is the summary of the completed run for review.',
      'The deployment pipeline executed without any failures today.',
      'Every logged check passed and the artifact was published.',
      'The team should review the attached output listing below.',
      '{"results":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}',
      'The conclusion follows here with more detail to read.',
      'That closing note ends the generated status report body.',
    ].join('\n')
    expect(isMixedContent(text)).toBe(true)
    const sections = splitIntoSections(text)
    expect(sections.length).toBeGreaterThanOrEqual(3)
    expect(sections.some(section => section.contentType === 'json')).toBe(true)
  })

  it('rebuilds the whole text, fence delimiters included', () => {
    // The splice replaces the model text with the sections joined, so a
    // partition that omits a line is a rewrite nothing announced: fences were
    // dropped this way, and the adopted rendering showed fenced code as bare
    // lines.
    for (const input of [
      ['Intro.', '```json', '{"k":"v"}', '```', 'Middle prose.', '', 'Tail.'].join('\n'),
      ['Before.', '```', 'const a = 1', '```', 'After.'].join('\n'),
      ['Before.', '```ts', 'const a = 1'].join('\n'),
      ['Only JSON and a trailing blank line.', '{"a":1}', ''].join('\n'),
    ]) {
      expect(splitIntoSections(input).map(section => section.content).join('\n')).toBe(input)
    }
  })

  it('protects custom tags from prose compression', () => {
    const text = 'Plain sentence number one goes here. <system-reminder>never ignore these rules</system-reminder> Final plain sentence.'
    const protectedText = protectTags(text, false)
    expect(protectedText.cleaned).toContain('{{HEADROOM_TAG_0}}')
    expect(protectedText.cleaned).not.toContain('<system-reminder>')
    const restored = restoreTags(protectedText.cleaned, protectedText.blocks)
    expect(restored).toBe(text)
  })

  it('protects the closing marker of a nested custom tag', () => {
    // Regression: the close-tag branch popped the matched entry *and* its parent,
    // so an outer tag's close marker was treated as an orphan and left raw — the
    // prose compressor was then free to drop it.
    const text = 'Plain lead sentence here. <x><y>inner directive</y></x> Plain trailing sentence.'
    const protectedText = protectTags(text, true)
    expect(protectedText.cleaned).not.toMatch(/<\/?[a-z]+>/u)
    expect(protectedText.blocks).toHaveLength(4)
    expect(restoreTags(protectedText.cleaned, protectedText.blocks)).toBe(text)
  })
})

describe('headroom output shaper', () => {
  it('emits byte-stable steering blocks per level', () => {
    expect(steeringText(0)).toBeUndefined()
    const block = steeringText(2)
    expect(block).toContain('<headroom_output_shaping>')
    expect(block).toContain('Never restate code')
    expect(steeringText(2)).toBe(block)
  })

  it('routes effort clamp-only on mechanical continuations', () => {
    expect(routeEffort('high', 'mechanical-continuation', true)).toBe('medium')
    expect(routeEffort('high', 'new-user-ask', true)).toBe('high')
    expect(routeEffort('high', 'error-continuation', true)).toBe('high')
    expect(routeEffort('high', 'mechanical-continuation', false)).toBe('high')
    expect(routeEffort(undefined, 'mechanical-continuation', true)).toBeUndefined()
  })
})

describe('headroom lossy branches keep their recovery channel', () => {
  /** The `tools/post-execute` seam, with just what the runtime touches. */
  function harness(settings: HeadroomSettings): {
    readonly runtime: FreeCodeGoHeadroomRuntime
    readonly run: (name: string, text: string, args?: Readonly<Record<string, unknown>>) => Promise<{ readonly kind: string; readonly content?: readonly { readonly text: string }[] } | undefined>
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
        if (listener === undefined) return undefined
        return await listener({ name, arguments: args ?? {} } as never, { content: [{ type: 'text', text }] } as never, async () => ({ kind: 'next' })) as never
      },
    }
  }

  it('names the hash it stashed when HTML is compressed', async () => {
    // `compressHtml` strips every tag, so the extraction drops markup the model
    // may need back — an `<img src>`, an inline JSON payload, a table's shape.
    // The branch stored the original in CCR but returned the extraction with no
    // `hash=` marker, so the entry sat there with nothing pointing at it: the
    // compression was irrecoverable, which is the one shape this subsystem
    // exists to avoid. `ccrEntries` alone cannot see it — the store was written
    // either way — so the assertion has to name the key.
    const chrome = '<div class="nav"><ul><li>Home</li><li>About</li><li>Contact</li><li>Blog</li><li>Careers</li><li>Docs</li></ul></div><footer><small>copyright notice</small></footer><aside><div>sidebar widget content</div></aside><div class="breadcrumbs"><a href="/">root</a><a href="/docs">docs</a><a href="/docs/guide">guide</a></div><div class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=3">3</a><a href="?page=4">4</a><a href="?page=5">5</a></div><script>var x=1;function y(){return 2}</script><style>.a{color:red}.b{margin:0}</style>'
    const body = '<main>' + '<h2>Section</h2><p>Substantive paragraph with the actual content the reader needs.</p>'.repeat(10) + '</main>'
    const html = `<!DOCTYPE html><html><head><title>Report</title><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="a.css"><link rel="icon" href="f.ico"><style>body{color:red}</style></head><body>${chrome}${body}</body></html>`
    // Both floors have to be cleared for this branch to answer: the extractor
    // declines above a 0.5 ratio of its own, and the runtime's `acceptRatio`
    // then re-tests the marker-carrying rendering.
    expect(Buffer.byteLength(html, 'utf8')).toBeGreaterThan(1_200)
    expect(compressHtml(html).applied).toBe(true)

    const { runtime: headroom, run } = harness({ headroomEnabled: true, headroomThresholdChars: 1_200 })
    const result = await run('curl', html)
    expect(result?.kind).toBe('accept')
    const output = result?.content?.[0]?.text ?? ''
    const status = headroom.status()
    expect(status.htmlCompressions).toBe(1)
    expect(status.ccrEntries).toBe(1)
    expect(output).toContain(`Retrieve original: hash=${computeKey(html)}`)
  })

  it('keeps every file header when a plain diff -u spans several files', () => {
    // `diff -u` prints no `diff --git` line, so every file boundary is a
    // `--- `/`+++ ` pair. The parser's condition let only the *first* `--- `
    // open a section, which both dropped the first file's `+++ ` line (the
    // rendering was then not a valid unified diff) and re-read each later
    // boundary as a removal plus an addition — inflating the `changeCount`
    // that `maxFiles` selects by.
    const file = (name: string): string => [
      `--- a/${name}\t2026-01-01 00:00:00.000000000 +0000`,
      `+++ b/${name}\t2026-01-02 00:00:00.000000000 +0000`,
      '@@ -1,18 +1,18 @@',
      ...Array.from({ length: 8 }, (_value, index) => ` context line ${index} of ${name}`),
      `-old value in ${name}`,
      `+new value in ${name}`,
      ...Array.from({ length: 8 }, (_value, index) => ` trailing context ${index} of ${name}`),
    ].join('\n')
    const text = ['alpha.ts', 'beta.ts', 'gamma.ts'].map(file).join('\n')
    expect(text.split('\n').length).toBeGreaterThanOrEqual(DIFF_COMPRESSOR_DEFAULTS.minLines)

    const result = compressDiff(text, DIFF_COMPRESSOR_DEFAULTS, new CcrStore())
    expect(result.applied).toBe(true)
    const lines = result.compressed.split('\n')
    const pathOf = (line: string): string => line.slice(4).split('\t')[0]!
    const seen: string[] = []
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith('--- ')) continue
      const next = lines[index + 1] ?? ''
      expect(next, `header at line ${index} lost its +++ half`).toMatch(/^\+\+\+ /u)
      expect(pathOf(next)).toBe(pathOf(line).replace(/^a\//u, 'b/'))
      seen.push(pathOf(line))
    }
    expect(seen).toEqual(['a/alpha.ts', 'a/beta.ts', 'a/gamma.ts'])
    // One add and one remove per file. The phantom boundary pair showed up here
    // as 5 and 5, and nothing else in the output revealed it.
    const adds = lines.filter(line => line.startsWith('+') && !line.startsWith('+++ '))
    const removes = lines.filter(line => line.startsWith('-') && !line.startsWith('--- '))
    expect(adds).toHaveLength(3)
    expect(removes).toHaveLength(3)
    expect(result.cacheKey).toBeDefined()
    expect(result.compressed).toContain(`hash=${result.cacheKey}`)
  })

  it('restores a protected block containing replacement patterns byte-for-byte', () => {
    // `String.prototype.replaceAll` expands `$&`, `` $` ``, `$'` and `$$` in a
    // *string* replacement. A protected block is arbitrary caller content, so
    // any of those sequences used to be rewritten while the placeholder was
    // put back — silently corrupting the exact text the protector exists to
    // carry through the compressor untouched.
    const patterns = ['$&', '$$', '$`', "$'", '$1', '$<name>'].join(' ')
    const text = `Lead sentence before the directive. <system-reminder>literal ${patterns} must survive</system-reminder> Trailing sentence after it.`
    const protectedText = protectTags(text, false)
    expect(protectedText.cleaned).not.toContain('<system-reminder>')
    expect(restoreTags(protectedText.cleaned, protectedText.blocks)).toBe(text)
  })
})
