/**
 * The contract this module owes a caller is byte equality: paging an artifact
 * must reconstruct exactly what was parked. So the tests page a payload that is
 * deliberately hostile to that — multi-byte characters, a line longer than any
 * budget, CRLF endings, and a final line with no newline.
 */

import { describe, expect, it } from 'vitest'
import { completeByteLength, MAX_RECALL_BYTES, readSpillPage, spillRetrievalGuidance, SpillOffsetError } from '../src/spill-recall.ts'

/** A payload whose every boundary is a chance to split a character or a line. */
function hostilePayload(targetBytes: number): string {
  const parts: string[] = []
  let index = 0
  while (Buffer.byteLength(parts.join(''), 'utf8') < targetBytes) {
    switch (index % 5) {
      case 0: parts.push(`line ${index} ascii\n`); break
      // Two-, three- and four-byte sequences, so a naive byte cut decodes to U+FFFD.
      case 1: parts.push(`grüße ${index} — 漢字 🎉\n`); break
      case 2: parts.push('x'.repeat(9_000) + '\n'); break
      case 3: parts.push(`crlf line ${index}\r\n`); break
      default: parts.push(''); break
    }
    index += 1
  }
  return parts.join('')
}

/** Page an artifact to the end, one call at a time, the way a caller must. */
function drain(content: string, input: Parameters<typeof readSpillPage>[1] = {}) {
  const pages: ReturnType<typeof readSpillPage>[] = []
  let offset = 0
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = readSpillPage(content, { ...input, offset })
    pages.push(page)
    if (page.eof) return pages
    expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
  throw new Error('paging did not terminate')
}

describe('spill recall paging', () => {
  it('reconstructs a 200KB artifact byte for byte', () => {
    const content = hostilePayload(200_000)
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThanOrEqual(200_000)
    const pages = drain(content)
    expect(pages.length).toBeGreaterThan(10)
    const rebuilt = Buffer.from(pages.map(page => page.text).join(''), 'utf8')
    expect(rebuilt.equals(Buffer.from(content, 'utf8'))).toBe(true)
  })

  it('reports the total size and the number of lines once, on every page', () => {
    const content = hostilePayload(60_000)
    const pages = drain(content)
    for (const page of pages) expect(page.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))
    const expectedLines = content.split('\n').length - 1 + (content.endsWith('\n') ? 0 : 1)
    expect(pages[0]?.totalLines).toBe(expectedLines)
  })

  it('marks eof only on the last page', () => {
    const pages = drain(hostilePayload(50_000))
    expect(pages.slice(0, -1).every(page => !page.eof)).toBe(true)
    expect(pages.at(-1)?.eof).toBe(true)
    expect(pages.at(-1)?.nextOffset).toBe(pages.at(-1)?.totalBytes)
  })

  it('never splits a multi-byte character, whichever way a caller pages', () => {
    // A one-byte budget walks every single character boundary, which is the worst
    // case a page size can produce.
    const content = 'grüße — 漢字 🎉\nsecond line\n'
    const pages = drain(content, { maxBytes: 1, maxLines: 1_000 })
    expect(pages.map(page => page.text).join('')).toBe(content)
    for (const page of pages) expect(page.text).not.toContain('\uFFFD')
  })

  it('retreats when an offset lands inside a character, and says so', () => {
    const content = '漢字'
    // Byte 1 is inside the first character's three-byte sequence.
    const page = readSpillPage(content, { offset: 1 })
    expect(page.offset).toBe(0)
    expect(page.text).toBe(content)
    // The retreat is reported as the offset served, so a caller paging by
    // arithmetic can see the page it got was not the page it asked for.
    expect(page.nextOffset).toBe(6)
  })

  it('cuts at a whole-line boundary when the line budget binds', () => {
    const content = 'one\ntwo\nthree\nfour\nfive\n'
    const page = readSpillPage(content, { maxLines: 2, maxBytes: 10_000 })
    expect(page.text).toBe('one\ntwo\n')
    expect(page.lines).toBe(2)
    // The next page therefore starts at a line start, not mid-line.
    expect(readSpillPage(content, { offset: page.nextOffset, maxLines: 2 }).text).toBe('three\nfour\n')
  })

  it('still advances when a single line exceeds the byte budget', () => {
    // Paging by line alone would ask for the same offset forever here, so the cut
    // falls back to a character boundary and the page reports zero whole lines.
    const content = 'x'.repeat(5_000) + '\ntail\n'
    const page = readSpillPage(content, { maxBytes: 1_000, maxLines: 5 })
    expect(page.bytes).toBe(1_000)
    expect(page.lines).toBe(0)
    expect(page.eof).toBe(false)
    const rest = drain(content, { maxBytes: 1_000, maxLines: 5 })
    expect(rest.map(entry => entry.text).join('')).toBe(content)
  })

  it('refuses an offset past the end rather than returning an empty page', () => {
    const content = 'short\n'
    expect(() => readSpillPage(content, { offset: Buffer.byteLength(content, 'utf8') + 1 })).toThrow(SpillOffsetError)
    // The exact end is a legitimate place to ask from: it is what a caller that
    // finished the previous page and did not read `eof` will ask for.
    expect(readSpillPage(content, { offset: Buffer.byteLength(content, 'utf8') }).eof).toBe(true)
  })

  it('treats a missing or nonsensical offset as the start', () => {
    const content = 'abc\n'
    expect(readSpillPage(content).text).toBe(content)
    expect(readSpillPage(content, { offset: Number.NaN }).offset).toBe(0)
    expect(readSpillPage(content, { offset: -5 }).offset).toBe(0)
  })

  it('caps a page below the artifact, so one call cannot repark the whole thing', () => {
    const content = 'y'.repeat(MAX_RECALL_BYTES * 2)
    const page = readSpillPage(content, { maxBytes: MAX_RECALL_BYTES * 10 })
    expect(page.bytes).toBe(MAX_RECALL_BYTES)
    expect(page.eof).toBe(false)
  })

  it('counts a trailing line that has no newline after it', () => {
    expect(readSpillPage('a\nb\n').totalLines).toBe(2)
    expect(readSpillPage('a\nb').totalLines).toBe(2)
    expect(readSpillPage('').totalLines).toBe(0)
  })
})

describe('truncated windows', () => {
  const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'))

  it('leaves an incomplete trailing character for the next page', () => {
    const whole = bytesOf('漢字')
    // Cutting inside the second character (bytes 3..5) leaves one character whole.
    expect(completeByteLength(whole.subarray(0, 4))).toBe(3)
    expect(completeByteLength(whole.subarray(0, 5))).toBe(3)
    expect(completeByteLength(whole)).toBe(6)
  })

  it('keeps a complete window intact, including a four-byte character', () => {
    expect(completeByteLength(bytesOf('🎉'))).toBe(4)
    expect(completeByteLength(bytesOf('ascii'))).toBe(5)
    expect(completeByteLength(new Uint8Array())).toBe(0)
  })

  it('decodes a trimmed window with no replacement character', () => {
    const content = 'grüße — 漢字 🎉 and more'
    const whole = bytesOf(content)
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const trimmed = completeByteLength(whole.subarray(0, cut))
      const decoded = Buffer.from(whole.subarray(0, trimmed)).toString('utf8')
      expect(decoded).not.toContain('\uFFFD')
      expect(content.startsWith(decoded)).toBe(true)
    }
  })
})

describe('spill retrieval guidance', () => {
  it('names the size, the call, and how to continue', () => {
    const text = spillRetrievalGuidance({ bytes: 204_800, lines: 4_096, locator: '/tmp/spill/abc.txt' })
    expect(text).toContain('204,800 bytes, 4,096 lines')
    expect(text).toContain('/tmp/spill/abc.txt')
    expect(text).toContain('nextOffset')
    expect(text).toContain('eof')
  })

  it('works when the backend reports no line count', () => {
    expect(spillRetrievalGuidance({ bytes: 1_024, locator: '/tmp/x' })).toContain('1,024 bytes parked')
  })
})
