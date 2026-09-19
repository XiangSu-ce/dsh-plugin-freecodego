/**
 * `read_document` — the two document formats the harness `read` tool cannot
 * show the model: PDF and Jupyter notebook.
 *
 * Why a separate tool instead of extending `read`
 * -----------------------------------------------
 * The harness `read` is a UTF-8 text reader with a strict line-window contract
 * (offset/limit, line numbers, presentation meta, replay views). PDFs are
 * binary; notebooks are JSON whose `outputs` must be filtered, not shown. Both
 * need content *transformation*, which is a different contract than `read`'s
 * content *windowing*. A separate, narrow tool leaves `read`'s schema and
 * replay views untouched and is honest in the tool list: the model picks
 * `read_document` when the format needs it. The credential guard applies to it
 * exactly as to `read` (both the lexical and the realpath tier — see
 * `tool-guards.ts`, which names this tool).
 *
 * PDF
 * ---
 * Text is extracted from content streams with a bounded scanner: literal and
 * hex strings are decoded, Tj/TJ/'/" drive emission, and Td/TD/T* advance the
 * row so each layout line becomes one output line. TJ gaps below -100 insert a
 * word break. FlateDecode, ASCIIHexDecode, and ASCII85Decode are supported;
 * identical streams (incremental updates duplicate them) are deduplicated by
 * hash. Fonts and images contain no text operators and are skipped. No
 * external dependencies.
 *
 * Notebook
 * --------
 * Formatted from the raw JSON: a header line (kernel/language when present),
 * then per cell an index heading and the source lines. Outputs are included
 * only when `include_outputs` is set — stream output as lines, execute_result
 * as `[out:N]` lines (rich MIME bundles fall back to text/plain), errors as
 * `[err:N]` with the traceback (ANSI stripped), binary MIME as one placeholder
 * line instead of megabytes of base64.
 */

import { createHash } from 'node:crypto'
import { readFile, stat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { ToolDefinitionShape } from './tool-definition.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { isCredentialPath } from './tool-guards.ts'

/** Whole-file cap for both formats: a document larger than this is refused. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

/** Default per-document output cap (characters of extracted/formatted text). */
const DEFAULT_MAX_CHARS = 60_000

/** Hard per-document output cap. */
const MAX_MAX_CHARS = 400_000

/**
 * Cap on one stream's *decoded* size.
 *
 * A PDF is compressed, so a small file can inflate enormously: 81 KB of deflate
 * expands to 80 MB here (a 1000:1 ratio), and one document may hold thousands of
 * streams. This cap is what keeps a hostile — or merely pathological — document
 * from turning a 64 MB file into gigabytes of decoded bytes, and it sits far
 * above anything text extraction can use: the hard output budget is
 * {@link MAX_MAX_CHARS} characters, so a single stream holding more than this
 * buys the model nothing. A stream past the cap is refused rather than
 * truncated, which is why {@link PdfExtraction} counts it separately — an empty
 * result must not be blamed on the font encoding when the real cause is a
 * bomb.
 */
const MAX_DECODED_STREAM_BYTES = 8 * 1024 * 1024

/** Default and maximum window size (`limit`), mirroring the read tool's shape. */
const DEFAULT_WINDOW = 2_000

/**
 * Resolve `~` and relative paths, then realpath so a symlink pointing at a
 * credential is caught by the guard on the *resolved* path. Fail-open on an
 * unresolvable path keeps the lexical decision standing (the file will fail
 * to open anyway).
 */
async function resolveDocumentPath(raw: string): Promise<string> {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('file_path must be a non-empty string')
  let candidate = trimmed
  if (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = resolve(homedir(), candidate.slice(2))
  }
  if (!isAbsolute(candidate)) candidate = resolve(process.cwd(), candidate)
  try {
    return await realpath(candidate)
  } catch {
    return candidate
  }
}

function clampInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return Math.min(value, max)
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

interface StreamRange {
  readonly dict: string
  readonly dataStart: number
  readonly dataEnd: number
  /** The stream's bytes after filter application, when they decoded. */
  readonly decoded?: Uint8Array
}

function findKeyword(data: Uint8Array, keyword: string, from: number): number {
  const bytes = Buffer.from(keyword, 'latin1')
  outer: for (let i = from; i <= data.length - bytes.length; i += 1) {
    for (let j = 0; j < bytes.length; j += 1) if (at(data, i + j) !== at(bytes, j)) continue outer
    return i
  }
  return -1
}

function isPdfWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D || byte === 0x0C || byte === 0x00
}

/**
 * Bounds-checked byte read. `noUncheckedIndexedAccess` is on, and a scanner
 * over raw PDF bytes indexes past the end constantly; one accessor keeps the
 * loops honest instead of scattering non-null assertions through them.
 */
const at = (data: Uint8Array, index: number): number => (index >= 0 && index < data.length ? data[index] : undefined) ?? -1

/**
 * Locate `dict … >> stream\n … endstream` ranges. The `stream` keyword is
 * disambiguated from `endstream` by requiring a `>` (dictionary close) before
 * it and an end-of-line after it, so prose that merely contains the word is
 * never mistaken for a stream.
 *
 * A generator rather than an array, deliberately: the caller extracts text one
 * stream at a time and stops at its character budget, while each decoded stream
 * is now large enough (see {@link MAX_DECODED_STREAM_BYTES}) that retaining all
 * of them at once is exactly the amplification the cap exists to prevent. A
 * generator keeps at most one decoded stream alive; abandoning the loop early
 * (the budget path) stops the scan instead of having already paid for it.
 *
 * @param data - the whole PDF file.
 * @param limit - maximum number of decoded streams to yield.
 * @param scan - mutable counter for streams refused for exceeding the cap.
 */
function* findStreamRanges(data: Uint8Array, limit: number, scan: { oversized: number }): Generator<StreamRange> {
  let found = 0
  let cursor = 0
  while (found < limit) {
    const keyword = findKeyword(data, 'stream', cursor)
    if (keyword < 0) break
    let back = keyword - 1
    while (back >= 0 && isPdfWhitespace(at(data, back))) back -= 1
    const dictClosed = back >= 1 && at(data, back) === 0x3E && at(data, back - 1) === 0x3E
    let forward = keyword + 6
    if (dictClosed && at(data, forward) === 0x0D) forward += 1
    if (!dictClosed || at(data, forward) !== 0x0A) {
      cursor = keyword + 6
      continue
    }
    const dataStart = forward + 1
    const terminator = findKeyword(data, 'endstream', dataStart)
    if (terminator < 0) break
    const dict = dictText(data, back - 1)
    const filters = parseFilters(dict)
    // Where the data ends is genuinely ambiguous: `/Length` is authoritative
    // when present, but a producer may also (or only) rely on the EOL before
    // `endstream`. The EOL trim cannot simply be applied, because compressed
    // bytes can legitimately end in 0x0D or 0x0A themselves — stripping one
    // byte too many truncates the deflate stream and the whole thing fails.
    // So the boundaries are candidates, tried in order of authority, and a
    // boundary is accepted when the data actually decodes.
    const candidates: number[] = []
    const declared = parseDeclaredLength(dict)
    if (declared !== undefined && dataStart + declared <= terminator + 1) candidates.push(dataStart + declared)
    let trimmed = terminator
    if (trimmed > dataStart && at(data, trimmed - 1) === 0x0A) trimmed -= 1
    if (trimmed > dataStart && at(data, trimmed - 1) === 0x0D) trimmed -= 1
    if (trimmed !== terminator) candidates.push(trimmed)
    if (terminator > dataStart && at(data, terminator - 1) === 0x0A) candidates.push(terminator - 1)
    candidates.push(terminator)
    let decoded: Uint8Array | undefined
    let dataEnd = terminator
    for (const candidateEnd of candidates) {
      if (candidateEnd <= dataStart) continue
      const attempt = decodeStreamData(data.subarray(dataStart, candidateEnd), filters)
      // Over the cap: no other boundary can help (the stream is simply too
      // large), so the whole stream is refused and reported as such.
      if (attempt === 'oversized') { scan.oversized += 1; break }
      if (attempt !== undefined && attempt.bytes.length >= 8) { decoded = attempt.bytes; dataEnd = candidateEnd; break }
    }
    if (decoded === undefined) {
      cursor = terminator + 9
      continue
    }
    yield { dict, dataStart, dataEnd, decoded }
    found += 1
    cursor = terminator + 9
  }
}

function dictText(data: Uint8Array, closeIndex: number): string {
  let depth = 1
  let i = closeIndex - 1
  while (i >= 1) {
    if (at(data, i) === 0x3E && at(data, i - 1) === 0x3E) { depth += 1; i -= 2; continue }
    if (at(data, i) === 0x3C && at(data, i + 1) === 0x3C) {
      depth -= 1
      if (depth === 0) return Buffer.from(data.slice(i, closeIndex + 1)).toString('latin1')
      i -= 2
      continue
    }
    i -= 1
  }
  return ''
}

/** A direct `/Length n` value; an indirect `/Length n 0 R` is not resolved here. */
function parseDeclaredLength(dict: string): number | undefined {
  const match = /\/Length\s+(\d+)(?!\s+\d+\s+R\b)/u.exec(dict)
  return match === null || match[1] === undefined ? undefined : Number(match[1])
}

function parseFilters(dict: string): string[] {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/u.exec(dict)
  if (match === null || match[1] === undefined) return []
  if (match[1].startsWith('[')) return [...match[1].matchAll(/\/([A-Za-z0-9]+)/gu)].map(entry => entry[1] ?? '')
  return [match[1].slice(1)]
}

/**
 * Decode ASCIIHex data, refusing rather than accumulating past `maxBytes`.
 *
 * `maxBytes` is {@link MAX_DECODED_STREAM_BYTES}, passed in rather than owned
 * here: it is the reader's answer to a document that decodes to more than a stream
 * can usefully hold, so every filter the reader decodes has to apply it. Left out
 * of the two ASCII filters, a 9 MB ASCII85 body — 11 MB on disk, well under the file
 * cap — was decoded and scanned while the reader described a cap it was not
 * applying. The refusal also has to happen *during* the decode: every byte passes
 * through a JS number array on the way to a `Uint8Array`, so the peak cost of an
 * uncapped stream is several times its decoded size, and it is paid before any
 * caller can notice the result was never going to be usable.
 */
function decodeAsciiHex(data: Uint8Array, maxBytes: number): Uint8Array | 'oversized' {
  const out: number[] = []
  let high = -1
  for (let i = 0; i < data.length && at(data, i) !== 0x3E; i += 1) {
    if (out.length > maxBytes) return 'oversized'
    const c = at(data, i)
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1
    if (v < 0) continue
    if (high < 0) high = v
    else { out.push((high << 4) | v); high = -1 }
  }
  if (high >= 0) out.push(high << 4)
  return out.length > maxBytes ? 'oversized' : Uint8Array.from(out)
}

/** Decode ASCII85 data under the same cap, and for the same reasons. */
function decodeAscii85(data: Uint8Array, maxBytes: number): Uint8Array | 'oversized' {
  let start = 0
  if (data[0] === 0x3C && data[1] === 0x7E) start = 2
  const out: number[] = []
  const group: number[] = []
  for (let i = start; i < data.length; i += 1) {
    if (out.length > maxBytes) return 'oversized'
    const c = at(data, i)
    if (isPdfWhitespace(c)) continue
    if (c === 0x7E && at(data, i + 1) === 0x3E) break // ~>
    if (c === 0x7A && group.length === 0) { out.push(0, 0, 0, 0); continue } // z
    if (c < 0x21 || c > 0x75) break
    group.push(c - 0x21)
    if (group.length === 5) {
      let value = 0
      for (const digit of group) value = value * 85 + digit
      out.push((value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF)
      group.length = 0
    }
  }
  if (group.length > 1) {
    let value = 0
    const padded = [...group, ...Array.from({ length: 5 - group.length }, () => 84)]
    for (const digit of padded) value = value * 85 + digit
    for (let k = 0; k < group.length - 1; k += 1) out.push((value >>> (24 - 8 * k)) & 0xFF)
  }
  return out.length > maxBytes ? 'oversized' : Uint8Array.from(out)
}

/**
 * The error code Node's zlib raises when `maxOutputLength` is exceeded.
 *
 * It is a *refusal*, not a decode failure, and the two must stay distinct: a
 * corrupt stream is skipped silently, while an over-cap stream is reported so
 * the empty result is not misattributed.
 */
function isOverCap(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { readonly code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
}

/**
 * Decode a stream's data by applying its filters in reverse.
 *
 * @param raw - the undecoded stream bytes.
 * @param filters - the stream's `/Filter` names, in application order.
 * @returns the decoded bytes; `'oversized'` when a filter's output ran past
 *          {@link MAX_DECODED_STREAM_BYTES}, which every filter enforces rather
 *          than only the inflating one; `undefined` when a filter is unsupported or
 *          the data is not decodable.
 */
function decodeStreamData(raw: Uint8Array, filters: string[]): { readonly bytes: Uint8Array } | 'oversized' | undefined {
  let data = raw
  for (let f = filters.length - 1; f >= 0; f -= 1) {
    const name = filters[f]
    try {
      if (name === 'FlateDecode' || name === 'Fl') {
        try {
          data = inflateSync(data, { maxOutputLength: MAX_DECODED_STREAM_BYTES })
        } catch (error) {
          // A zlib header is optional in PDFs, so a flate failure means "try
          // raw" — except over the cap, where the raw decoder would refuse the
          // same data for the same reason.
          if (isOverCap(error)) return 'oversized'
          data = inflateRawSync(data, { maxOutputLength: MAX_DECODED_STREAM_BYTES })
        }
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        const decoded = decodeAsciiHex(data, MAX_DECODED_STREAM_BYTES)
        if (decoded === 'oversized') return 'oversized'
        data = decoded
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        const decoded = decodeAscii85(data, MAX_DECODED_STREAM_BYTES)
        if (decoded === 'oversized') return 'oversized'
        data = decoded
      } else {
        return undefined
      }
    } catch (error) {
      return isOverCap(error) ? 'oversized' : undefined
    }
  }
  return { bytes: data }
}

/**
 * Dictionary declarations that rule a stream out as a content stream.
 *
 * `/Subtype /Form` is deliberately absent: a form XObject *is* a content stream
 * and can draw text.
 */
const DECLARED_NON_CONTENT_RE = /\/Subtype\s*\/(?:Image|XML|Type1C|CIDFontType0C|OpenType|TrueType|Bytes)\b|\/Type\s*\/(?:Font|FontDescriptor|FontFile[23]?|Metadata|ObjStm|EmbeddedFile|CMap|XRef|Sig|Filespec)\b/u

/**
 * Share of a stream's bytes that must be ASCII or PDF whitespace before the
 * stream is read as a content stream.
 *
 * Measured: compressed image samples and font outlines sit near 0.40 (95 of 256
 * byte values are printable, plus the whitespace codes) while real content
 * streams sit near 1.0, so the gap is wide and the exact value is not load
 * bearing. What this test buys is the stream that declares nothing — the usual
 * shape for an embedded font program, whose `/FontFile2` reference lives in the
 * font descriptor rather than in the stream's own dictionary. A content stream
 * that is itself mostly raw inline-image bytes is the boundary case and is read
 * as a carrier; inline images of that size are normally XObjects.
 */
const CONTENT_STREAM_PRINTABLE_RATIO = 0.6

/**
 * Whether a decoded stream is a content stream rather than a carrier of bytes.
 *
 * A two-byte search for `Tj`/`TJ` is not evidence of text: image samples and font
 * programs are arbitrary bytes, and a 200 KB one contains such a pair with
 * probability close to 1. Measured before this guard existed — a scanned page's
 * only stream, an `/Subtype /Image` XObject, was counted as a text stream, its
 * bytes were tokenized into one garbage "line", and since `lines.length > 0`
 * `describePdfLimitation` said nothing at all, so the "no text layer found …
 * needs OCR" message was unreachable for exactly the documents it was written
 * for. The pin for that message passed only because its image fixture was ten
 * bytes long and happened to contain no such byte pair.
 */
function isContentStream(dict: string, data: Uint8Array): boolean {
  if (DECLARED_NON_CONTENT_RE.test(dict)) return false
  let printable = 0
  for (let i = 0; i < data.length; i += 1) {
    const c = at(data, i)
    if ((c >= 0x20 && c <= 0x7E) || isPdfWhitespace(c)) printable += 1
  }
  return printable / data.length >= CONTENT_STREAM_PRINTABLE_RATIO
}

/**
 * Whether a decoded stream shows text through any of the four operators that can.
 *
 * `Tj` and `TJ` are found as byte pairs, which is exact: a two-letter operator
 * cannot occur inside another token. `'` and `"` cannot be, because both bytes are
 * *regular* characters in PDF's token grammar — `(it's)` and `(a " b)` hold them
 * inside strings — so they count only in operator position: bare, surrounded by
 * whitespace or by the delimiters that end a token. That is also what the
 * dispatcher believes. Until this, the gate searched for `Tj`/`TJ` alone, so a
 * stream that showed its text exclusively with `'` or `"` — both implemented in
 * {@link applyTextOperator}, both named in this module's header — was dropped
 * before tokenizing, and `describePdfLimitation` answered "no text operators
 * found … drawn as vector outlines" about a page of ordinary text.
 *
 * The boundary rule cannot tell a bare `'` inside a literal string from the
 * operator. The cost of that is bounded and pinned by a test: the stream is
 * tokenized, yields nothing, and only the explanation of an empty result moves
 * from "no operators" to "operators that produced no text" — no text is invented.
 */
function hasTextOperators(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const c = at(data, i)
    if (c === 0x54 && (at(data, i + 1) === 0x6A || at(data, i + 1) === 0x4A)) return true
    if (c !== 0x27 && c !== 0x22) continue
    const before = i === 0 ? -1 : at(data, i - 1)
    const after = i + 1 >= data.length ? -1 : at(data, i + 1)
    if ((before === -1 || isPdfWhitespace(before) || isDelimiter(before)) && (after === -1 || isPdfWhitespace(after) || isDelimiter(after))) return true
  }
  return false
}

function isDelimiter(byte: number): boolean {
  return isPdfWhitespace(byte) || byte === 0x28 || byte === 0x29 || byte === 0x3C || byte === 0x3E || byte === 0x5B || byte === 0x5D || byte === 0x7B || byte === 0x7D || byte === 0x2F || byte === 0x25
}

function readLiteralString(data: Uint8Array, start: number): { text: string; end: number } {
  const out: number[] = []
  let depth = 1
  let i = start + 1
  while (i < data.length && depth > 0) {
    const c = at(data, i)
    if (c === 0x5C) {
      i += 1
      if (i >= data.length) break
      const e = at(data, i)
      if (e >= 0x30 && e <= 0x37) {
        let value = 0
        let digits = 0
        while (digits < 3 && i < data.length && at(data, i) >= 0x30 && at(data, i) <= 0x37) { value = value * 8 + (at(data, i) - 0x30); digits += 1; i += 1 }
        out.push(value & 0xFF)
        continue
      }
      if (e === 0x6E) out.push(0x0A)
      else if (e === 0x72) out.push(0x0D)
      else if (e === 0x74) out.push(0x09)
      else if (e === 0x62) out.push(0x08)
      else if (e === 0x66) out.push(0x0C)
      else if (e === 0x0D) { if (at(data, i + 1) === 0x0A) i += 1 }
      else if (e !== 0x0A) out.push(e)
      i += 1
      continue
    }
    if (c === 0x28) depth += 1
    else if (c === 0x29) {
      depth -= 1
      if (depth === 0) { i += 1; break }
    }
    out.push(c)
    i += 1
  }
  return { text: Buffer.from(out).toString('latin1'), end: i }
}

function readHexString(data: Uint8Array, start: number): { text: string; end: number } {
  const out: number[] = []
  let high = -1
  let i = start + 1
  while (i < data.length && at(data, i) !== 0x3E) {
    const c = at(data, i)
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1
    if (v >= 0) {
      if (high < 0) high = v
      else { out.push((high << 4) | v); high = -1 }
    }
    i += 1
  }
  if (high >= 0) out.push(high << 4)
  return { text: Buffer.from(out).toString('latin1'), end: i + 1 }
}

interface TextSink {
  show(text: string): void
  newline(): void
}

/** Dispatch one content-stream operator against the operand stack. */
function applyTextOperator(op: string, stack: unknown[], sink: TextSink): void {
  const str = (value: unknown): string => value !== null && typeof value === 'object' && 'str' in value ? String((value).str) : ''
  const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (op === 'Tj' || op === "'") {
    // `'` moves to the next line BEFORE showing; showing first would glue the
    // text onto the previous line's tail.
    if (op === "'") sink.newline()
    sink.show(str(stack.pop()))
    return
  }
  if (op === '"') {
    sink.newline()
    sink.show(str(stack.pop()))
    return
  }
  if (op === 'TJ') {
    const value = stack.pop()
    const entries = value !== null && typeof value === 'object' && 'array' in value ? (value as { array: unknown[] }).array : []
    let text = ''
    for (const entry of entries) {
      if (entry !== null && typeof entry === 'object' && 'str' in entry) text += String((entry).str)
      else if (typeof entry === 'number' && entry <= -100) text += ' '
    }
    sink.show(text)
    return
  }
  if (op === 'Td' || op === 'TD') {
    const ty = num(stack.pop())
    stack.pop() // tx
    if (ty !== 0) sink.newline()
    return
  }
  if (op === 'T*') { sink.newline(); return }
  if (op === 'BT' || op === 'ET') sink.newline()
}

/**
 * Scan one decoded content stream for text. A single pass tokenizer keeps an
 * operand stack; strings and numbers land on it, TJ arrays are collected on
 * `]`, and operators consume what they need. Leftover operands are harmless —
 * every operator we care about pops exactly what it placed.
 */
function extractContentText(data: Uint8Array): string[] {
  const lines: string[] = []
  let current = ''
  const sink: TextSink = {
    show(text: string): void { current += text },
    newline(): void {
      const trimmed = current.replace(/\s+$/u, '')
      if (trimmed !== '') lines.push(trimmed)
      current = ''
    },
  }
  const stack: unknown[] = []
  const length = data.length
  let i = 0
  while (i < length) {
    const c = at(data, i)
    if (c < 0) break
    if (c === 0x25) { // comment to end of line
      while (i < length && at(data, i) !== 0x0A && at(data, i) !== 0x0D) i += 1
      continue
    }
    if (isPdfWhitespace(c)) { i += 1; continue }
    if (c === 0x28) { const s = readLiteralString(data, i); stack.push({ str: s.text }); i = s.end; continue }
    if (c === 0x3C && at(data, i + 1) !== 0x3C) { const s = readHexString(data, i); stack.push({ str: s.text }); i = s.end; continue }
    if (c === 0x3C) { stack.push({ dict: true }); i += 2; continue }
    if (c === 0x5B) { stack.push({ mark: true }); i += 1; continue }
    if (c === 0x5D) {
      const entries: unknown[] = []
      while (stack.length > 0) {
        const top = stack.pop()
        if (top !== null && typeof top === 'object' && 'mark' in top) break
        entries.unshift(top)
      }
      stack.push({ array: entries })
      i += 1
      continue
    }
    if (c === 0x2F) {
      let j = i + 1
      while (j < length && at(data, j) >= 0x21 && at(data, j) <= 0x7E && !isDelimiter(at(data, j))) j += 1
      stack.push({ name: Buffer.from(data.slice(i + 1, j)).toString('latin1') })
      i = j
      continue
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2B || c === 0x2D || c === 0x2E) {
      let j = i
      while (j < length && ((at(data, j) >= 0x30 && at(data, j) <= 0x39) || at(data, j) === 0x2B || at(data, j) === 0x2D || at(data, j) === 0x2E)) j += 1
      stack.push(Number(Buffer.from(data.slice(i, j)).toString('latin1')))
      i = j
      continue
    }
    if (c > 0x20 && c < 0x7F && !isDelimiter(c)) {
      let j = i
      while (j < length && at(data, j) > 0x20 && at(data, j) < 0x7F && !isDelimiter(at(data, j))) j += 1
      applyTextOperator(Buffer.from(data.slice(i, j)).toString('latin1'), stack, sink)
      i = j
      continue
    }
    i += 1
  }
  sink.newline()
  return lines
}

export interface PdfExtraction {
  readonly lines: readonly string[]
  readonly truncated: boolean
  readonly streams: number
  /** Content streams that contained text operators, whether or not they yielded lines. */
  readonly textStreams: number
  /** An `/Encrypt` dictionary is present, so stream data cannot be decoded. */
  readonly encrypted: boolean
  /** At least one `/Image` XObject is present — a scanned page stores its text as a picture. */
  readonly imageOnly: boolean
  /**
   * Streams refused for inflating past {@link MAX_DECODED_STREAM_BYTES}.
   *
   * Counted separately from `streams` because they were never scanned: calling
   * them "streams without text operators" would blame the document's encoding
   * for a size refusal, and the model's next step differs (a bomb is not a font
   * problem).
   */
  readonly oversizedStreams: number
}

/**
 * Say why a PDF yielded no text, when it yielded none.
 *
 * An empty result is the most confusing outcome a reader can return: the model
 * cannot tell a scanned document from an encrypted one from a parser gap, and
 * the three demand different next steps (OCR, ask the user for a copy, try
 * another tool). Naming the cause turns a dead end into an instruction.
 *
 * @param extraction - the finished extraction.
 * @returns the explanation, or `undefined` when there is text to show.
 */
export function describePdfLimitation(extraction: PdfExtraction): string | undefined {
  if (extraction.lines.length > 0) return undefined
  if (extraction.encrypted) return 'the PDF is encrypted, so its content streams cannot be decoded — ask the user for an unprotected copy if the text is needed'
  // Ahead of the scanned/encoding explanations: when a stream was refused for
  // size, that refusal is the fact of the extraction, and the other two readings
  // would send the model to OCR or to a font-conversion detour for a file that
  // was simply not decoded.
  if (extraction.oversizedStreams > 0) return `a content stream expands past the ${String(Math.round(MAX_DECODED_STREAM_BYTES / (1024 * 1024)))} MB decoded-size cap, so it was not scanned — the file is a decompression bomb, or an export this reader will not inflate`
  // "Scanned" requires BOTH sides of the evidence: pictures on the page AND no
  // content stream that even tried to draw text. A PDF with a logo and real
  // text operators that decoded to nothing is an encoding problem, not a scan,
  // and calling it a scan would send the model off to OCR for no reason.
  if (extraction.imageOnly && extraction.textStreams === 0) return 'no text layer found: this looks like a scanned or image-only PDF, so the text lives in pictures and needs OCR rather than extraction'
  if (extraction.textStreams === 0) return 'no text operators found: the text may be drawn as vector outlines, or stored in an encoding this reader does not decode'
  return 'text operators were found but produced no readable text: the page likely uses a font encoding this reader does not map (common with subset CID fonts)'
}

/**
 * Extract text lines from PDF bytes: decode every content stream, skip
 * streams without text operators (fonts, images, xref), deduplicate identical
 * streams (incremental saves re-emit them), and stop at the character budget.
 */
export function extractPdfLines(data: Uint8Array, maxChars: number): PdfExtraction {
  const seen = new Set<string>()
  const lines: string[] = []
  let used = 0
  let truncated = false
  let streams = 0
  let textStreams = 0
  // A zero-copy view for byte-pattern searches. `/Image` also matches
  // `/ImageMask`, which is equally an image-only page.
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const encrypted = view.indexOf('/Encrypt') >= 0
  const imageOnly = view.indexOf('/Image') >= 0
  // Shared with the scan so a stream that was refused for size is still
  // reported by the outcomes below, including the budget-truncated one.
  const scan = { oversized: 0 }
  const outcome = (): PdfExtraction => ({ lines, truncated, streams, textStreams, encrypted, imageOnly, oversizedStreams: scan.oversized })
  for (const range of findStreamRanges(data, 4_096, scan)) {
    if (lines.length > 200_000) { truncated = true; break }
    const decoded = range.decoded
    if (decoded === undefined || decoded.length < 8) continue
    // The `/Type /XRef` skip that used to sit here is part of this test now, so
    // one place decides what a content stream is.
    if (!isContentStream(range.dict, decoded) || !hasTextOperators(decoded)) continue
    textStreams += 1
    const hash = createHash('sha1').update(decoded).digest('hex')
    if (seen.has(hash)) continue
    seen.add(hash)
    streams += 1
    for (const line of extractContentText(decoded)) {
      const fit = fitLine(line, used, lines.length, maxChars)
      used = fit.used
      if (fit.text !== undefined) lines.push(fit.text)
      if (fit.done) {
        truncated = true
        return outcome()
      }
    }
  }
  return outcome()
}

// ---------------------------------------------------------------------------
// Notebook formatting
// ---------------------------------------------------------------------------

const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/gu

/** Per-cell output line cap: a wall of prints cannot flood the window. */
const MAX_OUTPUT_LINES_PER_CELL = 100

function sourceLines(source: unknown): string[] {
  const text = Array.isArray(source) ? source.map(String).join('') : typeof source === 'string' ? source : ''
  return text.split('\n')
}

/**
 * Cut formatted lines to a character budget, and say whether anything was cut.
 *
 * The same budget the PDF extractor already honoured, applied to the *formatted*
 * text. Without it the parameter was accepted, documented as "extraction budget in
 * characters", and silently ignored on the notebook path — measured, a notebook
 * with one long source line returned 200,041 characters in answer to a request for
 * 500. The line window is not a substitute: it bounds lines, and a line has no
 * length limit.
 *
 * `used` is the length of the joined text, so the budget is a property of what the
 * caller receives rather than of a running sum: each accepted line costs its own
 * length plus the newline that joins it, and the line that does not fit is kept as
 * the part of it that does. In-band markers are deliberately absent, because this is
 * exactly how the PDF path reports the same event — the text stops where the budget
 * ended and the caller learns it from `truncatedByChars` and the note, not from a
 * marker line that is not part of the document.
 *
 * @param lines - the formatted lines.
 * @param maxChars - the budget in characters, counting each newline as one.
 * @returns the lines that fit, and whether any line was shortened or dropped.
 */
/**
 * Charge one formatted line against the character budget.
 *
 * This is the budget rule of the whole tool, in one place, because it now has two
 * callers: the notebook formatter and the PDF extractor. For a while it had one,
 * and that is exactly what went wrong — "when a line does not fit, keep the part of
 * it that does" was written into the notebook path while the PDF path dropped the
 * whole line, so a PDF whose text was a single long line returned *no text at all*
 * and was then described as a font-encoding failure. Both callers ask this function
 * now, so the two paths cannot drift apart again.
 *
 * @param line - the formatted line being charged.
 * @param used - the total already spent, counting each kept line plus its newline.
 * @param kept - how many lines were kept so far; a later line pays for the newline
 *               that joins it, the first one does not.
 * @param maxChars - the budget in characters.
 * @returns the text to keep (the line, a prefix of it, or `undefined` when the
 *          budget left no room), the new total, and whether the budget is spent.
 */
function fitLine(line: string, used: number, kept: number, maxChars: number): { readonly text: string | undefined; readonly used: number; readonly done: boolean } {
  const cost = line.length + 1
  if (used + cost <= maxChars) return { text: line, used: used + cost, done: false }
  // The budget ends inside this line: keep what fits, so a document whose first
  // line is one long line still returns a usable prefix instead of nothing.
  // `undefined` rather than `''`: an empty line that fits is still a kept line, and
  // the notebook formatter pushes blank separators.
  const room = maxChars - used - (kept === 0 ? 0 : 1)
  return { text: room > 0 ? line.slice(0, room) : undefined, used: maxChars, done: true }
}

function capLinesByChars(lines: readonly string[], maxChars: number): { readonly lines: readonly string[]; readonly truncated: boolean } {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const fit = fitLine(line, used, kept.length, maxChars)
    used = fit.used
    if (fit.text !== undefined) kept.push(fit.text)
    if (fit.done) return { lines: kept, truncated: true }
  }
  return { lines: kept, truncated: false }
}

function capLines(lines: readonly string[], header: string): string[] {
  if (lines.length <= MAX_OUTPUT_LINES_PER_CELL) return [...lines]
  return [...lines.slice(0, MAX_OUTPUT_LINES_PER_CELL), `… (${lines.length - MAX_OUTPUT_LINES_PER_CELL} more lines of ${header} omitted)`]
}

function formatOutput(output: Record<string, unknown>, cellIndex: number, outputIndex: number): string[] {
  const type = typeof output.output_type === 'string' ? output.output_type : ''
  if (type === 'stream') return capLines(sourceLines(output.text).map(line => line.replace(/\n$/u, '')), 'stream output')
  if (type === 'error') {
    const head = `[err:${outputIndex}] ${String(output.ename ?? 'Error')}: ${String(output.evalue ?? '')}`
    const traceback = sourceLines(output.traceback).map(line => line.replace(ANSI_ESCAPE, ''))
    return capLines([head, ...traceback], 'traceback')
  }
  const data = typeof output.data === 'object' && output.data !== null ? output.data as Record<string, unknown> : {}
  const plain = data['text/plain']
  if (type === 'execute_result' || type === 'display_data') {
    if (plain !== undefined) return capLines(sourceLines(plain).map(line => `[out:${outputIndex}] ${line.replace(/\n$/u, '')}`), 'result output')
    const mime = Object.keys(data)[0]
    return [`[output omitted: ${mime ?? 'binary'} in cell ${cellIndex}]`]
  }
  return []
}

export interface NotebookFormat {
  readonly lines: readonly string[]
  readonly cells: number
  readonly kernel: string
  /** Present when the character budget cut the formatted text. */
  readonly truncated?: true
}

/**
 * Format a notebook's JSON into lines. nbformat 3 keeps cells under
 * `worksheets`; nbformat 4 under `cells` — both accepted.
 */
export function formatNotebookLines(source: string, includeOutputs: boolean, maxChars = DEFAULT_MAX_CHARS): NotebookFormat {
  // A leading byte-order mark is a legal prefix of a UTF-8 text file, and Windows
  // editors and PowerShell produce it: `JSON.parse` rejects it outright, so a
  // perfectly readable notebook used to arrive as `Unexpected token '\uFEFF'` —
  // JavaScript's message about JavaScript's rules, in answer to a document read.
  const body = source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    // The parser's own wording is still the most precise account of *what* is
    // malformed, so it is kept — behind the one sentence a caller can act on, and
    // **masked**, because a `JSON.parse` message quotes a window of the text it
    // rejected: a notebook that holds a key in a cell would print that key in the
    // refusal. This is the same treatment every other site that surfaces upstream
    // text gets (`tests/upstream-text-masking.spec.ts` names it).
    throw new Error(`not a Jupyter notebook: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not a Jupyter notebook: the root is not an object')
  const document = parsed as Record<string, unknown>
  const rawCells = Array.isArray(document.cells)
    ? document.cells
    : Array.isArray((document as { worksheets?: unknown }).worksheets)
      ? (document as { worksheets: Array<{ cells?: unknown }> }).worksheets.flatMap(worksheet => Array.isArray(worksheet?.cells) ? worksheet.cells : [])
      : undefined
  if (rawCells === undefined) throw new Error('not a Jupyter notebook: no cells found')
  const metadata = typeof document.metadata === 'object' && document.metadata !== null ? document.metadata as Record<string, unknown> : {}
  const language = typeof metadata.language_info === 'object' && metadata.language_info !== null && typeof (metadata.language_info as Record<string, unknown>).name === 'string'
    ? String((metadata.language_info as Record<string, unknown>).name)
    : typeof metadata.kernelspec === 'object' && metadata.kernelspec !== null && typeof (metadata.kernelspec as Record<string, unknown>).name === 'string'
      ? String((metadata.kernelspec as Record<string, unknown>).name)
      : 'unknown'
  const lines: string[] = []
  let cellIndex = 0
  for (const raw of rawCells) {
    if (typeof raw !== 'object' || raw === null) continue
    const cell = raw as Record<string, unknown>
    cellIndex += 1
    const kind = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown'
    lines.push(`### [${cellIndex}] ${kind}`)
    lines.push(...sourceLines(cell.source))
    if (includeOutputs && Array.isArray(cell.outputs)) {
      cell.outputs.forEach((output, outputIndex) => {
        if (typeof output === 'object' && output !== null) lines.push(...formatOutput(output as Record<string, unknown>, cellIndex, outputIndex))
      })
    }
    lines.push('')
  }
  // The budget is applied to the finished document rather than per cell: a per-cell
  // budget lets a thousand-cell notebook return a thousand budgets' worth, which is
  // the failure this closes.
  const budgeted = capLinesByChars(lines, maxChars)
  return { lines: budgeted.lines, cells: cellIndex, kernel: language, ...(budgeted.truncated ? { truncated: true } : {}) }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface ReadDocumentArgs {
  readonly file_path?: string
  readonly offset?: number
  readonly limit?: number
  readonly max_chars?: number
  readonly include_outputs?: boolean
}

export interface ReadDocumentExec {
  readonly signal?: AbortSignal
}

/** The result `read_document` returns once a document was read. */
export interface ReadDocumentResult {
  readonly path: string
  readonly kind: 'pdf' | 'notebook'
  /** Present only for a PDF whose text layer yielded nothing. */
  readonly textLayer?: false
  /** Human-readable provenance line: format, size, and any truncation. */
  readonly note: string
  /** 1-based first line of the returned window. */
  readonly offset: number
  readonly totalLines: number
  readonly returnedLines: number
  /** Lines after the window, when the requested window did not reach the end. */
  readonly moreLines?: number
  readonly truncatedByChars?: true
  readonly lines: readonly string[]
}

/**
 * The definition plus its own call signature.
 *
 * {@link ToolDefinitionShape} is a registration-shaped structural floor (its
 * `& Record<string, unknown>` accepts the call-signature members without typing
 * them), so a caller holding one sees `execute` as `unknown`. Naming the pair
 * here lets the regression suite call the tool directly — and therefore check
 * the result shape — instead of casting away the very types under test.
 */
export type ReadDocumentToolDefinition = ToolDefinitionShape & {
  execute(args: ReadDocumentArgs, exec: ReadDocumentExec): Promise<ReadDocumentResult>
}

/**
 * The `read_document` literal, built by the plugin and registered through the
 * same `ctx.get('tools')` seam as the other plugin tools.
 */
export function readDocumentToolDefinition(): ReadDocumentToolDefinition {
  return {
    name: 'read_document',
    description: 'Read a PDF or a Jupyter notebook (.ipynb) and return its text. PDFs are extracted from the document\'s text operators, one output line per layout line. Notebooks are formatted per cell; outputs are hidden unless include_outputs is true. Use the read tool for plain text files instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', required: true, description: 'Path to a .pdf or .ipynb file.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${DEFAULT_WINDOW}.` },
        max_chars: { type: 'number', description: `Extraction budget in characters. Defaults to ${DEFAULT_MAX_CHARS}.` },
        include_outputs: { type: 'boolean', description: 'Notebook only: include cell outputs (stream, results, errors). Defaults to false.' },
      },
      required: ['file_path'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => {
        const result = value as { note?: string; lines?: readonly string[] }
        const body = Array.isArray(result?.lines) ? result.lines.join('\n') : ''
        return [{ type: 'text' as const, text: `${result?.note ?? ''}\n${body}`.trim() }]
      },
    },
    presentCall: (args: ReadDocumentArgs) => ({
      card: 'generic',
      title: `Read document ${args?.file_path ?? ''}`,
      kind: 'read',
      locations: [{ path: args?.file_path ?? '' }],
    }),
    async execute(args: ReadDocumentArgs, exec: ReadDocumentExec) {
      const rawPath = typeof args?.file_path === 'string' ? args.file_path : ''
      const resolved = await resolveDocumentPath(rawPath)
      if (isCredentialPath(rawPath) || isCredentialPath(resolved)) {
        throw new Error('Blocked by the FreeCodeGo credential guard: this path looks like a credential or secret file. Ask the user for the needed value instead of reading it.')
      }
      const signal = exec?.signal
      // fs.stat has no signal-aware overload here; the read below is the
      // cancellable step, so the stat stays short and uncancellable.
      const info = await stat(resolved).catch(() => undefined)
      if (info === undefined) throw new Error(`cannot read "${resolved}": not found`)
      if (!info.isFile()) throw new Error(`cannot read "${resolved}": not a regular file`)
      if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`"${basename(resolved)}" exceeds the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB document cap`)
      const offset = clampInteger(args?.offset, 1, Number.MAX_SAFE_INTEGER, 'offset')
      const limit = clampInteger(args?.limit, DEFAULT_WINDOW, 100_000, 'limit')
      const maxChars = clampInteger(args?.max_chars, DEFAULT_MAX_CHARS, MAX_MAX_CHARS, 'max_chars')
      const lower = resolved.toLowerCase()

      let note: string
      let allLines: readonly string[]
      let extractionTruncated = false
      if (lower.endsWith('.pdf')) {
        const bytes = await readFile(resolved, signal === undefined ? undefined : { signal })
        const extraction = extractPdfLines(bytes, maxChars)
        extractionTruncated = extraction.truncated
        allLines = extraction.lines
        const limitation = describePdfLimitation(extraction)
        note = limitation !== undefined
          ? `[pdf] ${basename(resolved)} — no text could be extracted: ${limitation}`
          : `[pdf] ${basename(resolved)} — ${extraction.lines.length} lines of text from ${extraction.streams} content stream(s); layout approximated${extraction.truncated ? '; extraction stopped at the character budget' : ''}`
      } else if (lower.endsWith('.ipynb')) {
        const source = await readFile(resolved, { encoding: 'utf8', ...(signal === undefined ? {} : { signal }) })
        const includeOutputs = args?.include_outputs === true
        const formatted = formatNotebookLines(source, includeOutputs, maxChars)
        extractionTruncated = formatted.truncated === true
        allLines = formatted.lines
        note = `[notebook] ${basename(resolved)} — ${formatted.cells} cells (kernel: ${formatted.kernel})${includeOutputs ? '' : '; outputs hidden, pass include_outputs=true to show them'}${formatted.truncated === true ? '; formatted text stopped at the character budget' : ''}`
      } else {
        throw new Error(`read_document supports PDF (.pdf) and Jupyter notebook (.ipynb) files; use the read tool for text files: ${basename(resolved)}`)
      }

      const totalLines = allLines.length
      const window = allLines.slice(offset - 1, offset - 1 + limit)
      return {
        path: resolved,
        kind: lower.endsWith('.pdf') ? 'pdf' : 'notebook',
        // An empty extraction is a result, not an error: the note above says
        // why, and the flag lets a caller branch without parsing prose.
        ...(totalLines === 0 && lower.endsWith('.pdf') ? { textLayer: false } : {}),
        note,
        offset,
        totalLines,
        returnedLines: window.length,
        ...(offset - 1 + limit < totalLines ? { moreLines: totalLines - (offset - 1 + limit) } : {}),
        ...(extractionTruncated ? { truncatedByChars: true } : {}),
        lines: window,
      }
    },
  }
}
