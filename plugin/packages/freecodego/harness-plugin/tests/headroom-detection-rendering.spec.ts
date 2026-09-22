/**
 * Colour is decoration, and no shape decision may read it.
 *
 * Every content test in this subsystem is a `^`-anchored line test or an exact
 * prefix test — `diff --git`, `<!doctype`, `2026-09-19T09:00`, `^```(\w*)$`,
 * `^\s*[[{]`, `^[^\s:]+:\d+:`, `\b(ERROR|FATAL)\b`. A coloured line starts with
 * `\x1b[32m`, so SGR escapes defeated whole families of them at once, and each
 * spelling failed silently: the wrong compressor answered, or no compressor did.
 * Measured on the fixtures below, before the strip:
 *
 * - a **coloured application log** was typed `search` at confidence 1.0, because
 *   the clock guard that sends logs to the log compressor needs the line to
 *   *start* with the clock (`headroom-log-routing.spec.ts` pins that rule for
 *   uncoloured logs);
 * - a **coloured mixed payload** was not mixed content at all — `mixed=true` with
 *   sections `text code json text` on the plain bytes, `false` with one `text`
 *   section painted — so a fenced command, a JSON block and a block of matches
 *   were handed to the prose crusher as one run of lines.
 *
 * The rule is one line long and lives on both public entry points: `stripAnsi` is
 * applied to the payload before any test reads it (`detectContentType`,
 * `looksLikeSearchOutput`, `mixedContentIndicators`, `splitIntoSections`). What is
 * deliberately *not* done is stripping the content itself — a section still
 * carries the payload's own bytes, so the partition invariant (the sections
 * re-join to exactly what arrived) survives the fix, and a compressor that cannot
 * read escapes refuses rather than shipping a silently colour-free document. That
 * refusal is measured and asserted below rather than left as a surprise.
 *
 * The last case is also where the two spellings are compared as *products* rather
 * than as verdicts, because a refused section used to be an advantage: the payload
 * whose section refused was handed to the whole-payload stage (0.478) while the
 * payload whose section succeeded stopped at its splice (0.684). A splice is a
 * candidate now, held until the chain has had its turn, so both spellings land on
 * the same stage and within 0.003 of each other.
 *
 * The corpus is every content type the detector can return, plus the mixed shape,
 * which is the point: this is the sweep that would have caught the log misroute
 * before a fixture happened to carry the right spelling.
 */

import { describe, expect, it } from 'vitest'
import { detectContentType } from '../src/headroom/content-detector.ts'
import { isMixedContent, splitIntoSections } from '../src/headroom/mixed-content.ts'
import { looksLikeSearchOutput } from '../src/headroom/search-compressor.ts'
import { headroomSeam, referencesIn } from './support/headroom-seam.ts'

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const ratioOf = (from: string, to: string): number => bytesOf(to) / Math.max(1, bytesOf(from))

const SENTENCE = (index: number): string =>
  `The ${index}th paragraph explains why this particular decision was taken, in ordinary words that repeat no structure at all.`

/** SGR-paint every line, which is how a terminal colouring tool delivers one. */
const paint = (text: string, code = 32): string => text.split('\n').map(line => `\u001b[${code}m${line}\u001b[0m`).join('\n')

const GREPS = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts:${10 + i}: const value = f()`).join('\n')

/** One fixture per content type the detector can return, at a size it can act on. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['json', `[${Array.from({ length: 60 }, (_, i) => `{"id":${i},"name":"row_${i}","status":"active"}`).join(',')}]`],
  ['diff', ['diff --git a/src/x.ts b/src/x.ts', 'index 1111111..2222222 100644', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new'].join('\n')],
  ['html', `<!doctype html><html><head><title>t</title></head><body><div><span><p>${SENTENCE(1)}</p></span></div></body></html>`],
  ['search', GREPS],
  ['log', Array.from({ length: 12 }, (_, i) => `2026-09-20T10:00:0${i % 10}.000Z INFO worker[${i}] handled id=req-${i}`).join('\n')],
  ['tabular-markdown', ['| id | name | status |', '|----|------|--------|', ...Array.from({ length: 8 }, (_, i) => `| ${i} | row_${i} | active |`)].join('\n')],
  ['tabular-csv', [['id', 'name', 'status'].join(','), ...Array.from({ length: 8 }, (_, i) => [i, `row_${i}`, 'active'].join(','))].join('\n')],
  ['config', ['service:', '  name: worker', '  mode: batch', '  retry: 3', '  timeout: 30', '  log:', '    level: info', '    format: json'].join('\n')],
  ['code', Array.from({ length: 8 }, (_, i) => `export function helper_${i}(value: string): string {\n  const trimmed = value.trim()\n  return trimmed + ${i}\n}`).join('\n')],
  ['text', Array.from({ length: 12 }, (_, i) => SENTENCE(i)).join('\n\n')],
]

/** Prose + fenced command + a block of matches + prose: the mixed shape. */
const MIXED = [
  Array.from({ length: 30 }, (_, i) => SENTENCE(i)).join('\n'),
  '```sh',
  'find . -name "*.ts" | head -20',
  '```',
  Array.from({ length: 20 }, (_, i) => `src/deep/module.ts:${200 + i}:  const value_${i} = fn(${i}) // ${'y'.repeat(200)}`).join('\n'),
  Array.from({ length: 30 }, (_, i) => SENTENCE(i + 40)).join('\n'),
].join('\n')

const MIXED_WITH_JSON = [
  Array.from({ length: 9 }, (_, i) => SENTENCE(i)).join(' '),
  '```sh',
  'find . -name "*.ts" | head -20',
  '```',
  `[${Array.from({ length: 60 }, (_, i) => `{"id":${i},"name":"row_${i}","status":"active"}`).join(',')}]`,
  Array.from({ length: 9 }, (_, i) => SENTENCE(i + 20)).join(' '),
].join('\n')

describe('every content type survives being painted', () => {
  for (const [name, text] of CORPUS) {
    it(`${name}: the verdict is the same bytes with and without colour`, () => {
      const plain = detectContentType(text)
      expect(plain.contentType, `${name}: the fixture does not detect as expected`).toBe(name.startsWith('tabular') ? 'tabular' : name)
      // The whole verdict, not just the type: confidence and metadata are read from
      // the same rendered text, so a decision that only *partly* ignores colour would
      // show up here rather than pass.
      expect(detectContentType(paint(text))).toEqual(plain)
      expect(looksLikeSearchOutput(paint(text))).toBe(looksLikeSearchOutput(text))
      expect(isMixedContent(paint(text))).toBe(isMixedContent(text))
    })
  }

  it('the mixed shape splits the same way painted', () => {
    // The failure this replaced: `mixed=false` and a single `text` section for the
    // coloured bytes, `mixed=true` with `text code json text` for the same payload.
    expect(isMixedContent(MIXED)).toBe(true)
    expect(isMixedContent(paint(MIXED))).toBe(true)
    const plainTypes = splitIntoSections(MIXED).map(section => section.contentType)
    expect(plainTypes).toEqual(['text', 'code', 'search', 'text'])
    expect(splitIntoSections(paint(MIXED)).map(section => section.contentType)).toEqual(plainTypes)
    // The partition invariant the fix had to keep: sections are slices of the
    // payload, escapes included, so colour is never dropped by the act of splitting.
    for (const payload of [MIXED, paint(MIXED), MIXED_WITH_JSON, paint(MIXED_WITH_JSON)]) {
      expect(splitIntoSections(payload).map(section => section.content).join('\n')).toBe(payload)
    }
  })

  it('the coloured mixed payload compresses, not just splits', async () => {
    // The cost side of the same bug, through the shipped seam. Before the fix the
    // coloured bytes had no sections to compress, so the only stage left was the
    // whole-payload prose crusher (and here its 4 KB section floor was not met),
    // and the payload went out at 1.00.
    const plainSeam = headroomSeam()
    const plain = await plainSeam.run(MIXED)
    const colouredSeam = headroomSeam()
    const coloured = await colouredSeam.run(paint(MIXED))
    expect(ratioOf(MIXED, plain)).toBeLessThan(0.8)
    expect(ratioOf(paint(MIXED), coloured)).toBeLessThan(0.8)
    // The same stage answers both, and it is the prose crusher: measured, 0.512 on
    // either spelling.
    expect(plainSeam.status().proseCompressions).toBe(1)
    expect(colouredSeam.status().proseCompressions).toBe(1)
    expect(colouredSeam.status().losslessCompressions).toBe(0)
    // Matching counts on the other two counters are what says the *sections* were
    // reached before the prose stage answered: the match block's fold is demoted and
    // beaten (1/1 on both counters), the splice that would have carried it is
    // demoted and beaten too — so this payload is the case where a splice exists and
    // loses, rather than one where no section compressed at all.
    expect(plainSeam.status().foldSuperseded).toBeGreaterThanOrEqual(1)
    expect(colouredSeam.status().foldSuperseded).toBeGreaterThanOrEqual(1)
    // Within a few points of each other — the escapes are the only difference left.
    expect(Math.abs(ratioOf(MIXED, plain) - ratioOf(paint(MIXED), coloured))).toBeLessThan(0.05)
    const refs = referencesIn(coloured)
    expect(refs.length).toBe(1)
    expect(await colouredSeam.retrieve(refs[0]!)).toContain('const value_19')
  })

  it('a coloured JSON section is recognised and then refused, never silently stripped', async () => {
    // The boundary of the rule, asserted so it cannot drift into an accidental
    // colour drop: the *section* is recognised (the coloured bytes split the same
    // way) and it still carries the payload's own bytes, so the crusher is handed an
    // escaped document, refuses it, and nothing has quietly lost its colour.
    const painted = paint(MIXED_WITH_JSON)
    const sections = splitIntoSections(painted)
    expect(sections.map(section => section.contentType)).toEqual(['text', 'code', 'json', 'text'])
    const jsonSection = sections.find(section => section.contentType === 'json')!
    expect(jsonSection.content).toContain('\u001b[32m[')
    const colouredSeam = headroomSeam()
    const coloured = await colouredSeam.run(painted)
    expect(colouredSeam.status().jsonCompressions).toBe(0)
    // The saving is not lost, which is why refusing is the right outcome for a
    // coloured block rather than stripping it: the whole-payload stage takes the
    // payload, delivers 0.478, and its marker resolves to the payload byte for byte,
    // so the escapes and the block are both one `headroom_retrieve` away.
    const plainSeam = headroomSeam()
    const plain = await plainSeam.run(MIXED_WITH_JSON)
    // The same stage answers it, and this pair is the case that made the splice a
    // candidate rather than a verdict. It used to ship on sight at 0.684 here, while
    // the *coloured* payload — where the JSON section refused — was answered at 0.478
    // by the whole-payload stage: adding terminal escapes made the compression 20
    // points better, which is the inversion. Now the splice is held, the stage behind
    // it delivers 0.475, and the two spellings agree to within the escapes
    // themselves (0.003 — the escapes are inside the dropped block, so the plain
    // payload is the smaller of the two).
    expect(plainSeam.status().jsonCompressions).toBe(0)
    expect(plainSeam.status().proseCompressions).toBe(1)
    expect(ratioOf(MIXED_WITH_JSON, plain)).toBeLessThan(0.5)
    expect(ratioOf(painted, coloured)).toBeLessThan(0.55)
    expect(Math.abs(ratioOf(MIXED_WITH_JSON, plain) - ratioOf(painted, coloured))).toBeLessThan(0.005)
    // The ledger is what says the splice really was on offer here and lost on bytes
    // rather than never existing: one demotion, one supersede, nothing settled.
    expect(plainSeam.status().foldDeferred).toBe(1)
    expect(plainSeam.status().foldSuperseded).toBe(1)
    expect(plainSeam.status().foldSettled).toBe(0)
    // The coloured payload had no candidate at all, which is the other half of the
    // comparison: nothing was demoted, nothing was spent.
    expect(colouredSeam.status().foldDeferred).toBe(0)
    const refs = referencesIn(coloured)
    expect(refs.length).toBe(1)
    expect(await colouredSeam.retrieve(refs[0]!)).toBe(painted)
  })
})
