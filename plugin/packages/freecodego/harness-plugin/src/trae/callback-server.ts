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
 * What answers, and what does not
 * -------------------------------
 * This listener authenticates nothing: it serves one path, and any request for
 * that path is handed on as the redirect. Loopback is not owner-only (the same
 * fact `claude-protocol-bridge.ts` states as the reason its own listener compares
 * a secret), so a process on this machine — or a page that guesses the port and
 * requests this path — can deliver a callback URL of its own choosing, and the
 * exchange will adopt the account it names. Closing that needs a value only this
 * attempt and the sign-in page share, and the redirect's query is the page's own
 * (`isRedirect`, `scope`, `userInfo`, `refreshToken` — see `trae-login-flow.spec.ts`),
 * so there is nothing in it to check today. What is enforced here is the part
 * that is ours to enforce: the request has to name this attempt's path exactly,
 * and the listener stops after the attempt it belongs to.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/callback-server
 */

import { createServer, type Server } from 'node:http'
import { TRAE_CALLBACK_PATH } from './endpoints.ts'

/**
 * Whether a request's target is this attempt's callback path.
 *
 * The path component, compared whole. A prefix test would accept
 * `/authorize-anything`, and the URL it hands the exchange is the requester's own
 * — so the answer to "is this the redirect I am waiting for" has to be about the
 * one path, not about a string it starts with.
 * @param target - the request target, as `node:http` reports it.
 * @returns true when the request is for the callback path.
 */
function isCallbackTarget(target: string | undefined): boolean {
  if (target === undefined) return false
  try {
    // Absolute-form targets are legal in HTTP, so the base is only there for the
    // origin-form one a browser sends.
    return new URL(target, 'http://127.0.0.1').pathname === TRAE_CALLBACK_PATH
  } catch {
    return false
  }
}

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
    if (!isCallbackTarget(url)) {
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
