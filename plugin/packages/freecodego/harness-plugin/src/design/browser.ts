/**
 * Which browser the design engine drives, and what to say when there is none.
 *
 * Why this is a separate module with an injectable world
 * ------------------------------------------------------
 * The answer depends entirely on the machine, and the interesting cases are the ones
 * this machine does not have: Edge present but Chrome absent, a Playwright cache
 * whose revision the current install would not launch, a configured path that names a
 * file that has since moved. A resolver written against `existsSync` can only be
 * tested on whatever the developer happens to have installed, so it is written as a
 * pure function over {@link DesignBrowserProbes} instead — the same shape
 * `capability-rows.ts` already uses for its own browser probe, and for the same
 * reason.
 *
 * Why Edge is first
 * -----------------
 * Edge ships with Windows 10 and 11, so on the platform this plugin is built for it is
 * effectively always present, while Chrome is only present when somebody installed it.
 * The upstream engine and the Harness both look for Chrome alone — `@puppeteer/browsers`
 * does not even enumerate Edge — which is why this chain has to exist rather than being
 * delegated: leaving it out would mean the design engine reports "no browser" on a
 * machine that has one.
 *
 * Why a missing browser is a refusal rather than a degradation
 * ------------------------------------------------------------
 * The same posture `capability-rows.ts` states for its own rows ("reject rather than
 * degrade"): a browser that cannot be found leaves the capability **closed**, with the
 * reason attached, instead of open and failing at the first render. A render that
 * starts and then dies halfway has already cost the user the wait.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/design/browser
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Where the executable came from, for the settings surface to report. */
export type DesignBrowserSource = 'configured' | 'edge' | 'chrome' | 'playwright-cache'

/** What the resolver found. */
export type DesignBrowser =
  | { readonly kind: 'available'; readonly executable: string; readonly source: DesignBrowserSource }
  | { readonly kind: 'missing'; readonly detail: string }

/**
 * The world the resolver asks about.
 *
 * Every member is injectable so the priority order can be tested without the machine
 * that runs the test: a case for "Edge is present and Chrome is not" is a fixture, not a
 * workstation.
 */
export interface DesignBrowserProbes {
  readonly platform: NodeJS.Platform
  /** Whether a candidate path names an existing file. */
  readonly exists: (path: string) => boolean
  /** Directory listing, for the Playwright cache. Throws when the directory is absent. */
  readonly listDirectory: (directory: string) => readonly string[]
  /**
   * The Windows "App Paths" lookup, when the platform has one.
   *
   * Optional because it is the only probe that needs a subprocess and most cases do
   * not: a resolver that required it could not be exercised on a machine whose
   * registry cannot be read, which is exactly the machine most likely to need the
   * fallbacks behind it.
   */
  readonly appPath?: (executableName: string) => string | undefined
  /** Environment, for `PLAYWRIGHT_BROWSERS_PATH`. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** One candidate, in the order the chain tries them. */
interface Candidate {
  readonly path: string
  readonly source: DesignBrowserSource
}

/**
 * Well-known install locations per platform, Edge before Chrome.
 *
 * Absolute paths rather than a `PATH` lookup, and that is deliberate: `PATH` on Windows
 * routinely carries stale or shimmed entries, and a browser resolved through a shim is a
 * browser whose version the engine cannot reason about. A caller that wants a specific
 * binary passes one as `configuredPath` and skips this list entirely.
 */
const KNOWN_LOCATIONS: Readonly<Record<string, readonly Candidate[]>> = {
  win32: [
    { path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', source: 'edge' },
    { path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', source: 'edge' },
    { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', source: 'chrome' },
    { path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', source: 'chrome' },
  ],
  darwin: [
    { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', source: 'edge' },
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'chrome' },
    { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', source: 'chrome' },
  ],
  linux: [
    { path: '/usr/bin/microsoft-edge', source: 'edge' },
    { path: '/usr/bin/microsoft-edge-stable', source: 'edge' },
    { path: '/usr/bin/google-chrome', source: 'chrome' },
    { path: '/usr/bin/google-chrome-stable', source: 'chrome' },
    { path: '/usr/bin/chromium', source: 'chrome' },
    { path: '/usr/bin/chromium-browser', source: 'chrome' },
  ],
}

/** The default Playwright browser cache, per platform. */
function defaultBrowserCache(platform: NodeJS.Platform): string {
  if (platform === 'win32') return join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (platform === 'darwin') return join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  return join(process.env.HOME ?? '', '.cache', 'ms-playwright')
}

/**
 * Chromium executables inside one Playwright revision directory.
 *
 * A deliberate mirror of `browserExecutables()` in `capability-rows.ts`. The two lists
 * exist because that helper is module-private, and the follow-up that removes the
 * duplication is to export it and import it here — not to grow a second list that
 * quietly disagrees. Until then, both carry the same reason: Playwright changed its
 * layout between releases (`chrome-win64/` replaced `chrome-win/`), so a machine can
 * carry either, and the first name that exists wins.
 */
function playwrightExecutables(platform: NodeJS.Platform): readonly string[] {
  switch (platform) {
    case 'win32': return ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-win64/headless_shell.exe', 'chrome-win/headless_shell.exe']
    case 'darwin': return ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    default: return ['chrome-linux64/chrome', 'chrome-linux/chrome']
  }
}

/**
 * A Playwright-cached Chromium, when one is there.
 *
 * `PLAYWRIGHT_BROWSERS_PATH=0` asks Playwright to keep browsers *inside its own package*,
 * where this probe cannot know the layout. That reads as closed rather than as a guess:
 * an unreadable answer is not a yes. Same rule, and same wording, as the existing probe.
 * @param probes the world to ask
 * @returns the executable, or nothing
 */
function cachedChromium(probes: DesignBrowserProbes): Candidate | undefined {
  const configured = probes.env.PLAYWRIGHT_BROWSERS_PATH
  if (configured === '0') return undefined
  const directory = configured !== undefined && configured !== '' ? configured : defaultBrowserCache(probes.platform)
  let names: readonly string[]
  try {
    names = probes.listDirectory(directory)
  } catch {
    return undefined
  }
  // A revision directory, not any directory: `chromium-1243` and
  // `chromium_headless_shell-1243` are the two names Playwright uses, and matching
  // anything else would let `chromium-notes/` answer as a browser.
  for (const name of names) {
    if (!/^chromium(?:_headless_shell)?-\d+$/u.test(name)) continue
    for (const executable of playwrightExecutables(probes.platform)) {
      const candidate = join(directory, name, executable)
      if (probes.exists(candidate)) return { path: candidate, source: 'playwright-cache' }
    }
  }
  return undefined
}

/**
 * Resolve the browser the design engine will drive.
 *
 * Order, and what each step is worth:
 *
 * 1. **The configured path** — the caller's own answer, and it outranks everything.
 *    A caller that named a specific binary is not missing one, and second-guessing
 *    that would make the parameter a suggestion. No setting supplies one today:
 *    the design page has no field for it, so the search begins at step 2.
 * 2. **Edge** — present on effectively every Windows install, which is the platform
 *    this plugin's renderer is specified against.
 * 3. **Chrome** — the engine's and the Harness's own preference, kept after Edge only
 *    because it is the less certain of the two on Windows and equally certain elsewhere.
 * 4. **The Playwright cache** — last because its revision is chosen by a different
 *    package's install, so it is the candidate most likely to satisfy `exists` while
 *    not being a browser the engine can launch. It is still worth trying: a machine
 *    with no system browser but a Playwright one can render.
 *
 * On Windows the known paths are tried before the registry rather than after, because
 * the paths are the common case and the registry lookup costs a subprocess. The registry
 * remains the fallback for an install that moved — a per-user Edge or a non-default
 * drive, both of which occur in the field and neither of which a fixed list can name.
 *
 * @param configuredPath the caller's own browser binary, when it has one
 * @param probes the world to ask
 * @returns the browser, or the reason there is none
 */
export function resolveDesignBrowser(configuredPath: string | undefined, probes: DesignBrowserProbes): DesignBrowser {
  const configured = configuredPath?.trim()
  if (configured !== undefined && configured !== '') {
    return probes.exists(configured)
      ? { kind: 'available', executable: configured, source: 'configured' }
      : { kind: 'missing', detail: `the configured browser is not a file: ${configured}` }
  }

  for (const candidate of KNOWN_LOCATIONS[probes.platform] ?? []) {
    if (probes.exists(candidate.path)) return { kind: 'available', executable: candidate.path, source: candidate.source }
  }

  if (probes.platform === 'win32' && probes.appPath !== undefined) {
    for (const name of ['msedge.exe', 'chrome.exe']) {
      const found = probes.appPath(name)
      if (found !== undefined && probes.exists(found)) {
        return { kind: 'available', executable: found, source: name.startsWith('msedge') ? 'edge' : 'chrome' }
      }
    }
  }

  const cached = cachedChromium(probes)
  if (cached !== undefined) return { kind: 'available', executable: cached.path, source: cached.source }

  return {
    kind: 'missing',
    detail: 'no browser to drive: install Microsoft Edge or Google Chrome, or set the design browser path in the Design settings',
  }
}

/**
 * The probes a real install answers through.
 * @returns filesystem probes bound to this machine
 */
export function defaultDesignBrowserProbes(): DesignBrowserProbes {
  return {
    platform: process.platform,
    exists: (path) => existsSync(path),
    listDirectory: (directory) => readdirSync(directory),
    env: process.env,
  }
}
