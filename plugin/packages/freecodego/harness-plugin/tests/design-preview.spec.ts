/**
 * The preview tool and the servers it owns.
 *
 * A preview is the one design tool whose effect is supposed to outlive its call,
 * which makes lifetime the whole subject here: one server per composition rather
 * than one per call, a replacement that closes the server it displaces, a
 * stand-down that closes the last one, and a tool-call return that does *not*
 * close anything — because a preview that shut its own port as it returned would
 * be a URL the user can never open.
 *
 * The requests go to a real loopback listener rather than to a stubbed one. That
 * is the claim being made — a URL a person can open — and a double would agree
 * with whatever this module believes about `serveDesignDocument`.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import { DesignPreviewHost } from '../src/design/preview-host.ts'
import { DEFAULT_RESULT_PATH, serveDesignDocument } from '../src/design/preview-server.ts'
import { registerDesignTools } from '../src/design/tools.ts'

/** The host answers at its own origin, so a fetch is the assertion. */
async function textAt(url: string): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(url)
  return { status: response.status, body: await response.text() }
}

describe('DesignPreviewHost', () => {
  it('serves the document on loopback and keeps it serving after the call returns', async () => {
    const host = new DesignPreviewHost()
    try {
      const session = await host.start({ key: 'a.html', html: '<h1>one</h1>' })
      expect(session.url.startsWith('http://127.0.0.1:')).toBe(true)
      expect((await textAt(session.url)).body).toContain('one')
      // Still serving: nothing about returning from `start` closed it, which is
      // the property a preview exists for.
      expect((await textAt(session.url)).status).toBe(200)
      expect(host.running()).toEqual(['a.html'])
    } finally {
      await host.dispose()
    }
  })

  it('replaces the server for one composition instead of adding a second', async () => {
    const host = new DesignPreviewHost()
    try {
      const first = await host.start({ key: 'a.html', html: '<h1>one</h1>' })
      const second = await host.start({ key: 'a.html', html: '<h1>two</h1>' })
      // The new bytes are what is served — the snapshot is taken at the call, and
      // a second call is how an edit reaches the preview.
      expect((await textAt(second.url)).body).toContain('two')
      // And the displaced listener is gone rather than quietly holding a port.
      await expect(fetch(first.url)).rejects.toThrow()
      expect(host.running()).toEqual(['a.html'])
    } finally {
      await host.dispose()
    }
  })

  it('keeps two compositions apart', async () => {
    const host = new DesignPreviewHost()
    try {
      const one = await host.start({ key: 'a.html', html: '<h1>one</h1>' })
      const two = await host.start({ key: 'b.html', html: '<h1>two</h1>' })
      expect(one.origin).not.toBe(two.origin)
      expect((await textAt(one.url)).body).toContain('one')
      expect((await textAt(two.url)).body).toContain('two')
      expect(host.running()).toEqual(['a.html', 'b.html'])
    } finally {
      await host.dispose()
    }
  })

  it('releases one composition and reports whether there was one to release', async () => {
    const host = new DesignPreviewHost()
    try {
      const session = await host.start({ key: 'a.html', html: '<h1>one</h1>' })
      expect(await host.stop('a.html')).toBe(true)
      await expect(fetch(session.url)).rejects.toThrow()
      // Asked twice: the second answer is `false`, and a preview that claimed to
      // stop something that was not running would be inventing an effect.
      expect(await host.stop('a.html')).toBe(false)
      expect(host.running()).toEqual([])
    } finally {
      await host.dispose()
    }
  })

  it('closes every server on dispose, and refuses to start another', async () => {
    const host = new DesignPreviewHost()
    const one = await host.start({ key: 'a.html', html: '<h1>one</h1>' })
    const two = await host.start({ key: 'b.html', html: '<h1>two</h1>' })
    await host.dispose()
    await expect(fetch(one.url)).rejects.toThrow()
    await expect(fetch(two.url)).rejects.toThrow()
    await expect(host.start({ key: 'c.html', html: '<h1>three</h1>' })).rejects.toThrow(/shut down/u)
    // Twice, because the pack's teardown and the plugin's unload both reach it.
    await expect(host.dispose()).resolves.toBeUndefined()
  })

  it('hands a posted result back to the caller waiting for it', async () => {
    // The render path's whole handshake, and the one thing about it that cannot
    // be re-derived from the code: the listener has to be armed before the page
    // posts, because there is no second chance to be listening.
    const server = await serveDesignDocument({ html: '<h1>render</h1>' })
    try {
      const awaited = server.awaitResult(5_000)
      const response = await fetch(`${server.origin}${DEFAULT_RESULT_PATH}`, { method: 'POST', body: Buffer.from([1, 2, 3]) })
      expect(response.status).toBe(204)
      expect([...await awaited]).toEqual([1, 2, 3])
    } finally {
      await server.close()
    }
  })

  it('answers a waiter when it closes, instead of leaving it to its deadline', async () => {
    // A render that failed before its page could post used to leave this promise
    // pending for the whole two-minute deadline, with the timer holding the
    // process open after the render was over. Closing is the event that ends the
    // wait, so the wait has to end when it closes.
    const server = await serveDesignDocument({ html: '<h1>render</h1>' })
    const awaited = server.awaitResult(120_000)
    // Attached before the close, so the rejection has a handler from the moment
    // it exists — which is also what the render path does.
    const refused = expect(awaited).rejects.toThrow(/closed before the page posted/u)
    const started = Date.now()
    await server.close()
    await refused
    // Not the deadline: the rejection is what closing produced.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('refuses a GET on the result path, which would otherwise be read as an empty file', async () => {
    const server = await serveDesignDocument({ html: '<h1>render</h1>' })
    try {
      const response = await fetch(`${server.origin}${DEFAULT_RESULT_PATH}`)
      expect(response.status).toBe(405)
    } finally {
      await server.close()
    }
  })

  it('serializes concurrent starts for one key, so only one listener survives', async () => {
    const host = new DesignPreviewHost()
    try {
      const [first, second] = await Promise.all([
        host.start({ key: 'a.html', html: '<h1>one</h1>' }),
        host.start({ key: 'a.html', html: '<h1>two</h1>' }),
      ])
      expect(host.running()).toEqual(['a.html'])
      // Exactly one of the two origins answers. Asserted over the set of origins
      // rather than over the two URLs, because the OS is free to hand the
      // replacement the port the first one just released — in which case they are
      // one origin, and one answer is still the correct count.
      const alive = await Promise.all([...new Set([first.origin, second.origin])].map(
        async origin => fetch(`${origin}/`).then(() => true, () => false),
      ))
      expect(alive.filter(Boolean)).toHaveLength(1)
      // The last start owns the key, and its bytes are what is served.
      expect(await fetch(second.url).then(response => response.text())).toContain('two')
    } finally {
      await host.dispose()
    }
  })
})

describe('the preview tool', () => {
  /** A ctx with a tools service and a file service, over an in-memory tree. */
  function world(files: Readonly<Record<string, string>>): {
    readonly ctx: { get(name: string): unknown }
    readonly tools: Map<string, { execute?: (args: never, exec: never) => Promise<unknown> }>
  } {
    const tools = new Map<string, { execute?: (args: never, exec: never) => Promise<unknown> }>()
    return {
      tools,
      ctx: {
        get: (name: string) => {
          if (name === 'tools') {
            return {
              register: (tool: { readonly name?: string; execute?: (args: never, exec: never) => Promise<unknown> }) => {
                if (tool.name !== undefined) tools.set(tool.name, tool)
                return () => undefined
              },
            }
          }
          if (name === 'fs') {
            return {
              resolve: async (path: string) => path,
              readText: async (target: unknown) => {
                const text = files[String(target)]
                if (text === undefined) throw new Error(`ENOENT: ${String(target)}`)
                return text
              },
              readBytes: async () => undefined,
            }
          }
          return undefined
        },
      },
    }
  }

  const COMPOSITION = [
    '<div data-composition-id="intro" data-width="640" data-height="360">',
    '<div class="clip" data-start="0" data-duration="4" data-track-index="0"></div>',
    '</div>',
  ].join('\n')

  it('serves the composition, answers the timeline, and stops on request', async () => {
    const target = world({ 'C:/work/compositions/intro.html': COMPOSITION })
    const result = registerDesignTools({ ctx: target.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_preview'])
    expect(result.registered).toEqual(['freecodego_design_preview'])
    const execute = target.tools.get('freecodego_design_preview')!.execute!
    const exec = { agent: { session: { header: { cwd: 'C:/work' } } } } as never

    try {
      const served = await execute({ path: 'compositions/intro.html' } as never, exec) as {
        readonly serving: boolean
        readonly resolvedPath: string
        readonly url: string
        readonly compositions: readonly { readonly id: string }[]
        readonly tracks: readonly unknown[]
      }

      // The key a preview is addressed by is the resolved path, and the report
      // says which one that was — so a later `stop` that finds nothing can be
      // read rather than guessed at.
      expect(served.resolvedPath).toBe('C:/work/compositions/intro.html')

      expect(served.serving).toBe(true)
      // The read half of upstream's `timeline`: from the same source text the
      // renderer would use, so the two cannot describe different projects.
      expect(served.compositions.map(composition => composition.id)).toEqual(['intro'])
      expect(served.tracks).toHaveLength(1)

      // The URL is real: the path resolved against the session cwd is what the
      // file service was handed.
      expect((await textAt(served.url)).body).toContain('data-composition-id="intro"')

      const stopped = await execute({ path: 'compositions/intro.html', stop: true } as never, exec) as { readonly serving: boolean; readonly stopped: boolean }
      expect(stopped.serving).toBe(false)
      expect(stopped.stopped).toBe(true)
      await expect(fetch(served.url)).rejects.toThrow()
    } finally {
      await disposeAll(result.registrations)
    }
  })

  it('closes its listeners when the registration set is disposed', async () => {
    const target = world({ 'C:/work/intro.html': COMPOSITION })
    const result = registerDesignTools({ ctx: target.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_preview'])
    const execute = target.tools.get('freecodego_design_preview')!.execute!
    const served = await execute({ path: 'C:/work/intro.html' } as never, {} as never) as { readonly url: string }
    expect((await textAt(served.url)).status).toBe(200)

    // Standing the feature down withdraws the tools; a listener left behind would
    // be a port with no owner.
    await disposeAll(result.registrations)
    await expect(fetch(served.url)).rejects.toThrow()
  })

  it('refuses a composition it cannot read, and says which path it tried', async () => {
    const target = world({})
    const result = registerDesignTools({ ctx: target.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_preview'])
    const execute = target.tools.get('freecodego_design_preview')!.execute!
    await expect(execute({ path: 'gone.html' } as never, { agent: { session: { header: { cwd: 'C:/work' } } } } as never))
      .rejects.toThrow(/Could not read the composition at "C:\/work\/gone.html"/u)
    await disposeAll(result.registrations)
  })

  it('stops a preview even after the composition is unreadable', async () => {
    // Stopping addresses a server, not a file. A user who deleted the
    // composition between starting a preview and stopping it still has a port to
    // release, and requiring the source to be readable would leave no way to
    // release it.
    const files: Record<string, string> = { 'C:/work/intro.html': COMPOSITION }
    const target = world(files)
    const result = registerDesignTools({ ctx: target.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_preview'])
    const execute = target.tools.get('freecodego_design_preview')!.execute!
    const exec = { agent: { session: { header: { cwd: 'C:/work' } } } } as never
    try {
      const served = await execute({ path: 'C:/work/intro.html' } as never, exec) as { readonly url: string }
      delete files['C:/work/intro.html']
      const stopped = await execute({ path: 'C:/work/intro.html', stop: true } as never, exec) as { readonly stopped: boolean }
      expect(stopped.stopped).toBe(true)
      await expect(fetch(served.url)).rejects.toThrow()
    } finally {
      await disposeAll(result.registrations)
    }
  })
})

/**
 * Dispose a registration list the way the registry does, but awaiting the
 * teardown: a test that asserts a port is closed has to wait for the close, and
 * the registry's own teardown ignores the promise because it has nowhere to put
 * the wait.
 *
 * The local type admits a promise from `dispose`, which is what this module's
 * preview handle returns.
 */
type RegistrationHandle = (() => void) | { dispose?: () => void | Promise<void> }

async function disposeAll(registrations: readonly RegistrationHandle[]): Promise<void> {
  for (const registration of registrations) {
    if (typeof registration === 'function') registration()
    else await registration.dispose?.()
  }
}
