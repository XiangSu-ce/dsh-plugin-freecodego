/**
 * The two halves of one fact, each checked from the side the other cannot see.
 *
 * `headroom-retrievability.spec.ts` asks the runtime's question — *the text the
 * model received names a hash that returns the original* — and it asks it of the
 * first `hash=` marker only. That leaves three shapes invisible, and all three
 * have the same root: **a write to CCR and the reference that justifies it are
 * decided separately.**
 *
 * 1. A reference the store does not hold. The `<<ccr:HASH,KIND,SIZE>>` and
 *    `<<ccr:HASH N_rows_offloaded>>` spellings are never looked at by that file,
 *    so an opaque cell or a dropped-rows sentinel naming an entry that was never
 *    written, or was written and then evicted, is a retrieval the model is told
 *    it has and cannot make.
 * 2. A write nothing points at. `CcrStore.put` documents the outcome it refuses:
 *    a stashed original evicts a live one, so an entry no marker names destroys a
 *    retrieval another result was promised. The `html` bug in that file's header
 *    is this shape once removed; this file is the guard that asks it of *every*
 *    compressor rather than of one branch someone remembered.
 * 3. A rewrite nobody is told about. Every entry point here reports `applied`, and
 *    a caller reads `false` as "the input is what ships" — so a declined rendering
 *    that is not the input, or that wrote to the store anyway, is a lie in the
 *    other direction.
 *
 * Guarded per compressor rather than only at the runtime seam, because the
 * compressors own their own stash: `crushJsonDocument` writes opaque cells while
 * *building* a table it may then refuse, and `crushText` measures adoption on a
 * rendering that already carries its marker. A sweep over the acceptance bands
 * rather than one fixture, for the same reason — the defect lives in the strip
 * between two thresholds, so a single point on the scale proves nothing.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CcrStore, DEFAULT_CAPACITY, computeKey } from '../src/headroom/ccr.ts'
import { DIFF_COMPRESSOR_DEFAULTS, compressDiff } from '../src/headroom/diff-compressor.ts'
import { LOG_COMPRESSOR_DEFAULTS, LogCompressor } from '../src/headroom/log-compressor.ts'
import { SEARCH_COMPRESSOR_DEFAULTS, compressSearch } from '../src/headroom/search-compressor.ts'
import { SMART_CRUSHER_DEFAULTS, crushJson, crushJsonDocument } from '../src/headroom/smart-crusher.ts'
import { TEXT_CRUSHER_DEFAULTS, crushText } from '../src/headroom/text-crusher.ts'
import { compressConfig } from '../src/headroom/config-compressor.ts'
import { compressTabular, detectTabular } from '../src/headroom/tabular-ingest.ts'
import { skeletonizeReadOutput } from '../src/headroom/code-skeleton.ts'
import type { CcrStore as CcrStoreType } from '../src/headroom/ccr.ts'

/**
 * A real store that also remembers its writes, so the reference half is checkable.
 *
 * Only **accepted** writes are remembered — the store's answer is forwarded, not
 * swallowed. Swallowing it made every gate here read a compressor that checks
 * `put(...) !== true` as one that declined, so the file reported thirteen
 * compressors "writing while declining" when what they had actually seen was a
 * subclass returning `undefined`; and a refused write is not a write, so counting
 * one as a stash the model was not told about would be the same mistake mirrored.
 */
class RecordingStore extends CcrStore {
  readonly writes: { readonly hash: string; readonly payload: string }[] = []

  override put(hash: string, payload: string): boolean {
    const accepted = super.put(hash, payload)
    if (accepted) this.writes.push({ hash, payload })
    return accepted
  }
}

/**
 * Every CCR reference in a rendering, in either spelling.
 *
 * `hash=` is the runtime's suffix marker; `<<ccr:HASH…>>` is the crusher's
 * inline one, written both as an opaque cell (`HASH,KIND,SIZE`) and as the
 * dropped-rows sentinel (`HASH N_rows_offloaded`). The hash is the same 24 hex
 * characters in all three, which is why one pattern reads them.
 */
const REFERENCE = /hash=([a-f0-9]{24})|<<ccr:([a-f0-9]{24})/gu

/** The distinct hashes a rendering names. */
function referencesIn(text: string): readonly string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(REFERENCE)) found.add(match[1] ?? match[2]!)
  return [...found]
}

interface Attempt {
  readonly applied: boolean
  readonly output: string
}

interface CompressorCase {
  readonly label: string
  readonly fixture: string
  /** Acceptance thresholds to sweep: the defect lives between two of them. */
  readonly bands: readonly number[]
  readonly attempt: (store: CcrStoreType, band: number) => Attempt
}

const lines = (count: number, make: (index: number) => string): string =>
  Array.from({ length: count }, (_value, index) => make(index)).join('\n')

// A row whose blob is far past `opaqueMinBytes`, so the table compaction replaces
// it with an opaque-cell marker — which is a write, made while the table is built.
const OPAQUE_ROWS = JSON.stringify(Array.from({ length: 40 }, (_value, index) => ({
  id: index,
  owner: `team_${index % 4}`,
  note: `row ${index}`,
  blob: Buffer.from(`payload-${index}-`.repeat(30)).toString('base64'),
})), null, 1)

const CASES: readonly CompressorCase[] = [
  {
    label: 'json document (opaque cells, table compaction)',
    fixture: OPAQUE_ROWS,
    bands: [0.10, 0.30, 0.60, 0.90, 0.99],
    attempt: (store, band) => {
      const result = crushJsonDocument(OPAQUE_ROWS, { ...SMART_CRUSHER_DEFAULTS, minSavingsRatio: band }, store, '')
      return { applied: result.applied, output: result.output }
    },
  },
  {
    label: 'json value (lossy sample sentinel)',
    fixture: lines(120, index => `{"id": ${index}, "level": "${index % 11 === 0 ? 'ERROR' : 'INFO'}", "message": "task ${index} finished", "duration_ms": ${index * 7}}`),
    bands: [0.10, 0.30, 0.60, 0.90, 0.99],
    attempt: (store, band) => {
      const fixture = lines(120, index => `{"id": ${index}, "level": "${index % 11 === 0 ? 'ERROR' : 'INFO'}", "message": "task ${index} finished", "duration_ms": ${index * 7}}`)
      const result = crushJson(fixture, { ...SMART_CRUSHER_DEFAULTS, minSavingsRatio: band }, store, '')
      return { applied: result.applied, output: result.output }
    },
  },
  {
    label: 'diff',
    fixture: ['alpha.ts', 'gamma.ts'].map(name => [
      `--- a/${name}\t2026-01-01 00:00:00.000000000 +0000`,
      `+++ b/${name}\t2026-01-02 00:00:00.000000000 +0000`,
      '@@ -1,18 +1,18 @@',
      ...Array.from({ length: 8 }, (_value, index) => ` context line ${index} of ${name}`),
      `-old value in ${name}`,
      `+new value in ${name}`,
      ...Array.from({ length: 8 }, (_value, index) => ` trailing context ${index} of ${name}`),
    ].join('\n')).join('\n'),
    bands: [0.40, 0.70, 0.85, 0.90, 0.95],
    attempt: (store, band) => {
      const fixture = CASES[2]!.fixture
      const result = compressDiff(fixture, { ...DIFF_COMPRESSOR_DEFAULTS, maxRatio: band }, store, 1)
      return { applied: result.applied, output: result.compressed }
    },
  },
  {
    label: 'search',
    fixture: lines(120, index => `src/headroom/runtime.ts:${100 + index}:const value${index} = compute(${index}) // keep`),
    bands: [0.40, 0.70, 0.85, 0.90, 0.95],
    attempt: (store, band) => {
      const fixture = CASES[3]!.fixture
      const result = compressSearch(fixture, { ...SEARCH_COMPRESSOR_DEFAULTS, maxRatio: band }, store, [], 1)
      return { applied: result.applied, output: result.compressed }
    },
  },
  {
    label: 'log',
    fixture: lines(140, index => `2026-09-19T09:${String(index % 60).padStart(2, '0')}:01.000Z ${index % 11 === 0 ? 'ERROR' : 'INFO'} worker[${index}] task ${'x'.repeat(50)} id=${index}`),
    bands: [1],
    attempt: (store) => {
      const fixture = CASES[4]!.fixture
      const result = new LogCompressor(LOG_COMPRESSOR_DEFAULTS).compress(fixture, 1, store)
      return { applied: result.compressed !== fixture, output: result.compressed }
    },
  },
  {
    label: 'config',
    fixture: ['# generated by the toolchain, do not edit', ...Array.from({ length: 70 }, (_value, index) => `# annotation ${index} for reviewers of this configuration stanza`), 'title = "demo"', '[server]', 'port = 8080'].join('\n'),
    bands: [1],
    attempt: (store) => {
      const result = compressConfig(CASES[5]!.fixture, 'yaml', store)
      return { applied: result.applied, output: result.output }
    },
  },
  {
    label: 'prose',
    fixture: lines(40, index => `Paragraph ${index} explains in detail how the deployment pipeline reassembles the artifacts after the cache miss, and then records what the operator should check before the next release window closes.`),
    bands: [0.50, 0.70, 0.78, 0.80, 0.82, 0.85, 0.90],
    attempt: (store, band) => {
      const result = crushText(CASES[6]!.fixture, { ...TEXT_CRUSHER_DEFAULTS, maxRatio: band }, store, '')
      return { applied: result.applied, output: result.compressed }
    },
  },
  {
    label: 'tabular',
    fixture: ['| identifier_string | current_status_value | assigned_owner_name |', '|---|---|---|', ...Array.from({ length: 60 }, (_value, index) => `| user_${index} | ${index % 7 === 0 ? 'degraded' : 'active'} | owner_${index % 5} |`)].join('\n'),
    bands: [0.10, 0.30, 0.60, 0.90, 0.99],
    attempt: (store, band) => {
      const fixture = CASES[7]!.fixture
      const detection = detectTabular(fixture)
      if (detection === undefined) return { applied: false, output: fixture }
      const result = compressTabular(fixture, detection, { ...SMART_CRUSHER_DEFAULTS, minSavingsRatio: band }, store)
      return { applied: result.applied, output: result.output }
    },
  },
]

describe('a CCR reference and its entry are two halves of one fact', () => {
  it('writes nothing a rendering does not name, and names nothing it did not write', () => {
    const failures: string[] = []
    let engaged = 0
    let inlineReferences = 0

    for (const testCase of CASES) {
      for (const band of testCase.bands) {
        const store = new RecordingStore()
        const result = testCase.attempt(store, band)
        const where = `${testCase.label} @${band}`
        const named = referencesIn(result.output)
        inlineReferences += named.length

        if (result.applied) engaged += 1

        // 3. A declined rendering is the input, and writes nothing. The second
        // half is the one with teeth: a stash made before the decision leaves an
        // entry no delivered text can name.
        if (!result.applied) {
          if (result.output !== testCase.fixture) failures.push(`${where}: declined but rewrote the input (${result.output.length} chars vs ${testCase.fixture.length})`)
          if (store.writes.length > 0) failures.push(`${where}: declined and still wrote ${store.writes.length} entr(y/ies) — ${store.writes.map(write => write.hash).join(', ')}`)
          continue
        }

        // 2. Every write is named by the rendering that ships.
        for (const write of store.writes) {
          if (!named.includes(write.hash)) failures.push(`${where}: wrote ${write.hash} (${write.payload.length} chars) into CCR while the delivered text names no marker for it`)
        }

        // 1. Every name resolves, and `hash=` resolves to the original bytes.
        for (const hash of named) {
          const payload = store.get(hash)
          if (payload === undefined) {
            failures.push(`${where}: names ${hash}, which the store does not hold`)
            continue
          }
          if (payload === '') failures.push(`${where}: ${hash} resolves to an empty payload`)
          if (result.output.includes(`hash=${hash}`) && payload !== testCase.fixture) {
            failures.push(`${where}: hash=${hash} returned ${payload.length} chars instead of the ${testCase.fixture.length}-char original`)
          }
        }
      }
    }

    // Without these the file passes the day a threshold change makes every case
    // decline: the sweep would be green and would be checking nothing.
    expect(inlineReferences, 'no fixture produced a <<ccr:…>> reference, so the inline half is untested').toBeGreaterThan(0)
    expect(engaged, 'no case reached an accepted rendering').toBeGreaterThan(0)
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })

  it('makes one compression name only hashes the store still holds', () => {
    // A rendering may not advertise a retrieval it cannot honour, and capacity is
    // where that promise is easiest to break: `put` keeps the *newest* entries and
    // drops the oldest insertions, so a single compression that writes more entries
    // than the store holds evicts its own earliest writes — the very hashes the
    // rendering it is about to ship names. The model then calls `headroom_retrieve`
    // four hundred times for bytes that were never missing.
    //
    // Mutation: without the attempt's own budget, the fixture below delivers 1400
    // markers of which the store keeps 1000, i.e. 400 names pointing at nothing.
    const store = new CcrStore()
    const text = JSON.stringify(Array.from({ length: DEFAULT_CAPACITY + 400 }, (_value, index) => ({
      id: index,
      owner: `team_${index % 4}`,
      note: `row ${index}`,
      blob: Buffer.from(`payload-${index}-`.repeat(30)).toString('base64'),
    })), null, 1)
    const result = crushJsonDocument(text, SMART_CRUSHER_DEFAULTS, store, '')
    const named = referencesIn(result.output)
    expect(result.applied, 'the fixture must reach the crusher').toBe(true)
    // The budget caps one attempt at the store's own capacity, so a fixture wanting
    // more than that is served by exactly `DEFAULT_CAPACITY` markers — reaching the
    // ceiling is what makes this the case that tests it rather than one that merely
    // approaches it, and the verbatim row below is the other end of the same fact.
    expect(named.length, 'the fixture must exhaust the store, or the ceiling is untested here').toBeGreaterThanOrEqual(DEFAULT_CAPACITY)
    const dangling = named.filter(hash => store.get(hash) === undefined)
    expect(dangling, `${dangling.length} of ${named.length} named hashes were evicted by this compression's own later writes`).toEqual([])
    // The cells that could not be offloaded are rendered **verbatim**, not dropped:
    // refusing the write must not turn into losing the value — and a refused cell
    // must not carry a marker either, because that marker would name nothing.
    const lastRow = Buffer.from(`payload-${DEFAULT_CAPACITY + 399}-`.repeat(30)).toString('base64')
    expect(result.output).toContain(lastRow.slice(0, 48))
    expect(result.output, 'a cell the store refused must not be marked as retrievable').not.toContain(computeKey(lastRow))
  })

  it('never lets a skeleton marker name a hash the caller did not write', () => {
    // The skeleton is the one entry point that does not own a store: it is handed
    // the hash its caller is about to write. So the check runs the other way — the
    // marker must name exactly that hash, or the caller's write and the model's
    // reference are two different keys.
    const body = [
      '1: export function computeOptimalK(items: readonly string[], bias: number, minK: number, maxK?: number): number {',
      ...Array.from({ length: 90 }, (_value, index) => `${index + 2}:   const value${index} = compute(${index}) // body line the skeleton is expected to elide`),
      '92: }',
    ]
    const text = `<path>src/loader.ts</path>\n<type>file</type>\n<content>\n${body.join('\n')}\n\n(End of file - total ${body.length} lines)\n</content>`
    const hash = 'a'.repeat(24)
    const result = skeletonizeReadOutput(text, hash)
    expect(result.applied, 'the fixture must reach the skeleton').toBe(true)
    expect(referencesIn(result.output)).toEqual([hash])
  })
})
