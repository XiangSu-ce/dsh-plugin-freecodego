/**
 * What a render is allowed to read, and where it serves it from.
 *
 * This module had no spec until the audit that found two defects in it, which is
 * the reason the cases below are written as claims about *single references*
 * rather than as one end-to-end render: the module's whole job is to answer two
 * questions per reference — what will the browser ask for, and which file is that
 * — and both defects were those two answers being one string.
 *
 * The two defects, one case each, so a regression names itself:
 *
 *  1. A reference with an escaped character was read from disk and then 404'd in
 *     the page, because the server was keyed by the decoded path while the
 *     browser asks for the encoded one. Nothing reported it — `assetsMissing`
 *     stayed empty and the frame showed a hole.
 *  2. `%2e%2e/...` passed the "leaves the composition directory" check, which ran
 *     before decoding, so a composition could name a file beside it.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import {
  loadCompositionAssets,
  mediaTypeForPath,
  scanCompositionAssets,
  type CompositionAssetReader,
} from '../src/design/composition-assets.ts'

/** Scan one markup reference and report what the scanner made of it. */
function scanReference(reference: string): ReturnType<typeof scanCompositionAssets> {
  return scanCompositionAssets(`<img src="${reference}">`)
}

describe('scanCompositionAssets', () => {
  it('splits one reference into the path the browser requests and the path to read', () => {
    const scan = scanCompositionAssets('<img src="./assets/bg.png">')
    // The browser resolves the reference against the document at the origin
    // root, so `./assets/bg.png` is fetched as `/assets/bg.png` — and the file to
    // read is the same path relative to the composition's own directory.
    expect(scan.wanted).toEqual([{
      reference: './assets/bg.png',
      urlPath: '/assets/bg.png',
      filePath: 'assets/bg.png',
    }])
    expect(scan.skipped).toEqual([])
  })

  it('keys an escaped reference by the URL the page will fetch', () => {
    // The defect: served under `/assets/my image.png`, which no request ever
    // carries. The request path keeps the escape; the file on disk has the space.
    const scan = scanReference('assets/my%20image.png')
    expect(scan.wanted[0]?.urlPath).toBe('/assets/my%20image.png')
    expect(scan.wanted[0]?.filePath).toBe('assets/my image.png')
  })

  it('keeps a non-ASCII reference encoded for the request and decoded for the read', () => {
    const scan = scanReference('assets/背景.png')
    expect(scan.wanted[0]?.urlPath).toBe('/assets/%E8%83%8C%E6%99%AF.png')
    expect(scan.wanted[0]?.filePath).toBe('assets/背景.png')
  })

  it('drops a query and a fragment, which are not part of the file name', () => {
    const scan = scanReference('assets/hero.png?v=2#top')
    expect(scan.wanted[0]?.urlPath).toBe('/assets/hero.png')
    expect(scan.wanted[0]?.filePath).toBe('assets/hero.png')
  })

  it('refuses a path that leaves the composition directory through its own encoding', () => {
    // Every one of these reaches the parent directory, and every one of them is
    // refused for the same reason. The encodings are not exotic: the check that
    // ran before decoding simply could not see them.
    for (const reference of [
      '../secret.png',
      '%2e%2e/secret.png',
      '..%2fsecret.png',
      '%2E%2E%2F%2E%2E%2Fsecret.png',
      'a/%2e%2e/other/secret.png',
      '..\\secret.png',
      '%2e%2e%5Csecret.png',
    ]) {
      const scan = scanReference(reference)
      expect(scan.wanted, reference).toEqual([])
      expect(scan.skipped[0]?.reason, reference).toBe('the path leaves the composition directory')
    }
  })

  it('refuses a root-relative path, written plainly or produced by an escape', () => {
    expect(scanReference('/assets/bg.png').skipped[0]?.reason)
      .toBe('root-relative paths have no document root in a single-composition render')
    const decoded = scanReference('%2Fetc%2Fpasswd.png')
    expect(decoded.wanted).toEqual([])
    expect(decoded.skipped[0]?.reason)
      .toBe('root-relative paths have no document root in a single-composition render')
  })

  it('refuses an absolute Windows path that only appears once its escapes are decoded', () => {
    const scan = scanReference('%43%3A%5CWindows%5Cwin.ini')
    expect(scan.wanted).toEqual([])
    expect(scan.skipped[0]?.reason).toBe('the path names an absolute path once its escapes are decoded')
  })

  it('refuses malformed percent-encoding instead of reading a name it guessed at', () => {
    expect(scanReference('assets/%ZZ.png').skipped[0]?.reason).toBe('the path is not valid percent-encoding')
  })

  it('ignores a reference that is not this server to read', () => {
    for (const reference of [
      'data:image/png;base64,AAAA',
      'https://example.com/a.png',
      '//example.com/a.png',
      '#section',
      'blob:1234',
    ]) {
      const scan = scanReference(reference)
      expect(scan.wanted, reference).toEqual([])
      expect(scan.skipped, reference).toEqual([])
    }
  })

  it('folds the same file spelled two ways into one request path', () => {
    // Two keys for one file would be two copies of it in memory, and only one of
    // them would ever be fetched.
    const scan = scanCompositionAssets('<img src="a.png"><img src="./a.png"><script src="a.png"></script>')
    expect(scan.wanted.map(wanted => wanted.urlPath)).toEqual(['/a.png'])
  })

  it('reads src, href, poster and url(...), including the lazy-loading spellings', () => {
    const scan = scanCompositionAssets([
      '<link href="style.css" rel="stylesheet">',
      '<video poster="poster.jpg"></video>',
      '<div style="background: url(bg.webp)"></div>',
      '<svg><use xlink:href="sprite.svg#icon"></use></svg>',
      // Kept rather than ignored: the lazy loader fetches it once the element is
      // in view, and an unserved file is a hole the report would call nothing.
      '<img data-src="lazy.png" alt="not a reference">',
      // A descriptor list chooses between candidates, which is the page's
      // decision rather than this server's.
      '<img srcset="one.png 1x, two.png 2x">',
      '<img alt="ignored.png">',
    ].join('\n'))
    // Three patterns in turn — attributes, poster, `url(...)` — so the order
    // groups by kind rather than following document position. What matters here
    // is which references are read at all.
    expect(scan.wanted.map(wanted => wanted.urlPath))
      .toEqual(['/style.css', '/sprite.svg', '/lazy.png', '/poster.jpg', '/bg.webp'])
  })
})

describe('loadCompositionAssets', () => {
  /** A reader over an in-memory tree that records the paths it was asked for. */
  function reader(files: Readonly<Record<string, string>>): { readonly read: CompositionAssetReader; readonly asked: string[] } {
    const asked: string[] = []
    return {
      asked,
      read: async (relativePath) => {
        asked.push(relativePath)
        const text = files[relativePath]
        if (text === undefined) throw new Error(`ENOENT: ${relativePath}`)
        return text
      },
    }
  }

  it('reads the decoded path and serves it under the path the browser asks for', async () => {
    const target = reader({ 'assets/my image.png': 'PNG' })
    const loaded = await loadCompositionAssets('<img src="assets/my%20image.png">', target.read)
    expect(target.asked).toEqual(['assets/my image.png'])
    expect([...loaded.assets.keys()]).toEqual(['/assets/my%20image.png'])
    expect(loaded.assets.get('/assets/my%20image.png')).toEqual({ body: 'PNG', contentType: 'image/png' })
    expect(loaded.missing).toEqual([])
  })

  it('serves a refused or unreadable reference as a reason, not as a hole in the frame', async () => {
    const target = reader({ 'present.png': 'PNG' })
    const loaded = await loadCompositionAssets(
      '<img src="%2e%2e/leaves.png"><img src="absent.png"><img src="present.png">',
      target.read,
    )
    expect([...loaded.assets.keys()]).toEqual(['/present.png'])
    // Both halves, in one list: what the scanner would not read, and what the
    // file service could not. A render is asked to explain a blank frame, and
    // which of the two it was is the whole of the explanation.
    expect(loaded.missing).toEqual([
      { reference: '%2e%2e/leaves.png', reason: 'the path leaves the composition directory' },
      { reference: 'absent.png', reason: 'ENOENT: absent.png' },
    ])
    expect(target.asked).toEqual(['absent.png', 'present.png'])
  })

  it('reports a reader that answers undefined as a file it could not read', async () => {
    const loaded = await loadCompositionAssets('<img src="a.png">', async () => undefined)
    expect(loaded.assets.size).toBe(0)
    expect(loaded.missing).toEqual([{ reference: 'a.png', reason: 'the file could not be read' }])
  })

  it('reads bytes for a binary asset rather than turning it into text', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const loaded = await loadCompositionAssets('<img src="a.png">', async () => bytes)
    expect(loaded.assets.get('/a.png')?.body).toBe(bytes)
  })
})

describe('mediaTypeForPath', () => {
  it('names the types a composition is made of', () => {
    expect(mediaTypeForPath('/a/b.css')).toBe('text/css; charset=utf-8')
    expect(mediaTypeForPath('/a/b.mjs')).toBe('text/javascript; charset=utf-8')
    expect(mediaTypeForPath('/FONT.WOFF2')).toBe('font/woff2')
  })

  it('falls back to a type that still loads rather than to one that misparses', () => {
    // A wrong `text/html` on a font makes the browser try to parse the bytes as a
    // page; a wrong octet stream on an image still loads.
    expect(mediaTypeForPath('/a/b.bin')).toBe('application/octet-stream')
    expect(mediaTypeForPath('/a/b')).toBe('application/octet-stream')
  })
})
