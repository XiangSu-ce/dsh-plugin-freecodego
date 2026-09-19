import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describePdfLimitation, extractPdfLines, formatNotebookLines, readDocumentToolDefinition } from '../src/read-document.ts'

/** Build a one-object PDF whose content stream is Flate-compressed text ops. */
function pdfWithContent(contentOps: string): Uint8Array {
  const compressed = deflateSync(Buffer.from(contentOps, 'latin1'))
  const header = '%PDF-1.4\n'
  const dict = `<< /Length ${compressed.length} /Filter /FlateDecode >>`
  return Buffer.concat([
    Buffer.from(header, 'latin1'),
    Buffer.from('1 0 obj\n', 'latin1'),
    Buffer.from(dict, 'latin1'),
    Buffer.from('\nstream\n', 'latin1'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

/** Build a one-object PDF around an already-built stream body. */
function pdfWithRawStream(compressed: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
    Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    Buffer.from(compressed),
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

/** Build a one-object PDF whose stream body carries `filter` as its filter. */
function pdfWithFilteredStream(filter: string, body: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
    Buffer.from(`<< /Length ${body.length} /Filter /${filter} >>\nstream\n`, 'latin1'),
    Buffer.from(body),
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

/**
 * Deterministic pseudorandom bytes (xorshift, no `Math.random`), the shape of
 * image samples and glyph outlines: high-entropy, ~40% printable. Stable across
 * runs so a fixture is reproducible.
 */
function pseudoRandomBytes(length: number): Buffer {
  const out = Buffer.alloc(length)
  let state = 0x2545F491
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state |= 0
    out[i] = (state >>> 16) & 0xFF
  }
  return out
}

/** ASCII85-encode bytes the way a `/ASCII85Decode` reader expects to find them. */
function ascii85(data: Buffer): Buffer {
  const out: number[] = []
  for (let at = 0; at < data.length; at += 4) {
    const chunk = data.subarray(at, at + 4)
    let value = 0
    for (let index = 0; index < 4; index += 1) value = value * 256 + (chunk[index] ?? 0)
    if (chunk.length === 4 && value === 0) { out.push(0x7A); continue }
    const digits: number[] = []
    for (let index = 0; index < 5; index += 1) { digits.push(value % 85); value = Math.floor(value / 85) }
    for (const digit of digits.reverse().slice(0, chunk.length + 1)) out.push(0x21 + digit)
  }
  // The filter's own end marker. A reader that stops at anything else is reading a
  // different file than this fixture wrote.
  return Buffer.concat([Buffer.from(out), Buffer.from('~>', 'latin1')])
}

describe('extractPdfLines', () => {
  it('extracts Tj lines with Td row advances', () => {
    const pdf = pdfWithContent('BT /F1 12 Tf 72 720 Td (Hello) Tj 0 -14 Td (World) Tj ET')
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual(['Hello', 'World'])
    expect(result.truncated).toBe(false)
    expect(result.streams).toBe(1)
  })

  it('splits TJ arrays on large negative kerning', () => {
    const pdf = pdfWithContent('BT [(Hel) -200 (lo) 30 (World)] TJ ET')
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual(['Hel loWorld'])
  })

  it("moves to the next line BEFORE showing for the ' operator", () => {
    const pdf = pdfWithContent('BT (first) Tj (second) \' ET')
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual(['first', 'second'])
  })

  it('decodes hex strings', () => {
    const pdf = pdfWithContent('BT <48656C6C6F> Tj ET')
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual(['Hello'])
  })

  it('skips streams without text operators and deduplicates identical ones', () => {
    const compressed = deflateSync(Buffer.from('1 0 0 1 0 0 cm', 'latin1'))
    const dict = `<< /Length ${compressed.length} /Filter /FlateDecode >>`
    const textPdf = pdfWithContent('BT (Real) Tj ET')
    const filler = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(dict, 'latin1'),
      Buffer.from('\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from('2 0 obj\n', 'latin1'),
      Buffer.from(dict, 'latin1'),
      Buffer.from('\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
    const merged = Buffer.concat([filler, textPdf.subarray(Buffer.from('%PDF-1.4\n', 'latin1').length)])
    const result = extractPdfLines(merged, 10_000)
    expect(result.lines).toEqual(['Real'])
    expect(result.streams).toBe(1)
  })

  it('stops at the character budget and reports truncation', () => {
    const pdf = pdfWithContent('BT (aaaabbbbccccddddeeeeffff) Tj ET')
    const result = extractPdfLines(pdf, 10)
    expect(result.truncated).toBe(true)
  })

  it('refuses a stream that inflates past the decoded-size cap, and says so', () => {
    // The whole-file cap does not bound this: the body on disk is tiny, and the
    // text at its front is real content a reader without a decoded-size cap
    // would report while holding megabytes of inflate in memory.
    const bomb = deflateSync(Buffer.concat([
      Buffer.from('BT (needle) Tj ET', 'latin1'),
      Buffer.alloc(12 * 1024 * 1024, 0x20),
    ]))
    const extraction = extractPdfLines(pdfWithRawStream(bomb), 10_000)
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(extraction.lines).toEqual([])
    expect(extraction.streams).toBe(0)
    expect(extraction.oversizedStreams).toBe(1)
    expect(describePdfLimitation(extraction)).toMatch(/decoded-size cap/)
  })

  it('still reads a large stream that stays under the cap', () => {
    const body = deflateSync(Buffer.concat([
      Buffer.from('BT (needle) Tj ET', 'latin1'),
      Buffer.alloc(6 * 1024 * 1024, 0x20),
    ]))
    const extraction = extractPdfLines(pdfWithRawStream(body), 10_000)
    expect(extraction.lines).toEqual(['needle'])
    expect(extraction.oversizedStreams).toBe(0)
    expect(describePdfLimitation(extraction)).toBeUndefined()
  })

  it('reads an ASCII85 content stream', () => {
    // The control for the two cases below it: the encoder in this file and the
    // decoder in the module agree, so a refusal they produce is about size.
    const pdf = pdfWithFilteredStream('ASCII85Decode', ascii85(Buffer.from('BT (Hello) Tj ET', 'latin1')))
    const extraction = extractPdfLines(pdf, 10_000)
    expect(extraction.lines).toEqual(['Hello'])
    expect(extraction.oversizedStreams).toBe(0)
  })

  it('refuses an ASCII85 stream that decodes past the same cap', () => {
    // The cap is a property of the reader, not of Flate. The two ASCII filters do
    // not inflate, so they were left unbounded — and each decoded byte is pushed
    // into a JS number array before it becomes a `Uint8Array`, so a stream like this
    // costs several times its decoded size in memory. A document that says a content
    // stream expanding past the cap is refused has to mean every filter it decodes.
    const payload = Buffer.concat([Buffer.from('BT (needle) Tj ET', 'latin1'), Buffer.alloc(9 * 1024 * 1024, 0x20)])
    const pdf = pdfWithFilteredStream('ASCII85Decode', ascii85(payload))
    const extraction = extractPdfLines(pdf, 10_000)
    expect(extraction.lines).toEqual([])
    expect(extraction.streams).toBe(0)
    expect(extraction.oversizedStreams).toBe(1)
    expect(describePdfLimitation(extraction)).toMatch(/decoded-size cap/)
  })

  it('refuses an ASCIIHex stream that decodes past the same cap', () => {
    const payload = Buffer.concat([Buffer.from('BT (needle) Tj ET', 'latin1'), Buffer.alloc(9 * 1024 * 1024, 0x20)])
    const pdf = pdfWithFilteredStream('ASCIIHexDecode', Buffer.from(Buffer.from(payload).toString('hex'), 'latin1'))
    const extraction = extractPdfLines(pdf, 10_000)
    expect(extraction.lines).toEqual([])
    expect(extraction.oversizedStreams).toBe(1)
  })

  it('names an encrypted PDF as the reason for an empty result', () => {
    const encrypted = pdfWithContent('1 0 0 1 0 0 cm')
    const withEncrypt = Buffer.concat([encrypted, Buffer.from('trailer\n<< /Encrypt 9 0 R >>\n', 'latin1')])
    const result = extractPdfLines(withEncrypt, 10_000)
    expect(result.lines).toEqual([])
    expect(result.encrypted).toBe(true)
    expect(describePdfLimitation(result)).toMatch(/encrypted/)
  })

  it('names a scanned (image-only) PDF as the reason for an empty result', () => {
    // A real scanned page carries a large image stream. Arbitrary bytes contain a
    // `Tj`/`TJ` byte pair with probability close to 1, which is asserted below on
    // purpose: this fixture used to be ten bytes of `0x00..0x09` that happened to
    // contain no such pair, so it never reached the mechanism it claims to cover.
    // With a realistic blob the old two-byte search said "text stream", its bytes
    // were tokenized into one garbage line, and an extraction with a line is never
    // explained — the OCR message this test is about was unreachable.
    const samples = pseudoRandomBytes(200_000)
    expect(samples.includes(Buffer.from('Tj', 'latin1')) || samples.includes(Buffer.from('TJ', 'latin1'))).toBe(true)
    const compressed = deflateSync(samples)
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode /Subtype /Image /Width 1414 /Height 1000 >>`, 'latin1'),
      Buffer.from('\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ])
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual([])
    expect(result.textStreams).toBe(0)
    expect(result.imageOnly).toBe(true)
    expect(describePdfLimitation(result)).toMatch(/scanned|image-only/)
  })

  it('skips a stream the dictionary declares to be an image, even when its bytes read as text', () => {
    // The declaration half on its own: this body is text-like AND contains a
    // show-text operator, so the byte test cannot rule it out — only `/Subtype
    // /Image` can. A producer is free to put anything in an image stream, and a
    // PDF with one inline "( … ) Tj" run in it must not report that run as the
    // document's text.
    const body = Buffer.from('BT (not page text at all) Tj ET', 'latin1')
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${body.length} /Subtype /Image >>\nstream\n`, 'latin1'),
      body,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ])
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual([])
    expect(result.textStreams).toBe(0)
  })

  it('skips an embedded font program, whose stream declares nothing at all', () => {
    // The byte half on its own. An embedded font program's stream dict is the
    // minimal `<< /Length … >>` — the `/FontFile2` reference lives in the font
    // descriptor, not in the stream's own dict — so no declaration distinguishes
    // it and one lucky `Tj` pair used to be enough to turn a font program into
    // page text. The body carries that pair deliberately.
    const leaked = Buffer.from('(leaked from a font program) Tj', 'latin1')
    const font = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x80, 0x00, 0x03]), leaked, pseudoRandomBytes(4_000)])
    expect(font.includes(leaked)).toBe(true)
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${font.length} /Length1 ${font.length} >>\nstream\n`, 'latin1'),
      font,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ])
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual([])
    expect(result.textStreams).toBe(0)
  })

  it('keeps the text of a page that also carries an image', () => {
    // The image is not a text stream, so its bytes are neither scanned nor counted
    // toward the explanation: the page's own content stream answers, and the file
    // being image-bearing does not turn a successful read into a limitation.
    const textOps = deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Real page text) Tj ET', 'latin1'))
    const image = deflateSync(pseudoRandomBytes(64_000))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${textOps.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      textOps,
      Buffer.from('\nendstream\nendobj\n2 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${image.length} /Filter /FlateDecode /Subtype /Image >>\nstream\n`, 'latin1'),
      image,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ])
    const result = extractPdfLines(pdf, 10_000)
    expect(result.lines).toEqual(['Real page text'])
    expect(result.textStreams).toBe(1)
    expect(result.streams).toBe(1)
    expect(result.imageOnly).toBe(true)
    expect(describePdfLimitation(result)).toBeUndefined()
  })

  it('stays silent about a limitation once any text was extracted', () => {
    const extraction = extractPdfLines(pdfWithContent('BT (present) Tj ET'), 10_000)
    expect(describePdfLimitation(extraction)).toBeUndefined()
  })

  it('blames the font encoding, not OCR, when text operators existed but yielded nothing', () => {
    // A stream that DOES call show-text, plus an image elsewhere: the model must
    // not be sent to OCR for a PDF that drew text it could not map.
    const textOps = deflateSync(Buffer.from('BT (x) Tj ET', 'latin1'))
    const image = deflateSync(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${textOps.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      textOps,
      Buffer.from('\nendstream\nendobj\n2 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${image.length} /Filter /FlateDecode /Subtype /Image >>\nstream\n`, 'latin1'),
      image,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ])
    const extraction = extractPdfLines(pdf, 10_000)
    // The text stream DID decode and produced a line, so the tool has content;
    // the point is that a zero-text outcome would be attributed to encoding.
    const emptyOutcome = { ...extraction, lines: [] }
    expect(describePdfLimitation(emptyOutcome)).toMatch(/font encoding/)
    expect(describePdfLimitation(emptyOutcome)).not.toMatch(/OCR/)
  })
})

describe('formatNotebookLines', () => {
  it('formats cells with indexed headings and hides outputs by default', () => {
    const notebook = JSON.stringify({
      cells: [
        { cell_type: 'code', source: ['print(1)\n', 'print(2)'], outputs: [{ output_type: 'stream', text: ['1\n'] }] },
        { cell_type: 'markdown', source: '# Title' },
      ],
      metadata: { language_info: { name: 'python' } },
    })
    const result = formatNotebookLines(notebook, false)
    expect(result.cells).toBe(2)
    expect(result.kernel).toBe('python')
    expect(result.lines.join('\n')).not.toContain('[out:0]')
    expect(result.lines).toContain('### [1] code')
    expect(result.lines).toContain('print(2)')
  })

  it('includes stream, result, and error outputs when asked', () => {
    const notebook = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: '1/0',
          outputs: [
            { output_type: 'stream', text: ['side\n', 'effect\n'] },
            { output_type: 'execute_result', data: { 'text/plain': '42' } },
            { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001B[0;31mTrace\u001B[0m line 1'] },
          ],
        },
      ],
      metadata: {},
    })
    const result = formatNotebookLines(notebook, true)
    const text = result.lines.join('\n')
    expect(text).toContain('side')
    expect(text).toContain('[out:1] 42')
    expect(text).toContain('[err:2] ZeroDivisionError: division by zero')
    expect(text).toContain('Trace line 1')
    expect(text).not.toContain('\u001B')
  })

  it('renders rich binary outputs as one placeholder line', () => {
    const notebook = JSON.stringify({
      cells: [{ cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': 'aW1n' } }] }],
      metadata: {},
    })
    const result = formatNotebookLines(notebook, true)
    expect(result.lines.some(line => line.includes('image/png') && line.includes('omitted'))).toBe(true)
  })

  it('accepts nbformat 3 worksheets and rejects non-notebooks', () => {
    const v3 = JSON.stringify({ worksheets: [{ cells: [{ cell_type: 'code', source: 'x=1' }] }] }, null, 0)
    expect(formatNotebookLines(v3, false).cells).toBe(1)
    expect(() => formatNotebookLines('{"metadata":{}}', false)).toThrow(/no cells/)
    expect(() => formatNotebookLines('[]', false)).toThrow()
  })
})

describe('read_document tool', () => {
  let directory: string
  const tool = readDocumentToolDefinition()

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'read-doc-'))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('extracts a PDF end to end and windows the lines', async () => {
    const path = join(directory, 'sample.pdf')
    await writeFile(path, pdfWithContent('BT (Alpha) Tj 0 -14 Td (Beta) Tj 0 -14 Td (Gamma) Tj ET'))
    const full = await tool.execute({ file_path: path }, {})
    expect(full.lines).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(full.kind).toBe('pdf')
    expect(full.totalLines).toBe(3)
    const window = await tool.execute({ file_path: path, offset: 2, limit: 1 }, {})
    expect(window.lines).toEqual(['Beta'])
    expect(window.moreLines).toBe(1)
  })

  it('flags a text-less PDF in the result instead of returning a bare empty body', async () => {
    const path = join(directory, 'scanned.pdf')
    const compressed = deflateSync(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]))
    await writeFile(path, Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode /Subtype /Image >>`, 'latin1'),
      Buffer.from('\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ]))
    const result = await tool.execute({ file_path: path }, {})
    expect(result.lines).toEqual([])
    expect(result.textLayer).toBe(false)
    expect(result.note).toMatch(/scanned|image-only/)
  })

  it('formats a notebook end to end', async () => {
    const path = join(directory, 'sample.ipynb')
    await writeFile(path, JSON.stringify({ cells: [{ cell_type: 'code', source: 'x=1' }], metadata: {} }))
    const result = await tool.execute({ file_path: path }, {})
    expect(result.kind).toBe('notebook')
    expect(result.lines).toContain('x=1')
  })

  it('refuses credential-shaped paths before touching the disk', async () => {
    // A `.pem` basename is what the shared guard tier flags; an arbitrary name
    // that merely mentions a key (`id_rsa.pdf`) deliberately is not a denial.
    await expect(tool.execute({ file_path: join(directory, 'deploy-key.pem') }, {})).rejects.toThrow(/credential guard/)
  })

  it('refuses a symlink that resolves into a credential directory', async () => {
    const link = join(directory, 'report.pdf')
    const target = join(directory, '.ssh', 'id_ed25519')
    await mkdir(join(directory, '.ssh'), { recursive: true })
    await writeFile(target, 'not really a key')
    await symlink(target, link)
    await expect(tool.execute({ file_path: link }, {})).rejects.toThrow(/credential guard/)
  })

  it('rejects unsupported extensions with guidance back to read', async () => {
    const path = join(directory, 'notes.txt')
    await writeFile(path, 'plain')
    await expect(tool.execute({ file_path: path }, {})).rejects.toThrow(/use the read tool/)
  })

  it('reports absent files as a read failure', async () => {
    await expect(tool.execute({ file_path: join(directory, 'missing.pdf') }, {})).rejects.toThrow(/not found/)
  })
})
