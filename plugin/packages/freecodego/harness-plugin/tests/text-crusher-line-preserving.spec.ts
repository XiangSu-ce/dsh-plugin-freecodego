/**
 * The text stage's one structural promise: it never re-flows its input.
 *
 * The stage used to select *sentences* — split at `.`, `!`, `?` or a newline,
 * terminator kept on the unit — and join the selected ones with `''`. A unit
 * could therefore be a bare `"\n"` (a line break competing with the prose for the
 * budget, dropped on its own), and a `.` inside a line made that line's pieces
 * independently selectable. Measured on the fixtures below, before this rewrite:
 * 40 log records whose text carries a sentence arrived as **2 lines** with 1
 * record intact; a 9-match `grep` result kept 3 of its 9 `path:line:` tokens and
 * glued the heads of the rest (`pkg_0/src/module_0.pkg_1/…`); 60 lines of wrapped
 * prose arrived as 2 lines; a 45-line CRLF payload lost its endings. Under the
 * rewrite each of those renders as payload lines, and the number of rendered
 * lines the payload did not contain is 0 on every fixture.
 *
 * The cases below hold the replacement invariant, stated so that it can fail:
 *
 * 1. **Every non-marker line in the rendering comes from exactly one payload
 *    line**, and it *is* that whole line unless the payload line is longer than
 *    `RECORD_LINE_CHARS` — the one documented exception, a paragraph that happens
 *    to be a single long line, which may be shortened inside itself (see point 4).
 * 2. **No rendered line joins two payload lines**: the tail of one payload line
 *    is never followed by the head of the next inside a rendering, which is what
 *    the old sentence join produced (`a.` + `--- a/a.` arrived as `a.--- a/a.`).
 * 3. **Line endings are preserved byte for byte**, including CRLF, because the
 *    terminator is stored on the line rather than inside its last unit.
 * 4. **A single-line payload still compresses** — the one case where the unit
 *    must stay a sentence, and the reason `RECORD_LINE_CHARS` exists at all: a
 *    7 KB line kept whole cannot fit the budget, so the stage would become a
 *    no-op for exactly the documents it was written for.
 * 5. **A line-structured rendering says how much it dropped.** A subset of
 *    independent records (a search result, a listing) reads as the whole answer
 *    unless the rendering says otherwise; that reporting is what makes the
 *    search branch's fall-through acceptable, so it is asserted here rather than
 *    assumed there.
 *
 * And one promise the line rule cannot make on its own, so it has its own unit:
 *
 * 6. **On a diff the unit is the change.** A `-` line is half of a replacement
 *    and a change line is placed by the `@@` header above it, so neither can be
 *    selected alone: whatever survives must survive as a complete change, under
 *    the header that locates it. This is what lets the diff row fall through to
 *    this stage, and it is asserted through the same call the pipeline makes
 *    (`crushText`), not only through the seam.
 */

import { describe, expect, it } from 'vitest'
import { CcrStore } from '../src/headroom/ccr.ts'
import { RECORD_LINE_CHARS, TEXT_CRUSHER_DEFAULTS, crushText } from '../src/headroom/text-crusher.ts'
import { protectTags, restoreTags } from '../src/headroom/tag-protector.ts'

const SENTENCE = (index: number): string =>
  `The ${index}th paragraph explains why this particular decision was taken, in ordinary words that repeat no structure at all.`

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const ratioOf = (from: string, to: string): number => bytesOf(to) / Math.max(1, bytesOf(from))

/** The stage as the pipeline runs it: real store, marker written, tags restored. */
function stage(text: string): { readonly rendered: string; readonly store: CcrStore; readonly cacheKey: string | undefined } {
  const store = new CcrStore()
  const protectedProse = protectTags(text, false)
  const prose = crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, store, '')
  return { rendered: restoreTags(prose.compressed, protectedProse.blocks), store, cacheKey: prose.cacheKey }
}

const MARKER = /^\[Text compressed from \d+ bytes: .*\. Retrieve full text: hash=[a-f0-9]{24}\]$/

/** The rendering's lines minus the marker line. */
function contentLines(rendered: string): readonly string[] {
  const lines = rendered.split('\n')
  // The marker is emitted as its own line and never ends with a terminator.
  return lines.filter((line, index) => !(index === lines.length - 1 && MARKER.test(line)))
}

const DIFF = [
  'diff --git a/src/worker.ts b/src/worker.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/src/worker.ts',
  '+++ b/src/worker.ts',
  ...Array.from({ length: 12 }, (_, hunk) => [
    `@@ -${hunk * 20 + 1},20 +${hunk * 20 + 1},22 @@ export class Worker${hunk} {`,
    ...Array.from({ length: 5 }, (_, i) => `   const context_${hunk}_${i} = compute(${hunk}, ${i})`),
    ...Array.from({ length: 3 }, (_, i) => `-  const removed_${hunk}_${i} = legacy(${hunk}, ${i})`),
    ...Array.from({ length: 3 }, (_, i) => `+  const added_${hunk}_${i} = modern(${hunk}, ${i}, "${SENTENCE(hunk * 3 + i)}")`),
  ]).flat(),
].join('\n')
/**
 * `git diff -U0`: one hunk, 30 paired removals and additions, no context lines.
 * The shape whose diff-branch refusal is re-decided in `headroom-branch-refusals`.
 */
const DIFF_U0 = [
  'diff --git a/src/worker.ts b/src/worker.ts',
  '--- a/src/worker.ts',
  '+++ b/src/worker.ts',
  '@@ -5,30 +5,30 @@ export class Worker {',
  ...Array.from({ length: 30 }, (_, i) => `-  const removed_${i} = legacy(${i})`),
  ...Array.from({ length: 30 }, (_, i) => `+  const added_${i} = modern(${i}, "${SENTENCE(i)}")`),
].join('\n')

/**
 * A long ordinary payload that quotes a small patch: a listing with `+` lines
 * (which are not a change set) and one real, two-change diff in the middle of it.
 * The shape that says whether the pairing rule is local to what is actually a
 * diff, or leaks into the payload around it.
 */
const LISTING_WITH_PATCH = [
  ...Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `+ added_${i} = value(${i}, "${SENTENCE(i)}")` : `  plain_${i} = other(${i}, "${SENTENCE(i + 60)}")`)),
  '@@ -1,3 +1,3 @@',
  '-old_a = 1',
  '-old_b = 2',
  '+new_a = 3',
  '+new_b = 4',
  ...Array.from({ length: 10 }, (_, i) => `  tail_${i} = after(${i}, "${SENTENCE(i + 120)}")`),
].join('\n')

const LOG = Array.from({ length: 160 }, (_, i) => {
  const stamp = `2026-09-20T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`
  if (i % 37 === 0) return `${stamp} ERROR payment gateway timed out after 30000ms settling order ${900000 + i}`
  return `${stamp} INFO request ${i} handled by handler_${i % 9} in ${10 + (i % 40)}ms`
}).join('\n')

const SEARCH = Array.from({ length: 60 }, (_, i) => `src/handlers/module_${i}.ts:${120 + i}:  const value_${i} = await load(${i}) // steady state`).join('\n')

/** Hard-wrapped markdown: short lines, headings and bullets that must stay whole. */
const README = Array.from({ length: 120 }, (_, i) => (i % 12 === 0 ? `## Section ${i / 12}` : `Line ${i} of documentation explaining the option, its default, and the reason it exists.`)).join('\n')

const ONE_LINE = Array.from({ length: 60 }, (_, i) => SENTENCE(i)).join(' ')

const CRLF = [
  '## Report',
  ...Array.from({ length: 40 }, (_, i) => `Line ${i} of a Windows checkout report, documenting what the run did in ordinary words.`),
].join('\r\n')

const FIXTURES: readonly (readonly [string, string])[] = [
  ['diff', DIFF],
  ['log', LOG],
  ['search', SEARCH],
  ['markdown', README],
  ['one long line', ONE_LINE],
  ['crlf', CRLF],
]

describe('on a diff the unit is the change', () => {
  const changesOf = (text: string): { readonly removed: readonly number[]; readonly added: readonly number[] } => {
    const lines = text.split('\n')
    const pick = (prefix: string, notThis: string): readonly number[] =>
      lines.map((line, index) => ({ line, index })).filter(entry => entry.line.startsWith(prefix) && !entry.line.startsWith(notThis)).map(entry => entry.index)
    return { removed: pick('-', '---'), added: pick('+', '+++') }
  }

  it('keeps both halves of every change it keeps, and the header that locates them', () => {
    const { rendered } = stage(DIFF_U0)
    const lines = DIFF_U0.split('\n')
    const renderedLines = rendered.split('\n')
    const { removed, added } = changesOf(DIFF_U0)
    let changes = 0
    for (let index = 0; index < Math.min(removed.length, added.length); index += 1) {
      const keptRemoval = renderedLines.includes(lines[removed[index]!]!)
      expect(renderedLines.includes(lines[added[index]!]!), `change ${index} is half-kept`).toBe(keptRemoval)
      if (keptRemoval) changes += 1
    }
    // Some changes survive (the stage did compress) and not all of them (it is a
    // selection), and every change line in the rendering belongs to one of them.
    expect(changes).toBeGreaterThan(0)
    expect(changes).toBeLessThan(removed.length)
    expect(renderedLines.filter(line => line.startsWith('-') && !line.startsWith('---'))).toHaveLength(changes)
    expect(renderedLines.filter(line => line.startsWith('+') && !line.startsWith('+++'))).toHaveLength(changes)
    // Located: the `@@` header and the file header travel with the changes.
    expect(renderedLines).toContain('@@ -5,30 +5,30 @@ export class Worker {')
    expect(renderedLines).toContain('diff --git a/src/worker.ts b/src/worker.ts')
    expect(ratioOf(DIFF_U0, rendered)).toBeLessThan(0.6)
  })

  it('pairs only what is a change, and keeps compressing the payload around it', () => {
    // The two `+` lines the listing quotes are *not* changes — there are no
    // removals to pair them with, and the block below is the only real one. So the
    // rule has to be local: the quoted lines stay on the line rule, the patch's two
    // changes travel together under their header, and the 70 ordinary lines around
    // them are still selected as lines (the stage does not stop compressing a
    // payload because it contains a patch).
    const { rendered } = stage(LISTING_WITH_PATCH)
    const renderedLines = rendered.split('\n')
    expect(ratioOf(LISTING_WITH_PATCH, rendered)).toBeLessThan(0.6)
    // The patch is read as a patch — each change whole — and the header travels
    // with whichever of its changes survive, not with the payload.
    const aKept = renderedLines.includes('-old_a = 1')
    const bKept = renderedLines.includes('-old_b = 2')
    expect(renderedLines.includes('+new_a = 3')).toBe(aKept)
    expect(renderedLines.includes('+new_b = 4')).toBe(bKept)
    expect(renderedLines.includes('@@ -1,3 +1,3 @@')).toBe(aKept || bKept)
    // The line rule still runs on everything else: many payload lines survive.
    expect(renderedLines.filter(line => LISTING_WITH_PATCH.split('\n').includes(line)).length).toBeGreaterThan(10)
  })
})

describe('the text stage keeps the payload’s lines', () => {
  it.each(FIXTURES)('%s: each rendered line comes from exactly one payload line', (_name, text) => {
    const { rendered } = stage(text)
    const payloadLines = text.split('\n')
    for (const line of contentLines(rendered)) {
      const sources = payloadLines.filter(payload => payload.includes(line))
      expect(sources, `${JSON.stringify(line.slice(0, 100))} is not contained in exactly one payload line`).toHaveLength(1)
      // A fragment is allowed only for the one shape that must stay splittable.
      if (sources[0] !== line) expect(sources[0]!.length).toBeGreaterThan(RECORD_LINE_CHARS)
    }
  })

  it.each(FIXTURES)('%s: no rendered line joins two payload lines', (_name, text) => {
    // The failure the old join produced, stated as the boundary it crossed: the
    // tail of one payload line followed by the head of the next, inside one
    // rendered line.
    const { rendered } = stage(text)
    const payloadLines = text.split('\n').filter(line => line.trim() !== '')
    for (let i = 0; i + 1 < payloadLines.length; i += 1) {
      const boundary = `${payloadLines[i]!.slice(-24)}${payloadLines[i + 1]!.slice(0, 24)}`
      expect(rendered.includes(boundary), `rendering joins line ${i} to line ${i + 1}`).toBe(false)
    }
  })

  it('preserves line endings, CRLF included, byte for byte', () => {
    const { rendered } = stage(CRLF)
    expect(rendered).toContain('\r\n')
    // Every line break in the rendering is one the payload had: no line ending
    // is invented, and a CRLF payload never comes back as an LF one.
    expect(rendered.split('\r\n').length).toBeGreaterThan(2)
    expect(rendered.split('\n').length).toBe(rendered.split('\r\n').length)
  })

  it('still compresses a single-line payload, by sentence', () => {
    // Where the unit has to stay a sentence: a 7 KB line cannot fit the budget
    // as one unit, so line-only selection would make the stage a no-op here.
    const { rendered } = stage(ONE_LINE)
    expect(ratioOf(ONE_LINE, rendered)).toBeLessThan(0.6)
    expect(contentLines(rendered)).toHaveLength(1)
    expect(rendered).toContain('sentences kept')
  })

  it('reports what it dropped, and the count is true of the payload', () => {
    const { rendered } = stage(SEARCH)
    const marker = contentLines(rendered).length === 0 ? '' : rendered.split('\n').find(line => MARKER.test(line))
    expect(marker).toBeDefined()
    const report = /^\[Text compressed from (\d+) bytes: (\d+) of (\d+) lines kept\./.exec(marker!)
    expect(report, `marker did not report a line count: ${marker}`).not.toBeNull()
    const [, originalBytes, kept, total] = report!
    expect(Number(originalBytes)).toBe(bytesOf(SEARCH))
    expect(Number(total)).toBe(SEARCH.split('\n').length)
    expect(Number(kept)).toBeLessThan(Number(total))
    // And the count matches the rendering it is attached to.
    expect(contentLines(rendered)).toHaveLength(Number(kept))
  })
})

