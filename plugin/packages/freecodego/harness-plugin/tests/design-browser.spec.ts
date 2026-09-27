/**
 * The design engine's browser resolution chain.
 *
 * Each case is a machine this one is not, which is the whole reason the resolver takes
 * its world as an argument: the orderings that matter (Edge present and Chrome absent,
 * a configured path that no longer exists, a Playwright cache whose revision the engine
 * would not launch) cannot be produced on a developer's workstation on demand.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import { resolveDesignBrowser, type DesignBrowserProbes } from '../src/design/browser.ts'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/** A world where nothing exists unless it is named. */
function world(overrides: Partial<DesignBrowserProbes> & { readonly files?: readonly string[]; readonly directories?: Readonly<Record<string, readonly string[]>> }): DesignBrowserProbes {
  const files = new Set(overrides.files ?? [])
  const directories = overrides.directories ?? {}
  return {
    platform: overrides.platform ?? 'win32',
    exists: overrides.exists ?? ((path: string) => files.has(path)),
    listDirectory: overrides.listDirectory ?? ((directory: string) => {
      const entries = directories[directory]
      if (entries === undefined) throw new Error('ENOENT')
      return entries
    }),
    ...(overrides.appPath === undefined ? {} : { appPath: overrides.appPath }),
    env: overrides.env ?? {},
  }
}

describe('resolveDesignBrowser', () => {
  it('prefers Edge over Chrome on Windows', () => {
    // The platform reality: Edge is present on effectively every Windows install while
    // Chrome is only present when somebody installed it. Resolving Chrome first would
    // fail on machines that have a perfectly good browser.
    const result = resolveDesignBrowser(undefined, world({ files: [EDGE, CHROME] }))
    expect(result).toEqual({ kind: 'available', executable: EDGE, source: 'edge' })
  })

  it('falls back to Chrome when Edge is absent', () => {
    const result = resolveDesignBrowser(undefined, world({ files: [CHROME] }))
    expect(result).toEqual({ kind: 'available', executable: CHROME, source: 'chrome' })
  })

  it('lets a configured path outrank both', () => {
    // A setting that loses to a default is a suggestion, not a setting. This is also the
    // route by which a caller points the engine at a browser the fixed list cannot name.
    const custom = 'D:\\browsers\\chrome.exe'
    const result = resolveDesignBrowser(custom, world({ files: [custom, EDGE, CHROME] }))
    expect(result).toEqual({ kind: 'available', executable: custom, source: 'configured' })
  })

  it('reports a configured path that is not a file, rather than falling through', () => {
    // Falling through would silently render in a different browser than the one asked
    // for, which is worse than refusing: the user sees a setting that does nothing and
    // no reason why.
    const result = resolveDesignBrowser('D:\\gone\\chrome.exe', world({ files: [EDGE] }))
    expect(result.kind).toBe('missing')
    expect(result.kind === 'missing' ? result.detail : '').toContain('D:\\gone\\chrome.exe')
  })

  it('treats a blank configured path as unset', () => {
    // The settings surface writes an empty string for "not set", and a blank path that
    // counted as configured would make every install with an untouched field report a
    // missing browser.
    const result = resolveDesignBrowser('   ', world({ files: [EDGE] }))
    expect(result).toEqual({ kind: 'available', executable: EDGE, source: 'edge' })
  })

  it('uses the Windows App Paths registry when the known locations are all absent', () => {
    // A per-user Edge or a non-default drive lands here, and neither can be named in a
    // fixed list.
    const moved = 'D:\\Edge\\Application\\msedge.exe'
    const result = resolveDesignBrowser(undefined, world({
      files: [moved],
      appPath: (name) => (name === 'msedge.exe' ? moved : undefined),
    }))
    expect(result).toEqual({ kind: 'available', executable: moved, source: 'edge' })
  })

  it('accepts a Playwright-cached Chromium as the last resort', () => {
    const cache = 'C:\\pw'
    const executable = 'C:\\pw\\chromium-1243\\chrome-win64\\chrome.exe'
    const result = resolveDesignBrowser(undefined, world({
      files: [executable],
      directories: { [cache]: ['chromium-1243'] },
      env: { PLAYWRIGHT_BROWSERS_PATH: cache },
    }))
    expect(result).toEqual({ kind: 'available', executable, source: 'playwright-cache' })
  })

  it('reads PLAYWRIGHT_BROWSERS_PATH=0 as closed, not as a guess', () => {
    // The setting means "keep browsers inside Playwright's own package", where the layout
    // is not knowable from here. An unreadable answer is not a yes — the same rule the
    // existing capability probe states.
    const result = resolveDesignBrowser(undefined, world({
      files: [CHROME],
      directories: { '': ['chromium-1243'] },
      env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
      platform: 'linux',
    }))
    expect(result.kind).toBe('missing')
  })

  it('ignores a cache directory that is not a Playwright revision', () => {
    const cache = 'C:\\pw'
    const result = resolveDesignBrowser(undefined, world({
      files: ['C:\\pw\\chromium-notes\\chrome-win64\\chrome.exe'],
      directories: { [cache]: ['chromium-notes'] },
      env: { PLAYWRIGHT_BROWSERS_PATH: cache },
    }))
    expect(result.kind).toBe('missing')
  })

  it('names the platform and the remedy when there is no browser at all', () => {
    // A refusal is only useful if it says what to do. This is the message the Design page
    // renders, and it has to name both the install and the setting, because the reader
    // may prefer either.
    const result = resolveDesignBrowser(undefined, world({ platform: 'linux' }))
    expect(result.kind).toBe('missing')
    const detail = result.kind === 'missing' ? result.detail : ''
    expect(detail).toContain('Edge')
    expect(detail).toContain('Design settings')
  })
})
