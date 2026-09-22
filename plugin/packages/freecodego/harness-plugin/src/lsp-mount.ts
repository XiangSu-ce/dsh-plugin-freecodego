/**
 * Probe-based LSP auto-mount: attach the core LSP stack (`dsh-lsp` seam +
 * `dsh-lsp-stdio` providers + `dsh-tool-lsp` model tool) only when candidate
 * language-server executables actually resolve on PATH.
 *
 * The stock `lsp-stdio` plugin fails loud at load when a configured server
 * executable is missing, so an unconditional bundle mount would break boot for
 * users without language servers. Here we probe first, mount what exists, and
 * skip the whole stack when nothing does — boot is never blocked, and a
 * runtime `subprocess` service is required only after a positive probe.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/lsp-mount
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FreeCodeGoLspMountStatus, FreeCodeGoLspMountServer } from './types.ts'

/** One probe candidate: filesystem extensions → LSP language ids. */
interface LspCandidate {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly extensionToLanguage: Readonly<Record<string, string>>
}

const TS = { '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' }
const PY = { '.py': 'python', '.pyi': 'python' }
const GO = { '.go': 'go' }

/** Probed in order; the first hit per extension family wins. */
const CANDIDATES: readonly LspCandidate[] = [
  // typescript-language-server needs a tsserver binary on PATH.
  { id: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensionToLanguage: TS },
  { id: 'pyright', command: 'pyright-langserver', args: ['--stdio'], extensionToLanguage: PY },
  { id: 'gopls', command: 'gopls', args: [], extensionToLanguage: GO },
]

/** Subprocess surface used for probing (mirrors the core service). */
export interface LspSubprocessLike {
  readonly resolveExecutable: (command: string, env?: Record<string, string>, signal?: AbortSignal) => Promise<unknown>
}

/** What a caller gets back from installing the LSP mount. */
export interface LspMountDeps {
  /** Probe lazily and cache; return the live mount state. */
  readonly status: () => Promise<FreeCodeGoLspMountStatus>
}

/** Minimal mount surface: satisfied by the real Context and by test doubles. */
interface LspRuntimeLike {
  readonly plugin: (definition: unknown, config?: unknown) => Promise<unknown>
  readonly effect: (dispose: () => void, name?: string) => void
  readonly subprocess: LspSubprocessLike | undefined
}

/** Probes for language servers and mounts the LSP stack when any are found. */
export class FreeCodeGoLspMount {
  private probePromise?: Promise<FreeCodeGoLspMountStatus>
  private mounted = false
  private cachedStatus?: FreeCodeGoLspMountStatus

  constructor(private readonly ctx: LspRuntimeLike, private readonly settings: { get(): unknown } | undefined) {}

  /** Probe PATH once and mount the stack when servers exist. Fails soft. 
   * @returns the lsp Mount Status.
   */
  async status(): Promise<FreeCodeGoLspMountStatus> {
    this.probePromise ??= this.probeAndMount()
    return this.probePromise
  }

  private enabled(): boolean {
    const settings = this.settings?.get() as { lspEnabled?: boolean } | undefined
    return settings?.lspEnabled !== false
  }

  private async probeAndMount(): Promise<FreeCodeGoLspMountStatus> {
    if (!this.enabled()) {
      this.cachedStatus = { enabled: false, mounted: false, servers: [] }
      return this.cachedStatus
    }
    const results: FreeCodeGoLspMountServer[] = []
    for (const candidate of CANDIDATES) {
      // A missing subprocess service means "cannot probe", never "available".
      let available = false
      if (this.ctx.subprocess !== undefined) {
        try {
          await this.ctx.subprocess.resolveExecutable(candidate.command)
          available = true
        } catch {
          available = false
        }
      }
      results.push({ id: candidate.id, command: candidate.command, available })
    }
    const servers = results.filter(candidate => candidate.available)
    if (servers.length === 0) {
      this.cachedStatus = { enabled: true, mounted: false, servers: results }
      return this.cachedStatus
    }
    try {
      await this.mount(CANDIDATES.filter(candidate => results.find(result => result.id === candidate.id)?.available === true))
      this.mounted = true
      this.cachedStatus = { enabled: true, mounted: true, servers: results }
    } catch (error) {
      this.cachedStatus = { enabled: true, mounted: false, servers: results, error: error instanceof Error ? error.message : String(error) }
    }
    return this.cachedStatus
  }

  /** Mount `Lsp` → `lsp-stdio` → `tool-lsp` in dependency order, fail-soft. */
  private async mount(candidates: readonly LspCandidate[]): Promise<void> {
    // Source-level dynamic imports keep the heavy LSP graph out of the plugin's
    // static import table; the packages stay declared dependencies so the
    // bundler can still resolve them.
    const Lsp = (await import('@deepseek-ai/dsh-lsp')).default
    await this.ctx.plugin(Lsp)
    const servers: Record<string, object> = {}
    for (const candidate of candidates) {
      servers[candidate.id] = {
        command: candidate.command,
        args: [...candidate.args],
        extensionToLanguage: { ...candidate.extensionToLanguage },
      }
    }
    const { apply: applyLspStdio } = await import('@deepseek-ai/dsh-lsp-stdio')
    await this.ctx.plugin({ name: 'freecodego-lsp-stdio', inject: ['fs', 'lsp', 'subprocess'], apply: applyLspStdio }, { servers })
    const { apply: applyToolLsp } = await import('@deepseek-ai/dsh-tool-lsp')
    await this.ctx.plugin({ name: 'freecodego-tool-lsp', inject: ['tools', 'lsp', 'systemPrompt'], apply: applyToolLsp }, {})
    this.ctx.effect(() => { this.mounted = false }, 'freecodego: LSP stack disposed')
  }

  /** Synchronous last-known state for status remotes. 
   * @returns the lsp Mount Status.
   */
  snapshot(): FreeCodeGoLspMountStatus {
    return this.cachedStatus ?? { enabled: this.enabled(), mounted: this.mounted, servers: [] }
  }
}

/** Install the probe-based LSP mount (status-only until a session asks). 
 * @param ctx - context carrying the services this call reads.
 * @param settings - the settings scope that decides whether the mount is wanted.
 * @returns the lsp Mount Deps.
 */
export function installFreeCodeGoLspMount(ctx: Context, settings: { get(): unknown } | undefined): LspMountDeps {
  const runtime = ctx as unknown as LspRuntimeLike
  const mount = new FreeCodeGoLspMount(runtime, settings)
  return { status: () => mount.status() }
}
