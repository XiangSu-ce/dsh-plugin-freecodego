/**
 * The live preview servers, and the lifetime they have outside one tool call.
 *
 * A `render` or a `snapshot` opens a browser, takes what it needs, and closes
 * everything before it returns. A preview cannot work that way: its whole point
 * is that a *person* opens the URL and looks at the composition, which happens
 * after the tool call has ended. So the server has to outlive the call that
 * started it, and something has to own it — which is this class.
 *
 * Three rules it exists to enforce:
 *
 * 1. **One server per composition.** A second `preview` on the same file
 *    replaces the first rather than adding a second listener, so a model that
 *    calls the tool twice does not leave two ports holding two stale copies of
 *    the project.
 * 2. **The bytes are a snapshot, taken when the tool ran.** Nothing watches the
 *    filesystem, so an edit made after the call is *not* picked up. That is
 *    stated rather than fixed: a watcher would mean reading files the composition
 *    names without the user asking again, and re-reading a path the model chose
 *    is exactly the door this pack keeps shut.
 * 3. **Teardown is not optional.** The servers are released when the pack is
 *    switched off or the plugin unloads, because a loopback listener that
 *    outlives its owner is a port nobody will ever close.
 *
 * @module design/preview-host
 */

import { serveDesignDocument, type DesignPreviewAsset, type DesignPreviewServer } from './preview-server.ts'

/** A running preview, as the caller sees it. */
export interface DesignPreviewSession {
  /** The URL to open. Loopback only, so it is the user's own machine. */
  readonly url: string
  readonly origin: string
  /** When this server started serving, in epoch milliseconds. */
  readonly startedAt: number
}

/** What to serve. */
export interface DesignPreviewRequest {
  /** Identifies the composition. Reusing a key replaces that server. */
  readonly key: string
  readonly html: string
  readonly assets?: ReadonlyMap<string, DesignPreviewAsset>
}

/** One owned server. */
interface OwnedPreview {
  readonly server: DesignPreviewServer
  readonly startedAt: number
}

/** Owns the preview servers for as long as the design tools are registered. */
export class DesignPreviewHost {
  private readonly previews = new Map<string, OwnedPreview>()
  /** Serializes start/stop so two concurrent calls cannot both create a server
   *  for one key, which would leak the loser's listener. */
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    // The chain must survive a rejected task, or every later preview would
    // inherit that rejection instead of running.
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * Serve one composition, replacing any server already serving that key.
   *
   * @param request - the document and the assets it fetches.
   * @returns the URL to open.
   */
  start(request: DesignPreviewRequest): Promise<DesignPreviewSession> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('the design preview host is shut down')
      await this.replace(request.key)
      const server = await serveDesignDocument({
        html: request.html,
        ...(request.assets === undefined ? {} : { assets: request.assets }),
      })
      const startedAt = Date.now()
      this.previews.set(request.key, { server, startedAt })
      return { url: `${server.origin}/`, origin: server.origin, startedAt }
    })
  }

  /** Close the server for a key, if one is running. @returns whether there was one. */
  stop(key: string): Promise<boolean> {
    return this.enqueue(async () => this.replace(key))
  }

  /** The keys with a server currently serving. */
  running(): readonly string[] {
    return [...this.previews.keys()]
  }

  /** Close every server. Safe to call twice. */
  dispose(): Promise<void> {
    return this.enqueue(async () => {
      this.closed = true
      const existing = [...this.previews.values()]
      this.previews.clear()
      // Both afterwards rather than one at a time: they share no state, and
      // closing them in sequence would make the last one wait on the first.
      await Promise.all(existing.map(entry => entry.server.close().catch(() => undefined)))
    })
  }

  /** Close and forget one key. */
  private async replace(key: string): Promise<boolean> {
    const existing = this.previews.get(key)
    if (existing === undefined) return false
    this.previews.delete(key)
    await existing.server.close().catch(() => undefined)
    return true
  }
}
