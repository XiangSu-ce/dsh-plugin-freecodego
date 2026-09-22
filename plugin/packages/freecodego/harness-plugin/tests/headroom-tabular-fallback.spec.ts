/**
 * A table shape must not decide whether the rest of the waterfall runs.
 *
 * The defect these cases pin, measured through the shipped `tools/post-execute`
 * seam: `compressWorking` ended the chain whenever `detectTabular` found a table
 * anywhere in the payload, whether or not the tabular transform delivered
 * anything. A 7.5 KB report of sixty prose sentences containing one six-row
 * markdown table was therefore delivered verbatim — ratio 1.00, every counter at
 * zero — while the same report without the table compressed to 0.50.
 *
 * Two ordinary shapes reach that end: a line of prose after the table (the
 * ingest's jagged-row guard refuses the whole transform) and a table small
 * enough that compacting it cannot beat `acceptRatio` against the preamble it
 * must carry. Both mean "the table step delivered nothing", which is a fact
 * about the table step and not about the payload.
 *
 * The other direction is pinned here too, because the tempting over-fix is to
 * prefer prose everywhere: a payload that *is* a table still takes the tabular
 * branch and still reports itself as one.
 */

import { describe, expect, it } from 'vitest'
import { headroomSeam, referencesIn } from './support/headroom-seam.ts'

const SENTENCES = 60

/** Ordinary prose: no delimiter, no list, no code. */
const PROSE = Array.from(
  { length: SENTENCES },
  (_, index) => `Paragraph ${index} records what the run did and why the choice was made, in ordinary sentences with no delimiter of any kind.`,
).join(' ')

/** Six rows: what a report quotes from a result set. */
const TABLE = [
  '| model | score | notes |',
  '|---|---|---|',
  ...Array.from({ length: 6 }, (_, index) => `| model-${index} | ${index * 7} | within budget |`),
].join('\n')

/** The line that makes the ingest refuse: it is not a row of the table. */
const TRAILING_NOTE = 'Notes: the second run repeated the first, and the retry budget was never reached.'

/** Rows the crusher compacts (the shape `headroom-retrievability` already ships). */
const TABLE_PAYLOAD = [
  '| identifier_string | current_status_value | assigned_owner_name |',
  '|---|---|---|',
  ...Array.from({ length: 60 }, (_, index) => `| user_${index} | ${index % 7 === 0 ? 'degraded' : 'active'} | owner_${index % 5} |`),
].join('\n')

const ratioOf = (text: string, out: string): number =>
  Buffer.byteLength(out, 'utf8') / Buffer.byteLength(text, 'utf8')

describe('a refused table transform does not switch the waterfall off', () => {
  it('compresses a report that quotes a table and then adds a note', async () => {
    // The ingest's jagged guard: the note has one cell where the table has
    // three, so the transform refuses the payload as a whole.
    const text = `${PROSE}\n\n${TABLE}\n\n${TRAILING_NOTE}`
    const seam = headroomSeam()
    const out = await seam.run(text)
    const status = seam.status()
    expect(ratioOf(text, out)).toBeLessThan(0.6)
    // Delivered by the prose path, and reported as such: crediting the table
    // compressor for a rendering it refused is how the panel stops describing
    // what happened.
    expect(status.tabularCompressions).toBe(0)
    expect(status.proseCompressions).toBeGreaterThan(0)
    // Every reference the rendering names resolves to the original payload.
    const refs = referencesIn(out)
    expect(refs.length).toBeGreaterThan(0)
    for (const hash of refs) expect(await seam.retrieve(hash)).toContain('Paragraph 0')
  })

  it('compresses a report whose table compacted but lost the whole-payload ratio', async () => {
    // Here the transform *applies* — the table is a few percent of the payload,
    // so its rendering cannot reach the acceptance ratio against 7 KB of
    // preamble it carries verbatim.
    const text = `${PROSE}\n\n${TABLE}`
    const seam = headroomSeam()
    const out = await seam.run(text)
    const status = seam.status()
    expect(ratioOf(text, out)).toBeLessThan(0.6)
    expect(status.tabularCompressions).toBe(0)
    expect(status.proseCompressions).toBeGreaterThan(0)
  })

  it('delivers the same size whether or not the report quotes a table', async () => {
    // The property, stated without naming a branch: quoting a table is not a
    // reason for a document to travel uncompressed. Both readings are measured
    // on the same seam in the same run.
    const shapes = [
      PROSE,
      `${PROSE}\n\n${TABLE}\n\n${TRAILING_NOTE}`,
      `${PROSE}\n\n${TABLE}`,
      `${PROSE}\n\n${TRAILING_NOTE}\n\n${TABLE}`,
      // The table first and the prose after it: the orientation with no
      // preamble at all, where every line of prose is refused as a row.
      `${TABLE}\n\n${PROSE}`,
    ]
    const ratios: number[] = []
    for (const text of shapes) ratios.push(ratioOf(text, await headroomSeam().run(text)))
    expect(Math.max(...ratios)).toBeLessThan(0.6)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.15)
  })
})

describe('a payload that is a table still takes the table branch', () => {
  it('compacts and reports itself as tabular', async () => {
    const seam = headroomSeam()
    const out = await seam.run(TABLE_PAYLOAD)
    const status = seam.status()
    expect(ratioOf(TABLE_PAYLOAD, out)).toBeLessThan(0.85)
    // The fall-through added above must not become "prose wins over a table":
    // when the transform delivers, its rendering is what the model receives.
    expect(status.tabularCompressions).toBe(1)
    expect(status.proseCompressions).toBe(0)
    for (const hash of referencesIn(out)) expect(await seam.retrieve(hash)).toContain('identifier_string')
  })
})
