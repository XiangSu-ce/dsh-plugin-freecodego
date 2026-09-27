/**
 * The MP4 writer, checked as a byte-producing function.
 *
 * Two of these tests exist because of a specific way this module can fail
 * silently, and they are worth stating plainly:
 *
 * 1. **Self-containment.** The renderer gets its muxer by calling `toString()`
 *    on `muxMp4Document` and evaluating it in the page. Any identifier reached
 *    from module scope becomes `undefined` there — and the failure would surface
 *    at the end of a render, on the user's machine, after the work was done. So
 *    the source is compiled in a `node:vm` context with no globals.
 * 2. **`stco` actually pointing at the samples.** Offsets are arithmetic over
 *    sizes computed elsewhere in the same function; getting them wrong produces a
 *    file that is structurally valid and plays garbage. The test reads each
 *    sample back out of the finished file at the offset the index claims.
 */

import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { muxMp4Document, type Mp4DocumentInput } from '../src/design/mp4'

/** A fake `avcC` payload — the muxer never inspects it. */
const AVCC = new Uint8Array([0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28])

/** Sample payloads with distinguishable bytes, so a misplaced offset is visible. */
function makeVideoSamples(count: number): Mp4DocumentInput['video']['samples'] {
  return Array.from({ length: count }, (_, index) => ({
    data: new Uint8Array(64).fill(index + 1),
    duration: 1,
    // Every tenth frame, plus the first: enough that `stss` is a real subset.
    key: index === 0 || index % 10 === 0,
  }))
}

/** The input the structural tests share. */
function documentInput(withAudio: boolean): Mp4DocumentInput {
  return {
    video: { width: 640, height: 360, timescale: 30, samples: makeVideoSamples(31), description: AVCC },
    ...(withAudio
      ? {
        audio: {
          sampleRate: 48_000,
          channels: 2,
          // `0x12 0x10` is AAC-LC, 44.1 kHz, stereo — a plausible ASC whose bytes
          // the muxer only needs to carry.
          description: new Uint8Array([0x12, 0x10]),
          samples: Array.from({ length: 5 }, (_, index) => ({
            data: new Uint8Array(32).fill(0xa0 + index),
            duration: 1024,
          })),
        },
      }
      : {}),
  }
}

/** One box, as read back out of a buffer. */
interface Box {
  readonly type: string
  readonly start: number
  readonly size: number
  readonly payloadStart: number
}

/** Walk the top level of a file. */
function topLevelBoxes(bytes: Uint8Array): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: Box[] = []
  let at = 0
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at)
    if (size < 8 || at + size > bytes.length) break
    boxes.push({
      type: String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!),
      start: at,
      size,
      payloadStart: at + 8,
    })
    at += size
  }
  return boxes
}

/**
 * How far each container's first child sits from the container's payload start.
 *
 * Zero for the ordinary case. `stsd` adds its entry count, and the two sample
 * entries add their fixed headers before the decoder configuration they carry —
 * `mp4a` has 28 bytes of entry header, `avc1` has 78. These are the only places
 * in this file where a child box is not immediately after its parent's header,
 * and a walker that assumed otherwise would report a present `esds` as absent.
 */
const CONTAINER_HEADER: Readonly<Record<string, number>> = { stsd: 8, mp4a: 28, avc1: 78 }

/** Recursively find boxes by path, e.g. `['moov', 'trak']`. */
function findBox(bytes: Uint8Array, path: readonly string[], from = 0, to = bytes.length): Box | undefined {
  let at = from
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (at + 8 <= to) {
    const size = view.getUint32(at)
    if (size < 8 || at + size > to) return undefined
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    if (type === path[0]) {
      if (path.length === 1) return { type, start: at, size, payloadStart: at + 8 }
      const childrenAt = at + 8 + (CONTAINER_HEADER[type] ?? 0)
      const inner = findBox(bytes, path.slice(1), childrenAt, at + size)
      if (inner !== undefined) return inner
    }
    at += size
  }
  return undefined
}

/** Read a `fullBox`'s body, past version and flags. */
function body(bytes: Uint8Array, box: Box): Uint8Array {
  return bytes.subarray(box.payloadStart + 4, box.start + box.size)
}

describe('design mp4 muxer', () => {
  it('is self-contained enough to evaluate in a bare context', () => {
    // The context has no `Buffer`, no `process`, no module scope — only V8's own
    // intrinsics. Anything the muxer reached for from outside would be a
    // ReferenceError here, which is exactly the failure the page would hit.
    const context = createContext({})
    new Script(`globalThis.mux = (${muxMp4Document.toString()})`).runInContext(context)
    const injected = (context as { mux: (input: Mp4DocumentInput) => Uint8Array }).mux

    const bytes = Buffer.from(injected(documentInput(false)))
    expect(bytes.length).toBeGreaterThan(64)
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')
  })

  it('lays out ftyp, mdat and moov with sizes that account for the whole file', () => {
    const bytes = muxMp4Document(documentInput(false))
    const boxes = topLevelBoxes(bytes)

    expect(boxes.map(box => box.type)).toEqual(['ftyp', 'mdat', 'moov'])
    const total = boxes.reduce((sum, box) => sum + box.size, 0)
    expect(total).toBe(bytes.length)

    const moov = findBox(bytes, ['moov'])
    expect(moov).toBeDefined()
    // A `moov` that is present but empty would satisfy "the box exists" and
    // nothing else, so the check is on what has to be inside it.
    expect(findBox(bytes, ['moov', 'mvhd'])).toBeDefined()
    expect(findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])).toBeDefined()
    expect(findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])).toBeDefined()
    expect(findBox(bytes, ['moov', 'trak', 'mdia', 'hdlr'])).toBeDefined()
  })

  it('points stco at each sample, so the index and the bytes agree', () => {
    const input = documentInput(false)
    const bytes = muxMp4Document(input)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    const stco = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])
    const stsz = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz'])
    const stts = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts'])
    expect(stco).toBeDefined()
    expect(stsz).toBeDefined()
    expect(stts).toBeDefined()
    if (stco === undefined || stsz === undefined || stts === undefined) return

    const count = view.getUint32(stco.payloadStart + 4)
    expect(count).toBe(input.video.samples.length)

    const offsets: number[] = []
    for (let index = 0; index < count; index++) offsets.push(view.getUint32(stco.payloadStart + 8 + index * 4))

    // Read each sample back out at the offset the index names. A wrong base —
    // forgetting the `mdat` header, or the `ftyp` length — shows up here as
    // mismatched bytes rather than as a playable-looking broken file.
    // `subarray` returns a plain view, not a `Buffer`, so the comparison is
    // over the bytes rather than over a method `Uint8Array` does not have.
    const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
      left.length === right.length && left.every((byte, index) => byte === right[index])
    input.video.samples.forEach((sample, index) => {
      const at = offsets[index]!
      expect(sameBytes(bytes.subarray(at, at + sample.data.length), sample.data), `sample ${index} at offset ${at}`).toBe(true)
    })

    const sizes = view.getUint32(stsz.payloadStart + 8)
    expect(sizes).toBe(input.video.samples.length)
    // Declared sizes must match the real gaps between consecutive offsets.
    for (let index = 0; index < count - 1; index++) {
      const declared = view.getUint32(stsz.payloadStart + 12 + index * 4)
      expect(declared).toBe(offsets[index + 1]! - offsets[index]!)
    }
  })

  it('lists sync samples only when not every sample is one', () => {
    const bytes = muxMp4Document(documentInput(false))
    const stss = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss'])
    expect(stss).toBeDefined()
    if (stss === undefined) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = view.getUint32(stss.payloadStart + 4)
    const numbers: number[] = []
    for (let index = 0; index < count; index++) numbers.push(view.getUint32(stss.payloadStart + 8 + index * 4))
    // 1-based, and it must not claim all 31 frames are sync points.
    expect(numbers).toEqual([1, 11, 21, 31])

    const allKey = muxMp4Document({
      video: {
        width: 64, height: 64, timescale: 30,
        samples: Array.from({ length: 3 }, () => ({ data: new Uint8Array(8).fill(7), duration: 1, key: true })),
        description: AVCC,
      },
    })
    expect(findBox(allKey, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss'])).toBeUndefined()
  })

  it('collapses timing into runs and keeps the count honest', () => {
    const bytes = muxMp4Document({
      video: {
        width: 64, height: 64, timescale: 30,
        samples: [
          { data: new Uint8Array(8).fill(1), duration: 1, key: true },
          { data: new Uint8Array(8).fill(2), duration: 1, key: false },
          { data: new Uint8Array(8).fill(3), duration: 2, key: false },
        ],
        description: AVCC,
      },
    })
    const stts = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts'])
    expect(stts).toBeDefined()
    if (stts === undefined) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const entries = view.getUint32(stts.payloadStart + 4)
    expect(entries).toBe(2)
    const runs = Array.from({ length: entries }, (_, index) => [
      view.getUint32(stts.payloadStart + 8 + index * 8),
      view.getUint32(stts.payloadStart + 12 + index * 8),
    ])
    expect(runs).toEqual([[2, 1], [1, 2]])
  })

  it('adds an audio track only when it is given one', () => {
    const silent = muxMp4Document(documentInput(false))
    const withAudio = muxMp4Document(documentInput(true))

    /** Count the `trak` children of `moov`. */
    const trackCount = (bytes: Uint8Array): number => {
      const moov = findBox(bytes, ['moov'])
      if (moov === undefined) return 0
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let at = moov.payloadStart
      let count = 0
      while (at + 8 <= moov.start + moov.size) {
        const size = view.getUint32(at)
        if (size < 8) break
        if (String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!) === 'trak') count++
        at += size
      }
      return count
    }

    expect(trackCount(silent)).toBe(1)
    expect(trackCount(withAudio)).toBe(2)
    expect(findBox(withAudio, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])).toBeDefined()

    // The audio sample entry carries the descriptor chain; a missing `esds`
    // is the difference between "a player finds an audio track" and "a player
    // finds a track it cannot decode".
    const moov = findBox(withAudio, ['moov'])!
    const secondTrack = (() => {
      const view = new DataView(withAudio.buffer, withAudio.byteOffset, withAudio.byteLength)
      let at = moov.payloadStart
      let seen = 0
      while (at + 8 <= moov.start + moov.size) {
        const size = view.getUint32(at)
        if (String.fromCharCode(withAudio[at + 4]!, withAudio[at + 5]!, withAudio[at + 6]!, withAudio[at + 7]!) === 'trak') {
          seen++
          if (seen === 2) return { start: at, size, payloadStart: at + 8, type: 'trak' }
        }
        at += size
      }
      return undefined
    })()
    expect(secondTrack).toBeDefined()
    const esds = findBox(withAudio, ['mdia', 'minf', 'stbl', 'stsd', 'mp4a', 'esds'], secondTrack!.payloadStart, secondTrack!.start + secondTrack!.size)
    expect(esds).toBeDefined()
    if (esds === undefined) return

    /** Index of a byte subsequence, or -1. */
    const indexOfBytes = (haystack: Uint8Array, needle: readonly number[]): number => {
      for (let start = 0; start + needle.length <= haystack.length; start++) {
        if (needle.every((byte, offset) => haystack[start + offset] === byte)) return start
      }
      return -1
    }

    // The ASC has to survive the descriptor nesting: that is where a length off
    // by one truncates it, and a truncated ASC is a file that parses and then
    // fails to decode audio. Its exact framing is checked, not merely its bytes.
    const esdsBody = body(withAudio, esds)
    expect(indexOfBytes(esdsBody, [0x05, 0x02, 0x12, 0x10])).toBeGreaterThanOrEqual(0)
    // And the SLConfigDescriptor must be the last thing in it, which is what
    // tells us the lengths add up to the body rather than overrun it.
    expect(Array.from(esdsBody.subarray(-3))).toEqual([0x06, 0x01, 0x02])
  })

  it('scales each track duration into the movie timescale', () => {
    const bytes = muxMp4Document({
      video: { width: 320, height: 180, timescale: 30, samples: makeVideoSamples(30), description: AVCC },
    })
    const mvhd = findBox(bytes, ['moov', 'mvhd'])
    expect(mvhd).toBeDefined()
    if (mvhd === undefined) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // version/flags (4), creation (4), modification (4), then timescale.
    const timescale = view.getUint32(mvhd.payloadStart + 12)
    const duration = view.getUint32(mvhd.payloadStart + 16)
    expect(timescale).toBe(1000)
    // 30 frames at 30 fps: my arithmetic must produce a second, not 30 or 0.
    expect(duration).toBe(1000)
  })
})
