/**
 * The worker path the Host falls back to must be the file `runtime-codex`
 * actually ships.
 *
 * This is the probe for a silent failure, not a cosmetic one: the package builds
 * with `fixedExtension: true`, so its entry is `lib/worker.mjs`, while a stale
 * `lib/worker.js` from an earlier config sits beside it. Naming the stale file
 * spawns a day-old worker and nothing in the transcript says so. Keeping the
 * constant tied to the manifest is what makes that impossible.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_WORKER_SUBPATH,
  desktopDshShimDirectory,
  ensureDesktopDshShim,
  publishDesktopShimOnPath,
} from '../src/runtime-assets.ts'

const testsDirectory = dirname(fileURLToPath(import.meta.url))
// tests -> harness-plugin -> freecodego -> packages -> repository root.
const repositoryRoot = resolve(testsDirectory, '..', '..', '..', '..')
const codexDirectory = resolve(testsDirectory, '..', '..', 'runtime-codex')

const manifest = JSON.parse(
  readFileSync(resolve(codexDirectory, 'package.json'), 'utf8'),
) as { exports: Record<string, string> }

describe('CODEX_WORKER_SUBPATH', () => {
  it('names the same file runtime-codex exports as ./worker', () => {
    const declared = manifest.exports['./worker']
    if (declared === undefined) throw new Error('runtime-codex declares no "./worker" export')
    expect(resolve(repositoryRoot, CODEX_WORKER_SUBPATH))
      .toBe(resolve(codexDirectory, declared))
  })

  it('does not name the stale .js left beside the current .mjs output', () => {
    const resolved = resolve(repositoryRoot, CODEX_WORKER_SUBPATH)
    expect(resolved.endsWith('.mjs')).toBe(true)
    expect(resolved).not.toBe(resolve(codexDirectory, 'lib/worker.js'))
  })
})

/**
 * The desktop `dsh` shim reaches the embedded terminal through PATH and
 * nothing else, so the PATH rule is the whole contract: it must name the
 * current home's shim, and exactly one of it.
 *
 * `publishDesktopShimOnPath` is exercised directly rather than only through
 * `ensureDesktopDshShim`, and that is not a convenience. In a checkout where
 * `@deepseek-ai/dsh` is not installed — which is this one — `ensureDesktopDshShim`
 * throws at its first statement and every line after it is dead, so a spec that
 * went through it would be asserting on a function that never reached the PATH
 * code at all. The write is pinned separately below.
 */
describe('desktop dsh shim on PATH', () => {
  const delimiter = (): string => (process.platform === 'win32' ? ';' : ':')

  /** Run `body` with `process.platform` reporting `platform`, then restore it. */
  function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: platform })
    try { return body() } finally { if (original !== undefined) Reflect.defineProperty(process, 'platform', original) }
  }

  /** A PATH the caller owns, restored when `body` returns. */
  function withPath<T>(entries: string[], body: (delimiter: string) => T): T {
    const previous = process.env.PATH
    const separator = delimiter()
    process.env.PATH = entries.join(separator)
    try { return body(separator) } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  }

  /** A home directory unique to one test, removed when `body` returns. */
  function withHome<T>(label: string, body: (home: string) => T): T {
    const previous = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), `freecodego-dsh-shim-${label}-`))
    try { return body(home) } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }

  it('drops the shim published for the previous home when DSH_HOME moves', () => {
    withHome('move-a', (homeA) => {
      withHome('move-b', (homeB) => {
        const shimA = desktopDshShimDirectory(homeA)
        const shimB = desktopDshShimDirectory(homeB)
        const rest = [join(tmpdir(), 'freecodego-dsh-shim-existing-one'), join(tmpdir(), 'freecodego-dsh-shim-existing-two')]
        withPath(rest, (separator) => {
          publishDesktopShimOnPath(shimA)
          expect(process.env.PATH?.split(separator)[0]).toBe(shimA)
          publishDesktopShimOnPath(shimB)
          // The old home's shim must not survive ahead of the new one: the
          // terminal would resolve `dsh` out of a home the Desktop left.
          expect(process.env.PATH?.split(separator)).toEqual([shimB, ...rest])
        })
      })
    })
  })

  it('publishes the same shim directory once, however often it is called', () => {
    withHome('idempotent', (home) => {
      const shimDir = desktopDshShimDirectory(home)
      const rest = [join(tmpdir(), 'freecodego-dsh-shim-idempotent-rest')]
      withPath(rest, (separator) => {
        publishDesktopShimOnPath(shimDir)
        const first = process.env.PATH
        publishDesktopShimOnPath(shimDir)
        expect(process.env.PATH).toBe(first)
        expect(process.env.PATH?.split(separator)).toEqual([shimDir, ...rest])
      })
    })
  })

  it('recognises a quoted PATH entry as the shim directory it names', () => {
    withHome('quoted', (home) => {
      const shimDir = desktopDshShimDirectory(home)
      // A one-character entry and an unterminated quote pin the cheap half of
      // the quote test: neither is a quoted path, and neither may be stripped.
      const rest = ['"', '"unterminated', join(tmpdir(), 'freecodego-dsh-shim-quoted-rest')]
      withPath([`"${shimDir}"`, ...rest], (separator) => {
        publishDesktopShimOnPath(shimDir)
        // `path.resolve('"<dir>"')` is `<cwd>\"<dir>"` and matches nothing, so
        // the pre-fix dedupe missed and prepended a duplicate ahead of it.
        expect(process.env.PATH?.split(separator)).toEqual([shimDir, ...rest])
      })
    })
  })

  it('recognises a case-variant PATH entry as the shim directory it names', () => {
    withHome('case', (home) => {
      const shimDir = desktopDshShimDirectory(home)
      const rest = [join(tmpdir(), 'freecodego-dsh-shim-case-rest')]
      // Flipped before the PATH is built: the delimiter the source picks and the
      // one this test splits on have to be chosen under the same platform.
      withPlatform('win32', () => {
        withPath([shimDir.toUpperCase(), ...rest], (separator) => {
          // Windows compares PATH entries case-insensitively; `path.resolve`
          // does not fold case, so the pre-fix dedupe missed here too.
          expect(process.env.PATH?.split(separator)).toEqual([shimDir.toUpperCase(), ...rest])
          publishDesktopShimOnPath(shimDir)
          expect(process.env.PATH?.split(separator)).toEqual([shimDir, ...rest])
        })
      })
    })
  })

  it('leaves no trailing delimiter when there was no PATH to begin with', () => {
    withHome('empty-path', (home) => {
      const shimDir = desktopDshShimDirectory(home)
      const previous = process.env.PATH
      delete process.env.PATH
      try {
        publishDesktopShimOnPath(shimDir)
        // Not cosmetic: on Windows a trailing delimiter re-adds the current
        // directory to the command search path.
        expect(process.env.PATH).toBe(shimDir)
      } finally {
        if (previous === undefined) delete process.env.PATH
        else process.env.PATH = previous
      }
    })
  })

  it('resolves a `~` home through the harness resolver instead of the current directory', () => {
    // `path.join('~/harness', '.desktop-bin')` names a literal `~` directory
    // under the process's cwd — a shim the user never sees, in a tree that is
    // not the home the running Desktop reads.
    expect(desktopDshShimDirectory('~/freecodego-shim-probe')).toBe(join(homedir(), 'freecodego-shim-probe', '.desktop-bin'))
    expect(desktopDshShimDirectory('~')).toBe(join(homedir(), '.desktop-bin'))
  })

  it('reports where the shim could not be published instead of failing silently', () => {
    withHome('report', (home) => {
      // A file where the shim directory must go: the write cannot succeed, so
      // the only question is whether anything says so.
      const blocker = join(home, 'blocker')
      writeFileSync(blocker, 'not a directory')
      process.env.DSH_HOME = blocker
      const shimDir = desktopDshShimDirectory(blocker)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* captured */ })
      try {
        expect(() => { ensureDesktopDshShim() }).not.toThrow()
        expect(warn).toHaveBeenCalledTimes(1)
        const message = String(warn.mock.calls[0]?.[0])
        expect(message).toContain(shimDir)
        expect(message).toContain('dsh')
      } finally { warn.mockRestore() }
    })
  })
})
