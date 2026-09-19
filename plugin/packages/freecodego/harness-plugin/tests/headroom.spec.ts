import { describe, expect, it } from 'vitest'
import { CcrStore, computeKey } from '../src/headroom/ccr.ts'
import { LogCompressor } from '../src/headroom/log-compressor.ts'
import { SMART_CRUSHER_DEFAULTS, crushJson } from '../src/headroom/smart-crusher.ts'
import { computeOptimalK, computeUniqueBigramCurve, findKnee, validateWithZlib } from '../src/headroom/adaptive-sizer.ts'
import { compressSearch, looksLikeSearchOutput, SEARCH_COMPRESSOR_DEFAULTS } from '../src/headroom/search-compressor.ts'
import { compressDiff, looksLikeDiffOutput, DIFF_COMPRESSOR_DEFAULTS } from '../src/headroom/diff-compressor.ts'
import { crushText, TEXT_CRUSHER_DEFAULTS } from '../src/headroom/text-crusher.ts'
import { compactLossless } from '../src/headroom/lossless-compaction.ts'

describe('headroom ccr store', () => {
  it('round-trips a payload and reports unknown hashes', () => {
    const store = new CcrStore()
    const key = computeKey('original payload')
    store.put(key, 'original payload')
    expect(store.get(key)).toBe('original payload')
    expect(store.get('a'.repeat(24))).toBeUndefined()
  })

  it('re-storing a payload already held evicts nothing', () => {
    // Keys are content hashes, so the same text arrives repeatedly in real use
    // (the same file read twice, the same failing command rerun). Eviction
    // exists to make room for a *new* entry; making room for one already held
    // destroys an original the model can still see a marker for.
    const store = new CcrStore(2)
    store.put('a', 'A')
    store.put('b', 'B')
    store.put('b', 'B again')
    expect(store.size).toBe(2)
    expect(store.get('a')).toBe('A')
    expect(store.get('b')).toBe('B again')
  })

  it('re-storing an expired payload hands out a retrievable copy', () => {
    // The marker was just emitted for this payload, so the model will look it
    // up: reviving the row must reset the clock rather than leave a dead entry
    // whose only remaining behaviour is to answer `undefined`.
    const store = new CcrStore(4, 30, 1_000)
    store.put('k', 'v')
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        store.put('k', 'v')
        expect(store.get('k')).toBe('v')
        resolve()
      }, 50)
    })
  })
})

describe('headroom log compressor', () => {
  const buildLines = (count: number): string[] => Array.from({ length: count }, (_, i) => `2026-09-09 10:00:${String(i % 60).padStart(2, '0')} INFO ok iteration ${i}`)

  it('passes short logs through verbatim', () => {
    const compressor = new LogCompressor()
    const result = compressor.compress(['INFO small', 'ERROR tiny'].join('\n'), 1)
    expect(result.compressed).toBe('INFO small\nERROR tiny')
    expect(result.cacheKey).toBeUndefined()
  })

  it('keeps errors and collapses repetitive info lines', () => {
    const compressor = new LogCompressor()
    const lines = [...buildLines(400)]
    lines[10] = 'FATAL unrecoverable state in worker'
    lines[11] = 'stack frame detail for the fatal error'
    const result = compressor.compress(lines.join('\n'), 1)
    expect(result.compressed).toContain('FATAL unrecoverable state in worker')
    expect(result.compressionRatio).toBeLessThan(0.5)
    expect(result.compressed).toMatch(/\[\d+ lines omitted: \d+ ERROR, \d+ INFO\]/u)
  })

  it('stores the original in CCR and appends a retrieve marker', () => {
    const compressor = new LogCompressor()
    const store = new CcrStore()
    const lines = [...buildLines(400)]
    lines[5] = 'ERROR first failure'
    const result = compressor.compress(lines.join('\n'), 1, store)
    expect(result.cacheKey).toBeDefined()
    expect(result.compressed).toContain(`hash=${result.cacheKey}`)
    expect(store.get(result.cacheKey!)).toContain('ERROR first failure')
  })

  it('reports the line count of the text it returns, not of its own selection', () => {
    // The rendering carries a header line and, once CCR engaged, a retrieve
    // marker. Reporting `selected.length` described the compressor internal
    // choice rather than the text the caller receives, so a caller measuring
    // the saving measured a rendering it never saw.
    const compressor = new LogCompressor()
    const lines = [...buildLines(400)]
    lines[5] = 'ERROR first failure'
    const result = compressor.compress(lines.join('\n'), 1, new CcrStore())
    expect(result.compressedLineCount).toBe(result.compressed.split('\n').length)
    expect(result.compressedLineCount).toBeGreaterThan(0)
  })
})

describe('headroom smart crusher', () => {
  it('renders a uniform object array as a CSV-schema table', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `usr_${String(i).padStart(3, '0')}`, name: `file-${i}.ts`, status: 'active', size: 1024 + i }))
    const text = JSON.stringify(items)
    const result = crushJson(text, SMART_CRUSHER_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    expect(result.output).toMatch(/^\[40\]\{id:string,name:string,size:int,status:string\}/u)
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(Buffer.byteLength(text, 'utf8') * 0.7)
  })

  it('crushes a large array whose numeric column passes the argument limit', () => {
    // Regression: the field statistics (and the score-field detector) spread a
    // whole column into `Math.min(...values)`, which V8 caps at roughly 100k
    // arguments. The `RangeError` escaped this stage, so once the lossless table
    // missed `minSavingsRatio` — a long unique value per row removes only the
    // key overhead, well under 0.3 — an array of this size came back with
    // "Maximum call stack size exceeded" instead of a sample.
    const rows = Array.from({ length: 130_000 }, (_, index) => ({
      blob: `chunk_${index.toString(36)}_${(index * 7919).toString(36)}_tailpadpadpad`,
      n: (index * 37) % 5_000,
    }))
    expect(() => Math.min(...rows.map(row => row.n))).toThrow(RangeError)
    const text = JSON.stringify(rows)
    const result = crushJson(text, SMART_CRUSHER_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    // The lossy sample is what this payload needs: a handful of anchors plus the
    // information budget, not a table that keeps all 130k rows.
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(Buffer.byteLength(text, 'utf8') * 0.05)
  })

  it('keeps the original when JSON is not a compactable container', () => {
    const result = crushJson(JSON.stringify({ hello: 'world' }), SMART_CRUSHER_DEFAULTS, undefined)
    expect(result.applied).toBe(false)
    expect(result.output).toBe(JSON.stringify({ hello: 'world' }))
  })

  it('offloads opaque string cells into CCR', () => {
    const store = new CcrStore()
    // Whitespace keeps this out of the base64 alphabet; it classifies as a
    // plain long string.
    const blob = 'lorem ipsum dolor sit amet '.repeat(24)
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i, blob }))
    const result = crushJson(JSON.stringify(items), SMART_CRUSHER_DEFAULTS, store)
    // Markers carry a 24-hex hash — the same width headroom_retrieve validates.
    expect(result.output).toMatch(/<<ccr:[a-f0-9]{24},string,648B>>/u)
    const hash = result.output.match(/<<ccr:([a-f0-9]{24}),/u)?.[1]
    expect(hash).toBeDefined()
    expect(store.get(hash!)).toBe(blob)
  })

  it('minifies pretty-printed JSON losslessly when tabular form does not apply', () => {
    const pretty = JSON.stringify({ a: 1, b: [1, 2] }, null, 2)
    const result = crushJson(pretty, SMART_CRUSHER_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    expect(result.output).toBe('{"a":1,"b":[1,2]}')
  })

  it('lossy-samples large arrays down to the information budget with a CCR sentinel', () => {
    const store = new CcrStore()
    // 200 rows of mostly-repetitive content with one error row buried deep:
    // the tabular table compresses well, so force the lossy path by making
    // rows structurally noisy (unique keys per row defeat uniform tabling).
    const items = Array.from({ length: 200 }, (_, i) => {
      const row: Record<string, unknown> = { id: i, data: `payload ${i}` }
      // Varying keys keep the table sparse; two long unique fields keep the
      // CSV rendering above the savings floor so sampling takes over.
      row[`field_${i % 7}`] = `unique value ${i} ${'x'.repeat(30)}`
      return row
    })
    items[150] = { id: 150, data: 'ERROR deployment failed catastrophically' }
    const text = JSON.stringify(items)
    const result = crushJson(text, SMART_CRUSHER_DEFAULTS, store)
    expect(result.applied).toBe(true)
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(Buffer.byteLength(text, 'utf8') * 0.5)
    const sentinel = result.output.match(/_ccr_dropped":"<<ccr:([a-f0-9]{24}) (\d+)_rows_offloaded>>/u)
    expect(sentinel).toBeDefined()
    // The error row survives sampling.
    expect(result.output).toContain('ERROR deployment failed catastrophically')
    // The full array is retrievable through the sentinel hash.
    expect(store.get(sentinel![1]!)).toContain('payload 0')
  })
})

describe('headroom adaptive sizer', () => {
  it('keeps everything for tiny inputs', () => {
    expect(computeOptimalK(['a', 'b', 'c'], 1, 10)).toBe(3)
  })

  it('detects the flat curve as a single unique item', () => {
    expect(findKnee([1, 1, 1, 1])).toBe(1)
  })

  it('caps the keep count at the requested maximum', () => {
    const items = Array.from({ length: 200 }, (_, i) => `unique line ${i} with varying content ${i * 7919}`)
    expect(computeOptimalK(items, 1, 10, 100)).toBeLessThanOrEqual(100)
  })

  it('builds a non-decreasing cumulative coverage curve, one point per item', () => {
    const curve = computeUniqueBigramCurve([
      'alpha beta gamma',
      'alpha beta',
      'delta epsilon',
    ])
    expect(curve).toHaveLength(3)
    // Coverage only grows: a bigram already seen never raises the count again.
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!)
    // Item 1 contributes two bigrams; item 2 repeats one (alpha/beta) and adds
    // none; item 3's single word pair adds one more.
    expect(curve).toEqual([2, 2, 3])
  })

  it('treats a whitespace-only item as one anonymous bigram rather than skipping it', () => {
    // Every item must produce a curve point, otherwise the knee index would
    // drift out of alignment with the input positions.
    expect(computeUniqueBigramCurve(['', '   ', 'alpha'])).toEqual([1, 1, 2])
  })

  it('uses char bigrams for a single CJK token and a lone-word token otherwise', () => {
    // One CJK word has no spaces to split on, so the fallback is char bigrams.
    expect(computeUniqueBigramCurve(['量化压缩'])).toEqual([3])
    // A single ASCII word has no bigram at all: it counts as one marker.
    expect(computeUniqueBigramCurve(['alpha'])).toEqual([1])
  })

  it('returns no knee for a curve too short or too straight to have one', () => {
    expect(findKnee([1, 2])).toBeUndefined()
    // A linear curve is uniformly far from the diagonal, but never far enough:
    // nothing here is a saturation point.
    expect(findKnee([1, 2, 3, 4, 5])).toBeUndefined()
  })

  it('leaves k alone when there is nothing to validate against', () => {
    const items = Array.from({ length: 10 }, (_, i) => `item ${i} with a reasonably long body of text to exceed the byte floor`)
    // k at or past the end is already maximal.
    expect(validateWithZlib(items, 10, 10)).toBe(10)
    expect(validateWithZlib(items, 12, 20)).toBe(12)
    // Below the byte floor the compression ratio is noise, so k passes through.
    expect(validateWithZlib(['tiny'], 1, 5)).toBe(1)
  })

  it('never lets the zlib bump overshoot maxK', () => {
    const items = Array.from({ length: 300 }, (_, i) => `record ${i % 7} field ${i * 13} repeated payload fragment for ratio`)
    const bumped = validateWithZlib(items, 40, 45)
    expect(bumped).toBeGreaterThanOrEqual(0)
    expect(bumped).toBeLessThanOrEqual(45)
  })
})

describe('headroom search compressor', () => {
  // Each of the `files` groups holds `perFile` matches in ONE file path so
  // per-file grouping (and the per-file cap) is actually exercised.
  const buildSearch = (files: number, perFile: number): string =>
    Array.from({ length: files }, (_, f) =>
      Array.from({ length: perFile }, (_, i) => `src/module${f}/handler.ts:${100 + i}:export const value${f}_${i} = ${i}`),
    ).flat().join('\n')

  it('detects grep-style output', () => {
    expect(looksLikeSearchOutput(buildSearch(3, 5))).toBe(true)
    expect(looksLikeSearchOutput('plain prose\nwithout any\nfile line markers\nat all here')).toBe(false)
  })

  it('groups by file, caps matches, and stores the original in CCR', () => {
    const store = new CcrStore()
    const text = buildSearch(8, 12)
    const result = compressSearch(text, SEARCH_COMPRESSOR_DEFAULTS, store)
    expect(result.applied).toBe(true)
    expect(result.keptCount).toBeLessThan(result.matchCount)
    expect(result.compressed).toMatch(/\[\.\.\. and \d+ more matches in this file\]/u)
    expect(result.cacheKey).toBeDefined()
    expect(store.get(result.cacheKey!)).toBe(text)
  })

  it('keeps error matches over plain ones', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/a.ts:${i + 1}:const x${i} = ${i}`)
    lines[20] = 'src/a.ts:21:throw new Error("critical failure")'
    const result = compressSearch(lines.join('\n'), SEARCH_COMPRESSOR_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    expect(result.compressed).toContain('critical failure')
  })

  it('names a retrievable hash in the text it delivers, not only in its result', () => {
    // F-26's invariant, asserted where it lives rather than through two config
    // fields that had to stay equal: `applied: true` means the caller receives a
    // rendering instead of its input, so the footer hash is the only way back to
    // what was dropped. A key on the result object is not enough — the text is
    // what reaches the transcript, and a reader of that text has nothing else.
    const store = new CcrStore()
    const text = buildSearch(8, 12)
    const result = compressSearch(text, SEARCH_COMPRESSOR_DEFAULTS, store)
    expect(result.applied).toBe(true)
    const marker = /hash=([a-f0-9]{24})/u.exec(result.compressed)
    expect(marker, 'an adopted search rendering must name its hash in the text').not.toBeNull()
    expect(store.get(marker![1]!)).toBe(text)
    // The one combination a caller opts into, and it is explicit: no store means
    // no marker can exist.
    expect(compressSearch(text, SEARCH_COMPRESSOR_DEFAULTS, undefined).cacheKey).toBeUndefined()
  })
})

describe('headroom diff compressor', () => {
  const buildDiff = (): string => {
    const lines: string[] = []
    for (let file = 0; file < 6; file += 1) {
      lines.push(`diff --git a/src/file${file}.ts b/src/file${file}.ts`)
      lines.push('--- a/src/file.ts')
      lines.push('+++ b/src/file.ts')
      for (let hunk = 0; hunk < 4; hunk += 1) {
        lines.push(`@@ -${10 + hunk * 40},30 +${10 + hunk * 40},31 @@`)
        for (let i = 0; i < 14; i += 1) lines.push(` leading context line ${i} stays the same`)
        lines.push(`-old line ${hunk}`)
        lines.push(`+new line ${hunk} with a longer replacement`)
        for (let i = 0; i < 14; i += 1) lines.push(` trailing context ${i}`)
      }
    }
    return lines.join('\n')
  }

  it('detects unified diff output', () => {
    expect(looksLikeDiffOutput('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(true)
    expect(looksLikeDiffOutput('no diff markers\nin this text')).toBe(false)
  })

  it('compresses a multi-file diff and stores the original', () => {
    const store = new CcrStore()
    const text = buildDiff()
    const result = compressDiff(text, DIFF_COMPRESSOR_DEFAULTS, store)
    expect(result.applied).toBe(true)
    expect(result.compressed).toContain('diff --git a/src/file0.ts')
    expect(result.compressed).toMatch(/context lines omitted/u)
    expect(result.cacheKey).toBeDefined()
    expect(store.get(result.cacheKey!)).toBe(text)
    // F-26's invariant, and the half this test was missing: the hash has to be in
    // the delivered text, because that is the only channel a reader has. The
    // assertions above pass for a rendering whose caller side knows a key the
    // transcript never sees.
    const marker = /hash=([a-f0-9]{24})/u.exec(result.compressed)
    expect(marker, 'an adopted diff rendering must name its hash in the text').not.toBeNull()
    expect(store.get(marker![1]!)).toBe(text)
  })

  it('returns short diffs unchanged', () => {
    const short = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b'
    expect(compressDiff(short, DIFF_COMPRESSOR_DEFAULTS, undefined).applied).toBe(false)
  })

  it('renders exactly maxHunksPerFile hunks and tallies every rendered hunk', () => {
    // Regression: the render loop walked the *filtered* hunk list while probing
    // `selected.has(i + 1)` with a filtered index, so it broke early — rendering
    // fewer hunks than the cap and under-counting the footer's +added/-removed.
    const lines: string[] = ['--- a/file.ts', '+++ b/file.ts']
    for (let h = 0; h < 14; h += 1) {
      lines.push(`@@ -${h * 40 + 1},3 +${h * 40 + 1},4 @@`, ` context ${h}`, `-removed ${h}`, `+added ${h}`, `+another ${h}`)
    }
    const result = compressDiff(lines.join('\n'), DIFF_COMPRESSOR_DEFAULTS, undefined)
    expect(result.applied).toBe(true)
    expect(result.compressed.match(/^@@ /gmu) ?? []).toHaveLength(DIFF_COMPRESSOR_DEFAULTS.maxHunksPerFile)
    // 10 rendered hunks × (+2 adds / -1 remove each), 4 dropped.
    expect(result.compressed).toContain('4 hunk(s) omitted, +20 -10 lines shown')
  })
})

describe('headroom text crusher', () => {
  const buildProse = (): string => Array.from({ length: 120 }, (_, i) =>
    i === 60
      ? 'Critical: the migration failed because the schema lock timed out after 30 seconds. '
      : `Paragraph ${i} of the generated report describes routine step ${i} of the deployment process with detail ${i}. `,
  ).join('')

  it('extractively compresses long prose keeping salient sentences', () => {
    const store = new CcrStore()
    const text = buildProse()
    const result = crushText(text, TEXT_CRUSHER_DEFAULTS, store)
    expect(result.applied).toBe(true)
    expect(result.compressed).toContain('schema lock timed out')
    expect(Buffer.byteLength(result.compressed, 'utf8')).toBeLessThan(Buffer.byteLength(text, 'utf8') * 0.8)
    expect(result.cacheKey).toBeDefined()
    expect(store.get(result.cacheKey!)).toBe(text)
  })

  it('leaves short prose untouched', () => {
    expect(crushText('short text. stays. put.', TEXT_CRUSHER_DEFAULTS, undefined).applied).toBe(false)
  })
})

describe('headroom lossless compaction', () => {
  // Regression: the blank-run fold deleted the surplus lines instead of marking
  // them, so it threw away the count its own round-trip check compares. The check
  // therefore rejected every candidate and the fold was dead for every input,
  // which is the same shape as the config stanza fold that mis-targeted its span
  // and had every candidate rejected. An `applied: true` here is the proof that
  // the candidate rebuilt the original — `compactLossless` verifies that itself.
  const blankRun = (count: number): string => Array.from({ length: count }, () => '').join('\n')

  it('folds a blank run through a marker that rebuilds it', () => {
    const text = `before\n${blankRun(40)}\nafter`
    const result = compactLossless(text, 'text')
    expect(result.applied).toBe(true)
    expect(result.output).toContain('repeated 40 times')
    expect(result.output.length).toBeLessThan(text.length)
  })

  it('leaves a blank run alone when the marker costs more than it saves', () => {
    const text = 'before\n\n\n\nafter'
    const result = compactLossless(text, 'text')
    expect(result.applied).toBe(false)
    expect(result.output).toBe(text)
  })

  it('keeps a whitespace-only line, which the marker cannot rebuild', () => {
    // The marker rebuilds an empty line, so a line holding spaces is content:
    // collapsing it would fail the round-trip check rather than shrink the text.
    const text = `before\n${Array.from({ length: 40 }, () => ' ').join('\n')}\nafter`
    expect(compactLossless(text, 'text').applied).toBe(false)
  })
})
