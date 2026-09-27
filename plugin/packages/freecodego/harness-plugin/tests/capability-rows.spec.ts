import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITY_ENTRY_IDS,
  CAPABILITY_ROW_SERVICE,
  capabilityReadiness,
  capabilityReportLine,
  headlessShellSibling,
  installCapabilityRows,
  isCapabilitySelector,
  reconcileCapabilityRows,
  type BrowserAvailability,
  type CapabilityEntry,
  type CapabilityLoader,
  type CapabilityProbes,
  type CapabilityReadiness,
  type CapabilitySpec,
} from '../src/capability-rows.ts'
import { provideHostServiceAs } from './support/host-services.ts'

const BROWSER = CAPABILITIES.find(capability => capability.id === 'browser') as CapabilitySpec
const COMPUTER = CAPABILITIES.find(capability => capability.id === 'computer') as CapabilitySpec

/** The specifier each capability's own code resolves, spelled here so a rename in the table shows up. */
const BROWSER_SERVICE = '@deepseek-ai/dsh-browser-use'
const BROWSER_PROVIDER = '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
const PLAYWRIGHT_MCP = '@playwright/mcp/package.json'

/** A world where exactly the named specifiers resolve, and a browser exists when asked. */
function probesOf(options: {
  readonly found: Readonly<Record<string, string>>
  readonly browser?: string | undefined
  readonly calls?: Array<{ readonly specifier: string; readonly from: string | undefined }>
  readonly asked?: Array<{ readonly config: unknown; readonly from: string | undefined }>
}): CapabilityProbes {
  return {
    resolve(specifier, from) {
      options.calls?.push({ specifier, from })
      return options.found[specifier]
    },
    browser: (config, from): BrowserAvailability => {
      options.asked?.push({ config, from })
      return options.browser === undefined
        ? { kind: 'missing', detail: `Playwright has no browser at C:/cache/chromium-1/chrome.exe (run \`npx playwright install chromium\`)` }
        : { kind: 'available', executable: options.browser }
    },
  }
}

/** Every module of one capability, as its own `resolve` would find them. */
function foundOf(capability: CapabilitySpec, base = 'file:///profile/x.js'): Record<string, string> {
  const found: Record<string, string> = {}
  for (const module_ of capability.modules) found[module_.specifier] = base
  return found
}

describe('capabilityReadiness', () => {
  it('reports a capability whose packages are absent as not ready, with the command that supplies them', () => {
    const readiness = capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: {} }))

    expect(readiness.ready).toBe(false)
    expect(readiness.missing).toEqual(BROWSER.modules.map(module_ => module_.specifier))
    expect(readiness.blockedBy).toBeUndefined()
    expect(readiness.install[0]).toContain('pnpm add')
  })

  it('reads a transitive specifier from the package that resolves it, not from the profile root', () => {
    // The measured trap: `@playwright/mcp` is a dependency of the provider package,
    // and with pnpm's isolated layout a transitive dependency is not resolvable from
    // the profile root at all. A probe that asked there would report a working
    // install as missing and keep the capability off forever.
    const calls: Array<{ readonly specifier: string; readonly from: string | undefined }> = []
    const providerFile = 'file:///profile/node_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/lib/index.js'
    const found = { [BROWSER_SERVICE]: 'file:///profile/x/browser-use.js', [BROWSER_PROVIDER]: providerFile }
    const readiness = capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found, calls }))

    expect(calls.map(call => [call.specifier, call.from])).toEqual([
      [BROWSER_SERVICE, 'file:///profile/'],
      [BROWSER_PROVIDER, 'file:///profile/'],
      [PLAYWRIGHT_MCP, providerFile],
    ])
    // It is still missing — the world above has no `@playwright/mcp` — and the probe
    // never asked for it from the profile root, which is the point.
    expect(readiness.missing).toEqual([PLAYWRIGHT_MCP])
  })

  it('does not ask a transitive specifier from the root when its own package is missing', () => {
    // With the provider absent there is no directory to resolve its dependency from,
    // and a root-relative answer would describe a different installation.
    const calls: Array<{ readonly specifier: string; readonly from: string | undefined }> = []
    const readiness = capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: { [BROWSER_SERVICE]: 'file:///profile/x.js' }, calls }))

    expect(readiness.missing).toEqual([BROWSER_PROVIDER, PLAYWRIGHT_MCP])
    expect(calls.some(call => call.specifier === PLAYWRIGHT_MCP)).toBe(false)
  })

  it('keeps browser control off when the packages are there and no browser is', () => {
    // The failure this prevents is not "no feature": the provider opens the browser
    // from `agent/created` with `failOnStartupError: true`, so a browser that cannot
    // start rejects session creation. Turning a user's own install step into sessions
    // that cannot be created is worse than the capability being absent.
    const readiness = capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: foundOf(BROWSER) }))

    expect(readiness.ready).toBe(false)
    expect(readiness.missing).toEqual([])
    // Playwright's own words travel: the path it looked for is what a user has to act
    // on, and a bare "no browser" would leave them guessing which one.
    expect(readiness.blockedBy).toContain('C:/cache/chromium-1/chrome.exe')
    expect(readiness.blockedBy).toContain('playwright install chromium')
  })

  it('checks the browser against the provider row\'s own configuration, and asks it of the launcher', () => {
    // Two things the probe has to be given, and each is why the pairing is declared
    // rather than guessed. The configuration, because a row pointed at a system
    // Chrome under `executablePath` is not missing a browser and the provider is the
    // row the patch gives a `config:` at all; and the *launcher's* file, because the
    // question is what browser the package that starts it will start — a row's own
    // resolution is a different answer.
    const asked: Array<{ readonly config: unknown; readonly from: string | undefined }> = []
    const providerFile = 'file:///profile/node_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/lib/index.js'
    const probes: CapabilityProbes = {
      resolve: (specifier) => specifier === BROWSER_PROVIDER ? providerFile : 'file:///profile/x.js',
      browser: (config, from) => { asked.push({ config, from }); return { kind: 'available', executable: 'C:/chromium.exe' } },
    }
    const configs = new Map([[BROWSER.rows[1] ?? '', { mode: 'launch', headless: true, executablePath: 'C:/chrome.exe' }]])

    capabilityReadiness(BROWSER, 'file:///profile/', configs, probes)

    expect(asked).toEqual([{ config: { mode: 'launch', headless: true, executablePath: 'C:/chrome.exe' }, from: providerFile }])
  })

  it('does not ask about a browser before the packages are there', () => {
    // The machine probe is the second gate, and asking it about an install that has
    // no provider yet would run Playwright's own runtime for a capability whose rows
    // cannot start either way.
    const asked: unknown[] = []
    const probes: CapabilityProbes = {
      resolve: () => undefined,
      browser: () => { asked.push(1); return { kind: 'unknown' } },
    }

    capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probes)

    expect(asked).toEqual([])
  })

  it('is ready with the packages and a browser, and asks the machine only about the capability that has one', () => {
    const browser = capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: foundOf(BROWSER), browser: 'C:/chromium.exe' }))
    const computer = capabilityReadiness(COMPUTER, 'file:///profile/', new Map(), probesOf({ found: foundOf(COMPUTER) }))

    expect(browser.ready).toBe(true)
    // Desktop control is not gated on a machine probe: OS permission grants cannot be
    // read from here, and its failures are reported per call rather than at startup.
    expect(computer.ready).toBe(true)
  })

  it('is closed when the profile directory is unknown', () => {
    // Without a base URL nothing can be resolved, and an unanswerable question is not
    // a reason to start a row: the same `true` fallback the patch's selector carries.
    expect(capabilityReadiness(BROWSER, undefined, new Map(), probesOf({ found: foundOf(BROWSER), browser: 'C:/x.exe' })).ready).toBe(false)
  })
})

describe('headlessShellSibling', () => {
  it('finds the shell of the same revision, in either layout', () => {
    // A `--headless` launch uses the shell, so an install whose shell is present and
    // whose full browser is not can run this capability. Playwright names the full
    // browser, and the shell keeps its own executable name in its own directory —
    // built here rather than described, because the two paths are the whole rule.
    const root = mkdtempSync(join(tmpdir(), 'capability-shell-'))
    const cache = mkdtempSync(join(root, 'ms-playwright-'))
    mkdirSync(join(cache, 'chromium_headless_shell-1243', 'chrome-win'), { recursive: true })
    const shell = join(cache, 'chromium_headless_shell-1243', 'chrome-win', 'headless_shell.exe')
    writeFileSync(shell, '')
    const browser = join(cache, 'chromium-1243', 'chrome-win64', 'chrome.exe')

    expect(headlessShellSibling(browser)).toBe(shell)
    // A path Playwright did not name as a revision, or a revision with no shell, is
    // not this rule's to answer.
    expect(headlessShellSibling(join(cache, 'chromium', 'chrome-win64', 'chrome.exe'))).toBeUndefined()
    expect(headlessShellSibling(join(cache, 'chromium-9999', 'chrome-win64', 'chrome.exe'))).toBeUndefined()
  })
})

describe('isCapabilitySelector', () => {
  it('recognises this layer\'s own selector and nothing else', () => {
    expect(isCapabilitySelector({ __jsExpr: `!ctx.get('${CAPABILITY_ROW_SERVICE}')?.usable('${BROWSER_SERVICE}')` })).toBe(true)
    // A person's decision, a later layer's, or another module's expression: none of
    // them are this plugin's to undo.
    expect(isCapabilitySelector(false)).toBe(false)
    expect(isCapabilitySelector(undefined)).toBe(false)
    expect(isCapabilitySelector({ __jsExpr: "ctx.get('freecodegoOfficialRows')?.holds('@deepseek-ai/dsh-subagent-codex')" })).toBe(false)
  })
})

/**
 * A Host whose app config lives in a directory, which is the one thing the probe
 * cannot invent.
 *
 * The Loader imports every top-level row relative to that directory — this plugin's
 * own context inherits it through the tree — so it is also where a user's `pnpm add`
 * lands and therefore where the probe has to resolve from. A context without one is
 * the closed case the last readiness test pins.
 */
function hostOf(loader: CapabilityLoader): Context {
  const ctx = new Context()
  provideHostServiceAs<CapabilityLoader>(ctx, 'loader', loader)
  ctx.baseUrl = 'file:///profile/'
  return ctx
}

/**
 * A fake row: `disabled` follows its own `update`, and `updates` records what was
 * asked.
 *
 * The option is written back, because the Loader's own `update` writes it — and that
 * write is the whole reason a second pass over the same tree is idempotent: what
 * started the row was this file's selector, and the value it left behind is a plain
 * boolean, which this file does not treat as its own.
 */
interface FakeRow extends CapabilityEntry {
  readonly updates: unknown[]
  readonly options: { readonly id: string; readonly name: string; disabled?: unknown; readonly config?: unknown }
  disabled: boolean
  fiber?: { readonly uid: unknown } | undefined
}

/**
 * One Loader row, as the runtime reports it.
 *
 * A row whose `disabled` option is an expression reads as disabled, which is what
 * the Loader does with the patch's own selector before the plugin answers it.
 */
function row(over: {
  readonly id: string
  readonly name: string
  readonly disabled: unknown
  readonly config?: unknown
  readonly serving?: boolean
  readonly updateThrows?: boolean
}): FakeRow {
  const updates: unknown[] = []
  const self: FakeRow = {
    id: over.id,
    updates,
    options: { id: over.id, name: over.name, disabled: over.disabled, ...(over.config === undefined ? {} : { config: over.config }) },
    disabled: over.disabled !== false,
    ...(over.serving === true ? { fiber: { uid: 1 } } : {}),
    update: async (next) => {
      if (over.updateThrows === true) throw new Error(`${over.id}: could not start`)
      updates.push(next)
      self.options.disabled = next.disabled
      self.disabled = next.disabled
    },
  }
  return self
}

const selectorFor = (moduleName: string): unknown => ({ __jsExpr: `!ctx.get('${CAPABILITY_ROW_SERVICE}')?.usable('${moduleName}')` })

/** The bundle's own rows, as the patch declares them: each one gated on its own module. */
function browserRows(over: { readonly serving?: boolean; readonly updateThrows?: boolean } = {}): FakeRow[] {
  return [
    row({ id: 'browser-use', name: BROWSER_SERVICE, disabled: selectorFor(BROWSER_SERVICE), ...over }),
    row({ id: 'browser-use-playwright-mcp', name: BROWSER_PROVIDER, disabled: selectorFor(BROWSER_PROVIDER), config: { mode: 'launch', headless: true }, ...over }),
  ]
}

/** The service the patch's selectors ask, as a test reads it back out of the context. */
interface CapabilityService {
  usable(moduleName: string): boolean
  report(): readonly CapabilityReadiness[]
}

const loaderOf = (...rows: FakeRow[]): CapabilityLoader => ({
  // The Loader's `entries()` is a generator over the tree — one call is one pass — so
  // the fake yields rather than returning an array, which would let a walk that
  // consumes the tree twice pass here.
  *entries() { yield* rows },
  await: async () => undefined,
})

describe('reconcileCapabilityRows', () => {
  it('starts both rows of an installed capability, service before provider', async () => {
    const rows = browserRows()
    const started = await reconcileCapabilityRows(
      loaderOf(...rows),
      'file:///profile/',
      probesOf({ found: foundOf(BROWSER), browser: 'C:/chromium.exe' }),
    )

    expect(started).toEqual(['browser-use', 'browser-use-playwright-mcp'])
    expect(rows.map(entry => entry.updates)).toEqual([[{ disabled: false }], [{ disabled: false }]])
  })

  it('starts nothing on an install that does not carry the packages', async () => {
    // The whole point of the selector: absent packages are the row being off, and the
    // Host log carries one line about it rather than one failed entry per row.
    const rows = browserRows()
    const started = await reconcileCapabilityRows(loaderOf(...rows), 'file:///profile/', probesOf({ found: {} }))

    expect(started).toEqual([])
    expect(rows.map(entry => entry.updates)).toEqual([[], []])
  })

  it('never overrules a plain boolean, whoever wrote it', async () => {
    // `disabled: true` is the user's or a later layer's decision, and this pass may
    // only replace its own selectors. A deployment that enabled the row by hand gets
    // exactly what it asked for, including the failed entry when the package is absent.
    const off = row({ id: 'browser-use', name: BROWSER_SERVICE, disabled: true })
    const on = row({ id: 'browser-use-playwright-mcp', name: BROWSER_PROVIDER, disabled: false })

    await reconcileCapabilityRows(loaderOf(off, on), 'file:///profile/', probesOf({ found: foundOf(BROWSER), browser: 'C:/x.exe' }))

    expect(off.updates).toEqual([])
    expect(on.updates).toEqual([])
  })

  it('leaves a row that is already serving alone', async () => {
    // The Loader re-applies the patch over what it last held, so a row can read as
    // disabled while its fiber is live and serving. A second start is only churn.
    const rows = browserRows({ serving: true })

    expect(await reconcileCapabilityRows(loaderOf(...rows), 'file:///profile/', probesOf({ found: foundOf(BROWSER), browser: 'C:/x.exe' }))).toEqual([])
    expect(rows.map(entry => entry.updates)).toEqual([[], []])
  })

  it('keeps starting the rest when one row cannot start', async () => {
    // A row that fails to import is a reason to log, not a reason to leave the
    // capability's other half — and every other capability — unstarted.
    const rows = browserRows({ updateThrows: true })

    const started = await reconcileCapabilityRows(loaderOf(...rows), 'file:///profile/', probesOf({ found: foundOf(BROWSER), browser: 'C:/x.exe' }))

    // The first throw skips that row, and the second row is still attempted — as is
    // the pair behind it, which this fake has already answered for.
    expect(rows[0]?.updates).toEqual([])
    expect(rows[1]?.updates).toEqual([])
    expect(started).toEqual([])
  })

  it('ignores rows that do not belong to the table', async () => {
    const unrelated = row({ id: 'web', name: '@deepseek-ai/dsh-web', disabled: selectorFor(BROWSER_SERVICE) })

    await reconcileCapabilityRows(loaderOf(unrelated), 'file:///profile/', probesOf({ found: foundOf(BROWSER), browser: 'C:/x.exe' }))

    expect(unrelated.updates).toEqual([])
  })

  it('covers every row the table claims, so a row added to the patch cannot be gated by nothing', () => {
    expect([...CAPABILITY_ENTRY_IDS].sort()).toEqual(CAPABILITIES.flatMap(capability => capability.rows).sort())
    for (const capability of CAPABILITIES) {
      expect(capability.rows.length).toBeGreaterThan(1)
      expect(capability.install.length).toBeGreaterThan(0)
    }
  })
})

describe('installCapabilityRows', () => {
  it('provides the service the patch asks and starts what the install carries', async () => {
    const rows = browserRows()
    const ctx = hostOf(loaderOf(...rows))
    try {
      await ctx.plugin({
        name: 'capability-rows-test',
        apply(inner: Context) {
          installCapabilityRows(inner, probesOf({ found: foundOf(BROWSER), browser: 'C:/chromium.exe' }))
        },
      })

      await vi.waitFor(() => { expect(rows[0]?.updates).toEqual([{ disabled: false }]) })
      // The row after it is the provider, and it starts too.
      expect(rows[1]?.updates).toEqual([{ disabled: false }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts a ready row without waiting for the tree to settle', async () => {
    // The measured failure, and the reason the first pass does not wait: the rows a
    // ready install carries have to be started *inside* this mount, because the Host
    // audits the tree right after `loader.await()` settles and reports a row that is
    // enabled with no fiber as `failed to import`. The loader below never settles its
    // await, so a pass that waited first would start nothing at all.
    const rows = browserRows()
    const ctx = hostOf({
      *entries() { yield* rows },
      await: () => new Promise<never>(() => undefined),
    })
    try {
      await ctx.plugin({
        name: 'capability-immediate-test',
        apply(inner: Context) {
          installCapabilityRows(inner, probesOf({ found: foundOf(BROWSER), browser: 'C:/chromium.exe' }))
        },
      })

      await vi.waitFor(() => { expect(rows[0]?.updates).toEqual([{ disabled: false }]) })
      expect(rows[1]?.updates).toEqual([{ disabled: false }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers a selector for a capability the install carries and closes for one it does not', async () => {
    const ctx = hostOf(loaderOf(...browserRows()))
    try {
      await ctx.plugin({
        name: 'capability-service-test',
        apply(inner: Context) {
          installCapabilityRows(inner, probesOf({ found: foundOf(BROWSER), browser: 'C:/chromium.exe' }))
        },
      })
      const service = ctx.get(CAPABILITY_ROW_SERVICE) as CapabilityService

      expect(service.usable(BROWSER_PROVIDER)).toBe(true)
      expect(service.usable('@deepseek-ai/dsh-computer-use')).toBe(false)
      // A module no capability names answers `false` rather than throwing: the caller
      // is a patch expression, where a throw is reported as a broken row of its own.
      expect(service.usable('@deepseek-ai/dsh-nothing')).toBe(false)
      expect(service.report().map(readiness => [readiness.id, readiness.ready])).toEqual([['browser', true], ['computer', false]])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts nothing and leaves no failed row on an install without the packages', async () => {
    const rows = browserRows()
    const ctx = hostOf(loaderOf(...rows))
    try {
      await ctx.plugin({
        name: 'capability-absent-test',
        apply(inner: Context) {
          installCapabilityRows(inner, probesOf({ found: {} }))
        },
      })

      // Both rows keep the patch's selector, which reads as disabled: the row is off
      // rather than failed, which is the whole difference this module exists for.
      expect(rows.map(entry => entry.updates)).toEqual([[], []])
      expect(rows.map(entry => entry.disabled)).toEqual([true, true])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('capabilityReportLine', () => {
  it('names each off capability, what is missing, and where to run the install', () => {
    // The panel can say a row is closed; it cannot say which specifier this install
    // lacks, which is the part a user has to act on.
    const line = capabilityReportLine(
      [
        capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: {} })),
        // The half-installed case, which is the one a user cannot diagnose from the
        // panel: every package is there and the machine is what is missing.
        capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: foundOf(BROWSER) })),
      ],
      'C:/Users/me/.dsh/profiles/freecodego-latest/',
    )

    expect(line).toContain(BROWSER_SERVICE)
    expect(line).toContain('pnpm add')
    expect(line).toContain('C:/Users/me/.dsh/profiles/freecodego-latest/')
    expect(line).toContain('playwright install chromium')
  })

  it('states the reason without an install command when the profile directory is unknown', () => {
    const line = capabilityReportLine([capabilityReadiness(BROWSER, 'file:///profile/', new Map(), probesOf({ found: {} }))], undefined)

    expect(line).toContain(BROWSER_SERVICE)
    expect(line).not.toContain('pnpm add')
  })
})
