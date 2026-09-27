/**
 * The browser driver, against whatever browser this machine actually has.
 *
 * Every other design test substitutes the browser. This one does not, and that
 * is its entire reason for existing: the driver's claims — that the port file
 * appears, that a page attaches, that a pinned time renders the same bytes twice
 * — are claims about a real browser, and a fake cannot confirm or refute any of
 * them. Type-checking a CDP call proves the call is shaped right, not that the
 * method exists or that the arguments mean what we think.
 *
 * It skips rather than fails when there is no browser: a machine without Edge or
 * Chrome is a supported install (the plugin reports it), not a broken checkout.
 * A skipped run is visible in the output, so it cannot be mistaken for a pass.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { defaultDesignBrowserProbes, resolveDesignBrowser } from '../src/design/browser'
import { launchDesignSession, type DesignBrowserPage } from '../src/design/browser-driver'
import { serveDesignDocument, type DesignPreviewServer } from '../src/design/preview-server'

const resolved = resolveDesignBrowser(undefined, defaultDesignBrowserProbes())

/** The profile directory, deleted with the process. */
const profile = mkdtempSync(join(tmpdir(), 'freecodego-design-live-'))
// Retried, then left to the OS. The browser this file launches is an external
// process: Windows keeps its handles on the profile directory for as long as the
// close is draining, and an unretried `rmSync` turns that into EPERM — which the
// runner reports as this whole file failing, after every assertion in it passed.
// The Harness's own fixture cleanup (`scripts/test-fixture-cleanup.ts`) budgets 50
// × 200 ms for the same reason; past that, a leaked temporary directory is a
// better outcome than a suite that cannot report what it proved.
afterAll(() => {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
  } catch { /* the OS reaps it */ }
})

/**
 * A composition whose motion is driven by CSS animation, so a seeked frame is
 * reproducible: no rAF loop, no clock read inside the page.
 */
const COMPOSITION = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #101014; }
  #card {
    width: 320px; height: 180px; margin: 40px;
    background: #2d6cdf;
    animation: slide 2000ms linear infinite;
    font: 700 48px/180px system-ui; color: white; text-align: center;
  }
  @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(400px); } }
</style></head>
<body><div id="card">HF</div>
<script>
  window.__seek = (ms) => {
    for (const animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = ms
    }
    return document.getAnimations().length
  }
  window.__probe = () => ({ ready: document.readyState, animated: document.getAnimations().length })
</script>
</body></html>`

/** Shared across the file: one browser, one server, a handful of commands. */
let page: DesignBrowserPage | undefined
let server: DesignPreviewServer | undefined

afterAll(async () => {
  if (page !== undefined) await page.close()
  if (server !== undefined) await server.close()
})

const describeLive = resolved.kind === 'available' ? describe : describe.skip

describeLive(`design browser (live: ${resolved.kind === 'available' ? resolved.source : 'none'})`, () => {
  it('serves the composition, attaches a page, and renders the same frame twice', async () => {
    expect(resolved.kind).toBe('available')
    if (resolved.kind !== 'available') return

    server = await serveDesignDocument({
      html: COMPOSITION,
      assets: new Map([['/assets/marker.svg', { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', contentType: 'image/svg+xml' }]]),
    })

    page = await launchDesignSession({
      executable: resolved.executable,
      profileDirectory: join(profile, 'session'),
      url: `${server.origin}/`,
      width: 640,
      height: 360,
    })

    await page.setViewport(640, 360)
    await page.navigate(`${server.origin}/`)

    // The page is scripted, so if it attached at all this must be true.
    const probe = await page.evaluate<{ ready: string; animated: number }>('window.__probe()')
    expect(probe.ready).toBe('complete')
    expect(probe.animated).toBe(1)

    // A seeked frame, twice. This is the property the whole render path rests on:
    // if a pinned time does not produce identical bytes, "render frame N" is not a
    // well-defined request and every downstream claim about it is unfounded.
    await page.evaluate('window.__seek(500)')
    const first = await page.screenshot()
    await page.evaluate('window.__seek(1750)')
    await page.evaluate('window.__seek(500)')
    const second = await page.screenshot()

    expect(first.length).toBeGreaterThan(1000)
    expect(first.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG signature
    expect(second.equals(first)).toBe(true)
  }, 90_000)

  it('answers assets by exact path and nothing else', async () => {
    expect(server).toBeDefined()
    if (server === undefined) return

    const asset = await fetch(`${server.origin}/assets/marker.svg`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('image/svg+xml')

    // The server holds a map, not a directory, so a traversal path is not
    // defended against — it simply has no meaning here.
    for (const attempt of ['/assets/../secret', '/assets/marker.svg/../../etc/passwd', '/nope']) {
      const response = await fetch(`${server.origin}${attempt}`)
      expect(response.status, attempt).toBe(404)
    }
  }, 30_000)
})
