/**
 * The optional Harness capabilities this layer mounts — on by default, and off
 * without a word on an install that cannot run them.
 *
 * Browser control, desktop control and session-history retrieval each arrive in
 * the Harness as a service plus one provider (or tool) package, and no upstream
 * bundle mounts any of them: mounting them is how a deployment says yes. This
 * layer mounts all three, because a capability the user has to find in a panel
 * they do not open is a capability the deployment does not have.
 *
 * What "on by default" cannot mean is a plain `disabled: false`, and the reason
 * is the grain the Loader fails at. An *enabled* row naming a package the install
 * does not carry is a row that fails: `Entry._init` catches the import error, logs
 * `did not activate`, and the Loader reports one more failed entry on every boot
 * after. The panel shows it as 未运行 rather than 已关闭 — a permanently broken
 * plugin, not an unused one. The capability is not broken either: it is absent,
 * and this file's job is to say so in the one way the Loader reads as silence.
 *
 * So each of these rows carries a selector instead of a value:
 *
 *     disabled: !!js "!ctx.get('freecodegoCapabilities')?.usable('@deepseek-ai/dsh-browser-use')"
 *
 * Typed out in full, the rule is:
 *
 * - **The install has it** → {@link reconcileCapabilityRows} starts the row, and
 *   the capability works with nothing else asked of the user. Installing the
 *   packages *is* the opt-in; there is no second switch to find.
 * - **The install does not have it** → nothing is started, nothing is logged as a
 *   failure, and the panel says 已关闭. The key is that a selector's fallback is
 *   `true` (disabled): before this plugin mounts, the row is already off.
 * - **We cannot tell** → off. The service is absent from a context that cannot see
 *   it, and `!undefined` is `true`. Unknown is never a reason to start something.
 *
 * The plugin has to be the one that decides, rather than the expression alone,
 * because the expression is evaluated *before* this plugin mounts: this row is
 * last in the patch list (the providers it needs are mounted before it, which is
 * what they document as their own requirement), and a patch row's `disabled` is
 * read as the Loader starts that row. Asked at that moment, a plugin-provided
 * service answers nothing — so the expression stays closed and the pass that runs
 * afterwards opens what the probe says is there. That is also why the answer is
 * *resolvability* rather than a stored preference: nothing in this plugin keeps a
 * copy of a state the install can report itself, and a user who removes the
 * packages gets the rows quietly back off on the next boot instead of a failed
 * entry per row.
 *
 * Two things are checked beyond "is the package there", and both are the
 * difference between a default that helps and one that breaks sessions:
 *
 * 1. **What the row's own code resolves.** The Playwright provider resolves
 *    `@playwright/mcp` and the native desktop provider imports
 *    `@trycua/cua-driver` while it activates, so those specifiers are probed
 *    *from the package that resolves them* — with pnpm's isolated layout a
 *    transitive dependency is not resolvable from the profile root, and a probe
 *    that asked there would report a working install as missing.
 * 2. **Prerequisites the machine supplies.** A launched browser follows the
 *    Playwright runtime's own browser installation (`mode: launch` with no
 *    `executablePath` uses the browser Playwright installed), and the provider
 *    opens it from `agent/created` with `failOnStartupError: true` — upstream's
 *    README says the consequence in those words: "Startup failure or cancellation
 *    rejects Session creation or resume". Enabling that pair on a machine with
 *    the packages and no browser would turn a user's own install step into
 *    sessions that cannot be created, which is worse than the feature being
 *    absent. Desktop control is *not* probed the same way: OS permission grants
 *    cannot be read from here, its failures are reported per call rather than at
 *    startup, and its README asks for an explicit decision — so the driver
 *    package is the whole probe, and the capability arrives with the packages.
 *
 * A user who wants one of these while the probe says no can still enable the row
 * where they manage their other entries: a `disabled` write replaces the selector
 * with a plain boolean, and {@link reconcileCapabilityRows} acts only on its own
 * selectors, so nothing here overrules that. What they get is exactly what they
 * asked for — including the failed entry when the package is not there.
 * @module
 */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'

/**
 * The service this layer's capability rows ask, through the patch's own selector,
 * whether the capability can run here.
 *
 * Named beside `freecodegoOfficialRows` (`stand-in-rows.ts`) rather than merged
 * with it because the two answer different questions: that one asks whether the
 * official *row* is serving, this one whether the *install* can supply the
 * package at all. A stand-in that cannot import is not the same as a capability
 * whose dependencies are absent, and the repairs differ — one re-enables a
 * fallback, the other leaves a row closed on purpose.
 */
export const CAPABILITY_ROW_SERVICE = 'freecodegoCapabilities'

/** One module a capability's own code resolves while it activates. */
export interface CapabilityModule {
  /** The bare specifier that must resolve. */
  readonly specifier: string
  /**
   * The specifier this one is resolved *from*, when it is not resolved from the
   * profile root: a transitive dependency of a package this layer does not own.
   */
  readonly from?: string
}

/** One capability this layer mounts: the rows, what they need, and how to get it. */
export interface CapabilitySpec {
  /** Stable id, used by the readiness report and by the tests that pin this table. */
  readonly id: string
  /**
   * The Loader entry ids this patch declares for the capability, in mount order.
   *
   * A capability is a *pair* — the service that holds the single registration slot
   * and the provider that fills it — and the two are enabled together or not at
   * all: the service alone gives the model no tool, and the provider alone fails
   * on the service it injects. So readiness is per capability and the rows are
   * started as one.
   */
  readonly rows: readonly string[]
  /** Every specifier that has to resolve, in the order the code resolves it. */
  readonly modules: readonly CapabilityModule[]
  /** A prerequisite the machine supplies rather than the install. */
  readonly machine?: {
    readonly kind: 'browser'
    /**
     * The module whose own code launches the browser. It is named here rather than
     * inferred from the module list because the probe asks *its* runtime what
     * browser it would start: a row that resolves its own browser is not the same
     * question, and the answer has to come from the package that will do the
     * launching.
     */
    readonly from: string
  } | undefined
  /** What supplies the packages, as the user would run it in the profile directory. */
  readonly install: readonly string[]
}

/**
 * The table, and the only place these rows' requirements are stated.
 *
 * Three consumers read it: the pass below, the settings-side readiness report,
 * and `alpha-composition.spec.ts`, which holds the composition to the same rule
 * this file implements — an enabled row may name a package outside the install
 * contract only while the selector that enabled it is this file's own.
 */
export const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: 'browser',
    rows: ['browser-use', 'browser-use-playwright-mcp'],
    modules: [
      { specifier: '@deepseek-ai/dsh-browser-use' },
      { specifier: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp' },
      // The pinned Playwright MCP server, resolved by the provider's own `apply`.
      {
        specifier: '@playwright/mcp/package.json',
        from: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
      },
    ],
    machine: { kind: 'browser', from: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp' },
    install: [
      'pnpm add @deepseek-ai/dsh-browser-use @deepseek-ai/dsh-experimental-browser-use-playwright-mcp @playwright/mcp',
    ],
  },
  {
    id: 'computer',
    rows: ['computer-use', 'computer-use-cua-driver-native'],
    modules: [
      { specifier: '@deepseek-ai/dsh-computer-use' },
      { specifier: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native' },
      // The native SDK, imported by the provider while it activates — and a
      // type-only import in its source, so the row fails at `apply` rather than
      // at import and this is the specifier that decides whether it can start.
      {
        specifier: '@trycua/cua-driver',
        from: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
      },
    ],
    install: [
      'pnpm add @deepseek-ai/dsh-computer-use @deepseek-ai/dsh-experimental-computer-use-cua-driver-native @trycua/cua-driver',
    ],
  },
]

/** The entry ids this table mounts, which is what the patch is held to. */
export const CAPABILITY_ENTRY_IDS: ReadonlySet<string> = new Set(
  CAPABILITIES.flatMap(capability => capability.rows),
)

/** One capability's readiness, as the pass acts on it and a status surface reads it. */
export interface CapabilityReadiness {
  readonly id: string
  readonly rows: readonly string[]
  readonly ready: boolean
  /** Specifiers this install cannot resolve, in table order. */
  readonly missing: readonly string[]
  /** A prerequisite the machine is missing, in words; absent when it is met. */
  readonly blockedBy?: string | undefined
  /** What supplies it, as the user would run it. */
  readonly install: readonly string[]
}

/**
 * What readiness needs from the world, injected so the answer can be tested
 * without a disk.
 */
export interface CapabilityProbes {
  /**
   * The file a specifier resolves to, or `undefined` when it does not resolve.
   * @param specifier - the bare specifier to resolve.
   * @param from - the profile directory URL, or the resolved file of the package
   *   whose code resolves this specifier; `undefined` when neither is known.
   */
  resolve(specifier: string, from: string | undefined): string | undefined
  /**
   * The browser the row's own configuration can launch.
   *
   * Three answers rather than two, because the *reason* is a deliverable: "the
   * browser is missing and here is the path Playwright looked for" is something a
   * user can act on, while a bare no says only that the feature is off.
   * @param config - the provider row's configuration as the Loader holds it.
   * @param from - the resolved file of the module that will launch the browser.
   */
  browser(config: unknown, from: string | undefined): BrowserAvailability
}

/**
 * What the machine says about the browser a capability needs: a path when one is
 * there, the note that names what is missing when the machine is the gap, and
 * nothing readable when neither could be asked.
 */
export type BrowserAvailability =
  | { readonly kind: 'available'; readonly executable: string }
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'unknown' }

/** The Loader row surface this module reads and corrects. */
export interface CapabilityEntry {
  readonly id: string
  readonly options: {
    readonly id?: string | undefined
    readonly name: string
    readonly disabled?: unknown
    readonly config?: unknown
  }
  /** True when this entry or an owning parent is disabled; throws when the expression does. */
  readonly disabled: boolean
  /** Present once the entry's module has been imported; `uid` is null before it starts. */
  readonly fiber?: { readonly uid: unknown } | undefined
  update(options: { readonly disabled: boolean }): Promise<unknown>
}

/** The slice of the Loader service this module needs. */
export interface CapabilityLoader {
  entries(): Iterable<CapabilityEntry>
  await(): Promise<unknown>
}

/** Resolve one specifier the way the Loader and the packages themselves will. */
function resolveFromDisk(specifier: string, from: string | undefined): string | undefined {
  if (from === undefined || from === '') return undefined
  try {
    return createRequire(from).resolve(specifier)
  } catch {
    // Not installed, not exported under that key, or resolvable only from another
    // directory: three answers to "can this row start", and the row cannot in all
    // three. A thrown resolution error is the answer, not a failure of this probe.
    return undefined
  }
}

/** Where the current platform keeps Playwright's browsers when nothing overrides it. */
function defaultBrowserCache(): string {
  switch (process.platform) {
    case 'win32': return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
    case 'darwin': return join(homedir(), 'Library', 'Caches', 'ms-playwright')
    default: return join(homedir(), '.cache', 'ms-playwright')
  }
}

/**
 * The executable inside one Playwright browser directory, by platform.
 *
 * The headless shell is accepted beside Chromium rather than treated as an
 * alternative install because that is what the row asks for: this patch configures
 * the provider with `headless: true`, and modern Playwright launches the shell for
 * a headless Chromium. A probe that accepted only the full browser would report a
 * working headless install as missing.
 *
 * Both directory generations are listed because the layout is Playwright's to
 * change and it did: measured on a real install, the browser it wanted lived at
 * `chromium-1243/chrome-win64/chrome.exe`, while the older releases this machine
 * still had were unpacked as `chrome-win/`. The first name that exists wins, so a
 * machine carrying either layout is read as having a browser.
 */
function browserExecutables(): readonly string[] {
  switch (process.platform) {
    case 'win32': return ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-win64/headless_shell.exe', 'chrome-win/headless_shell.exe']
    case 'darwin': return ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/headless_shell', 'chrome-mac/headless_shell']
    default: return ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux64/headless_shell', 'chrome-linux/headless_shell']
  }
}

/**
 * The headless shell Playwright records beside the browser it named.
 *
 * `executablePath()` answers for the full browser, and a `headless: true` launch is
 * what this row configures — so an install whose shell is present and whose full
 * browser is not is an install that can run the capability. The revision decides
 * which directory to look in, and the shell keeps its own executable name, so the
 * lookup is a rename of the same revision rather than a guess at the layout.
 * @param executable - the browser path Playwright answered with.
 * @returns the shell's executable, when it is there.
 */
export function headlessShellSibling(executable: string): string | undefined {
  const layout = dirname(executable)
  const revision = basename(dirname(layout))
  if (!/^chromium-\d+$/u.test(revision)) return undefined
  const directory = join(dirname(dirname(layout)), revision.replace(/^chromium-/u, 'chromium_headless_shell-'))
  let names: readonly string[]
  try {
    names = readdirSync(directory)
  } catch {
    return undefined
  }
  for (const name of names) {
    for (const candidate of [join(directory, name, 'headless_shell.exe'), join(directory, name, 'headless_shell')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Read `executablePath` out of a row's configuration, when it carries one. */
function configuredBrowser(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const value = (config as { readonly executablePath?: unknown }).executablePath
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Require a module the way the package that declares it will. */
function requireFrom(specifier: string, from: string | undefined): Record<string, unknown> | undefined {
  if (from === undefined) return undefined
  try {
    return createRequire(from)(specifier) as Record<string, unknown>
  } catch {
    // A package that is not installed, or one readable only as ESM: both mean the
    // runtime cannot be asked here, which the caller reports as an unread answer.
    return undefined
  }
}

/**
 * Playwright's own answer for the browser it would launch.
 *
 * The API rather than a directory scan, because the question is "can this install
 * launch a browser" and only the runtime knows which revision it will look for.
 * Measured on a real install: it answered with a path under a revision that was
 * *not* in the cache, while several older revisions were — a scan would have read
 * that machine as ready and let a browser that cannot start into a Session.
 * @param module_ - the required Playwright module, when it could be read.
 * @returns the path it named, or `undefined` when its API could not be read.
 */
function playwrightExecutable(module_: Record<string, unknown> | undefined): string | undefined {
  const chromium = module_?.chromium
  if (typeof chromium !== 'object' || chromium === null) return undefined
  const executablePath = (chromium as { readonly executablePath?: unknown }).executablePath
  if (typeof executablePath !== 'function') return undefined
  try {
    const value = (executablePath as () => unknown).call(chromium)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    // A Playwright that throws here is one whose browser it cannot name; the
    // caller falls back to the cache rather than reading this as a missing one.
    return undefined
  }
}

/** A Chromium in the directory Playwright unpacks browsers into, whatever named it. */
function cachedChromium(): string | undefined {
  // `0` asks Playwright to keep browsers inside its own package, where this probe
  // cannot know the layout — closed, because an unread answer is not a yes.
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (root === '0') return undefined
  const directory = root !== undefined && root !== '' ? root : defaultBrowserCache()
  let names: readonly string[]
  try {
    names = readdirSync(directory)
  } catch {
    return undefined
  }
  for (const name of names) {
    if (!/^chromium(?:_headless_shell)?-\d+$/u.test(name)) continue
    for (const executable of browserExecutables()) {
      const candidate = join(directory, name, executable)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The browser a row's own configuration can launch, read from the machine.
 *
 * Three sources in the order of how much each one is worth. A configured
 * `executablePath` is the row's own answer and outranks everything: `mode: launch`
 * passes it to the provider as `--executable-path`, so a user who pointed the row
 * at a system Chrome is not missing anything. Playwright's own API is next, and is
 * the only source that knows which revision this install will look for. The cache
 * directory is last, for a provider whose runtime cannot be read here at all.
 * @param config - the provider row's configuration as the Loader holds it.
 * @param from - the resolved file of the module that will launch the browser.
 * @returns the browser, the missing one, or an unreadable answer.
 */
function browserOnDisk(config: unknown, from: string | undefined): BrowserAvailability {
  const configured = configuredBrowser(config)
  if (configured !== undefined) {
    return existsSync(configured)
      ? { kind: 'available', executable: configured }
      : { kind: 'missing', detail: `the row's \`executablePath\` is not a file: ${configured}` }
  }
  const answer = playwrightExecutable(requireFrom('playwright-core', from) ?? requireFrom('playwright', from))
  if (answer !== undefined) {
    if (existsSync(answer)) return { kind: 'available', executable: answer }
    const shell = headlessShellSibling(answer)
    if (shell !== undefined) return { kind: 'available', executable: shell }
    return { kind: 'missing', detail: `Playwright has no browser at ${answer} (run \`npx playwright install chromium\`)` }
  }
  const cached = cachedChromium()
  return cached === undefined ? { kind: 'unknown' } : { kind: 'available', executable: cached }
}

/**
 * The probes a real install answers through: module resolution from the profile
 * directory, and the browser Playwright would launch.
 * @returns the probes {@link installCapabilityRows} uses unless a caller injects its own.
 */
export function defaultCapabilityProbes(): CapabilityProbes {
  return { resolve: resolveFromDisk, browser: browserOnDisk }
}

/**
 * One capability's readiness, checked in the order its own code resolves.
 *
 * A module resolved from another module is probed from *that* module's file, which
 * is the chain the Loader and the packages use; when its origin is missing, the
 * transitive specifier is reported missing too rather than probed from the root,
 * because a root-relative answer would be about a different installation.
 * @param capability - the table entry to check.
 * @param baseUrl - the profile directory URL the Loader imports rows from.
 * @param configs - row id to the configuration the Loader holds for it.
 * @param probes - the world to ask.
 * @returns whether the capability can run, and what is missing when it cannot.
 */
export function capabilityReadiness(
  capability: CapabilitySpec,
  baseUrl: string | undefined,
  configs: ReadonlyMap<string, unknown>,
  probes: CapabilityProbes,
): CapabilityReadiness {
  const resolved = new Map<string, string>()
  const missing: string[] = []
  for (const entry of capability.modules) {
    const from = entry.from === undefined ? baseUrl : resolved.get(entry.from)
    const file = from === undefined ? undefined : probes.resolve(entry.specifier, from)
    if (file === undefined) {
      // One missing specifier is enough, but the walk continues: a report that
      // names everything absent is what lets a user install in one step.
      missing.push(entry.specifier)
      continue
    }
    resolved.set(entry.specifier, file)
  }
  let blockedBy: string | undefined
  const machine = capability.machine
  if (missing.length === 0 && machine !== undefined) {
    const config = configs.get(capability.rows[capability.rows.length - 1] ?? '')
    const browser = probes.browser(config, resolved.get(machine.from) ?? baseUrl)
    if (browser.kind === 'missing') blockedBy = browser.detail
    // An unreadable answer is not a yes, and it is worth saying so in the same words
    // as a missing browser: the two are the same instruction to the user.
    else if (browser.kind !== 'available') {
      blockedBy = 'no browser for Playwright to launch (run `npx playwright install chromium`, or set the row\'s `executablePath`)'
    }
  }
  return {
    id: capability.id,
    rows: capability.rows,
    ready: missing.length === 0 && blockedBy === undefined,
    missing,
    blockedBy,
    install: capability.install,
  }
}

/**
 * Row id to the configuration the Loader holds for it.
 *
 * Read rather than restated because the browser probe has to see a configuration
 * the user may have written: a row pointed at a system Chrome under
 * `executablePath` is not missing a browser, and a probe that checked only the
 * Playwright cache would keep that install's rows closed.
 * @param loader - the running Loader service, when one is reachable.
 * @returns one map entry per readable row.
 */
function configsOf(loader: CapabilityLoader | undefined): ReadonlyMap<string, unknown> {
  const configs = new Map<string, unknown>()
  if (loader === undefined) return configs
  try {
    for (const entry of loader.entries()) {
      const id = entry.options.id ?? entry.options.name
      if (id !== undefined) configs.set(id, entry.options.config)
    }
  } catch {
    // A tree that cannot be walked leaves every configuration unknown, which is the
    // shipped default — and the shipped default is what the patch states.
  }
  return configs
}

/**
 * Whether an entry's `disabled` is still one of this file's own capability selectors.
 *
 * The same distinction `stand-in-rows.ts` draws, for the same reason: a selector is
 * this layer's decision and may be replaced by the Loader's state, while a plain
 * boolean is a person's — a panel click or a later patch layer — and overruling it
 * would be this plugin starting something the deployment said no to. The marker is
 * {@link CAPABILITY_ROW_SERVICE}, so a row whose selector names it belongs to this
 * table.
 * @param value - the entry's `disabled` option.
 * @returns whether the option is one of this layer's capability selectors.
 */
export function isCapabilitySelector(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const expression = (value as { readonly __jsExpr?: unknown }).__jsExpr
  return typeof expression === 'string' && expression.includes(CAPABILITY_ROW_SERVICE)
}

/**
 * Start every capability row this install can run, and leave the rest closed.
 *
 * Idempotent, because it runs after every `loader/entry-init`: a row that is
 * already serving is skipped before the probe, and a row this file enables loses
 * its selector — the Loader's `update` writes the value it was given — so the next
 * pass does not see it as its own any more.
 *
 * Rows are started in table order, which is service-before-provider: the provider
 * injects the service, and a provider started first would sit pending until the
 * service arrived instead of failing outright, which is a state the user would
 * read as a hang.
 * @param loader - the running Loader service.
 * @param baseUrl - the profile directory URL the Loader imports rows from.
 * @param probes - the world to ask.
 * @returns the entry ids this pass started, for a caller that logs.
 */
export async function reconcileCapabilityRows(
  loader: CapabilityLoader,
  baseUrl: string | undefined,
  probes: CapabilityProbes,
): Promise<readonly string[]> {
  const byId = new Map<string, CapabilityEntry>()
  for (const entry of loader.entries()) {
    const id = entry.options.id ?? entry.options.name
    if (id !== undefined) byId.set(id, entry)
  }
  const configs = configsOf(loader)
  const started: string[] = []
  for (const capability of CAPABILITIES) {
    if (!capabilityReadiness(capability, baseUrl, configs, probes).ready) continue
    for (const id of capability.rows) {
      const entry = byId.get(id)
      // Not in this composition: a deployment that removed the row keeps it removed.
      if (entry === undefined) continue
      // Ours to decide only while the selector is still what stands the row down.
      if (!isCapabilitySelector(entry.options.disabled)) continue
      if (entry.fiber !== undefined && entry.fiber.uid !== null) continue
      try {
        await entry.update({ disabled: false })
      } catch {
        // The Loader logged why; the other capabilities are still worth starting.
        continue
      }
      started.push(id)
    }
  }
  return started
}

/**
 * The Loader, when this context can reach it.
 *
 * Two sources, in the order of how much of the Loader's contract each relies on,
 * and the same pair `stand-in-rows.ts` arrived at by measurement: `ctx.get('loader')`
 * answered `undefined` from this plugin's own context on the web Host while the
 * Loader was running and serving every row, and the Loader owns this plugin's row,
 * so the row carries the source that cannot fail on a mount the Loader performed.
 * @param ctx - the plugin context to resolve the Loader from.
 * @returns the Loader service, when one is reachable.
 */
function resolveLoader(ctx: Context): CapabilityLoader | undefined {
  const named = ctx.get('loader') as CapabilityLoader | undefined
  if (named !== undefined) return named
  const fiber = (ctx as unknown as { readonly fiber?: { readonly entry?: { readonly loader?: CapabilityLoader } } }).fiber
  return fiber?.entry?.loader
}

/**
 * The one line a Host log carries when capabilities are off, and why one line.
 *
 * A user reads the panel to learn that a row is closed; what the panel cannot say is
 * *which* specifier this install is missing, because "did not activate" is the only
 * thing the Loader would have said per row — and it would have said it on every boot.
 * So the reasons are gathered here instead: one line naming each off capability, the
 * specifiers that did not resolve or the prerequisite that is absent, and the command
 * that supplies them, which is only worth stating with a directory to run it in.
 * @param blocked - the capabilities that are off.
 * @param directory - the profile directory, when it is known.
 * @returns the log line.
 */
export function capabilityReportLine(blocked: readonly CapabilityReadiness[], directory: string | undefined): string {
  const reasons = blocked
    .map(readiness => `${readiness.id} (${[...readiness.missing, ...readiness.blockedBy === undefined ? [] : [readiness.blockedBy]].join('; ')})`)
    .join(', ')
  const command = blocked[0]?.install[0]
  return 'freecodego: optional Harness capabilities this profile does not carry are off, not failed: ' + reasons
    + (directory === undefined || command === undefined ? '' : ` — install with \`${command}\` in ${directory}`)
}

/** The profile directory a URL names, for a message that has to be run somewhere. */
function directoryOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  try {
    return fileURLToPath(baseUrl)
  } catch {
    return isAbsolute(baseUrl) ? baseUrl : undefined
  }
}

/**
 * Provide the capability service and keep its rows in step with the install.
 *
 * The service is provided before the first pass because the rows that ask through
 * it are siblings in the same patch list: a profile recomposition re-applies their
 * selectors over whatever the Loader last held, and asked live the selector then
 * answers from the probe instead of from a value the Loader has already overwritten.
 *
 * **The first pass does not wait for the tree.** That is a correctness requirement
 * rather than impatience, and it is measured: waiting left the rows enabled with no
 * fiber at the moment the Host audits the tree, and the audit reports *that* as
 * `failed to import` — a startup warning about a capability that does work, which is
 * the very noise this file exists to remove. Every step of the window is upstream's
 * own: a row whose selector is evaluated before this plugin mounts answers "off" and
 * is not started; the audit that runs after `loader.await()` settles evaluates the
 * selector again, now answers "on", and finds a row that never ran. Starting the row
 * inside this pass instead publishes the Loader's own `_initTask`, which is what the
 * audit waits for — so the row is either serving or honestly failed by the time it
 * looks.
 * @param ctx - the plugin context whose Loader is watched.
 * @param probes - the world to ask; the real filesystem unless a caller says otherwise.
 */
export function installCapabilityRows(ctx: Context, probes: CapabilityProbes = defaultCapabilityProbes()): void {
  let loader = resolveLoader(ctx)
  const baseUrl = ctx.baseUrl
  const current = (): readonly CapabilityReadiness[] => CAPABILITIES.map(capability =>
    capabilityReadiness(capability, baseUrl, configsOf(loader), probes))
  const disposeService = ctx.provide(CAPABILITY_ROW_SERVICE, {
    /**
     * Whether the capability the row naming `moduleName` belongs to can run here.
     * @param moduleName - the module a capability row names.
     * @returns whether its rows may be enabled.
     */
    usable: (moduleName: string): boolean => {
      const capability = CAPABILITIES.find(spec => spec.modules.some(entry => entry.specifier === moduleName))
      if (capability === undefined) return false
      return capabilityReadiness(capability, baseUrl, configsOf(loader), probes).ready
    },
    /** Every capability's readiness, for a status surface. */
    report: current,
  })
  // The reasons do not change while the process runs, and the rows themselves are
  // where a user reads that one is off, so the note is written once per boot — and
  // after the tree settles, because that is when the list is complete.
  let reported = false
  const reconcile = async (active: CapabilityLoader): Promise<void> => {
    const started = await reconcileCapabilityRows(active, baseUrl, probes)
    if (started.length) ctx.logger.info(`freecodego: optional Harness capabilities installed in this profile are mounted (${started.join(', ')})`)
  }
  const run = (): void => {
    const active = loader
    if (active === undefined) return
    // Now, so the rows a ready install carries are started inside this mount.
    void reconcile(active).catch(() => undefined)
    void active.await().then(async () => {
      // And again on the settled tree, which is where a row added after this plugin
      // mounted is caught and where the note below belongs.
      await reconcile(active)
      if (reported) return
      reported = true
      const blocked = current().filter(readiness => !readiness.ready)
      if (blocked.length === 0) return
      ctx.logger.info(capabilityReportLine(blocked, directoryOf(baseUrl)))
    }).catch(() => undefined)
  }
  ctx.effect(() => {
    const dispose = ctx.on('loader/entry-init', (entry) => {
      loader ??= (entry as { readonly loader?: CapabilityLoader }).loader
      run()
    }, { global: true })
    return dispose
  }, 'freecodego: optional capability rows')
  ctx.effect(() => disposeService, 'freecodego: capability queries')
  run()
}
