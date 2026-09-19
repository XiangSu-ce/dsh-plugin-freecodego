/**
 * Paged, byte-exact retrieval of a parked tool result.
 *
 * Why
 * ---
 * `result-spill.ts` parks an oversized result and leaves a locator, and the model
 * reads it back with the file tools. That works, and it leaves two failures the
 * locator cannot prevent:
 *
 * 1. **A read that is too large.** A 200KB artifact read whole is the same context
 *    cost the clear was reclaiming, so the loop the clear closed reopens.
 * 2. **A read that is too small, silently.** A `read` with a line limit returns
 *    the *start* of the file with no statement of how much is left, so a model
 *    that wanted the end has no way to learn there was more.
 *
 * This module is the contract between those two: it answers with the bytes it
 * served, how many lines that was, and the exact offset to ask for next, so a
 * caller can walk the artifact in pieces and know when it has all of it.
 *
 * Byte offsets are the interface, on purpose: they are the unit the storage
 * measures in, they make each page's size checkable, and they make the
 * acceptance property expressible — concatenating the pages of an artifact, in
 * order, reconstructs its bytes exactly.
 *
 * Two boundaries are respected and neither is optional:
 *
 * - **No page may split a character.** A byte offset that lands inside a UTF-8
 *   sequence retreats to the start of that sequence, and a page end retreats off
 *   a partial sequence, because half a character decodes to U+FFFD and the
 *   caller would silently reconstruct different text than was parked.
 * - **No page may fail to advance.** A single line longer than the byte budget
 *   is cut at a character boundary rather than at a line boundary, because a
 *   caller paging by line alone would ask for the same offset forever.
 *
 * @module @deepseek-ai/dsh-freecodego/harness-plugin/spill-recall
 */

/** Default page size: large enough to be worth a call, small enough to be cheap. */
export const DEFAULT_RECALL_MAX_BYTES = 16_384
/** Default line budget, applied together with the byte budget. */
export const DEFAULT_RECALL_MAX_LINES = 400
/** Hard ceiling on one page, so a caller cannot ask for the artifact whole by accident. */
export const MAX_RECALL_BYTES = 256 * 1024

/** One page of an artifact. */
export interface SpillPage {
  readonly text: string
  /** Bytes in `text`, which is what the next offset advances by. */
  readonly bytes: number
  /** Whole lines in `text`. Zero when a single line exceeded the byte budget. */
  readonly lines: number
  /**
   * The offset that was actually served.
   *
   * Lower than the requested offset when the request landed inside a character,
   * which is reported rather than corrected in silence: a caller paging by
   * arithmetic needs to know the page it got is not the page it asked for.
   */
  readonly offset: number
  /** The offset to request next; equals `totalBytes` on the last page. */
  readonly nextOffset: number
  readonly eof: boolean
  readonly totalBytes: number
  readonly totalLines: number
}

/** An offset no page can start at, because it is past the artifact. */
export class SpillOffsetError extends Error {
  constructor(readonly totalBytes: number, readonly requested: number) {
    super(`offset ${requested} is past the end of the artifact (${totalBytes} bytes)`)
    this.name = 'SpillOffsetError'
  }
}

/** Whether this byte position continues a UTF-8 sequence. */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000
}

/**
 * Retreat an index to the start of the character it lands in.
 *
 * Exported because there are two ways into this module's paging — the artifact
 * in memory, and a window read from a file handle — and this rule is the one
 * thing they must never implement twice. A caller holding a window passes the
 * window and the index of the requested offset inside it; four bytes ending at
 * that offset always contain the character's first byte, because a UTF-8
 * character is at most four bytes long.
 * @param bytes - the bytes the index refers to.
 * @param index - the index to retreat; an index at or past the end is returned.
 * @returns the index of the first byte of the character containing `index`.
 */
export function characterStartIndex(bytes: Uint8Array, index: number): number {
  let start = index
  while (start > 0 && isContinuation(bytes[start])) start -= 1
  if (start === index) return start
  // The retreat has to land on a sequence that **covers** `index`. Walking back
  // to the first non-continuation byte is not enough: on bytes that are not valid
  // UTF-8 it can walk *past* the character's own start to an earlier one — an
  // isolated continuation byte after a newline (`41 0a 80 80`) retreats from 2 to
  // 1, which is the newline, so the page begins before what was requested and
  // re-serves a byte the previous page already carried. Accepting the retreat only
  // when the sequence at `start` extends past `index` leaves an isolated
  // continuation byte standing as the one-byte character it is, which is the same
  // reading the decoder below applies to it.
  return start + characterLengthAt(bytes, start) > index ? start : index
}

/**
 * Retreat a page end off a partial character.
 *
 * Walks back only as far as the character it cut, so a page ends at the last
 * complete character before the budget rather than at the budget.
 */
function toCharacterEnd(bytes: Uint8Array, end: number): number {
  let cut = end
  while (cut > 0 && isContinuation(bytes[cut])) cut -= 1
  return cut
}

/**
 * The byte length of the UTF-8 sequence starting at `start`.
 *
 * Read from the lead byte rather than by decoding, so an invalid byte cannot
 * produce a zero length and stall a caller: anything unrecognized counts as one
 * byte, which always advances.
 */
function characterLengthAt(bytes: Uint8Array, start: number): number {
  const lead = bytes[start]
  if (lead === undefined) return 0
  if (lead < 0x80) return 1
  if ((lead & 0b1110_0000) === 0b1100_0000) return 2
  if ((lead & 0b1111_0000) === 0b1110_0000) return 3
  if ((lead & 0b1111_1000) === 0b1111_0000) return 4
  return 1
}

/** Newlines in a byte range, for the line budget and the reported line count. */
function countNewlines(bytes: Uint8Array, start: number, end: number): number {
  let count = 0
  for (let index = start; index < end; index += 1) if (bytes[index] === 0x0a) count += 1
  return count
}

/**
 * Read one page of a parked artifact.
 *
 * @param content - the artifact's text, as it was parked.
 * @param input - where to start, and the byte and line budgets for this page.
 * @returns the page, with the offset to request next and whether it was the last.
 * @throws {@link SpillOffsetError} when the offset is past the end of the artifact.
 *   A negative or non-finite offset is read as zero rather than throwing, because
 *   a caller that omits it and a caller that miscomputes it want the same page.
 */
export function readSpillPage(content: string, input: {
  readonly offset?: number
  readonly maxBytes?: number
  readonly maxLines?: number
} = {}): SpillPage {
  return readSpillPageBytes(new Uint8Array(Buffer.from(content, 'utf8')), input)
}

/**
 * Read one page of an artifact **whose bytes are already bytes**.
 *
 * The one paging rule this module implements. `readSpillPage` is its wrapper for a
 * caller holding text, and the disk path in `index.ts` calls it directly on the
 * window it read — because that path used to decode its window to a string and
 * hand that string back for re-encoding, which made the offsets it returned live
 * in a *different byte domain* from the file offsets they were then added to. On
 * valid UTF-8 the two domains coincide (decode∘encode is the identity), which is
 * why every existing case was green; on bytes that are not valid UTF-8 they
 * diverge, and the divergence is not cosmetic: each invalid byte re-encodes as
 * three (U+FFFD), so offsets drift forward and pages run out early, while the
 * retreat above can move a page backwards over bytes already served.
 *
 * @param bytes - the artifact's bytes, or any window of them starting at the
 *   offset the caller will pass: every figure returned is relative to `bytes`.
 * @param input - where to start, and the byte and line budgets for this page.
 * @returns the page, with the offset to request next and whether it was the last.
 * @throws {@link SpillOffsetError} when the offset is past the end of `bytes`.
 */
export function readSpillPageBytes(bytes: Uint8Array, input: {
  readonly offset?: number
  readonly maxBytes?: number
  readonly maxLines?: number
} = {}): SpillPage {
  const totalBytes = bytes.byteLength
  const requested = Number.isFinite(input.offset) && (input.offset ?? 0) > 0 ? Math.floor(input.offset as number) : 0
  if (requested > totalBytes) throw new SpillOffsetError(totalBytes, requested)
  const budget = Math.max(1, Math.min(Math.floor(input.maxBytes ?? DEFAULT_RECALL_MAX_BYTES), MAX_RECALL_BYTES))
  const lineBudget = Math.max(1, Math.floor(input.maxLines ?? DEFAULT_RECALL_MAX_LINES))
  const start = characterStartIndex(bytes, requested)
  // The byte budget is a window, not a promise: the page can end earlier to keep
  // a character whole or to respect the line budget.
  let end = toCharacterEnd(bytes, Math.min(start + budget, totalBytes))
  const windowLines = countNewlines(bytes, start, end)
  if (windowLines > lineBudget) {
    // Cut just past the last newline that fits, so the page holds whole lines and
    // the next page starts at a line start rather than mid-line.
    let seen = 0
    for (let index = start; index < end; index += 1) {
      if (bytes[index] !== 0x0a) continue
      seen += 1
      if (seen === lineBudget) {
        end = index + 1
        break
      }
    }
  }
  // A page that cannot advance would loop the caller forever. When the retreats
  // above emptied the window — a budget smaller than the character it starts in —
  // the page serves that whole character and exceeds the budget, because progress
  // and character integrity are requirements and the byte budget is a preference.
  if (end <= start && start < totalBytes) end = Math.min(totalBytes, start + characterLengthAt(bytes, start))
  const text = end <= start ? '' : Buffer.from(bytes.subarray(start, end)).toString('utf8')
  return {
    text,
    bytes: end - start,
    lines: countNewlines(bytes, start, end),
    offset: start,
    nextOffset: end,
    eof: end >= totalBytes,
    totalBytes,
    // A trailing fragment counts as a line: the last line of most artifacts has no
    // newline after it, and reporting one fewer would make the figure wrong by one
    // for the common case.
    totalLines: countNewlines(bytes, 0, totalBytes) + (totalBytes > 0 && bytes[totalBytes - 1] !== 0x0a ? 1 : 0),
  }
}

/**
 * How many leading bytes of a window form complete UTF-8 characters.
 *
 * Used when reading an artifact directly off disk, where the read budget can end
 * in the middle of a character and decoding the whole window would leave a
 * replacement character at the page's edge — text that reconstructs differently
 * from what was parked. The tail is left for the next page, whose offset then
 * starts where this one stopped.
 *
 * @param bytes - a window read from the artifact.
 * @returns the length that decodes without an incomplete sequence.
 */
export function completeByteLength(bytes: Uint8Array): number {
  // At most three continuation bytes can precede a truncation, so three steps
  // back find the lead byte of the last character, or establish that there is
  // none to find.
  for (let back = 1; back <= 3; back += 1) {
    const index = bytes.length - back
    const byte = bytes[index]
    if (byte === undefined) return bytes.length
    if (isContinuation(byte)) continue
    const expected = characterLengthAt(bytes, index)
    // Fewer bytes present than the lead byte announced: the character is split.
    return back < expected ? index : bytes.length
  }
  return bytes.length
}

/**
 * The retrieval guidance a parked result's marker carries.
 *
 * States the size of what is behind the locator and the exact first call, because
 * a model that has to guess how to page a 200KB artifact guesses wrong in one of
 * the two directions this module exists to close. Kept short: it is prompt text on
 * every cleared result, and the figures that matter are the two a caller pages by.
 *
 * @param input - what the backend reported about the parked text.
 * @returns one line to append to the marker.
 */
export function spillRetrievalGuidance(input: {
  readonly bytes: number
  readonly lines?: number
  readonly locator: string
}): string {
  const size = `${input.bytes.toLocaleString('en-US')} bytes${input.lines === undefined ? '' : `, ${input.lines.toLocaleString('en-US')} lines`}`
  return `read it back with spill_recall { locator: "${input.locator}" } for the first page (${size} parked); it answers with nextOffset and eof, so pass nextOffset back as offset until eof is true.`
}
