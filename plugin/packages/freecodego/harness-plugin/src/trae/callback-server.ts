/**
 * The loopback listener that captures one TRAE sign-in redirect.
 *
 * Why a listener rather than a poll
 * ---------------------------------
 * SOLO does not hand its result to a polling endpoint; it redirects the browser
 * to an `auth_callback_url` with the refresh token in the query string. So the
 * Host has to be *reachable* by that redirect, which is exactly what a loopback
 * socket is: the URL names `127.0.0.1`, the browser is on this machine, and the
 * credential never travels over a network a third party could answer on.
 *
 * The port is chosen by the OS (`listen(0)`) rather than fixed, because a fixed
 * one collides with whatever else is running and because the URL is minted fresh
 * for every attempt anyway — nothing needs to be remembered between them.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/callback-server
 */

import { createServer, type Server } from 'node:http'
import { TRAE_CALLBACK_PATH } from './endpoints.ts'

/** A running listener for one sign-in attempt. */
export interface TraeCallbackListener {
  /** The port the OS assigned, for building the callback URL. */
  readonly port: number
  /** Stop listening; safe to call more than once. */
  close(): Promise<void>
}

/**
 * The page the browser is left on once the redirect has been captured.
 *
 * It speaks for the part that already happened — the redirect arrived — and not
 * for the exchange, which is still running in the app. Saying "authorized" here
 * and "failed" there would describe one attempt two ways.
 */
function completionPage(language: 'zh' | 'en'): string {
  const title = language === 'zh' ? 'TRAE 授权已收到' : 'TRAE authorization received'
  const body = language === 'zh' ? '请回到应用查看登录结果。' : 'Return to the app to see the result.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;margin:48px;color:#222"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body></html>`
}

/**
 * Start listening for one sign-in redirect.
 *
 * The handler answers the browser immediately and hands the raw callback URL to
 * the caller, which performs the exchange on its own clock. Answering first
 * matters: the exchange is several network calls, and a browser left waiting on
 * them shows a blank tab for as long as they take.
 * @param onCallback - called with the full callback URL once it arrives.
 * @param language - language of the page the browser is left on.
 * @returns the running listener.
 */
export async function startTraeCallbackListener(
  onCallback: (url: string) => void,
  language: 'zh' | 'en' = 'zh',
): Promise<TraeCallbackListener> {
  const server: Server = createServer((request, response) => {
    const url = request.url === undefined ? '/' : request.url
    if (!url.startsWith(TRAE_CALLBACK_PATH)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    onCallback(`http://127.0.0.1${url}`)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(completionPage(language))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only: a listener on every interface would accept an
    // authorization meant for this machine from anywhere on the network.
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  let closed = false
  return {
    port,
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
