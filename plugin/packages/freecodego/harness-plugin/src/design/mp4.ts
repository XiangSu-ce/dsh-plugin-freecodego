/**
 * A minimal MP4 writer, written as one self-contained function.
 *
 * WebCodecs hands us encoded chunks plus a decoder configuration record, and for
 * H.264 that record *is* the `avcC` payload — so the only thing left between an
 * encoded frame and a playable file is box layout. Writing that here, rather than
 * installing a muxer, is what keeps a render from depending on anything that
 * would first have to be downloaded.
 *
 * ## Why it is a single function with nothing outside it
 *
 * The encoder runs **in the page**, so the muxer has to get there too, and the
 * way it gets there is `muxMp4Document.toString()`. That is a real constraint, not
 * a style choice: an identifier looked up from module scope would become an
 * undefined reference in the page, and it would fail at the *end* of a render
 * rather than at build time. `tests/design-mp4.spec.ts` compiles this function's
 * source in a `node:vm` context with no globals, so hoisting a helper out "for
 * readability" breaks that test instead of a user's render.
 *
 * The same property is what makes it testable: it takes bytes and returns bytes.
 *
 * ## What it deliberately does not do
 *
 * Non-fragmented layout only. Every sample is already in memory, so `stsz` and
 * `stco` can be computed once `mdat` is laid out and there is no reason for
 * `moof` fragments. `mdat` precedes `moov` for the same reason — the offsets do
 * not depend on a size that is not yet known.
 *
 * No `edts`/`elst` and no `ctts`: timing is a constant duration per sample, which
 * is what a frame sequence is. A track with variable deltas would need more, and
 * would need a caller that measures them.
 *
 * @module design/mp4
 */

/** One encoded video sample. */
export interface Mp4VideoSample {
  readonly data: Uint8Array
  /** Duration in the video track's timescale, in samples. */
  readonly duration: number
  /** Whether the sample is a sync point a decoder may start at. */
  readonly key: boolean
}

/** One encoded audio sample. */
export interface Mp4AudioSample {
  readonly data: Uint8Array
  /** Duration in samples at `sampleRate`. */
  readonly duration: number
}

/** One track's samples, in decode order. */
export interface Mp4TrackSamples<Sample> {
  readonly samples: readonly Sample[]
}

/** What to write. */
export interface Mp4DocumentInput {
  readonly video: {
    readonly width: number
    readonly height: number
    /** Frames per second; also the video track's timescale, so a frame is 1. */
    readonly timescale: number
    readonly samples: readonly Mp4VideoSample[]
    /** The `avcC` payload WebCodecs reported for the track. */
    readonly description?: Uint8Array
  }
  /**
   * The audio track, when the composition has one.
   *
   * Optional on purpose: a silent composition is still a composition, and a
   * muxer that demanded audio would make the video-only case the special one.
   */
  readonly audio?: {
    readonly sampleRate: number
    readonly channels: number
    readonly samples: readonly Mp4AudioSample[]
    /** The `AudioSpecificConfig` WebCodecs reported for the track. */
    readonly description?: Uint8Array
  }
}

/**
 * Write a playable MP4 (H.264 video, optional AAC audio).
 *
 * @param input - encoded samples and each track's decoder configuration.
 * @returns the file bytes.
 */
export function muxMp4Document(input: Mp4DocumentInput): Uint8Array {
  // Declared inside, not at module scope. The movie timescale every track's
  // duration is scaled into — and the reason it is not a module constant is
  // precisely that a module constant would be unreachable from the page.
  const movieTimescale = 1000

  const u8 = (value: number): Uint8Array => new Uint8Array([value & 0xff])
  const u16 = (value: number): Uint8Array => new Uint8Array([(value >>> 8) & 0xff, value & 0xff])
  const u32 = (value: number): Uint8Array => new Uint8Array([
    (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
  ])
  const str = (value: string): Uint8Array => {
    const out = new Uint8Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
    return out
  }
  const join = (parts: readonly Uint8Array[]): Uint8Array => {
    let total = 0
    for (const part of parts) total += part.length
    const out = new Uint8Array(total)
    let at = 0
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }
  const zeros = (count: number): Uint8Array => new Uint8Array(count)
  /** A box: length, four-character type, payload. */
  const box = (type: string, payload: readonly Uint8Array[]): Uint8Array => {
    let size = 8
    for (const part of payload) size += part.length
    return join([u32(size), str(type), ...payload])
  }
  /** A box whose payload starts with version and flags. */
  const fullBox = (type: string, version: number, flags: number, payload: readonly Uint8Array[]): Uint8Array =>
    box(type, [u8(version), new Uint8Array([(flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]), ...payload])
  /** The identity transform, in 16.16 / 2.30 fixed point. */
  const unityMatrix = (): Uint8Array => join([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  ])
  /**
   * An MPEG-4 descriptor length: 7 bits per byte, high bit meaning "more".
   * Descriptors nest, so a byte count depends on a byte count — the one fiddly
   * part of `esds`, and the reason it gets its own function.
   */
  const descriptorLength = (value: number): Uint8Array => {
    const out: number[] = [value & 0x7f]
    let rest = value >>> 7
    while (rest > 0) { out.unshift((rest & 0x7f) | 0x80); rest >>>= 7 }
    return new Uint8Array(out)
  }
  const descriptor = (tag: number, payload: readonly Uint8Array[]): Uint8Array => {
    const body = join(payload)
    return join([u8(tag), descriptorLength(body.length), body])
  }
  /** `'und'`, packed ISO-639-2/T: each character is its code minus 0x60. */
  const LANG_UNDETERMINED = 0x55c4

  const video = input.video
  const audio = input.audio
  const videoSamples = video.samples
  const audioSamples = audio?.samples ?? []

  const videoDuration = videoSamples.reduce((sum, sample) => sum + sample.duration, 0)
  const videoMovieDuration = Math.round((videoDuration / video.timescale) * movieTimescale)
  const audioDuration = audioSamples.reduce((sum, sample) => sum + sample.duration, 0)
  const audioMovieDuration = audio === undefined ? 0 : Math.round((audioDuration / audio.sampleRate) * movieTimescale)
  const movieDuration = Math.max(videoMovieDuration, audioMovieDuration, 1)

  // `mdat` first, and the offsets derived from what is already known rather than
  // from a `moov` that has not been sized yet.
  const mdatPayload = join([...videoSamples.map(sample => sample.data), ...audioSamples.map(sample => sample.data)])
  const mdatHeaderLength = 8
  const ftypLength = 32
  const videoOffsets: number[] = []
  const audioOffsets: number[] = []
  {
    let at = ftypLength + mdatHeaderLength
    for (const sample of videoSamples) { videoOffsets.push(at); at += sample.data.length }
    for (const sample of audioSamples) { audioOffsets.push(at); at += sample.data.length }
  }

  const ftyp = box('ftyp', [str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41')])
  const mdat = join([u32(mdatHeaderLength + mdatPayload.length), str('mdat'), mdatPayload])

  /** Sample timing as (count, delta) runs; a frame sequence is usually one run. */
  const timingBox = (durations: readonly number[]): Uint8Array => {
    const runs: Array<{ count: number; delta: number }> = []
    for (const duration of durations) {
      const last = runs[runs.length - 1]
      if (last !== undefined && last.delta === duration) last.count++
      else runs.push({ count: 1, delta: duration })
    }
    const payload: Uint8Array[] = [u32(runs.length)]
    for (const run of runs) payload.push(u32(run.count), u32(run.delta))
    return fullBox('stts', 0, 0, payload)
  }

  /** The per-track boxes every track shares a shape with. */
  const sampleTable = (
    stsd: Uint8Array,
    sizes: readonly number[],
    offsets: readonly number[],
    durations: readonly number[],
    syncSampleNumbers: readonly number[],
  ): Uint8Array => {
    const boxes: Uint8Array[] = [
      stsd,
      timingBox(durations),
      // One sample per chunk. Slightly larger than necessary and exactly
      // right: chunk grouping is an optimisation for streaming, and nothing
      // here streams.
      fullBox('stsc', 0, 0, [u32(1), u32(1), u32(1), u32(1)]),
      fullBox('stsz', 0, 0, [u32(0), u32(sizes.length), ...sizes.map(u32)]),
      fullBox('stco', 0, 0, [u32(offsets.length), ...offsets.map(u32)]),
    ]
    // An absent `stss` means every sample is a sync point; write it only when
    // that is false, since a file that lists every frame as a sync point is
    // telling a reader less than a file that says nothing.
    if (syncSampleNumbers.length !== sizes.length) {
      boxes.push(fullBox('stss', 0, 0, [u32(syncSampleNumbers.length), ...syncSampleNumbers.map(u32)]))
    }
    return join(boxes)
  }

  const dref = fullBox('dref', 0, 0, [u32(1), fullBox('url ', 0, 1, [])])
  const dinf = box('dinf', [dref])
  const mediaHeaderBoxes = (trackDuration: number, timescale: number, handlerType: string, name: string): Uint8Array[] => {
    const mdhd = fullBox('mdhd', 0, 0, [
      u32(0), u32(0), u32(timescale), u32(trackDuration), u16(LANG_UNDETERMINED), u16(0),
    ])
    const hdlr = fullBox('hdlr', 0, 0, [u32(0), str(handlerType), zeros(12), str(name), u8(0)])
    return [mdhd, hdlr]
  }

  // --- video track -----------------------------------------------------------
  const avcC = video.description === undefined
    ? new Uint8Array(0)
    // WebCodecs reports the AVCDecoderConfigurationRecord itself, so it goes in
    // as the box payload; there is no SPS/PPS to walk.
    : box('avcC', [video.description])
  const avc1 = box('avc1', [
    zeros(6), u16(1),
    zeros(16), u16(video.width), u16(video.height),
    u32(0x00480000), u32(0x00480000),
    u32(0), u16(1),
    zeros(32), u16(0x0018), u16(0xffff),
    avcC,
  ])
  const stsdVideo = fullBox('stsd', 0, 0, [u32(1), avc1])
  const vmhd = fullBox('vmhd', 0, 1, [u16(0), u16(0), u16(0), u16(0)])
  const videoSyncNumbers: number[] = []
  for (let index = 0; index < videoSamples.length; index++) {
    if (videoSamples[index]!.key) videoSyncNumbers.push(index + 1)
  }
  const videoMinf = box('minf', [
    vmhd, dinf,
    box('stbl', [sampleTable(
      stsdVideo,
      videoSamples.map(sample => sample.data.length),
      videoOffsets,
      videoSamples.map(sample => sample.duration),
      videoSyncNumbers,
    )]),
  ])
  const videoTrak = box('trak', [
    fullBox('tkhd', 0, 0x000007, [
      u32(0), u32(0), u32(1), u32(0), u32(videoMovieDuration), zeros(8),
      u16(0), u16(0), u16(0), u16(0), unityMatrix(),
      u32(video.width * 65536), u32(video.height * 65536),
    ]),
    box('mdia', [...mediaHeaderBoxes(videoDuration, video.timescale, 'vide', 'VideoHandler'), videoMinf]),
  ])

  // --- audio track -----------------------------------------------------------
  const audioTrak: Uint8Array[] = []
  if (audio !== undefined) {
    // A nominal bitrate: it is a hint a player may ignore, and measuring the
    // real one would mean a second pass over samples we have already sized.
    const nominalBitrate = 128_000
    const decoderSpecific = audio.description === undefined
      ? new Uint8Array(0)
      : descriptor(0x05, [audio.description])
    const decoderConfig = descriptor(0x04, [
      u8(0x40), u8(0x15), zeros(3),
      u32(nominalBitrate), u32(nominalBitrate),
      decoderSpecific,
    ])
    const slConfig = descriptor(0x06, [u8(0x02)])
    const es = descriptor(0x03, [u16(0), u8(0), decoderConfig, slConfig])
    const esds = fullBox('esds', 0, 0, [es])
    const mp4a = box('mp4a', [
      zeros(6), u16(1),
      zeros(8), u16(audio.channels), u16(16), u16(0), u16(0),
      u32(audio.sampleRate * 65536),
      esds,
    ])
    const smhd = fullBox('smhd', 0, 0, [u16(0), u16(0)])
    const audioMinf = box('minf', [
      smhd, dinf,
      box('stbl', [sampleTable(
        fullBox('stsd', 0, 0, [u32(1), mp4a]),
        audioSamples.map(sample => sample.data.length),
        audioOffsets,
        audioSamples.map(sample => sample.duration),
        // Every audio sample is a sync point, so this must equal the count for
        // the `stss` to be omitted — which is the correct encoding.
        audioSamples.map((_, index) => index + 1),
      )]),
    ])
    audioTrak.push(box('trak', [
      fullBox('tkhd', 0, 0x000007, [
        u32(0), u32(0), u32(2), u32(0), u32(audioMovieDuration), zeros(8),
        u16(0), u16(0), u16(0x0100), u16(0), unityMatrix(),
        u32(0), u32(0),
      ]),
      box('mdia', [...mediaHeaderBoxes(audioDuration, audio.sampleRate, 'soun', 'SoundHandler'), audioMinf]),
    ]))
  }

  const mvhd = fullBox('mvhd', 0, 0, [
    u32(0), u32(0), u32(movieTimescale), u32(movieDuration),
    u32(0x00010000), u16(0x0100), u16(0), zeros(8),
    unityMatrix(), zeros(24), u32(audio === undefined ? 2 : 3),
  ])
  const moov = box('moov', [mvhd, videoTrak, ...audioTrak])

  return join([ftyp, mdat, moov])
}
