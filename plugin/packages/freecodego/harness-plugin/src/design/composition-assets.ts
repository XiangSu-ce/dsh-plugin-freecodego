/**
 * Reading what a composition refers to.
 *
 * A render serves the composition from loopback, so every file it fetches has to
 * be in memory before the page loads. That means reading them in advance, through
 * the plugin's `fs` service, and deciding what "the file it refers to" means —
 * which is where the judgement is:
 *
 * - **Absolute and `data:` URLs are left alone.** They are not ours to read, and
 *   a render that fetched them would be making a network request on the user's
 *   behalf.
 * - **A path that leaves the composition's directory is refused, not clamped.**
 *   `../../.ssh/id_rsa` is not an asset, and a reader that rewrote it into
 *   something readable inside the project would be answering a question nobody
 *   asked. The lint side already reports this shape; here it is a skip with a
 *   reason.
 * - **A missing file is reported, not invented.** The page will fetch it and get
 *   a 404, which is the same thing a browser does with a broken reference — but
 *   the tool's report says so before the render, so a black frame is not
 *   discovered from a video.
 *
 * One reference asks two questions, and conflating them shipped two defects:
 *
 * - **What will the browser request?** The URL path, percent-encoded exactly as
 *   the page wrote it and with its dot segments resolved — that is what the
 *   loopback server is asked for and what the asset has to be keyed by. Keying by
 *   the decoded path, as this module did, meant `<img src="my%20image.png">` was
 *   read from disk and then 404'd in the page, with nothing reporting it.
 * - **Which file is that?** The percent-decoded path, resolved against the
 *   composition's own directory. Validated *after* decoding, because the check is
 *   about what the filesystem will do with the string and `%2e%2e` reaches the
 *   parent directory exactly as `..` does.
 *
 * @module design/composition-assets
 */

import type { DesignPreviewAsset } from './preview-server.ts'

/** One reference found in the markup. */
export interface CompositionAssetReference {
  /** The path as written. */
  readonly reference: string
  /**
   * The URL path the browser will request for it: absolute, with a leading
   * slash, and still percent-encoded, because that is the string the request
   * carries and therefore the key this asset has to be served under.
   */
  readonly urlPath: string
  /**
   * The path to read, percent-decoded and relative to the composition's
   * directory — which is the name the file has on disk.
   */
  readonly filePath: string
}

/** Why a reference was not served. */
export interface SkippedReference {
  readonly reference: string
  readonly reason: string
}

/** What scanning produced. */
export interface CompositionAssetScan {
  readonly wanted: readonly CompositionAssetReference[]
  readonly skipped: readonly SkippedReference[]
}

/** Only these are read; an HTML document may reference anything. */
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

/**
 * The media type for a served path.
 *
 * @param urlPath - the URL path being served.
 * @returns the media type, defaulting to binary rather than to HTML: a wrong
 *          `text/html` on a font makes the browser try to parse it as a page,
 *          while a wrong `application/octet-stream` on an image still loads.
 */
export function mediaTypeForPath(urlPath: string): string {
  const match = /\.([a-z0-9]+)$/iu.exec(urlPath.toLowerCase())
  return (match === null ? undefined : EXTENSION_MEDIA_TYPES[`.${match[1]}`]) ?? 'application/octet-stream'
}

/** Attribute and CSS references worth reading, in the order they appear. */
function referenceMatches(html: string): readonly string[] {
  const found: string[] = []
  // `src`/`href` on any element, and `url(...)` in inline style or a <style>
  // block. `srcset` is deliberately absent: its descriptors (`2x`, `100w`) make
  // "the reference" a list, and a render that served one candidate would be
  // choosing which image the composition gets.
  //
  // The word boundary sits *before* the name rather than requiring it to start
  // the attribute, so `data-src` counts — which is deliberate, not a leak. A
  // lazy loader swaps `data-src` in after load, so the file is fetched by the
  // frame that scrolls it into view: leaving it unserved would produce a hole
  // with an empty `assetsMissing`, which is the one failure this module exists
  // to make impossible. `xlink:href` on a detached `<use>` comes in the same way.
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)) found.push(match[1]!)
  for (const match of html.matchAll(/\bposter\s*=\s*["']([^"']+)["']/giu)) found.push(match[1]!)
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) found.push(match[1]!)
  return found
}

/**
 * Replace backslashes with slashes.
 *
 * A URL path has no backslash: the browser reads `assets\\bg.png` as
 * `assets/bg.png`. Normalizing here is both faithful to the request and the only
 * way the traversal check can see `..\..\secrets.txt` for what it is — on the
 * platform this plugin is specified against, `path.resolve` would follow it.
 *
 * @param reference - the path as written.
 * @returns the path with one separator spelling.
 */
function withSlashes(reference: string): string {
  return reference.replace(/\\/gu, '/')
}

/** Percent-decode one path, or `undefined` when the encoding is malformed. */
function decodePath(path: string): string | undefined {
  try {
    return decodeURIComponent(path)
  } catch {
    return undefined
  }
}

/**
 * Why a decoded path cannot be read, or `undefined` when it can.
 *
 * Written over the *decoded* string on purpose. The three escapes are one rule
 * applied to three spellings — a path that leaves the directory is refused the
 * same way whether it left as `/`, as a drive letter, or as `%2e%2e` — and a
 * check that ran before decoding would only be true of the spellings it could
 * read as text.
 *
 * @param decoded - the path after percent-decoding and separator normalization.
 * @returns the reason to report, or `undefined` for a readable path.
 */
function readRefusal(decoded: string): string | undefined {
  if (decoded.startsWith('/')) return 'root-relative paths have no document root in a single-composition render'
  if (/^[a-z]:\//iu.test(decoded)) return 'the path names an absolute path once its escapes are decoded'
  if (decoded.includes('\u0000')) return 'the path contains a null character'
  if (decoded.split('/').includes('..')) return 'the path leaves the composition directory'
  return undefined
}

/**
 * The URL path a browser will request for a written reference.
 *
 * Asked of the URL parser rather than computed by hand, because the parser is
 * what the browser and the loopback server both use: it percent-encodes what has
 * to be encoded, resolves `.` and `..` segments, and drops a query the same way.
 * A path that resolves to another origin (`//elsewhere/x.png`) has no pathname
 * this renderer could serve, which is reported rather than served as `/x.png`.
 *
 * @param written - the reference as the page wrote it, minus query and fragment.
 * @returns the absolute pathname, or `undefined` when it names no path here.
 */
function requestedPath(written: string): string | undefined {
  try {
    const url = new URL(written, 'http://127.0.0.1/')
    return url.origin === 'http://127.0.0.1' ? url.pathname : undefined
  } catch {
    return undefined
  }
}

/** True for a reference this module must not read. */
function isForeign(reference: string): boolean {
  const trimmed = reference.trim()
  return trimmed === ''
    || trimmed.startsWith('#')
    || trimmed.startsWith('data:')
    || trimmed.startsWith('blob:')
    || trimmed.startsWith('about:')
    || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)
    || trimmed.startsWith('//')
}

/** Keep a path, dropping query and fragment. */
function pathOnly(reference: string): string {
  return reference.trim().split(/[?#]/u)[0] ?? ''
}

/**
 * Scan a document for the files it will fetch.
 *
 * @param html - the composition source.
 * @returns the references to serve and the ones refused, each with a reason.
 */
export function scanCompositionAssets(html: string): CompositionAssetScan {
  const wanted: CompositionAssetReference[] = []
  const skipped: SkippedReference[] = []
  const seen = new Set<string>()

  for (const reference of referenceMatches(html)) {
    if (isForeign(reference)) continue
    const written = pathOnly(reference)
    if (written === '') continue
    // Normalized before decoding, so `..\..\s` is seen as a path and not as one
    // long file name; the decoded result is then what the read is judged on.
    const slashed = withSlashes(written)
    const decoded = decodePath(slashed)
    if (decoded === undefined) {
      skipped.push({ reference, reason: 'the path is not valid percent-encoding' })
      continue
    }
    // Normalized a second time, because an escape can produce the separator:
    // `%2e%2e%5Csecret` decodes to a backslash-separated escape that a check on
    // the decoded string alone would read as a file name.
    const safe = withSlashes(decoded)
    const refusal = readRefusal(safe)
    if (refusal !== undefined) {
      skipped.push({ reference, reason: refusal })
      continue
    }
    const urlPath = requestedPath(slashed)
    if (urlPath === undefined) {
      skipped.push({ reference, reason: 'the path names no path on this server' })
      continue
    }
    // Deduplicated by the request path, not by the spelling: `./a.png` and
    // `a.png` are one file, and serving both keys would be two copies of it.
    if (seen.has(urlPath)) continue
    seen.add(urlPath)
    wanted.push({ reference, urlPath, filePath: safe.replace(/^\.\//u, '') })
  }
  return { wanted, skipped }
}

/** What loading produced. */
export interface LoadedCompositionAssets {
  readonly assets: ReadonlyMap<string, DesignPreviewAsset>
  readonly missing: readonly SkippedReference[]
}

/** Read one file's bytes or text, by path relative to the composition. */
export type CompositionAssetReader = (relativePath: string) => Promise<Uint8Array | string | undefined>

/**
 * Read every referenced file.
 *
 * @param html - the composition source.
 * @param read - the caller's reader; returns undefined for a file it cannot read.
 * @returns the assets to serve, plus what could not be read.
 */
export async function loadCompositionAssets(
  html: string,
  read: CompositionAssetReader,
): Promise<LoadedCompositionAssets> {
  const scan = scanCompositionAssets(html)
  const assets = new Map<string, DesignPreviewAsset>()
  const missing: SkippedReference[] = scan.skipped.map(entry => ({ reference: entry.reference, reason: entry.reason }))

  for (const wanted of scan.wanted) {
    let body: Uint8Array | string | undefined
    try {
      // The decoded path: the request path is what the browser asks for, and the
      // file on disk has the name the escapes stand for.
      body = await read(wanted.filePath)
    } catch (error) {
      missing.push({ reference: wanted.reference, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (body === undefined) {
      missing.push({ reference: wanted.reference, reason: 'the file could not be read' })
      continue
    }
    // Keyed by the request path, so a reference with an escaped character is
    // served at the URL the page actually fetches rather than only read.
    assets.set(wanted.urlPath, { body, contentType: mediaTypeForPath(wanted.urlPath) })
  }

  return { assets, missing }
}
