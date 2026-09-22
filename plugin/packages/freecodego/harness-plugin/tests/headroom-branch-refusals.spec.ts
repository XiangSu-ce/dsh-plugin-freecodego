/**
 * What a refused branch is allowed to do to the rest of the waterfall.
 *
 * `compressWorking` is a chain: every typed branch may refuse the payload it was
 * handed, and whether that refusal ends the chain decides whether a payload
 * reaches the generic stages at all. Two questions decide each row, and they are
 * different questions:
 *
 * 1. **How was the branch entered?** A *whole-payload* reading (`detectContentType`'s
 *    verdict, or `looksLikeSearchOutput`'s ≥80%-of-lines proportion) settles what
 *    the payload is; a *reading of a part* (`detectTabular` finding a table in
 *    some lines, `isMixedContent` finding sections) does not, so it can never
 *    justify ending the chain.
 * 2. **Can the surviving lines be read without the absent ones?** This is what
 *    the fall-through actually turns on, and the line-structured branches answer
 *    it differently — measured on this file's own fixtures, after the text stage
 *    stopped re-flowing its input:
 *    - a **diff**'s lines are *paired* and *located*, so the text stage selects a
 *      *change* there: both halves plus the header that places them, which makes
 *      a partial diff a faithful subset of this diff (5652 -> 2832 bytes, 14
 *      complete changes). Before that rule existed the same fixture kept 21 of 30
 *      removals against 14 of 30 additions with no hunk header at all — a
 *      different change set, not a smaller one — and this row was a refusal;
 *    - a **log**'s important line is what a generic scorer measurably misses
 *      (2 of 5 ERROR records kept), while the log compressor's own anchor rule
 *      exists for exactly that;
 *    - a **search** result is a list of *homogeneous, independent* records: which
 *      matches survive does not change what the survivors say, so it falls
 *      through, and the text stage's marker reports how many lines it kept.
 *
 * | branch  | entered on                          | refusal                   | delivered  | text stage |
 * |---------|-------------------------------------|---------------------------|------------|------------|
 * | json    | verdict                             | rendering above the ratio | verbatim   | 0.49 declined |
 * | html    | verdict                             | extraction above the ratio| verbatim   | 0.50 declined |
 * | log     | verdict                             | anchors covered every line| verbatim   | 0.52 refused: anchors |
 * | config  | verdict                             | fold and elision empty    | verbatim   | nothing to select |
 * | code    | verdict                             | pass-through by design    | verbatim   | 0.50 declined |
 * | diff    | verdict                             | compressor found no fold  | compressed | taken: changes stay paired |
 * | search  | verdict (fewer than 10 matches)     | compressor floor          | compressed | taken, and it says so |
 * | mixed   | sections found (part)               | cannot change a section   | compressed | – |
 * | tabular | shape found (part)                  | ingest refused            | compressed | – |
 *
 * The "text stage" column is measured: for every row above except `config` the
 * generic stage *would* deliver roughly half, and for `log` it does — so that
 * refusal is a decision with a cost, re-made deliberately here rather than
 * drifted into. The two rows that moved into it did so for one reason each, and
 * both are pinned below: `search` once the stage stopped re-flowing its input (on
 * that row's fixture it used to keep 3 of 9 match lines and glue their heads —
 * `pkg_0/src/module_0.pkg_1/…` — because its unit was a sentence and the `.` in
 * `.ts` ended one), and `diff` once the stage began selecting a change as a change
 * (both halves plus the header that locates them) instead of scoring its lines
 * independently. Change either rule and the row must be re-decided, which is what
 * the cases below fail on.
 *
 * One thing did change since those rows were decided, and it widens `search`: the
 * **scope** of the fall-through. Stage 2's lossless fold used to return at any
 * ratio, so a search result whose matches shared a directory or file prefix was
 * answered by a 1.6% reversible fold before this branch was reached — measured on
 * the shared-prefix fixture, which then delivered 0.984 with no marker. The fold
 * now competes unless it clears the bar at which it is a delivery on its own (see
 * `headroom-fold-competition.spec.ts`), so that shape arrives here and is
 * delivered at 0.47 as a subset of whole matches with a marker. The row's
 * reasoning is the one above and it is unchanged; what changed is which payloads
 * it applies to, and the last case in this file is the one that pins it.
 *
 * `headroom-tabular-fallback.spec.ts` carries the tabular case that started this
 * (a 7.5 KB report quoting one six-row table, delivered verbatim where the same
 * report without the table compressed to 0.50).
 */

import { describe, expect, it } from 'vitest'
import { headroomSeam, referencesIn } from './support/headroom-seam.ts'
import { CcrStore } from '../src/headroom/ccr.ts'
import { detectContentType } from '../src/headroom/content-detector.ts'
import { compactLossless } from '../src/headroom/lossless-compaction.ts'
import { compressTabular, detectTabular } from '../src/headroom/tabular-ingest.ts'
import { SMART_CRUSHER_DEFAULTS, crushJsonDocument } from '../src/headroom/smart-crusher.ts'
import { compressDiff, DIFF_COMPRESSOR_DEFAULTS } from '../src/headroom/diff-compressor.ts'
import { compressHtml } from '../src/headroom/html-extractor.ts'
import { SEARCH_COMPRESSOR_DEFAULTS, compressSearch } from '../src/headroom/search-compressor.ts'
import { compressConfig } from '../src/headroom/config-compressor.ts'
import { LogCompressor } from '../src/headroom/log-compressor.ts'
import { isMixedContent, splitIntoSections } from '../src/headroom/mixed-content.ts'
import { TEXT_CRUSHER_DEFAULTS, crushText } from '../src/headroom/text-crusher.ts'
import { protectTags, restoreTags } from '../src/headroom/tag-protector.ts'

const MIN_RATIO = 0.85
/** `MIN_COMPRESSIBLE_CHARS` in the runtime: below this nothing is even considered. */
const PIPELINE_FLOOR = 1_200

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const ratioOf = (from: string, to: string): number => bytesOf(to) / Math.max(1, bytesOf(from))
/** Either stage's own marker line, which is never a payload line. */
const MARKER = /^\[(?:Text|Prose) compressed from /u

/** One ordinary sentence, long enough that a selection of them is a real saving. */
const SENTENCE = (index: number): string =>
  `The ${index}th paragraph explains why this particular decision was taken, in ordinary words that repeat no structure at all.`

/**
 * What the generic text stage would have delivered, measured with the stage's own
 * function and its own acceptance ratio. This is the cost side of every
 * deliberate refusal above; `undefined` means the stage would have refused too.
 */
function textStageWouldDeliver(text: string): number | undefined {
  const protectedProse = protectTags(text, false)
  const prose = crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, undefined, '')
  if (!prose.applied) return undefined
  const restored = restoreTags(prose.compressed, protectedProse.blocks)
  const value = ratioOf(text, restored)
  return value <= MIN_RATIO ? value : undefined
}

/** The stage as the pipeline runs it: real store, marker written, tags restored. */
function textStageRendering(text: string): { readonly rendered: string; readonly store: CcrStore } {
  const store = new CcrStore()
  const protectedProse = protectTags(text, false)
  const prose = crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, store, '')
  return { rendered: restoreTags(prose.compressed, protectedProse.blocks), store }
}

const JSON_BODY = `[${Array.from({ length: 40 }, (_, i) => `"${SENTENCE(i)} entry ${i} of a list whose rows are all distinct strings"`).join(',\n')}]`

/**
 * A `git diff -U0` of one hunk: 30 removals, 30 additions, no context lines.
 *
 * Every part of that shape is load-bearing. `maxHunksPerFile` is 10, so a
 * twelve-hunk diff *is* folded — hunks are dropped and their context trimmed to
 * ±2 — and the branch never reaches the refusal this row is about; the shape
 * required here is a diff with nothing left to fold, which is what `-U0` gives:
 * `trimContext` keeps every line, no hunk exceeds the cap, there is no `index`
 * line to strip, so the compressor's own rendering is its input and its ratio
 * gate refuses it.
 *
 * The removals are short and the additions carry a sentence, which is the
 * ordinary direction (a call site is replaced by a longer one) and also the one
 * that shows what the fall-through would do: the two halves of each change are
 * *paired*, and a line-level selection does not keep pairs.
 */
const DIFF_BODY = [
  'diff --git a/src/worker.ts b/src/worker.ts',
  '--- a/src/worker.ts',
  '+++ b/src/worker.ts',
  '@@ -5,30 +5,30 @@ export class Worker {',
  ...Array.from({ length: 30 }, (_, i) => `-  const removed_${i} = legacy(${i})`),
  ...Array.from({ length: 30 }, (_, i) => `+  const added_${i} = modern(${i}, "${SENTENCE(i)}")`),
].join('\n')

const HTML_BODY = `<!doctype html>\n<html><head><title>report</title></head><body><div><span>${Array.from({ length: 40 }, (_, i) => `<p>${SENTENCE(i)}</p>`).join('')}</span></div></body></html>`

/** Six matches in six directories: below `minMatches`, and no repeated prefix to fold. */
const SEARCH_BODY = Array.from(
  { length: 9 },
  (_, i) => `pkg_${i}/src/module_${i}.ts:${200 + i}:  const value_${i} = fn(${i}) // ${'y'.repeat(430 - i)}`,
).join('\n')

/**
 * Forty distinct records, long enough that the payload clears the text stage's
 * own 4 KB floor — the size is what makes the counterfactual real, and it is the
 * reason these lines carry a second sentence.
 *
 * The refusal is the ordinary one for this length and worth stating exactly:
 * `selectLines` anchors on the five errors and the seven warnings and adds
 * `errorContextLines` around each, which already covers every line, so nothing is
 * dropped, `formatOutput` returns the input, and there is no
 * `[N lines omitted]` body to deliver. Five errors are spread through the
 * payload because they are the lines a reader scans for.
 *
 * The fixture used to be 160 lines, which its own compressor *does* compress; the
 * row's guard — `the fixture is not refused by its own compressor` — is what
 * caught that, which is what it is there for.
 */
const LOG_BODY = Array.from({ length: 40 }, (_, i) => {
  const stamp = `2026-09-20T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`
  if (i % 8 === 0) return `${stamp} ERROR payment gateway timed out after ${30000 + i}ms settling order ${900000 + i}: the upstream acquirer closed the socket before the retry window ran out`
  if (i % 5 === 0) return `${stamp} WARN retry budget spent on shard ${i % 4} after ${i} attempts: the next attempt will be scheduled with the backoff table`
  return `${stamp} INFO request ${i} handled by handler_${i % 9} in ${10 + (i % 40)}ms: the response was written and the connection returned to the pool`
}).join('\n')

/** A real config document: sections, keys, all distinct, no comment to elide. */
const CONFIG_BODY = `service:\n${Array.from({ length: 60 }, (_, i) => `  handler_${i}:\n    path: /opt/handler_${i}\n    timeout: ${i}`).join('\n')}`

/** Source code, which the chain refuses to hand to any lossy compressor. */
const CODE_BODY = [
  "import { readFileSync } from 'node:fs'",
  ...Array.from({ length: 60 }, (_, i) => `export function helper_${i}(value: string): string {\n  const trimmed = value.trim()\n  return trimmed.toLowerCase() + ${i}\n}`),
].join('\n')

const SMALL_BODY = `${SENTENCE(1)} ${SENTENCE(2)} ${SENTENCE(3)}`

interface Refusal {
  readonly branch: string
  readonly text: string
  /** The branch's own compressor refusing, checked with its own implementation. */
  readonly refuses: (text: string) => boolean
  readonly refusal: string
  /** Whether the text stage would have delivered, so the row states its cost. */
  readonly counterfactual: boolean
}

const REFUSALS: readonly Refusal[] = [
  {
    branch: 'json',
    text: JSON_BODY,
    // The crusher compacts forty distinct strings, and its rendering is still
    // 0.994 of the payload — there was nothing to win behind the marker.
    refuses: text => ratioOf(text, crushJsonDocument(text, SMART_CRUSHER_DEFAULTS, undefined, '').output) > MIN_RATIO,
    refusal: 'the rendering the crusher produced did not clear the acceptance ratio',
    counterfactual: true,
  },
  {
    branch: 'html',
    text: HTML_BODY,
    refuses: text => !compressHtml(text).applied,
    refusal: 'stripping the markup did not beat the ratio (this page is nearly all text)',
    counterfactual: true,
  },
  {
    branch: 'log',
    text: LOG_BODY,
    refuses: text => new LogCompressor().compress(text, 1).compressed === text,
    // Not "nothing worth keeping": the anchor rule kept *everything* — every line
    // is an error, a warning, or context around one — so the rendering is the
    // input and there is no `[N lines omitted]` body to deliver.
    refusal: 'the anchors and their context already covered every line',
    counterfactual: true,
  },
  {
    branch: 'config',
    text: CONFIG_BODY,
    refuses: (text) => {
      const config = compressConfig(text, 'yaml', undefined)
      return !config.applied || ratioOf(text, config.output) > MIN_RATIO
    },
    refusal: 'nothing to fold and no comment to elide',
    counterfactual: false,
  },
  {
    branch: 'code',
    text: CODE_BODY,
    refusal: 'source code passes through unmangled, so this branch refuses by design',
    refuses: () => true,
    counterfactual: true,
  },
]

describe('a refusal ends the chain when the surviving lines need the absent ones', () => {
  for (const row of REFUSALS) {
    it(`${row.branch}: ${row.refusal}`, async () => {
      const text = row.text
      // The refusal is the branch's own, checked with its own implementation.
      expect(row.refuses(text), `${row.branch}: the fixture is not refused by its own compressor`).toBe(true)
      // What the generic text stage would have delivered. Recorded so the
      // decision is visible: for most of these rows the answer is "about half",
      // and it is declined on purpose (see the module header).
      const counterfactual = textStageWouldDeliver(text)
      if (row.counterfactual) {
        expect(counterfactual, `${row.branch}: the text stage had no saving to decline`).toBeDefined()
        expect(counterfactual!).toBeLessThanOrEqual(MIN_RATIO)
      } else {
        expect(counterfactual, `${row.branch}: the text stage now delivers, so this row's cost changed`).toBeUndefined()
      }
      const seam = headroomSeam()
      const out = await seam.run(text)
      // Delivered verbatim, and reported as nothing-happened: a counter that
      // claimed a compression the model did not receive is the one outcome this
      // whole module refuses.
      expect(ratioOf(text, out), `${row.branch}: the refused branch still changed the payload`).toBe(1)
      expect(seam.status().compressions, `${row.branch}: a refusal was still credited`).toBe(0)
    })
  }
})

describe('why a count cannot repair the log refusal', () => {
  it('log: the scorer misses the lines the log compressor exists to keep', () => {
    // Salience is a per-word *average*, so a long record — which is what an error
    // usually is, once it says what happened — scores below a short informational
    // one. Measured here: 2 of the 5 ERROR records survive. The log branch's
    // anchor rule ("keep every error, keep the first and last of a run") is the
    // guarantee for precisely this, and a count of kept lines does not repair it:
    // it counts lines, while what went missing is a *class* of lines, silently.
    const { rendered, store } = textStageRendering(LOG_BODY)
    const refs = referencesIn(rendered)
    expect(store.get(refs[0]!)).toBe(LOG_BODY)
    const payloadLines = LOG_BODY.split('\n')
    const renderedLines = rendered.split('\n')
    const errorsTotal = payloadLines.filter(line => line.includes('ERROR')).length
    const errorsKept = payloadLines
      .filter(line => line.includes('ERROR') && renderedLines.includes(line)).length
    expect(errorsTotal).toBeGreaterThan(3)
    expect(errorsKept).toBeLessThan(errorsTotal)
    expect(errorsKept).toBeGreaterThan(0)
  })
})

describe('a refusal falls through when the line is not the unit the payload needs', () => {
  it('search: the stage takes it, keeps every surviving line whole, and reports the drop', async () => {
    // Nine matches in nine directories: below the search compressor's floor of
    // ten, and with no repeated directory prefix for the lossless fold to
    // factor — so this payload reaches the stage that used to end the chain.
    expect(!compressSearch(SEARCH_BODY, SEARCH_COMPRESSOR_DEFAULTS, undefined, []).applied).toBe(true)
    const seam = headroomSeam()
    const out = await seam.run(SEARCH_BODY)
    expect(ratioOf(SEARCH_BODY, out)).toBeLessThan(0.6)
    // Every surviving match line is whole, with the `path:line:` token that is
    // the entire content of a match. Membership is by *exact* rendered line, and
    // the converse is asserted too — nothing in the rendering that the payload did
    // not contain — because the old stage kept 3 of these 9 and glued the heads
    // of the rest together (`pkg_0/src/module_0.pkg_1/…`), a rendering that a
    // substring test cannot tell from this one.
    const payloadLines = SEARCH_BODY.split('\n')
    const renderedLines = out.split('\n')
    const surviving = payloadLines.filter(line => renderedLines.includes(line))
    expect(surviving).toHaveLength(4)
    expect(surviving.every(line => /^[\w/.-]+\.ts:\d+:/.test(line))).toBe(true)
    const foreign = renderedLines.filter(line => line !== '' && !MARKER.test(line) && !payloadLines.includes(line))
    expect(foreign).toEqual([])
    // And the rendering says how much of the result it is: a subset of matches
    // that reads as the whole answer is the one outcome this row must not have.
    expect(out).toContain(`${surviving.length} of ${payloadLines.length} lines kept`)
    // Retrievable, and credited as the stage that actually delivered it.
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(SEARCH_BODY)
    expect(seam.status().proseCompressions).toBe(1)
    expect(seam.status().searchCompressions).toBe(0)
  })

  it('diff: a change is kept as a change, so what ships is a subset of this diff', async () => {
    // The pairing rule (`readDiffPairing` in `text-crusher.ts`), measured through
    // the same seam the model sees. The refusal above the line rule was what kept
    // this row a refusal: 21 of 30 removals against 14 of 30 additions and no
    // hunk header, which is a change set the payload did not contain. With the
    // change as the unit it is 14 complete changes — 5652 -> 2832 bytes (0.50) —
    // each one a removal with its addition, under the header that places them.
    const seam = headroomSeam()
    const out = await seam.run(DIFF_BODY)
    expect(ratioOf(DIFF_BODY, out)).toBeLessThan(0.6)
    const payloadLines = DIFF_BODY.split('\n')
    const renderedLines = out.split('\n')
    const keptLine = (index: number): boolean => renderedLines.includes(payloadLines[index]!)
    const indices = (prefix: string, notThis: string): readonly number[] =>
      payloadLines.map((line, index) => ({ line, index })).filter(entry => entry.line.startsWith(prefix) && !entry.line.startsWith(notThis)).map(entry => entry.index)
    const removals = indices('-', '---')
    const additions = indices('+', '+++')
    expect(removals).toHaveLength(30)
    expect(additions).toHaveLength(30)
    // The pairing, read the way the stage reads it: positionally inside the
    // change block. A kept removal whose addition is absent would mean the rule
    // is not in force, and that is exactly what this row was re-decided on.
    let changes = 0
    for (let index = 0; index < Math.min(removals.length, additions.length); index += 1) {
      const removed = keptLine(removals[index]!)
      expect(keptLine(additions[index]!), `change ${index} kept a removal without its addition`).toBe(removed)
      if (removed) changes += 1
    }
    expect(changes).toBeGreaterThan(0)
    // Every change line on screen belongs to one of those changes: no half-pairs.
    expect(renderedLines.filter(line => line.startsWith('-') && !line.startsWith('---'))).toHaveLength(changes)
    expect(renderedLines.filter(line => line.startsWith('+') && !line.startsWith('+++'))).toHaveLength(changes)
    // And the lines that locate them are on screen: without the hunk header a
    // change cannot be placed in the file, which is what made this row a refusal.
    expect(renderedLines).toContain('@@ -5,30 +5,30 @@ export class Worker {')
    expect(renderedLines).toContain('diff --git a/src/worker.ts b/src/worker.ts')
    // The marker reports the same count it is attached to, and the original is
    // retrievable — the partial diff is a view, and the view says so.
    const kept = renderedLines.filter(line => line !== '' && !MARKER.test(line) && payloadLines.includes(line)).length
    expect(out).toContain(`${kept} of ${payloadLines.length} lines kept`)
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(DIFF_BODY)
    // Credited to the stage that delivered it: the diff branch refused this
    // payload, so a `diff` counter here would report a compression the model did
    // not receive from it (the same accounting the search row pins).
    expect(seam.status().diffCompressions).toBe(0)
    expect(seam.status().proseCompressions).toBe(1)
  })

  it('diff: a payload that merely contains + and - lines is left on the line rule', async () => {
    // The pairing is read only when the payload really is a diff — at least one
    // `@@` header and a change block to pair. A listing with `+` lines is not a
    // diff, and must not acquire diff semantics: nothing is paired here, and the
    // stage's own refusal stands (a listing of 60 lines whose 20 `+` lines are
    // not a change set).
    const listing = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `+ added_${i} = value(${i})` : `  plain_${i} = other(${i})`)).join('\n')
    expect(compressDiff(listing, DIFF_COMPRESSOR_DEFAULTS, undefined, 1).applied).toBe(false)
    const seam = headroomSeam()
    const out = await seam.run(listing)
    expect(out).toBe(listing)
    expect(seam.status().compressions).toBe(0)
  })

  it('search: a foldable prefix is now a candidate like every other stage', async () => {
    // This shape — matches that share a directory prefix — used to be answered by
    // Stage 2 *before* this branch was asked, and this case pinned that: the fold
    // is reversible, so it outranked everything, and the fall-through above was
    // the narrow case. Stage 2's fold now competes unless it clears the bar at
    // which a fold is a delivery on its own, and this one does not: measured
    // 0.984 (4310 -> 4239) with `compactLossless`, so the payload reaches the
    // stage and the stage's own decision applies to it.
    //
    // The row's reasoning has not changed, which is why the outcome is a
    // re-decision rather than a regression: a search result is a list of
    // homogeneous, independent records (question 2 in the header), and a 1.6%
    // reversible saving is not a finding about that shape. The fillers are long so
    // the payload clears both the pipeline floor and the text stage's own 4 KB
    // floor — without that the counterfactual is a fixture artifact.
    const sameDir = Array.from({ length: 9 }, (_, i) => `src/deep/module_${i}.ts:${200 + i}:  const value_${i} = fn(${i}) // ${'y'.repeat(430 - i)}`).join('\n')
    const fold = compactLossless(sameDir, 'search')
    expect(fold.applied).toBe(true)
    expect(ratioOf(sameDir, fold.output)).toBeGreaterThan(0.9)
    const seam = headroomSeam()
    const out = await seam.run(sameDir)
    const status = seam.status()
    // The fold did not ship, and nothing claims it did: the stage that delivered is
    // the one the counters name, the same accounting both rows above pin.
    expect(status.losslessCompressions).toBe(0)
    expect(status.proseCompressions).toBe(1)
    // What shipped is a subset of whole match lines — each one still carrying the
    // `path:line:` token that is the entirety of a match — and the ones that are
    // not there are named by the marker rather than silently absent.
    const payloadLines = sameDir.split('\n')
    const renderedLines = out.split('\n')
    const surviving = payloadLines.filter(line => renderedLines.includes(line))
    expect(surviving.length).toBeGreaterThan(0)
    expect(surviving.length).toBeLessThan(payloadLines.length)
    expect(surviving.every(line => /^[\w/.-]+\.ts:\d+:/.test(line))).toBe(true)
    expect(out).toContain(`${surviving.length} of ${payloadLines.length} lines kept`)
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(sameDir)
  })
})

describe('a refusal by a reading of a part must not decide the payload', () => {
  it('mixed: sections no section-level compressor can shrink are still compressed as text', async () => {
    // Every section is below the section floor, so the splice *cannot* have
    // changed anything — the compression that arrives can only have come from a
    // later stage, which is what "falls through" means.
    const text = [
      Array.from({ length: 9 }, (_, i) => SENTENCE(i)).join(' '),
      '```sh',
      'find . -name "*.ts" | head -20',
      '```',
      Array.from({ length: 9 }, (_, i) => SENTENCE(i + 20)).join(' '),
      '{"run": 1, "status": "ok"}',
      Array.from({ length: 9 }, (_, i) => SENTENCE(i + 40)).join(' '),
      '```sh',
      'grep -rn "needle" ./src | head -5',
      '```',
      Array.from({ length: 9 }, (_, i) => SENTENCE(i + 60)).join(' '),
    ].join('\n')
    expect(isMixedContent(text)).toBe(true)
    const sections = splitIntoSections(text)
    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) expect(bytesOf(section.content)).toBeLessThan(PIPELINE_FLOOR)
    const seam = headroomSeam()
    const out = await seam.run(text)
    expect(ratioOf(text, out)).toBeLessThan(0.6)
    expect(seam.status().proseCompressions).toBeGreaterThan(0)
  })

  it('tabular: a table found beyond the detector window does not stop the text stage', async () => {
    // The two readings disagree on purpose here: `detectTabular` walks every
    // line, while the detector's verdict samples the first fifty non-empty ones.
    // The table sits on line 61, so the *verdict* is `text` and the shape is a
    // table — the part reading the fall-through exists for.
    const text = `${Array.from({ length: 60 }, (_, i) => SENTENCE(i)).join('\n')}\n\n${[
      '| model | score | notes |',
      '|---|---|---|',
      ...Array.from({ length: 6 }, (_, i) => `| model-${i} | ${i * 7} | within budget |`),
    ].join('\n')}`
    expect(detectContentType(text).contentType).toBe('text')
    const shape = detectTabular(text)
    expect(shape).toBeDefined()
    // The transform delivers nothing the chain can adopt: either it refuses, or
    // its rendering (the prose preamble carried through verbatim plus a
    // compacted table) cannot clear the acceptance ratio against the whole
    // payload. That is a fact about the table step, not about the payload —
    // which is exactly why it may not end the chain.
    const transform = compressTabular(text, shape!, SMART_CRUSHER_DEFAULTS, undefined)
    expect(!transform.applied || ratioOf(text, transform.output) > MIN_RATIO).toBe(true)
    const seam = headroomSeam()
    const out = await seam.run(text)
    expect(ratioOf(text, out)).toBeLessThan(0.6)
    expect(seam.status().tabularCompressions).toBe(0)
  })
})

describe('the pipeline floor', () => {
  it('leaves a payload below the floor alone, whatever shape it is', async () => {
    // 1.2 KB is where the pipeline starts reading a payload at all; a table or a
    // search listing under it is delivered verbatim, and the text stage's own
    // floor (4 KB) is a second, later reason no compression appears.
    expect(bytesOf(SMALL_BODY)).toBeLessThan(PIPELINE_FLOOR)
    const seam = headroomSeam()
    const out = await seam.run(SMALL_BODY)
    expect(out).toBe(SMALL_BODY)
    expect(seam.status().compressions).toBe(0)
  })
})
