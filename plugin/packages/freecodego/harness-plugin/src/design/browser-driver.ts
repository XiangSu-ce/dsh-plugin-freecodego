/**
 * A headless browser session driven over CDP, with no dependency to install.
 *
 * The transport is Node's own `WebSocket` and `fetch`, so this module adds no
 * package to the plugin. That matters beyond tidiness: the plan's claim is that a
 * composition is produced on the machine the user already has, and a driver that
 * needed `puppeteer` would mean a first render downloads a browser — the thing
 * the whole design avoids.
 *
 * Three decisions are carried over from measurement rather than taste:
 *
 * 1. **The port is read from `DevToolsActivePort`, not from stderr.** `--remote
 *    debugging-port=0` asks the browser to pick a free port; parsing a log line
 *    would bind the driver to a message format, and that file is the browser's
 *    own answer.
 * 2. **`Browser.close` before `kill`.** On Windows a killed process does not
 *    take its children, and this browser has several. Asking it to close gives
 *    the profile directory back; the kill is the fallback for a browser that
 *    already died.
 * 3. **The raster output is pinned.** `--force-color-profile=srgb`,
 *    `--font-render-hinting=none` and `--disable-lcd-text` keep it independent
 *    of the machine's display settings — without them the determinism this
 *    render path promises would be an artefact of the harness rather than a
 *    property of the composition.
 *
 * @module design/browser-driver
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** One CDP message. */
interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly sessionId?: string
  readonly result?: unknown
  readonly error?: { readonly message?: string }
}

/** Longest a launch may take before it is reported as a failure. */
const LAUNCH_TIMEOUT_MS = 20_000

/** How long to wait between port-file polls. */
const PORT_POLL_INTERVAL_MS = 50

/** Arguments every session gets, in the order they were measured. */
const BASE_ARGUMENTS: readonly string[] = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  // Raster output, pinned. Without these the same composition renders differently
  // on two machines with different display settings, which would make the
  // determinism the render path promises an artefact of the harness.
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--hide-scrollbars',
]

/** Pause. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

/**
 * A CDP connection.
 *
 * Requests are matched to responses by id. A browser that closes mid-request
 * rejects every pending one rather than leaving them to time out: the caller is
 * usually holding a launch, and a hang there is indistinguishable from a slow
 * machine.
 */
class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as CdpMessage
      if (message.id === undefined) return
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP request failed'))
      else waiter.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('the browser closed the CDP connection'))
      this.pending.clear()
    })
  }

  /** Send one command, optionally inside an attached target's session. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const payload = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }
      this.socket.send(JSON.stringify(payload))
    })
  }
}

/** A live page, attached and enabled. */
export interface DesignBrowserPage {
  /**
   * Run `source` before any document loads in this page, from now on.
   *
   * This exists because a composition's own script runs as it parses: a hook
   * installed after navigation would arrive after the timeline was built, and
   * the seek contract would be a contract with nobody. CDP's
   * `addScriptToEvaluateOnNewDocument` is the only way to be earlier than the
   * document.
   */
  injectOnNewDocument(source: string): Promise<void>
  /** Evaluate an expression in the page and return its value by value. */
  evaluate<T = unknown>(expression: string): Promise<T>
  /** Wait until an expression evaluates to `true`. */
  waitFor(expression: string, timeoutMs?: number): Promise<void>
  /** Override the viewport; the device metrics a frame is captured at. */
  setViewport(width: number, height: number): Promise<void>
  /** Capture the rendered surface as PNG bytes. */
  screenshot(): Promise<Buffer>
  /** Navigate and wait for the document to finish loading. */
  navigate(url: string): Promise<void>
  /** Close the browser this page belongs to. */
  close(): Promise<void>
}

/** What a launch needs. */
export interface LaunchDesignSessionOptions {
  readonly executable: string
  /** A directory this session owns; the profile is deleted with it. */
  readonly profileDirectory: string
  readonly url: string
  readonly width: number
  readonly height: number
  /** Extra browser arguments, for a caller that needs to pin something more. */
  readonly extraArguments?: readonly string[]
}

/**
 * Launch a browser and attach to one page.
 *
 * @param options - executable, profile directory, first URL, and viewport.
 * @returns the page handle. `close()` is idempotent.
 */
export async function launchDesignSession(options: LaunchDesignSessionOptions): Promise<DesignBrowserPage> {
  const child: ChildProcess = spawn(options.executable, [
    ...BASE_ARGUMENTS,
    `--user-data-dir=${options.profileDirectory}`,
    `--window-size=${options.width},${options.height}`,
    ...options.extraArguments ?? [],
    options.url,
  ], { stdio: 'ignore', detached: false, windowsHide: true })

  let closed = false
  let socket: WebSocket | undefined
  let connection: CdpConnection | undefined
  // Recorded rather than thrown: `spawn` reports a missing executable through an
  // `error` event that arrives while this call is already polling for the port
  // file, so the message has to be carried to the loop that can act on it.
  let launchFailure: string | undefined
  child.once('error', (error: Error) => { launchFailure = error.message })
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (connection !== undefined) {
      // Ask first. A killed browser leaves its children behind on Windows, and
      // this one has several; a graceful close is what gives the profile
      // directory back.
      try { await connection.send('Browser.close') } catch { /* already gone */ }
    }
    if (socket !== undefined) {
      try { socket.close() } catch { /* already gone */ }
    }
    await sleep(200)
    if (child.exitCode === null) child.kill()
  }

  try {
    const portFile = `${options.profileDirectory.replace(/[\\/]+$/u, '')}${process.platform === 'win32' ? '\\' : '/'}DevToolsActivePort`
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    let port: number | undefined
    while (Date.now() < deadline) {
      // An executable that could not be started at all is reported as that,
      // rather than as a browser that took twenty seconds to answer. The port
      // file is never going to appear, and "did not report a debugging port" —
      // which is what this used to say about a missing file, a bad path, or an
      // architecture mismatch — sends the reader to the wrong place.
      if (launchFailure !== undefined) throw new Error(`the browser could not be started: ${launchFailure}`)
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
        if (first !== undefined && first !== '' && Number.isFinite(Number(first))) { port = Number(first); break }
      }
      await sleep(PORT_POLL_INTERVAL_MS)
    }
    if (port === undefined) {
      throw new Error(launchFailure === undefined
        ? 'the browser did not report a debugging port'
        : `the browser could not be started: ${launchFailure}`)
    }

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl?: string }
    if (version.webSocketDebuggerUrl === undefined) throw new Error('the browser did not report a debugging endpoint')
    const opened = new WebSocket(version.webSocketDebuggerUrl)
    socket = opened
    await new Promise<void>((resolve, reject) => {
      opened.addEventListener('open', () => resolve())
      opened.addEventListener('error', () => reject(new Error('could not open the CDP connection')))
    })
    const cdp = new CdpConnection(opened)
    connection = cdp

    // The requested URL, not a blank page. This was `about:blank` with the
    // option ignored, which made `url` a lie: a caller that passed a page and
    // did not navigate afterwards got a blank one, and would have found out by
    // evaluating an expression against a document that was never loaded.
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: options.url })
    const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached.sessionId
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)

    const evaluate = async <T = unknown>(expression: string): Promise<T> => {
      const result = await cdp.send<{
        result?: { value?: unknown }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      if (result.exceptionDetails !== undefined) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'the page threw')
      }
      return result.result?.value as T
    }

    const waitFor = async (expression: string, timeoutMs = 30_000): Promise<void> => {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        try {
          if (await evaluate(expression) === true) return
        } catch {
          // The document may not be there yet. Retrying is the whole point of a
          // wait; a failed evaluation is a state, not an error, until the deadline.
        }
        await sleep(PORT_POLL_INTERVAL_MS)
      }
      throw new Error(`timed out waiting for: ${expression}`)
    }

    // The URL a caller passed is a page to work against, not one to hope for.
    // `Target.createTarget` resolves when the target exists, which is *before* its
    // document has loaded: a new target starts on an empty `about:blank` and
    // navigates from there. So evaluating as soon as this function returned read
    // the empty document — a page whose `window.describe` is "not a function",
    // which is exactly the shape this failure was found in, one live test at a
    // time and never the same test twice.
    //
    // Two conditions rather than one. "No longer on the blank document" is what
    // separates the requested page from the target's initial one — `readyState`
    // alone is already `complete` on `about:blank`, so it would be satisfied by
    // the document that is not the page. "Not still loading" is what makes a
    // script-defined global safe to touch once it is. `about:blank` is the one URL
    // where the first half can never come true, so it is asked for by itself, and
    // it is already parsed — the wait returns at once rather than being skipped.
    //
    // A page that fails to load is not this function's failure: the URL is still
    // the one that was requested, so the wait completes and the caller's own wait
    // reports what is actually wrong with the document.
    await waitFor(options.url === 'about:blank'
      ? 'document.readyState !== "loading"'
      : 'location.href !== "about:blank" && document.readyState !== "loading"')

    return {
      evaluate,
      waitFor,
      injectOnNewDocument: async (source) => {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
      },
      setViewport: async (width, height) => {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: 1, mobile: false,
        }, sessionId)
      },
      screenshot: async () => {
        const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png', optimizeForSpeed: true, fromSurface: true,
        }, sessionId)
        return Buffer.from(shot.data, 'base64')
      },
      navigate: async (url) => {
        await cdp.send('Page.navigate', { url }, sessionId)
        await waitFor('document.readyState === "complete"')
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
