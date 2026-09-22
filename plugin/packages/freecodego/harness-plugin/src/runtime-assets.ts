import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Where the Codex worker lands inside its own package.
 *
 * Mirrors `exports["./worker"]` in `runtime-codex/package.json`. The extension is
 * `.mjs`, not `.js`: that package builds with `fixedExtension: true`, and a stale
 * `.js` left over from an earlier config sits beside the current output — naming
 * the stale one spawns a day-old worker with no visible symptom.
 * `runtime-assets.spec.ts` asserts this against the manifest so the two cannot
 * drift apart again.
 */
export const CODEX_WORKER_SUBPATH = 'packages/freecodego/runtime-codex/lib/worker.mjs'

/** Resolve the Codex worker entry point, preferring the installed package and falling back to the packaged path.
 * @returns the worker module path.
 */
export function requireRuntimeWorkerPath(): string {
  const require = createRequire(import.meta.url)
  try { return require.resolve('@deepseek-ai/dsh-freecodego-runtime-codex/worker') }
  catch {
    return packagedWorkerPath('codex-worker.js')
      ?? path.resolve(process.cwd(), CODEX_WORKER_SUBPATH)
  }
}

/**
 * Locate the Claude driver manifest the native runtime host pins its identity to.
 *
 * This replaced `requireClaudeWorkerPath()` when the sidecar transport was
 * deleted. The path still matters: `ClaudeRuntimeManager.identity()` reads the
 * Agent SDK version out of this manifest and folds its bytes into the installed
 * runtime's `artifactDigest`, so the digest changes when the driver SDK is
 * repinned — which is what makes a durable session plan reject a mismatched
 * runtime instead of resuming under it.
 * @returns the Claude driver manifest path.
 */
export function requireClaudeEngineManifestPath(): string {
  const require = createRequire(import.meta.url)
  try { return require.resolve('@deepseek-ai/dsh-freecodego-runtime-claude/package.json') }
  catch {
    return path.resolve(process.cwd(), 'packages/freecodego/runtime-claude/package.json')
  }
}

/** Resolve workers bundled beside the single public FreeCodeGo artifact.
 * @param file - the worker filename to look for.
 * @returns the adjacent worker path, or `undefined` when none is bundled.
 */
export function packagedWorkerPath(file: string): string | undefined {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(moduleDirectory, 'workers', file),
    path.join(moduleDirectory, '..', 'workers', file),
    path.join(moduleDirectory, '..', 'dist', 'workers', file),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

/** The PATH delimiter this host uses. */
function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

/**
 * Comparison key for a single PATH entry.
 *
 * `===` on `path.resolve` alone misses two spellings that name the same
 * directory. Windows PATH entries are routinely written quoted, and
 * `path.resolve('"C:\\x"')` yields `<cwd>\"C:\x"` — a path that matches nothing,
 * so the dedupe never fired and a duplicate was prepended ahead of the
 * original. Windows also compares paths case-insensitively, which `resolve`
 * does not fold. Both are normalised here; a trailing separator needs no help,
 * `path.resolve` already strips it.
 */
function pathEntryKey(value: string): string {
  const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
  const resolved = path.resolve(unquoted)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Shim directories this process has published onto PATH, keyed by
 * `pathEntryKey` so a later call can recognise and drop the one it published
 * before.
 *
 * `$DSH_HOME` is not fixed for the lifetime of a process — the harness resolves
 * it per read, and this plugin's own eval harness rewrites it in-process
 * (`engineering-eval.ts`, `preset.honours-an-overridden-home`). Without this
 * set, a second call for a different home prepends a new directory while the
 * old home's directory stays on PATH ahead of it: the terminal resolves `dsh`
 * out of a home the Desktop is no longer using, and PATH grows by one entry per
 * home per call.
 */
const publishedShimDirectories = new Set<string>()

/**
 * Make `shimDir` the leading PATH entry, and the only entry naming a shim this
 * process published.
 *
 * Split out from the write so the PATH rule is reachable and pinnable on its
 * own: in a checkout where `@deepseek-ai/dsh` is not installed the write below
 * throws before ever reaching this line, which is exactly the case where the
 * PATH contract still has to be provably right.
 * @param shimDir - the shim directory to publish as the leading PATH entry.
 */
export function publishDesktopShimOnPath(shimDir: string): void {
  const delimiter = pathDelimiter()
  const shimKey = pathEntryKey(shimDir)
  // Drop this shim directory wherever it already sits, so the fresh one leads
  // and cannot be duplicated; drop every directory published for a home this
  // process has since left behind, so a stale home cannot keep winning.
  const kept = (process.env.PATH ?? '').split(delimiter).filter(Boolean).filter((value) => {
    const key = pathEntryKey(value)
    return key !== shimKey && !publishedShimDirectories.has(key)
  })
  publishedShimDirectories.add(shimKey)
  // Joined rather than string-templated: the template form leaves a trailing
  // delimiter when nothing was kept, and on Windows a trailing delimiter
  // re-adds the current directory to the command search path.
  process.env.PATH = [shimDir, ...kept].join(delimiter)
}

/**
 * The directory the desktop shim is published into for a configured
 * `$DSH_HOME`.
 *
 * Resolved through the harness's own home resolver rather than joined onto the
 * raw variable. `DSH_HOME=~/harness` is a supported configuration, and
 * `path.join('~/harness', '.desktop-bin')` names a literal `~` directory *under
 * the process's current working directory*: a shim the user never sees, in a
 * tree that is not the home the running Desktop reads, and one that cannot be
 * created at all when the harness was launched from a read-only directory.
 * `data-home.ts` documents this same defect being removed from the plugin's
 * other paths; this was the one path that still had it.
 * @param home - the configured `$DSH_HOME` value.
 * @returns the resolved shim directory for that home.
 */
export function desktopDshShimDirectory(home: string): string {
  return path.join(resolveDshHome(home), '.desktop-bin')
}

/**
 * Desktop's embedded web terminal inherits the Harness process environment,
 * not the private command shims created for the standalone Desktop terminal.
 * Publish a small profile-local `dsh` shim so commands entered in that
 * terminal use the same DSH_HOME and active Profile as the running Desktop.
 *
 * Mutating `process.env.PATH` is the contract, not a side effect: inheriting
 * the environment is the only channel the embedded terminal has, so a shim that
 * is written but never published is a shim nothing can find. That makes the
 * PATH rule load bearing — PATH must name the current home's shim, and exactly
 * one of it — and it makes a failure here something the user has to be able to
 * read about, because the symptom is a terminal that cannot resolve `dsh` and
 * no other trace of why.
 */
export function ensureDesktopDshShim(): void {
  const home = process.env.DSH_HOME?.trim()
  if (home === undefined || home === '') return
  const shimDir = desktopDshShimDirectory(home)
  try {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
    mkdirSync(shimDir, { recursive: true, mode: 0o700 })
    const node = process.execPath
    const shimPath = path.join(shimDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    const content = process.platform === 'win32'
      ? `@echo off\r\n"${node.replaceAll('"', '""')}" "${entry.replaceAll('"', '""')}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nexec '${node.replaceAll("'", '\'"\'"\'')}' '${entry.replaceAll("'", '\'"\'"\'')}' "$@"\n`
    writeFileSync(shimPath, content, { encoding: 'utf8', mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(shimPath, 0o700)
    publishDesktopShimOnPath(shimDir)
  } catch (error) {
    // Desktop integration is optional; never prevent the Harness from booting.
    // It is not, however, invisible: swallowing this silently leaves the user's
    // `dsh` shim missing with nothing anywhere to say why the embedded terminal
    // cannot find it. Collapsed to one line — a host log is read as records, and
    // a require failure's own message carries a multi-line stack.
    const reason = String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ')
    console.warn(`[freecodego] the desktop \`dsh\` shim could not be published under ${shimDir}, so commands entered in the embedded terminal will not resolve it: ${reason}`)
  }
}
