/**
 * The render path, end to end, against a real browser.
 *
 * This is the test that can say whether the engine works, and nothing else can.
 * Unit tests cover the muxer's box arithmetic and the resolver's priority order,
 * but they cannot tell you whether WebCodecs accepts this machine's `avc1.640028`
 * with `avc: { format: 'avc' }`, whether `Page.addScriptToEvaluateOnNewDocument`
 * really lands before the composition's script, or whether H.264 from this
 * encoder survives a round trip.
 *
 * The last check is the one worth the trouble: the rendered file is loaded back
 * into the browser as `<video>` and asked for its dimensions and duration. The
 * browser is then an **independent decoder** reading our bytes — a muxer bug
 * produces a file that its own author's parser accepts and a real decoder
 * refuses, and only the second opinion catches it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { defaultDesignBrowserProbes, resolveDesignBrowser } from '../src/design/browser'
import { launchDesignSession } from '../src/design/browser-driver'
import { captureDesignSnapshot, renderDesignVideo } from '../src/design/capture'
import { serveDesignDocument } from '../src/design/preview-server'

const resolved = resolveDesignBrowser(undefined, defaultDesignBrowserProbes())

/** The profile directory for every session in this file. */
const profile = mkdtempSync(join(tmpdir(), 'freecodego-design-render-'))
// Retried, then left to the OS, for the reason `design-browser-live.spec.ts`
// states: the browser is an external process, and Windows drains its handles on
// the profile directory after the close resolves, so catching the unretried
// `rmSync` reports a passing file as a failure.
afterAll(() => {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
  } catch { /* the OS reaps it */ }
})

/**
 * A composition written the way the vendored Skills instruct.
 *
 * It registers one paused timeline at `window.__timelines['demo']` and drives
 * everything from `seek(t)`. GSAP is not available in this page, so the timeline
 * is the three methods the runtime actually uses — which is the point: the
 * contract is `pause`/`seek`/`paused`, and a fixture that satisfied it with real
 * GSAP would be testing GSAP.
 */
const COMPOSITION = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #0b0b12; }
  #box { position: absolute; top: 40px; left: 0; width: 80px; height: 80px; background: #2d6cdf; }
</style></head>
<body><div id="box"></div>
<script>
  var box = document.getElementById('box')
  var timeline = {
    paused: function () { return true },
    pause: function () { return this },
    seek: function (t) {
      var p = Math.max(0, Math.min(1, t * 2))
      box.style.transform = 'translateX(' + (p * 480) + 'px)'
      box.style.opacity = String(0.2 + 0.8 * p)
      return this
    },
  }
  window.__timelines = window.__timelines || {}
  window.__timelines['demo'] = timeline
  timeline.seek(0)
</script>
</body></html>`

const describeLive = resolved.kind === 'available' ? describe : describe.skip

/** Read a PNG's width and height out of its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describeLive(`design render engine (live: ${resolved.kind === 'available' ? resolved.source : 'none'})`, () => {
  it('renders a still at a seeked time', async () => {
    expect(resolved.kind).toBe('available')
    if (resolved.kind !== 'available') return

    const still = await captureDesignSnapshot({
      html: COMPOSITION,
      executable: resolved.executable,
      profileDirectory: join(profile, 'still'),
      width: 640,
      height: 360,
      atSeconds: 0.25,
    })

    expect(still.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(pngSize(still.png)).toEqual({ width: 640, height: 360 })
    // The composition is a correct one, so the self-check must find nothing.
    expect(still.preflight.codes).toEqual([])
    expect(still.preflight.timelines).toEqual(['demo'])
    expect(still.timelinesSeeked).toBe(1)
  }, 90_000)

  it('renders a sequence, muxes it, and the browser decodes it back', async () => {
    expect(resolved.kind).toBe('available')
    if (resolved.kind !== 'available') return

    const rendered = await renderDesignVideo({
      html: COMPOSITION,
      executable: resolved.executable,
      profileDirectory: join(profile, 'render'),
      width: 320,
      height: 180,
      fps: 10,
      frameCount: 8,
      bitrate: 1_000_000,
    })

    expect(rendered.container).toBe('mp4')
    expect(rendered.codec.startsWith('avc1')).toBe(true)
    expect(rendered.frames).toBe(8)
    // Without a decoder configuration the video track is undecodable, so this is
    // an assertion about playability rather than about a field being present.
    expect(rendered.carriedDecoderConfig).toBe(true)
    expect(rendered.bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')

    // The second opinion: hand the bytes to the browser as a video and ask what
    // it makes of them. A duration of 0.8s at 320x180 is the answer a correct
    // file gets; a muxer bug gets `NaN`, `0`, or an error.
    const playback = await serveDesignDocument({
      html: `<!doctype html><html><body><video id="v" src="/clip.mp4" muted></video>
      <script>
        window.__describe = function () {
          return new Promise(function (resolve) {
            var video = document.getElementById('v')
            var done = false
            var report = function (extra) {
              if (done) return
              done = true
              resolve(Object.assign({
                width: video.videoWidth, height: video.videoHeight, duration: video.duration,
              }, extra || {}))
            }
            video.onloadedmetadata = function () { report() }
            video.onerror = function () { report({ error: 'the browser refused the file' }) }
            setTimeout(function () { report({ error: 'no metadata within 10s, readyState=' + video.readyState }) }, 10000)
          })
        }
      </script></body></html>`,
      assets: new Map([['/clip.mp4', { body: rendered.bytes, contentType: 'video/mp4' }]]),
    })

    const page = await launchDesignSession({
      executable: resolved.executable,
      profileDirectory: join(profile, 'playback'),
      url: `${playback.origin}/`,
      width: 320,
      height: 180,
    })
    try {
      // `Runtime.evaluate` has no top-level `await`, so an asynchronous page
      // answer arrives through an async wrapper — the same shape
      // `evaluateJson` uses, and for the same reason.
      const described = JSON.parse(await page.evaluate<string>('(async () => JSON.stringify(await window.__describe()))()')) as {
        width: number
        height: number
        duration: number
        error?: string
      }
      expect(described.error).toBeUndefined()
      expect(described.width).toBe(320)
      expect(described.height).toBe(180)
      // 8 frames at 10 fps.
      expect(described.duration).toBeCloseTo(0.8, 1)
    } finally {
      await page.close()
      await playback.close()
    }
  }, 180_000)

  it('produces identical frames for an identical render', async () => {
    expect(resolved.kind).toBe('available')
    if (resolved.kind !== 'available') return

    // Two independent sessions, same composition, same times. This is the
    // property the whole design is staked on — a render that cannot repeat is a
    // render whose frames cannot be reasoned about.
    const session = {
      html: COMPOSITION,
      executable: resolved.executable,
      width: 160,
      height: 90,
      atSeconds: 0.3,
    } as const
    const first = await captureDesignSnapshot({ ...session, profileDirectory: join(profile, 'repeat-a') })
    const second = await captureDesignSnapshot({ ...session, profileDirectory: join(profile, 'repeat-b') })
    expect(second.png.equals(first.png)).toBe(true)
  }, 120_000)
})
