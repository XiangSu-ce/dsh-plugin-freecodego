/**
 * A loopback HTTP server for one composition.
 *
 * A composition is an HTML document that pulls in local files, so it has to be
 * served rather than handed to the browser as a `file://` URL: under `file://`
 * every relative fetch is a cross-origin request, and the modules a composition
 * loads would be blocked.
 *
 * The server is deliberately capable of nothing. It holds an in-memory map of
 * the document and its assets, and answers only exact matches against it:
 *
 * - **It never touches the filesystem.** The caller reads the files, through the
 *   plugin's own `fs` service, and hands over the bytes. So there is no path here
 *   that a request could traverse — the usual `..` and symlink escapes are not
 *   defended against, they are unrepresentable.
 * - **It binds loopback only**, on a port the OS picks, and lives for the length
 *   of one render. A composition is often unreleased work; a temporary server on
 *   0.0.0.0 would publish it to the local network.
 *
 * @module design/preview-server
 */

import { createServer, type Server } from 'node:http'

/** Where the page posts the finished file, unless told otherwise. */
export const DEFAULT_RESULT_PATH = '/__fcg/result'

/** One file the composition refers to, keyed by the URL path it is fetched at. */
export interface DesignPreviewAsset {
  /** `Uint8Array` rather than `Buffer`: a `Buffer` is one, and the wider type is
   *  what lets a caller hand over bytes without converting them. */
  readonly body: Uint8Array | string
  readonly contentType: string
}

/** What to serve. */
export interface DesignPreviewDocument {
  /** The document, served at `/`. */
  readonly html: string
  /** Everything else, keyed by absolute URL path (`/assets/app.js`). */
  readonly assets?: ReadonlyMap<string, DesignPreviewAsset>
  /** Where the page posts the finished file. Defaults to `DEFAULT_RESULT_PATH`. */
  readonly resultPath?: string
}

/** A running server. */
export interface DesignPreviewServer {
  /** The origin the document is reachable at, without a trailing slash. */
  readonly origin: string
  /**
   * Wait for the page to post the finished file to the result path.
   *
   * Separate from the request handler on purpose: the bytes belong to the
   * caller, and a server that stored them until asked would keep a rendered
   * video alive for as long as the server ran.
   *
   * @param timeoutMs - how long to wait before reporting the page never posted.
   * @returns the file bytes.
   */
  readonly awaitResult: (timeoutMs: number) => Promise<Buffer>
  /** Stop serving and release the port. Idempotent. */
  readonly close: () => Promise<void>
}

/**
 * Serve one document on loopback.
 *
 * @param document - the HTML and the assets it fetches.
 * @returns the origin and a closer.
 */
export async function serveDesignDocument(document: DesignPreviewDocument): Promise<DesignPreviewServer> {
  const resultPath = document.resultPath ?? DEFAULT_RESULT_PATH
  let deliver: ((bytes: Buffer) => void) | undefined
  let refuse: ((error: Error) => void) | undefined

  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === resultPath) {
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('the result path takes POST')
        return
      }
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        response.writeHead(204)
        response.end()
        deliver?.(Buffer.concat(chunks))
      })
      request.on('error', (error: Error) => { refuse?.(error) })
      return
    }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // A stale composition would be rendered from cache and reported as the
        // current one, which is exactly the kind of silent wrong answer this
        // whole path exists to avoid.
        'cache-control': 'no-store',
      })
      response.end(document.html)
      return
    }
    const asset = document.assets?.get(path)
    if (asset === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`no such asset: ${path}`)
      return
    }
    response.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-store' })
    response.end(asset.body)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1, never 0.0.0.0, and port 0 so the OS picks a free one: two renders
    // running at once must not fight over a fixed port.
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('the preview server did not report a port')
  }

  let closed = false
  return {
    origin: `http://127.0.0.1:${address.port}`,
    awaitResult: (timeoutMs) => new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        deliver = undefined
        refuse = undefined
        reject(new Error('the page never posted a result'))
      }, timeoutMs)
      deliver = (bytes) => { clearTimeout(timer); deliver = undefined; refuse = undefined; resolve(bytes) }
      refuse = (error) => { clearTimeout(timer); deliver = undefined; refuse = undefined; reject(error) }
    }),
    close: async () => {
      if (closed) return
      closed = true
      // A waiter still waiting is rejected here rather than left to its own
      // deadline. Two reasons, and the second is the one that bit: the caller
      // gets "the server closed" instead of a two-minute wait for a page that
      // can no longer deliver, and the deadline's timer — which holds the event
      // loop open — is cleared instead of outliving the render that started it.
      // `deliver` and `refuse` are set and cleared together, so calling one is
      // the same as asking whether anything is pending.
      refuse?.(new Error('the preview server closed before the page posted a result'))
      // Keep-alive sockets would hold the port open past the render, so the
      // server is asked to drop idle ones rather than waiting them out.
      server.closeIdleConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
}
