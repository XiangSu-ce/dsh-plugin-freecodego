/**
 * Driving one composition: serve it, seek it, photograph it, encode it.
 *
 * The order below is the whole of the design, and each step sits where it does
 * because the step before it makes it possible:
 *
 * 1. **Serve on loopback.** A composition fetches relative URLs, and under
 *    `file://` every one of them is cross-origin. It also puts the page in a
 *    secure context, which WebCodecs requires — on `file://` the encoder is not
 *    merely unavailable, it is absent.
 * 2. **Inject the runtime before the document.** The runtime installs the seek
 *    contract, and a composition builds its timeline *while parsing*. Injected
 *    after navigation it would arrive after the thing it exists to seek, and the
 *    render would photograph a composition nobody ever seeked.
 * 3. **Seek, settle, photograph, encode** — in that order, every frame. Encoding
 *    a frame photographed before the paint settled produces the previous frame's
 *    pixels under this frame's timestamp: a file that plays, with the wrong
 *    frame boundaries, and nothing in it to say so.
 * 4. **Never record in real time.** "Same input, same frames" is the only
 *    property that makes a render worth doing; capturing in real time trades it
 *    away and does not say that it did.
 *
 * @module design/capture
 */

import { resolve } from 'node:path'

import { launchDesignSession, type DesignBrowserPage } from './browser-driver'
import { DEFAULT_RESULT_PATH, serveDesignDocument, type DesignPreviewAsset, type DesignPreviewServer } from './preview-server'
import { designRendererSource } from './renderer'

/**
 * The codecs a render may use, best first.
 *
 * H.264 only, and that is a limit rather than a preference: the muxer writes
 * MP4, where a video track is an `avc1` sample entry carrying `avcC`. Handing it
 * VP9 would produce a structurally valid MP4 with an empty decoder
 * configuration — a file that opens and does not decode.
 *
 * The plan's degradation chain put VP9/WebM behind H.264. WebM is **not
 * implemented**, so that chain is not here: a machine with no H.264 encoder gets
 * an error naming what it does have, rather than a WebM file it did not get.
 * `DESIGN_PROBE_CODECS` exists so that error can be specific.
 */
export const DESIGN_VIDEO_CODECS: readonly string[] = ['avc1.640028', 'avc1.4D401E', 'avc1.42E01E']

/** Codecs probed only to make a failure message say something useful. */
export const DESIGN_PROBE_CODECS: readonly string[] = [...DESIGN_VIDEO_CODECS, 'vp09.00.10.08', 'vp8', 'av01.0.04M.08']

/** The composition to render. */
export interface DesignCompositionSource {
  /** The composition's HTML, already read by the caller. */
  readonly html: string
  /** Files it fetches, keyed by absolute URL path. */
  readonly assets?: ReadonlyMap<string, DesignPreviewAsset>
}

/** Where and how large to render it. */
export interface DesignCompositionSession {
  readonly executable: string
  /** A directory this call owns; the browser profile lives inside it. */
  readonly profileDirectory: string
  readonly width: number
  readonly height: number
}

/** What the page's self-check reported before any frame was taken. */
export interface DesignPreflightReport {
  readonly codes: readonly string[]
  readonly timelines: readonly string[]
}

/** One opened composition, before any frame is taken. */
interface OpenedComposition {
  readonly page: DesignBrowserPage
  readonly server: DesignPreviewServer
  readonly preflight: DesignPreflightReport
  readonly close: () => Promise<void>
}

/**
 * Run an expression that may be asynchronous and parse its JSON result.
 *
 * The `await` inside the wrapper is load-bearing, and its absence is a defect
 * this code shipped for one test run: `JSON.stringify(somePromise)` is `"{}"`,
 * so every `async` expression came back as an empty object. The caller then read
 * `undefined` out of it — and `undefined` for "is H.264 supported" is
 * indistinguishable from a machine that has no H.264, which sent this renderer
 * down its no-codec path while the browser supported three of them.
 *
 * Awaiting before stringifying is what makes the answer's *shape* the same for a
 * synchronous and an asynchronous expression.
 */
async function evaluateJson<T>(page: DesignBrowserPage, expression: string): Promise<T> {
  const text = await page.evaluate<string>(`(async () => JSON.stringify(await (${expression})))()`)
  return JSON.parse(text) as T
}

/** How long the page has to post a finished render back. */
const RESULT_TIMEOUT_MS = 120_000

/**
 * Claim a promise's rejection, whatever happens to it next.
 *
 * `awaitResult` is armed *before* the page is asked to post, because the listener
 * has to be in place first — so every path between the two can throw and leave the
 * promise never awaited. An unhandled rejection is not a log line: it takes the
 * host process down, two minutes after the render that failed, which is a failure
 * with no connection left to what caused it. Marking the rejection as seen here is
 * what makes the deadline safe on the paths that never reach the `await`.
 *
 * @param promise - the promise to claim.
 * @returns the same promise, so the caller can still await the real outcome.
 */
function claimed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}

/** Serve, open, attach, inject, navigate, and run the self-check. */
async function openComposition(
  source: DesignCompositionSource,
  session: DesignCompositionSession,
  resultPath: string,
): Promise<OpenedComposition> {
  // Spread rather than a plain optional property: `exactOptionalPropertyTypes`
  // is on in this workspace, so passing `assets: undefined` is not the same as
  // not passing it, and the server's type says what it means.
  const server = await serveDesignDocument({
    html: source.html,
    ...(source.assets === undefined ? {} : { assets: source.assets }),
    resultPath,
  })
  const page = await launchDesignSession({
    executable: session.executable,
    profileDirectory: resolve(session.profileDirectory),
    url: 'about:blank',
    width: session.width,
    height: session.height,
  })

  const close = async (): Promise<void> => {
    await page.close()
    await server.close()
  }

  try {
    // Before navigating, because `about:blank` is already loaded and the
    // composition is what must be preceded.
    await page.injectOnNewDocument(designRendererSource())
    await page.setViewport(session.width, session.height)
    await page.navigate(`${server.origin}/`)
    await page.waitFor('typeof globalThis.__fcg === "object"')
    await page.evaluate('__fcg.ready()')
    const preflight = await evaluateJson<DesignPreflightReport>(page, '__fcg.preflight()')
    return { page, server, preflight, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Seek to a time and wait for everything that time depends on. */
async function seekAndSettle(page: DesignBrowserPage, seconds: number): Promise<{ timelines: number }> {
  const seeked = await evaluateJson<{ timelines: number }>(page, `__fcg.seek(${seconds})`)
  await page.evaluate('__fcg.ready()')
  return seeked
}

/** One rendered still. */
export interface DesignSnapshotResult {
  readonly png: Buffer
  readonly width: number
  readonly height: number
  /** The time the frame was seeked to, in seconds. */
  readonly atSeconds: number
  readonly preflight: DesignPreflightReport
  readonly timelinesSeeked: number
}

/** Capture one frame. */
export interface DesignSnapshotRequest extends DesignCompositionSource, DesignCompositionSession {
  readonly atSeconds: number
}

/**
 * Render a single frame as PNG.
 *
 * No encoder is involved: a still is a screenshot, and running it through
 * WebCodecs would add a codec's opinion to an image that has no reason to have
 * one.
 *
 * @param request - the composition, where to run it, and the time to seek to.
 * @returns the PNG bytes and what was observed on the way there.
 */
export async function captureDesignSnapshot(request: DesignSnapshotRequest): Promise<DesignSnapshotResult> {
  const opened = await openComposition(request, request, DEFAULT_RESULT_PATH)
  try {
    const seeked = await seekAndSettle(opened.page, request.atSeconds)
    return {
      png: await opened.page.screenshot(),
      width: request.width,
      height: request.height,
      atSeconds: request.atSeconds,
      preflight: opened.preflight,
      timelinesSeeked: seeked.timelines,
    }
  } finally {
    await opened.close()
  }
}

/** One rendered video. */
export interface DesignRenderResult {
  readonly bytes: Buffer
  /** Always `mp4`: see `DESIGN_VIDEO_CODECS` for why there is no other. */
  readonly container: 'mp4'
  readonly codec: string
  readonly frames: number
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly preflight: DesignPreflightReport
  /** Whether the encoder reported a decoder configuration record. */
  readonly carriedDecoderConfig: boolean
  /** Total time the render took, in milliseconds. */
  readonly elapsedMs: number
  /** Per-frame duration in milliseconds, for a caller deciding on a larger render. */
  readonly perFrameMs: number
}

/** Render a sequence. */
export interface DesignRenderRequest extends DesignCompositionSource, DesignCompositionSession {
  readonly fps: number
  readonly frameCount: number
  readonly bitrate?: number
  /** Seconds to seek to for each frame; defaults to `index / fps`. */
  readonly atSeconds?: readonly number[]
  /** Which codec to ask for; defaults to the first this machine supports. */
  readonly codec?: string
}

/**
 * Render a sequence into a video file.
 *
 * @param request - the composition, where to run it, and how many frames.
 * @returns the finished bytes plus what was measured while producing them.
 */
export async function renderDesignVideo(request: DesignRenderRequest): Promise<DesignRenderResult> {
  if (!Number.isInteger(request.frameCount) || request.frameCount <= 0) {
    throw new Error('frameCount must be a positive integer')
  }
  if (!(request.fps > 0)) throw new Error('fps must be greater than zero')

  const started = Date.now()
  const opened = await openComposition(request, request, DEFAULT_RESULT_PATH)
  try {
    // Ask the encoder, on this machine, rather than assuming. H.264 is absent
    // on some Linux builds, and a render that assumed it would fail at the end.
    const support = await evaluateJson<Record<string, boolean>>(
      opened.page,
      `__fcg.supported(${JSON.stringify(DESIGN_PROBE_CODECS)})`,
    )
    const codec = request.codec ?? DESIGN_VIDEO_CODECS.find(candidate => support[candidate] === true)
    if (codec === undefined) {
      const encodes = DESIGN_PROBE_CODECS.filter(candidate => support[candidate] === true)
      throw new Error(
        'this browser has no H.264 encoder, and MP4 is the only container this renderer writes — '
        + `it does support: ${encodes.length === 0 ? 'no video codec at all' : encodes.join(', ')}`,
      )
    }
    if (support[codec] === false) throw new Error(`this browser cannot encode ${codec}`)

    await opened.page.evaluate(`__fcg.begin(${JSON.stringify({
      width: request.width,
      height: request.height,
      fps: request.fps,
      bitrate: request.bitrate ?? 4_000_000,
      codec,
    })})`)

    const frameStarted = Date.now()
    for (let index = 0; index < request.frameCount; index += 1) {
      const seconds = request.atSeconds?.[index] ?? index / request.fps
      await seekAndSettle(opened.page, seconds)
      const png = await opened.page.screenshot()
      await opened.page.evaluate(`__fcg.frame(${JSON.stringify(png.toString('base64'))}, ${index})`)
    }
    const perFrameMs = (Date.now() - frameStarted) / request.frameCount

    const awaited = claimed(opened.server.awaitResult(RESULT_TIMEOUT_MS))
    const summary = await evaluateJson<{ bytes: number; frames: number; description: boolean }>(
      opened.page,
      `__fcg.finish(${JSON.stringify(DEFAULT_RESULT_PATH)})`,
    )
    const bytes = await awaited

    if (bytes.length !== summary.bytes) {
      throw new Error(`the page reported ${summary.bytes} bytes and posted ${bytes.length}`)
    }

    return {
      bytes,
      container: 'mp4',
      codec,
      frames: summary.frames,
      width: request.width,
      height: request.height,
      fps: request.fps,
      preflight: opened.preflight,
      carriedDecoderConfig: summary.description,
      elapsedMs: Date.now() - started,
      perFrameMs,
    }
  } finally {
    await opened.close()
  }
}
