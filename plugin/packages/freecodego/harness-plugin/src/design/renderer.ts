/**
 * The runtime that runs inside the page: seek contract, self-check, encoder.
 *
 * ## The contract it implements, and where the contract comes from
 *
 * The vendored Skills describe one shape for a composition: a paused GSAP
 * timeline registered at `window.__timelines[<composition-id>]`, all motion
 * driven from that timeline in seconds, no `Math.random()`, no wall clock. A
 * frame is then "seek the timeline to t and photograph the result".
 *
 * That is not an interpretation. It is what the instructions the model reads
 * tell it to write, so the renderer has to speak exactly that, or the documents
 * and the engine disagree about what a composition is.
 *
 * ## Why this is two functions and not a string
 *
 * The page source is built by calling `toString()` on these functions. Writing
 * it as a template literal instead would mean escaping every backtick and `${`
 * by hand, in a body that is mostly string-handling — the kind of thing that is
 * correct until someone edits it. `tests/design-renderer.spec.ts` compiles the
 * assembled source in a bare context for the same reason the muxer's test does:
 * an identifier reached from module scope would be `undefined` in the page.
 *
 * @module design/renderer
 */

import { muxMp4Document } from './mp4'

/**
 * The page-side runtime.
 *
 * Declared as a function taking its one dependency so that it can be serialised
 * on its own. It has no imports and reaches for nothing outside itself; the DOM
 * is read off `globalThis` so this module needs no DOM type library.
 *
 * @param muxMp4DocumentArg - the muxer, passed in rather than imported.
 */
function designPageRuntime(muxMp4DocumentArg: (input: unknown) => Uint8Array): void {
  const g = globalThis as unknown as Record<string, any>
  const doc = g.document as {
    fonts?: { ready?: Promise<unknown> }
    getAnimations?: () => { pause: () => void; currentTime: number | null }[]
    images: ArrayLike<{ complete: boolean; naturalWidth: number }>
    querySelectorAll: (selector: string) => ArrayLike<{ tagName?: string; classList?: unknown; style?: unknown }>
    documentElement: { style: { setProperty: (name: string, value: string) => void } }
    readyState: string
  }
  const win = g.window as Record<string, any>

  /** Encoded samples accumulated so far, in encode order. */
  const samples: { data: Uint8Array; duration: number; key: boolean }[] = []
  /** The decoder configuration the encoder reported; for H.264 this is `avcC`. */
  let description: Uint8Array | undefined
  let encoder: any
  let config: { width: number; height: number; fps: number; bitrate: number } | undefined
  let failure: string | undefined
  let keyInterval = 30

  /** Wait for a macrotask boundary, so layout and paint can settle. */
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  /** Wait for two animation frames: the point where a change has been painted. */
  const painted = async (): Promise<void> => {
    await new Promise(resolve => g.requestAnimationFrame(() => resolve(undefined)))
    await new Promise(resolve => g.requestAnimationFrame(() => resolve(undefined)))
  }

  /**
   * Seek every registered timeline to `seconds`.
   *
   * Registration is the documented contract, so this seeks what is registered
   * rather than guessing at globals. A timeline that does not look like one is
   * skipped and reported by `preflight`, which is the difference between
   * "nothing moved because you did not register" and "nothing moved for reasons
   * we cannot see".
   */
  const seek = (seconds: number): { timelines: number } => {
    let count = 0
    const registry = win.__timelines
    if (registry !== null && typeof registry === 'object') {
      for (const key of Object.keys(registry)) {
        const timeline = registry[key]
        if (timeline === null || typeof timeline !== 'object') continue
        try {
          if (typeof timeline.pause === 'function') timeline.pause()
          if (typeof timeline.seek === 'function') timeline.seek(seconds)
          else if (typeof timeline.time === 'function') timeline.time(seconds)
          else continue
          count += 1
        } catch (error) {
          failure = `timeline "${key}" could not be seeked: ${String(error)}`
        }
      }
    }
    // The web-animation fallback. Documented compositions do not use these for
    // motion, but a seekable CSS animation is still seekable, and leaving one
    // running would make a frame depend on when it was photographed.
    if (typeof doc.getAnimations === 'function') {
      try {
        for (const animation of doc.getAnimations()) {
          animation.pause()
          animation.currentTime = seconds * 1000
        }
      } catch { /* an animation that refuses to be paused is not one we drove */ }
    }
    doc.documentElement.style.setProperty('--fcg-time', String(seconds))
    return { timelines: count }
  }

  /** Wait for everything a frame depends on that is not the timeline. */
  const ready = async (): Promise<boolean> => {
    if (doc.fonts?.ready !== undefined) await doc.fonts.ready
    // Images are waited on by completion, not by decode: a decoded-but-not-yet
    // painted image is the failure mode, and `painted()` covers the painting.
    const deadline = Date.now() + 5000
    for (;;) {
      let pending = 0
      for (let index = 0; index < doc.images.length; index += 1) {
        const image = doc.images[index]!
        if (!image.complete || image.naturalWidth === 0) pending += 1
      }
      if (pending === 0 || Date.now() > deadline) break
      await tick()
    }
    await painted()
    return true
  }

  /**
   * The checks a render depends on, reported by name before any frame is taken.
   *
   * `timeline_not_paused`, `timeline_not_registered` and `css_transition_used`
   * are the names the vendored frame-worker self-check uses, so a model that
   * reads that list and a renderer that emits these codes are talking about the
   * same three things. They are *runtime* checks and have no upstream lint id:
   * upstream's static rule for the registration case is
   * `gsap_timeline_not_registered`, which the lint tool reports instead. Two
   * tools, two names, each true where it is made.
   */
  const preflight = (): { codes: string[]; timelines: string[] } => {
    const codes: string[] = []
    const registry = win.__timelines
    const names: string[] = []
    if (registry === null || typeof registry !== 'object') {
      codes.push('timeline_not_registered')
    } else {
      for (const key of Object.keys(registry)) {
        const timeline = registry[key]
        if (timeline === null || typeof timeline !== 'object') continue
        names.push(key)
        const paused = typeof timeline.paused === 'function' ? timeline.paused() : timeline.paused
        if (paused !== true) codes.push('timeline_not_paused')
      }
      if (names.length === 0) codes.push('timeline_not_registered')
    }

    // CSS motion runs on the browser clock, so it desynchronises from the seek
    // clock — which is why the instructions ban it for motion. Read from
    // computed style rather than from the stylesheet, so a transition inherited
    // from a class or set inline counts too.
    // Indexed rather than iterated: a `NodeList` is an `ArrayLike`, and the DOM
    // type library is not in scope here — this runs in the page.
    const elements = doc.querySelectorAll('*')
    const inspectedMax = Math.min(elements.length, 4000)
    for (let index = 0; index < inspectedMax; index += 1) {
      const element = elements[index]
      try {
        const style = g.getComputedStyle(element)
        const durations = String(style.transitionDuration ?? '')
        if (durations !== '' && durations.split(',').some(value => Number.parseFloat(value) > 0)) {
          codes.push('css_transition_used')
          break
        }
        const animation = String(style.animationName ?? '')
        if (animation !== '' && animation !== 'none') {
          codes.push('css_transition_used')
          break
        }
      } catch { /* detached or unstyleable node */ }
    }
    return { codes, timelines: names }
  }

  /** What the encoder can do here, asked of the encoder itself. */
  const supported = async (codecs: readonly string[]): Promise<Record<string, boolean>> => {
    const out: Record<string, boolean> = {}
    for (const codec of codecs) {
      try {
        const result = await g.VideoEncoder.isConfigSupported({
          codec,
          width: config?.width ?? 640,
          height: config?.height ?? 360,
          bitrate: config?.bitrate ?? 4_000_000,
          framerate: config?.fps ?? 30,
        })
        out[codec] = result?.supported === true
      } catch {
        out[codec] = false
      }
    }
    return out
  }

  /** Configure the encoder for one render. */
  const begin = (options: { width: number; height: number; fps: number; bitrate?: number; codec?: string; keyInterval?: number }): void => {
    samples.length = 0
    description = undefined
    failure = undefined
    keyInterval = options.keyInterval ?? Math.max(1, Math.round(options.fps))
    config = {
      width: options.width,
      height: options.height,
      fps: options.fps,
      bitrate: options.bitrate ?? 4_000_000,
    }
    encoder = new g.VideoEncoder({
      output: (chunk: any, metadata: any) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        const reported = metadata?.decoderConfig?.description
        if (reported !== undefined && reported !== null && description === undefined) {
          description = new Uint8Array(reported)
        }
        samples.push({ data, duration: 1, key: chunk.type === 'key' })
      },
      error: (error: unknown) => { failure = String(error) },
    })
    encoder.configure({
      codec: options.codec ?? 'avc1.640028',
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.fps,
      // `avc` rather than `annexb`: MP4 wants length-prefixed NAL units, and the
      // annexb form would need rewriting per sample before it could be muxed.
      avc: { format: 'avc' },
      latencyMode: 'quality',
    })
  }

  /** Feed one PNG frame, taken by the driver at the current seek time. */
  const frame = async (pngBase64: string, index: number): Promise<number> => {
    if (failure !== undefined) throw new Error(failure)
    if (encoder === undefined || config === undefined) throw new Error('the encoder was used before begin()')
    const binary = g.atob(pngBase64)
    const bytes = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
    const bitmap = await g.createImageBitmap(new g.Blob([bytes], { type: 'image/png' }))
    const microsPerFrame = 1_000_000 / config.fps
    const videoFrame = new g.VideoFrame(bitmap, {
      timestamp: Math.round(index * microsPerFrame),
      duration: Math.round(microsPerFrame),
    })
    encoder.encode(videoFrame, { keyFrame: index % keyInterval === 0 })
    videoFrame.close()
    if (typeof bitmap.close === 'function') bitmap.close()

    // Backpressure: an unbounded queue holds every frame's pixels at once, and
    // a long render would exhaust the page rather than finishing.
    const deadline = Date.now() + 30_000
    while (encoder.encodeQueueSize > 8 && Date.now() < deadline) await tick()
    return encoder.encodeQueueSize as number
  }

  /** Flush, mux, and hand the finished bytes back through the result path. */
  const finish = async (resultPath: string): Promise<{ bytes: number; frames: number; description: boolean }> => {
    if (failure !== undefined) throw new Error(failure)
    if (encoder === undefined || config === undefined) throw new Error('the encoder was used before begin()')
    await encoder.flush()
    encoder.close()
    const file = muxMp4DocumentArg({
      video: {
        width: config.width,
        height: config.height,
        timescale: config.fps,
        samples,
        description,
      },
    })
    // Posted as bytes, not as a base64 string in an evaluated expression: a
    // rendered minute is tens of megabytes, and `returnByValue` would inflate it
    // by a third and then hit a message ceiling.
    const response = await g.fetch(resultPath, { method: 'POST', body: file })
    if (!response.ok) throw new Error(`the preview server refused the result: ${response.status}`)
    return { bytes: file.length, frames: samples.length, description: description !== undefined }
  }

  const state = (): Record<string, unknown> => ({
    ready: doc.readyState,
    failure: failure ?? null,
    frames: samples.length,
    width: config?.width ?? null,
    height: config?.height ?? null,
    queue: encoder?.encodeQueueSize ?? null,
  })

  win.__fcg = { seek, ready, preflight, supported, begin, frame, finish, state }
}

/**
 * The source the driver injects before any document loads.
 *
 * @returns JavaScript that installs `globalThis.__fcg`.
 */
export function designRendererSource(): string {
  return `(${designPageRuntime.toString()})(${muxMp4Document.toString()})`
}
