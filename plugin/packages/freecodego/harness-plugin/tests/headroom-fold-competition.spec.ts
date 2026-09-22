/**
 * Whether a Stage 2 lossless fold is a *delivery* or only a *candidate*.
 *
 * Stage 2 folds a payload reversibly (search headings, log ANSI + run collapse,
 * diff index lines, config stanzas) and used to return at **any** ratio — a veto,
 * not a preference, because every typed branch behind it was never asked. That
 * cost real compression on the shapes a fold touches: a twelve-hunk diff with
 * `index` lines folded 0.931 where the text stage ships 0.53 as a subset whose
 * changes stay paired, a search result whose matches share a prefix folded 0.984
 * where the stage delivers 0.47 (and 0.26 when the hits share a file), and a
 * coloured log folded 0.777 where the log compressor delivers 0.17 with its
 * anchor rule keeping every error line.
 *
 * There are **three** such renders, not one: a Stage 2 fold, the mixed-content
 * splice that compresses each section with the compressor written for its shape
 * (a JSON block table-compacted, a match block folded), and the cross-turn pointer
 * over a repeated run. The splice had the same veto and the same cost, in the shape
 * that is hardest to see: a payload whose *sections refused* fell through to the
 * whole-payload stage and came out smaller than the same payload whose sections
 * succeeded, so adding terminal escapes to a payload improved its compression by
 * twenty points (0.478 against 0.684). The pointer had it too, and paid for it the
 * same way — a partial repeat shipped as a pointer over lines the chain never saw,
 * 1.7x the size of what the chain makes of the repeat itself; that half of the rule
 * is pinned where the pointer is measured, in `headroom-extra.spec.ts`, on the same
 * three counters this file reads.
 *
 * The rule pinned here has two halves, and each case below is one of them:
 *
 * 1. **Decisive** — the smallest candidate reaches `FOLD_DECISIVE_RATIO` (or the
 *    user's stricter `headroomMinSavingsRatio`, whichever binds). It is then within
 *    a hair of anything the chain could hand back, it is reversible, and it is what
 *    the model receives.
 * 2. **Held** — anything weaker is a candidate: the chain is offered the payload
 *    first, and at every delivery point `adopt` compares bytes and hands back the
 *    candidate when the branch is not smaller. The bars alone do not give that
 *    (see `adopt`), ties go to the candidate, and if every branch refuses it is
 *    what ships.
 *
 * Four consequences are asserted rather than assumed, because each one is a
 * plausible way to get this wrong:
 *
 * - the payload the chain sees is the **original**, not the fold's rendering
 *   (heading-form search rows are not `path:line:` rows) — asserted by measuring
 *   what the branch behind it reports on the same bytes;
 * - the render is recorded **once, and only when it ships** — a render credited
 *   while the model received something else is the panel claiming a compression
 *   that never happened, and the same rule covers the store: a branch that loses
 *   must not leave an entry no marker points at (the "spends nothing" case turns
 *   red when the branch's writes are committed before the decision — measured
 *   `entries held without a marker naming them: expected 1 to be 0`);
 * - a branch takes a candidate's place only when it is **strictly smaller**, so
 *   the union of the two rules can only ever improve on what a fold alone gave
 *   (the `max`/paths case turns red when the comparison is dropped: `delivered
 *   more than the fold (3445 vs 664)`);
 * - when nothing delivers, the candidate ships — asserted by the last-resort case,
 *   where the branch refuses and the payload would otherwise ship verbatim.
 *
 * Falsified by mutation, each one run against these files: returning the fold at
 * any ratio (`if (true)` for the decisive test) takes the three candidate cases
 * red; returning the **splice** at any ratio takes four red across this file and
 * `headroom-detection-rendering.spec.ts` (`expected 9408 to be less than 2371`);
 * dropping a held render instead of settling it takes the last-resort case red
 * (`expected '\u001b[32m2026-09-20T10:00:01.000Z IN…' not to be …`, and the floor
 * invariant reports the cost: `the chain delivered more than the fold it deferred
 * (3329 vs 2969)`); recording the render where it is computed takes the accounting
 * assertions red (`expected 2 to be 1`); computing the candidate bar locally in the
 * section path takes the two section cases red; committing a branch's writes
 * before the decision takes the write case red; picking the *largest* candidate
 * takes the section case red (`expected 'src/deep/module.ts\n  200:   const va…' to
 * contain 'The 0th paragraph…'`); and lowering the bar to 0.1 takes the decisive
 * case red, because the search branch then answers a payload the fold should have
 * answered (`identicalToFold` goes false). What *does* falsify the decisive case
 * matters: `FOLD_DECISIVE_RATIO = 1` changes nothing at all, since the bar is
 * `min(minRatio, FOLD_DECISIVE_RATIO)` and the user's ratio (0.85) is the binding
 * term — which is exactly why the bar is written that way.
 */

import { describe, expect, it } from 'vitest'
import { HEADROOM_SEAM_SETTINGS, headroomSeam, referencesIn } from './support/headroom-seam.ts'
import type { HeadroomSettings } from '../src/headroom/runtime.ts'
import { detectContentType } from '../src/headroom/content-detector.ts'
import { compactLossless } from '../src/headroom/lossless-compaction.ts'
import { SEARCH_COMPRESSOR_DEFAULTS, compressSearch } from '../src/headroom/search-compressor.ts'

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const ratioOf = (from: string, to: string): number => bytesOf(to) / Math.max(1, bytesOf(from))
/** The stage's own marker line, which is never a payload line. */
const MARKER = /^\[(?:Text|Prose) compressed from /u

/** One ordinary sentence, long enough that a selection of them is a real saving. */
const SENTENCE = (index: number): string =>
  `The ${index}th paragraph explains why this particular decision was taken, in ordinary words that repeat no structure at all.`

/**
 * Thirty hits in one file. The repeated prefix dominates the payload, so the fold
 * lands far below the bar: measured 0.122 (1949 -> 238 bytes) — the model receives
 * the heading form itself.
 */
const ONE_FILE_SEARCH = Array.from({ length: 30 }, (_, i) => `packages/freecodego/harness-plugin/src/headroom/runtime.ts:${100 + i}:x`).join('\n')

/**
 * Twenty hits in one file whose lines carry real content, so the fold saves only
 * the prefix: measured 0.928 and therefore deferred — and here the search branch
 * behind it *does* deliver (0.260), dropping matches with a marker.
 */
const SAME_FILE_SEARCH = Array.from({ length: 20 }, (_, i) => `src/deep/module.ts:${200 + i}:  const value_${i} = fn(${i}) // ${'y'.repeat(200)}`).join('\n')

/**
 * A diff with `index` bookkeeping lines — the one thing `diffStripIndex` strips —
 * and twelve hunks. The fold exists and is deferred (0.931), the diff branch
 * refuses it (its own rendering is its input: no hunk exceeds the cap, nothing to
 * trim), and the text stage's change-paired selection ships instead.
 */
const INDEX_DIFF = (() => {
  const lines: string[] = ['diff --git a/src/worker.ts b/src/worker.ts']
  for (let h = 0; h < 12; h += 1) {
    lines.push(`index ${String(h).padStart(7, '0')}..${String(h + 1).padStart(7, '0')} 100644`)
    lines.push('--- a/src/worker.ts')
    lines.push('+++ b/src/worker.ts')
    lines.push(`@@ -${h * 20 + 1},6 +${h * 20 + 1},6 @@ export class Worker {`)
    for (let c = 0; c < 4; c += 1) lines.push(`   context line ${h}_${c} unchanged in this hunk`)
    lines.push(`-  const old${h} = compute(${h}) // ${'z'.repeat(40)}`)
    lines.push(`+  const fresh${h} = compute(${h} + 1) // ${'z'.repeat(40)}`)
  }
  return lines.join('\n')
})()

/**
 * A coloured application log with no repeated line: the fold is the ANSI strip
 * alone (0.892, so deferred) and the log branch refuses it — the shape
 * `headroom-log-routing.spec.ts` pins as "the compressor leaves it untouched" —
 * which is the deferral's last resort.
 */
const ANSI_LOG = Array.from({ length: 40 }, (_, i) => `\u001b[32m2026-09-20T10:${String(i % 60).padStart(2, '0')}:01.000Z INFO worker[${i}] request id=req-${i} handled in ${i % 90}ms\u001b[0m`).join('\n')

describe('a Stage 2 fold that clears the bar is the delivery', () => {
  it('search: a fold at 0.12 ships as its own heading form, with nothing else asked', async () => {
    const fold = compactLossless(ONE_FILE_SEARCH, 'search')
    expect(fold.applied).toBe(true)
    expect(ratioOf(ONE_FILE_SEARCH, fold.output)).toBeLessThan(0.6)
    const seam = headroomSeam()
    const out = await seam.run(ONE_FILE_SEARCH)
    const status = seam.status()
    // The fold's own rendering, byte for byte — not a re-render of it and not the
    // search branch's rendering of the same bytes (which exists: this payload has
    // thirty match lines, well past that branch's floor).
    expect(out).toBe(fold.output)
    expect(status.losslessCompressions).toBe(1)
    expect(status.searchCompressions).toBe(0)
    expect(status.proseCompressions).toBe(0)
    // A lossless fold carries no `hash=`, and that is the point of preferring it:
    // nothing has to be retrieved, because nothing was dropped.
    expect(referencesIn(out)).toEqual([])
    // And it is credited as what it is: one compression, of exactly this size.
    expect(status.compressions).toBe(1)
    expect(status.originalBytes).toBe(bytesOf(ONE_FILE_SEARCH))
    expect(status.compressedBytes).toBe(bytesOf(out))
  })
})

describe('a Stage 2 fold below the bar is a candidate', () => {
  it('search: the branch that owns the shape is asked, and outbids the fold', async () => {
    const fold = compactLossless(SAME_FILE_SEARCH, 'search')
    expect(fold.applied).toBe(true)
    expect(ratioOf(SAME_FILE_SEARCH, fold.output)).toBeGreaterThan(0.9)
    const seam = headroomSeam()
    const out = await seam.run(SAME_FILE_SEARCH)
    const status = seam.status()
    // The search branch delivered — the fold did not stand in front of it.
    expect(status.searchCompressions).toBe(1)
    expect(status.losslessCompressions).toBe(0)
    expect(ratioOf(SAME_FILE_SEARCH, out)).toBeLessThan(ratioOf(SAME_FILE_SEARCH, fold.output) / 2)
    // The branch saw the *original* payload: its own grouping marker counts all
    // twenty matches and says how many survived (five), and the fifteen it did not
    // keep are one `headroom_retrieve` away. A chain handed the fold's heading-form
    // rendering instead would report different counts here — that rendering has no
    // `path:line:` rows left for the branch to group, so the fixture doubles as
    // evidence of what the branch was handed.
    expect(out).toContain('[20 matches compressed to 5. Retrieve more: hash=')
    expect(out).toContain('15 more matches in this file')
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(SAME_FILE_SEARCH)
    // One compression, credited to the delivery — not two, one of which the model
    // never saw.
    expect(status.compressions).toBe(1)
    expect(status.originalBytes).toBe(bytesOf(SAME_FILE_SEARCH))
    expect(status.compressedBytes).toBe(bytesOf(out))
  })

  it('diff: the stage behind it still ships a subset whose changes stay paired', async () => {
    const fold = compactLossless(INDEX_DIFF, 'diff')
    expect(fold.applied).toBe(true)
    expect(ratioOf(INDEX_DIFF, fold.output)).toBeGreaterThan(0.9)
    expect(detectContentType(INDEX_DIFF).contentType).toBe('diff')
    const seam = headroomSeam()
    const out = await seam.run(INDEX_DIFF)
    const status = seam.status()
    expect(status.losslessCompressions).toBe(0)
    expect(status.proseCompressions).toBe(1)
    // Not the fold: the fold keeps all 121 lines minus the twelve `index` ones and
    // would have been 0.931. What ships is 0.53.
    expect(out).not.toBe(fold.output)
    expect(ratioOf(INDEX_DIFF, out)).toBeLessThan(0.6)
    const payloadLines = INDEX_DIFF.split('\n')
    const renderedLines = out.split('\n')
    const indices = (prefix: string, notThis: string): readonly number[] =>
      payloadLines
        .map((line, index) => ({ line, index }))
        .filter(entry => entry.line.startsWith(prefix) && !entry.line.startsWith(notThis))
        .map(entry => entry.index)
    const removals = indices('-', '---')
    const additions = indices('+', '+++')
    expect(removals).toHaveLength(12)
    expect(additions).toHaveLength(12)
    let changes = 0
    for (let index = 0; index < removals.length; index += 1) {
      const removalKept = renderedLines.includes(payloadLines[removals[index]!]!)
      expect(renderedLines.includes(payloadLines[additions[index]!]!), `change ${index} kept a removal without its addition`).toBe(removalKept)
      if (removalKept) changes += 1
    }
    expect(changes).toBeGreaterThan(0)
    expect(changes).toBeLessThan(removals.length)
    // And the marker says how much of the diff this is, over a retrievable original.
    expect(out).toContain(` of ${payloadLines.length} lines kept`)
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(INDEX_DIFF)
    expect(status.compressions).toBe(1)
  })

  it('log: a deferred fold whose branch refuses is the last resort, and it is lossless', async () => {
    const fold = compactLossless(ANSI_LOG, 'log')
    expect(fold.applied).toBe(true)
    expect(fold.output).not.toContain('\u001b[')
    expect(ratioOf(ANSI_LOG, fold.output)).toBeGreaterThan(0.6)
    expect(detectContentType(ANSI_LOG).contentType).toBe('log')
    const seam = headroomSeam()
    const out = await seam.run(ANSI_LOG)
    const status = seam.status()
    // The log branch was asked and refused it (this is that row's fixture shape),
    // so the alternative on offer was the payload verbatim — and the fold is
    // strictly better than that, which is the whole reason a deferred fold has to
    // be settled rather than dropped.
    expect(status.logCompressions).toBe(0)
    expect(out).not.toBe(ANSI_LOG)
    expect(out).toBe(fold.output)
    expect(status.losslessCompressions).toBe(1)
    expect(status.compressions).toBe(1)
    expect(status.originalBytes).toBe(bytesOf(ANSI_LOG))
    expect(status.compressedBytes).toBe(bytesOf(fold.output))
    // Lossless means no marker and no entry: nothing was dropped, so there is
    // nothing to retrieve and no capacity promised to anything.
    expect(referencesIn(out)).toEqual([])
    expect(status.ccrEntries).toBe(0)
  })
})

describe('a mixed-content section is answered by the same rule', () => {
  /** Nine sentences: prose, which the section splitter types as `text`. */
  const prose = (offset: number): string => Array.from({ length: 9 }, (_, i) => SENTENCE(i + offset)).join(' ')

  it('search section: the compressor is asked on the section, not on the fold', async () => {
    // The section path ran the two the other way round — fold first, then hand the
    // *fold's rendering* to the search compressor. The compressor reads
    // `path:line:` rows and a heading-form fold has none, so it parsed zero matches
    // and refused a section it compresses by three quarters: the payload below went
    // out at 0.95 with a 1.6% `lossless` credit where the compressor delivers 0.245.
    const section = SAME_FILE_SEARCH
    const fold = compactLossless(section, 'search')
    expect(fold.applied).toBe(true)
    expect(ratioOf(section, fold.output)).toBeGreaterThan(0.9)
    expect(compressSearch(fold.output, SEARCH_COMPRESSOR_DEFAULTS, undefined, [], 1).applied).toBe(false)
    const payload = [prose(0), section, prose(20)].join('\n')
    const seam = headroomSeam()
    const out = await seam.run(payload)
    const status = seam.status()
    expect(status.searchCompressions).toBe(1)
    expect(status.losslessCompressions).toBe(0)
    expect(ratioOf(payload, out)).toBeLessThan(0.5)
    // The section's own marker, over a retrievable original, and the two prose
    // sections untouched around it — a splice, not a rewrite.
    expect(out).toContain('[20 matches compressed to 5. Retrieve more: hash=')
    expect(out).toContain(SENTENCE(0))
    expect(out).toContain(SENTENCE(20))
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(section)
    // One credit for the section, measured against the section: the old path
    // recorded the fold *and* the compressor whenever both applied, which doubled
    // `originalBytes` for the same bytes.
    expect(status.compressions).toBe(1)
    expect(status.originalBytes).toBe(bytesOf(section))
    expect(status.compressedBytes).toBeLessThan(bytesOf(section) / 2)
  })

  it('the policy reaches a section, and the ledger says so', async () => {
    // A section folded on sight while the setting said every fold has to compete:
    // the bar was `min(minRatio, FOLD_DECISIVE_RATIO)` in this path too, computed
    // locally, so `max` never reached it — the setting was half-applied, and the
    // ledger did not even show the half it missed.
    //
    // The fixture is the extreme of that shape: twelve matches that each live in a
    // different file, so the group's fold is decisive (0.340) and the search
    // compressor has nothing to offer them (its floor is ten matches *in one file*,
    // and it declines — asserted below as the premise, not assumed). The delivery is
    // therefore identical under both policies; what differs is the ledger, which is
    // the point: under `max` the section's fold is demoted and settles, where under
    // `reversible` it was never demoted at all.
    const section = Array.from({ length: 12 }, (_, i) => `packages/${'d'.repeat(90)}/src/module_${i}.ts:${100 + i}:  const value_${i} = fn(${i})`).join('\n')
    const fold = compactLossless(section, 'search')
    expect(fold.applied).toBe(true)
    expect(ratioOf(section, fold.output)).toBeLessThan(0.6)
    expect(compressSearch(section, SEARCH_COMPRESSOR_DEFAULTS, undefined, [], 1).applied).toBe(false)
    const payload = [prose(0), section, prose(20)].join('\n')

    const reversibleSeam = headroomSeam()
    const reversible = await reversibleSeam.run(payload)
    const reversibleStatus = reversibleSeam.status()
    const maxSeam = headroomSeam({ ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: 'max' })
    const max = await maxSeam.run(payload)
    const maxStatus = maxSeam.status()
    // Same bytes: a policy that cannot improve on a render must not change what the
    // model reads, and here there is nothing smaller to be had.
    expect(max).toBe(reversible)
    // One more demotion under `max`, and it is the section's: the extra deferral is
    // exactly the section fold, and it settles rather than being superseded.
    expect(maxStatus.foldDeferred).toBe(reversibleStatus.foldDeferred + 1)
    expect(maxStatus.foldSettled).toBe(reversibleStatus.foldSettled + 1)
    expect(maxStatus.foldSuperseded).toBe(reversibleStatus.foldSuperseded)
    expect(reversibleStatus.foldDeferred).toBeGreaterThan(0)
  })

  it('a candidate that clears the bar still ships on sight, with nothing else asked', async () => {
    // The other half, so neither outcome reads as "mixed payloads stopped being
    // answered by their own render": thirty hits in one file make the *payload's* fold
    // clear the bar (0.581), and it ships as itself — no branch asked, no marker, no
    // entry, nothing to retrieve. Two candidates are on offer here and they are a
    // byte apart (the splice that folds the same rows as its own section is 0.582),
    // which is why the tie rule prefers the fold and why the assertion is on the
    // bytes rather than on which of the two produced them.
    const payload = [prose(0), ONE_FILE_SEARCH, prose(20)].join('\n')
    const payloadFold = compactLossless(payload, 'search')
    expect(payloadFold.applied).toBe(true)
    expect(ratioOf(payload, payloadFold.output)).toBeLessThan(0.6)
    const seam = headroomSeam()
    const out = await seam.run(payload)
    const status = seam.status()
    expect(out).toBe(payloadFold.output)
    expect(status.losslessCompressions).toBe(1)
    expect(status.searchCompressions).toBe(0)
    expect(status.proseCompressions).toBe(0)
    expect(referencesIn(out)).toEqual([])
    expect(status.ccrEntries).toBe(0)
    expect(status.foldDeferred).toBe(0)

    // Under `max` the bar is zero, so both candidates are demoted and the
    // whole-payload search branch takes the payload instead: 0.054 against the
    // reversible 0.581, with one marker that resolves to the payload byte for byte.
    // Both demotions are superseded — the branch beat both, which is what `max` is
    // for: every fold is priced against what the chain can do.
    const maxSeam = headroomSeam({ ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: 'max' })
    const maxOut = await maxSeam.run(payload)
    const maxStatus = maxSeam.status()
    expect(maxOut).not.toBe(out)
    expect(maxStatus.searchCompressions).toBe(1)
    expect(maxStatus.losslessCompressions).toBe(0)
    expect(bytesOf(maxOut) * 4).toBeLessThan(bytesOf(out))
    expect(maxStatus.foldDeferred).toBe(2)
    expect(maxStatus.foldSuperseded).toBe(2)
    expect(maxStatus.foldSettled).toBe(0)
    const maxRefs = referencesIn(maxOut)
    expect(maxRefs.length).toBe(1)
    expect(await maxSeam.retrieve(maxRefs[0]!)).toBe(payload)
  })
})

describe('the fold policy decides whether a fold that clears the bar competes', () => {
  /** Sixty identical records: the fold that dominates this shape is a run collapse. */
  const REPEATED_LOG = [
    '2026-09-20T10:00:01.000Z INFO worker start',
    ...Array.from({ length: 60 }, () => '2026-09-20T10:00:02.000Z INFO worker heartbeat ok'),
    '2026-09-20T10:00:03.000Z INFO worker stop',
  ].join('\n')

  /**
   * Forty paths under one long shared prefix: the fold collapses the prefix into a
   * heading and lands at 0.100, which is the shape `max` is worst at — see the case
   * below, where the prose stage used to answer such a payload five times larger.
   */
  const PATH_LISTING = Array.from({ length: 40 }, (_, i) => `packages/${'d'.repeat(140)}/src/module_${i}.ts`).join('\n')

  it('reversible (default): the fold clears the bar and ships, so nothing competes', async () => {
    const seam = headroomSeam()
    const out = await seam.run(REPEATED_LOG)
    const status = seam.status()
    expect(status.foldPolicy).toBe('reversible')
    expect(status.losslessCompressions).toBe(1)
    expect(status.logCompressions).toBe(0)
    // Nothing was deferred, so there is nothing for the ledger to report: the three
    // counters describe competition, and here there was none.
    expect(status.foldDeferred).toBe(0)
    expect(status.foldSuperseded).toBe(0)
    expect(status.foldSettled).toBe(0)
    expect(ratioOf(REPEATED_LOG, out)).toBeLessThan(0.1)
    expect(out).toContain('repeated 60 times')
    expect(referencesIn(out)).toEqual([])
  })

  it('max: the same payload is handed to its own compressor, and the fold loses', async () => {
    // The measured difference between the two products, on one fixture: lossless
    // and 5.1% of the payload under `reversible` against lossy and 3.2% under `max`.
    const seam = headroomSeam({ ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: 'max' })
    const out = await seam.run(REPEATED_LOG)
    const status = seam.status()
    expect(status.foldPolicy).toBe('max')
    expect(status.logCompressions).toBe(1)
    expect(status.losslessCompressions).toBe(0)
    expect(ratioOf(REPEATED_LOG, out)).toBeLessThan(0.05)
    // The ledger says exactly what happened to the fold the policy demoted.
    expect(status.foldDeferred).toBe(1)
    expect(status.foldSuperseded).toBe(1)
    expect(status.foldSettled).toBe(0)
    // And the safety net is the lossy stage's, not the fold's: a resolvable marker.
    const refs = referencesIn(out)
    expect(refs.length).toBe(1)
    expect(await seam.retrieve(refs[0]!)).toBe(REPEATED_LOG)
  })

  it('the ledger accounts for every deferred fold, under both policies', async () => {
    // `deferred = superseded + settled` is what makes the counters a ledger rather
    // than three independent hints: a delivery point that forgot to go through
    // `adopt` would leave a deferred fold unaccounted for, which is the shape of
    // bug this rule has produced twice (a fold credited while something else
    // shipped, and a fold dropped instead of settled).
    const rows: readonly (readonly [string, HeadroomSettings])[] = [
      ['reversible', HEADROOM_SEAM_SETTINGS],
      ['max', { ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: 'max' as const }],
    ]
    const payloads = [REPEATED_LOG, SAME_FILE_SEARCH, INDEX_DIFF, ANSI_LOG, ONE_FILE_SEARCH, PATH_LISTING]
    for (const [policy, settings] of rows) {
      for (const payload of payloads) {
        const seam = headroomSeam(settings)
        await seam.run(payload)
        const status = seam.status()
        expect(status.foldDeferred, `${policy}: deferred did not account for superseded + settled`)
          .toBe(status.foldSuperseded + status.foldSettled)
        // A deferred fold is never both recorded and beaten: `losslessCompressions`
        // counts one delivery per payload at most, whatever the ledger says.
        expect(status.losslessCompressions).toBeLessThanOrEqual(1)
      }
    }
  })

  it('max: a branch that does not beat the fold never takes its place', async () => {
    // `max` demotes a fold that clears the bar, and here that is a demotion the
    // chain cannot answer: the fold is 0.100 and the stage that used to answer such
    // a listing (the prose crusher, which sees forty long path lines with nothing
    // to select) delivered 0.517 — five times the bytes, lossy where the fold was
    // reversible, from a setting whose whole promise is more compression. The bars
    // alone cannot prevent that: a deferred fold is only above
    // `min(FOLD_DECISIVE_RATIO, minRatio)` while a branch delivery merely has to
    // reach `minRatio`, so with the default 0.85 the branch had room to be larger.
    const fold = compactLossless(PATH_LISTING, 'paths')
    expect(fold.applied).toBe(true)
    expect(ratioOf(PATH_LISTING, fold.output)).toBeLessThan(0.2)
    const seam = headroomSeam({ ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: 'max' })
    const out = await seam.run(PATH_LISTING)
    const status = seam.status()
    expect(status.foldPolicy).toBe('max')
    expect(status.foldDeferred).toBe(1)
    // Settled, not superseded: the fold is what shipped, which is the distinction
    // the ledger exists to make.
    expect(status.foldSettled).toBe(1)
    expect(status.foldSuperseded).toBe(0)
    expect(out).toBe(fold.output)
    expect(status.losslessCompressions).toBe(1)
    expect(status.proseCompressions).toBe(0)
    expect(status.compressedBytes).toBeLessThanOrEqual(bytesOf(fold.output))
    // And `reversible` reaches the same bytes by a different route — the fold clears
    // the bar there, so nothing is even deferred: this payload is one product under
    // both settings, not two.
    const reversibleSeam = headroomSeam()
    expect(await reversibleSeam.run(PATH_LISTING)).toBe(fold.output)
    expect(reversibleSeam.status().foldDeferred).toBe(0)
  })

  it('a render that does not ship spends nothing', async () => {
    // The write half of the same rule, and a defect the deferral introduced: every
    // branch used to commit its CCR entries and only *then* ask `adopt`, so a payload
    // answered by the candidate left the store holding an entry no marker in the
    // context pointed at — a spent entry that can evict one the model was promised,
    // and the one shape `headroom-ccr-writes.spec.ts` exists to catch (measured here
    // before the fix: the listing below delivered its fold with `ccrEntries: 1` and
    // not one reference in the text). Now the branch's writes travel to `adopt` as a
    // `commit` closure, and a branch that loses never runs it.
    const rows: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ['paths listing / max (the fold wins)', PATH_LISTING, 'max'],
      ['paths listing / reversible (nothing is offered)', PATH_LISTING, undefined],
    ]
    for (const [label, payload, policy] of rows) {
      const seam = headroomSeam(policy === undefined ? HEADROOM_SEAM_SETTINGS : { ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: policy as 'max' })
      const out = await seam.run(payload)
      const status = seam.status()
      const refs = referencesIn(out)
      expect(status.ccrEntries, `${label}: entries held without a marker naming them`).toBe(refs.length)
      for (const hash of refs) expect(await seam.retrieve(hash), `${label}: a marker that does not resolve`).toBe(payload)
    }
  })

  it('reversible: the same guarantee holds when a fold only just clears the bar', async () => {
    // The other side of the same comparison, because `max` is not the only policy
    // that can defer: `min(FOLD_DECISIVE_RATIO, minRatio)` is 0.6 by default, so any
    // fold between 0.6 and `minRatio` is deferred under `reversible` too — and there
    // the branch has the same room to answer larger. Asserted as the rule rather
    // than as a fixture's luck, over both policies and every shape above.
    for (const policy of ['reversible', 'max'] as const) {
      for (const [kind, payload] of [['search', SAME_FILE_SEARCH], ['diff', INDEX_DIFF], ['log', ANSI_LOG], ['paths', PATH_LISTING], ['search', ONE_FILE_SEARCH]] as const) {
        const fold = compactLossless(payload, kind)
        expect(fold.applied, `${policy}/${kind}: the fixture does not fold`).toBe(true)
        const seam = headroomSeam({ ...HEADROOM_SEAM_SETTINGS, headroomFoldPolicy: policy })
        const out = await seam.run(payload)
        expect(
          bytesOf(out) <= bytesOf(fold.output),
          `${policy}/${kind}: delivered more than the fold (${bytesOf(out)} vs ${bytesOf(fold.output)})`,
        ).toBe(true)
      }
    }
  })
})

describe('the deferral never loses compression', () => {
  it('every candidate row still compresses, and never by less than the fold', async () => {
    // The invariant across the shapes above: the fold is a floor, not a ceiling.
    // Measured on the shipped seam, each of these ships at a ratio at or below what
    // the fold alone would have given — which is what `FOLD_DECISIVE_RATIO ≤
    // minRatio` guarantees, since every acceptable delivery behind the fold is at
    // or below `minRatio` while a deferred fold is above both bars.
    const rows: readonly (readonly [string, string])[] = [
      ['search', SAME_FILE_SEARCH],
      ['diff', INDEX_DIFF],
      ['log', ANSI_LOG],
    ]
    for (const [kind, payload] of rows) {
      const fold = compactLossless(payload, kind as 'search' | 'diff' | 'log')
      const seam = headroomSeam()
      const out = await seam.run(payload)
      expect(fold.applied, `${kind}: the fixture does not fold`).toBe(true)
      expect(
        bytesOf(out) <= bytesOf(fold.output),
        `${kind}: the chain delivered more than the fold it deferred (${bytesOf(out)} vs ${bytesOf(fold.output)})`,
      ).toBe(true)
      // And whatever shipped is either the fold (lossless, no marker) or a marked
      // rendering whose marker resolves — there is no third shape.
      const refs = referencesIn(out)
      if (refs.length === 0) {
        expect(out, `${kind}: an unmarked rendering that is not the fold`).toBe(fold.output)
      } else {
        expect(refs.length).toBe(1)
        expect(await seam.retrieve(refs[0]!)).toBe(payload)
      }
      expect(MARKER.test(out) || refs.length > 0 || out === fold.output).toBe(true)
    }
  })
})
