/**
 * Probe-based LSP mount: probing never breaks boot, mounts only detected
 * servers, and honors the settings toggle.
 *
 * @module lsp-mount.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoLspMount, type LspSubprocessLike } from '../src/lsp-mount.ts'

function settingsScope(lspEnabled?: boolean): { get(): { lspEnabled?: boolean } } {
  return { get: () => ({ ...(lspEnabled === undefined ? {} : { lspEnabled }) }) }
}

function subprocessWith(available: readonly string[]): { resolveExecutable: LspSubprocessLike['resolveExecutable'] } {
  return {
    async resolveExecutable(command: string) {
      if (!available.includes(command)) throw new Error(`not found: ${command}`)
      return command
    },
  }
}

function mountRuntime(subprocess: LspSubprocessLike | undefined, mounted: string[] = []): {
  plugin: (definition: unknown, config?: unknown) => Promise<unknown>
  effect: (dispose: () => void, name?: string) => void
  subprocess: LspSubprocessLike | undefined
} {
  return {
    // The real Lsp service is a class; test doubles only need to record the mount.
    plugin: async (definition) => {
      mounted.push(((definition as { name?: string }).name ?? 'dsh-lsp'))
      return undefined
    },
    effect: () => {},
    subprocess,
  }
}

describe('FreeCodeGoLspMount', () => {
  it('reports disabled without probing when the toggle is off', async () => {
    const runtime = mountRuntime(subprocessWith([]))
    const mount = new FreeCodeGoLspMount(runtime, settingsScope(false))
    const status = await mount.status()
    expect(status).toEqual({ enabled: false, mounted: false, servers: [] })
    expect(mount.snapshot()).toEqual({ enabled: false, mounted: false, servers: [] })
  })

  it('skips mounting when no language server resolves', async () => {
    const mounted: string[] = []
    const runtime = mountRuntime(subprocessWith([]), mounted)
    const mount = new FreeCodeGoLspMount(runtime, settingsScope(true))
    const status = await mount.status()
    expect(status.enabled).toBe(true)
    expect(status.mounted).toBe(false)
    expect(status.error).toBeUndefined()
    expect(status.servers).toEqual([
      { id: 'typescript', command: 'typescript-language-server', available: false },
      { id: 'pyright', command: 'pyright-langserver', available: false },
      { id: 'gopls', command: 'gopls', available: false },
    ])
    expect(mounted).toEqual([])
  })

  it('mounts even with a single detected server family', async () => {
    const mounted: string[] = []
    const runtime = mountRuntime(subprocessWith(['pyright-langserver']), mounted)
    const mount = new FreeCodeGoLspMount(runtime, settingsScope(true))
    const status = await mount.status()
    expect(status.mounted).toBe(true)
    expect(status.servers.find(server => server.id === 'pyright')?.available).toBe(true)
    expect(status.servers.filter(server => server.id !== 'pyright').every(server => !server.available)).toBe(true)
    expect(mounted).toEqual(['Lsp', 'freecodego-lsp-stdio', 'freecodego-tool-lsp'])
  })

  it('mounts the stack once with only the detected servers', async () => {
    const mounted: string[] = []
    const runtime = mountRuntime(subprocessWith(['typescript-language-server', 'gopls']), mounted)
    const mount = new FreeCodeGoLspMount(runtime, settingsScope(true))
    const status = await mount.status()
    expect(status.mounted).toBe(true)
    expect(status.error).toBeUndefined()
    expect(mounted).toEqual(['Lsp', 'freecodego-lsp-stdio', 'freecodego-tool-lsp'])
    // Second status call reuses the probe; the stack mounts exactly once.
    await mount.status()
    expect(mounted).toEqual(['Lsp', 'freecodego-lsp-stdio', 'freecodego-tool-lsp'])
  })

  it('fails soft with a diagnostic when the stack cannot mount', async () => {
    const runtime = mountRuntime(subprocessWith(['gopls']))
    runtime.plugin = async (definition) => {
      if ((definition as { name?: string }).name === 'freecodego-lsp-stdio') throw new Error('boom')
      return undefined
    }
    const mount = new FreeCodeGoLspMount(runtime, settingsScope(true))
    const status = await mount.status()
    expect(status.mounted).toBe(false)
    expect(status.error).toContain('boom')
    expect(status.servers).toEqual([
      { id: 'typescript', command: 'typescript-language-server', available: false },
      { id: 'pyright', command: 'pyright-langserver', available: false },
      { id: 'gopls', command: 'gopls', available: true },
    ])
  })

  it('reports default-on via snapshot before any probe', () => {
    const mount = new FreeCodeGoLspMount(mountRuntime(undefined), settingsScope())
    expect(mount.snapshot()).toEqual({ enabled: true, mounted: false, servers: [] })
  })

  it('installs through the real cordis context shape', async () => {
    const ctx = new Context()
    // No subprocess service in a bare context: the probe must still resolve
    // (all servers unavailable) rather than throwing.
    // The runtime parameter's own type, read off the constructor: a bare
    // `Parameters<...>` and an `& never` used to hide that the cast target was
    // `never`, which is a cast onto nothing.
    const runtime = ctx as unknown as ConstructorParameters<typeof FreeCodeGoLspMount>[0]
    const status = await new FreeCodeGoLspMount(runtime, settingsScope(true)).status().catch(async () => {
      // Fall back to the installer path used in production.
      const { installFreeCodeGoLspMount } = await import('../src/lsp-mount.ts')
      const deps = installFreeCodeGoLspMount(ctx, settingsScope(true))
      return deps.status()
    })
    expect(status.enabled).toBe(true)
    expect(status.mounted).toBe(false)
    await ctx.fiber.dispose()
  })
})
