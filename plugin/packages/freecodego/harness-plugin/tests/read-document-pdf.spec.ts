/**
 * `read_document`'s PDF path: the character budget, and the gate that decides a
 * stream is worth tokenizing at all.
 *
 * 1. **The budget keeps the part of a line that fits** — the rule the notebook
 *    path already had (§36) and the PDF path did not. A PDF whose text is one long
 *    line is not exotic: it is what a single-paragraph page looks like, one `Tj`
 *    with no `Td` to advance a row. Measured before this fix, `extractPdfLines`
 *    with `max_chars: 500` over a 200,000-character line returned **zero lines**
 *    with `truncated: true`, and `describePdfLimitation` then answered "text
 *    operators were found but produced no readable text: the page likely uses a
 *    font encoding this reader does not map" — an empty result blamed on the one
 *    cause that was not present, sending the model off to font conversion for a
 *    document that had extracted perfectly. The same document with a short first
 *    line kept its tail (`lines: ['short', …]`, also asserted here), so the loss
 *    was specific to the first line and invisible in every fixture whose first line
 *    was short.
 * 2. **The gate and the dispatcher agree on which operators show text.** `'` and
 *    `"` were implemented in `applyTextOperator` and named in the module header,
 *    but `hasTextOperators` searched for `Tj`/`TJ` alone, so a stream that showed
 *    its text exclusively with `'`/`"` was discarded before tokenizing and the
 *    limitation text fired about text "drawn as vector outlines".
 *
 * Asserted on the returned text and on the reason string, not on the flags: a
 * `truncated` flag next to an empty answer is the failure being fixed.
 */

import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { describePdfLimitation, extractPdfLines } from '../src/read-document.ts'

/** Build a one-object PDF whose content stream is Flate-compressed text ops. */
function pdfWithContent(contentOps: string): Uint8Array {
  const compressed = deflateSync(Buffer.from(contentOps, 'latin1'))
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
    Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

const text = (result: { readonly lines: readonly string[] }): string => result.lines.join('\n')

describe('the PDF character budget', () => {
  it('keeps a prefix of a first line the budget cuts, instead of returning nothing', () => {
    const result = extractPdfLines(pdfWithContent(`BT (${'A'.repeat(200_000)}) Tj ET`), 500)
    // What the caller receives, not what the flag says: the joined text is the
    // budget's worth, and it is not empty.
    expect(result.lines).toHaveLength(1)
    expect(text(result)).toHaveLength(500)
    expect(text(result)).toMatch(/^A{500}$/u)
    expect(result.truncated).toBe(true)
  })

  it('blames the budget, not the font, when the budget is what cut the text', () => {
    // The second half of the same defect: with no lines extracted, the limitation
    // shown to the model named a font encoding. There is nothing to explain once a
    // prefix is kept.
    const result = extractPdfLines(pdfWithContent(`BT (${'A'.repeat(200_000)}) Tj ET`), 500)
    expect(describePdfLimitation(result)).toBeUndefined()
  })

  it('keeps the lines before the cut and a prefix of the line that is cut', () => {
    const result = extractPdfLines(pdfWithContent(`BT (short) Tj 0 -12 Td (${'B'.repeat(200_000)}) Tj ET`), 500)
    expect(result.lines[0]).toBe('short')
    expect(result.lines[1]).toMatch(/^B+$/u)
    expect(result.lines[1]?.length).toBeGreaterThan(0)
    expect(text(result).length).toBeLessThanOrEqual(500)
    expect(result.truncated).toBe(true)
  })

  it('does not touch a document that fits, and reports no truncation', () => {
    const result = extractPdfLines(pdfWithContent('BT (Hello) Tj 0 -14 Td (World) Tj ET'), 10_000)
    expect(result.lines).toEqual(['Hello', 'World'])
    expect(result.truncated).toBe(false)
    expect(describePdfLimitation(result)).toBeUndefined()
  })

  it('still leaves an empty answer empty when the document has no text at all', () => {
    // The control for the fix: keeping a prefix must not turn "no text here" into a
    // line of something. A stream with no show operator yields no lines and keeps a
    // reason.
    const result = extractPdfLines(pdfWithContent('BT /F1 12 Tf 72 720 Td ET'), 10_000)
    expect(result.lines).toEqual([])
    expect(result.textStreams).toBe(0)
    expect(describePdfLimitation(result)).toContain('no text operators found')
  })
})

describe('the text-operator gate', () => {
  it('scans a stream whose text is shown only with the single-quote operator', () => {
    const result = extractPdfLines(pdfWithContent("BT 12 TL (Hello) ' (World) ' ET"), 10_000)
    expect(result.lines).toEqual(['Hello', 'World'])
    expect(result.textStreams).toBe(1)
    expect(describePdfLimitation(result)).toBeUndefined()
  })

  it('scans a stream whose text is shown only with the double-quote operator', () => {
    const result = extractPdfLines(pdfWithContent('BT 1 2 (Hi) " ET'), 10_000)
    expect(result.lines).toEqual(['Hi'])
    expect(result.textStreams).toBe(1)
  })

  it('counts a stream that carries no show operator as a non-text stream', () => {
    const result = extractPdfLines(pdfWithContent('BT 1 0 0 1 10 10 cm ET'), 10_000)
    expect(result.textStreams).toBe(0)
  })

  it('pins the one admitted cost: a string holding a bare quote reads as an operator', () => {
    // Documented rather than hidden. The boundary rule cannot distinguish a bare
    // `'` inside a literal string from the operator, so the stream is tokenized and
    // yields nothing. The consequence is bounded — no text is invented, and only the
    // explanation of an empty result moves from "no operators" to "operators that
    // produced no text".
    const result = extractPdfLines(pdfWithContent("BT (a ' b) ET"), 10_000)
    expect(result.lines).toEqual([])
    expect(result.textStreams).toBe(1)
    expect(describePdfLimitation(result)).toContain('text operators were found')
  })
})
