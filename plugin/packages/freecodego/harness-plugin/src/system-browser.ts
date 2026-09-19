/**
 * Host-only helper for opening a URL in the user's default browser.
 *
 * The Settings cards delegate OAuth/device authorization to the browser, and a
 * plain link is easy to miss, so the Host can open the page itself. The
 * command is platform dispatch only — no shell string is ever built from the
 * URL, and non-http(s) schemes are refused outright.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/system-browser
 */

import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Whether the URL is one we are willing to hand to the system browser.
 *
 * Exported because the rule is not the opener's alone: an OAuth/device
 * authorization URL arrives from the provider and is *also* rendered as a
 * clickable link in Settings, so whatever produces a ticket has to apply the
 * same allow-list the opener applies. A URL this Host refuses to open must not
 * become clickable just because the user pressed the link instead.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch { return false }
}

/**
 * Open one http(s) URL with the platform default browser.
 *
 * Resolves `true` when the platform opener really started and `false` when the
 * platform is unsupported or the opener is missing. Fire-and-forget by design:
 * "the OS accepted the open request" is the strongest signal available without
 * waiting on a browser process, and the caller always keeps a manual link as
 * the fallback — which only appears if this answer is honest.
 *
 * The child's own events decide that answer, not the return of `spawn()`: a
 * missing binary is reported asynchronously, as an `'error'` event. Returning
 * `true` from the call site made the answer a constant (a headless host said
 * "opened" for a page that never opened), and — worse — an `'error'` event with
 * no listener is rethrown inside the Host process, which a caller's
 * `.catch(() => false)` cannot intercept because it is not a rejection. Every
 * other `spawn` in this plugin attaches an error handler for the same reason.
 */
export async function openUrlInSystemBrowser(url: string): Promise<boolean> {
  if (!isHttpUrl(url)) return false
  let child: ChildProcess
  try {
    child = process.platform === 'win32'
      // `start` is a cmd builtin, and cmd mangles certain characters in plain
      // args; `rundll32` with the URL as a single argument avoids both.
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' })
  } catch { return false }
  child.unref()
  return await new Promise<boolean>((resolve) => {
    child.once('error', () => { resolve(false) })
    child.once('spawn', () => { resolve(true) })
  })
}
