// Web e2e scenario: the optional Harness capabilities the FreeCodeGo bundle
// mounts on a *real* Host, where the question they are gated on is answered by
// the running tree rather than by the test.
//
// Both halves of `capability-rows.ts` are visible here, and each is the half the
// other cannot show. The capabilities this install cannot run — browser and
// desktop control, whose packages are not part of the bundle's install contract —
// have to be *off* rather than failed: on a row that is plainly enabled the Loader
// imports, fails, and reports one `did not activate` entry per row on every boot,
// which is the state this file pins. And session-history retrieval has to be
// *serving*, because it is the one capability that needs nothing installed: the
// bundle ships upstream's own tool package as this composition's artifact, so the
// five tools exist on an install that added nothing.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const FREECODEGO_BUNDLE = fileURLToPath(new URL('../../../packages/freecodego/bundle-latest', import.meta.url))

/**
 * The rows whose packages this bundle does not ship and the Harness need not
 * supply, so they are the ones whose `disabled` has to keep answering `true`.
 */
const UNSUPPORTED_ROWS = ['browser-use', 'browser-use-playwright-mcp', 'computer-use', 'computer-use-cua-driver-native'] as const

/** The tools upstream's own package registers, which mounting it is supposed to reach. */
const SESSION_HISTORY_TOOLS = ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read'] as const

describe('web e2e: the optional Harness capabilities this bundle mounts', () => {
  it('leaves the capabilities this install cannot run closed, and serves the one it carries', async () => {
    const scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
    })
    try {
      const rows = [...scaffold.ctx.loader.entries()] as readonly {
        options: { id?: string, name?: string }
        fiber?: { uid?: unknown } | undefined
        disabled?: unknown
      }[]
      const rowOf = (id: string): (typeof rows)[number] | undefined => rows.find(row => row.options.id === id)
      // Reading a selector is the very act that throws when the expression names
      // something this context cannot answer, so the read itself is asserted.
      const stateOf = (row: (typeof rows)[number] | undefined): string => {
        try {
          return `${String(row?.disabled)}/${String(row?.fiber?.uid)}`
        } catch (error) {
          return `throws:${error instanceof Error ? error.message : String(error)}`
        }
      }

      for (const id of UNSUPPORTED_ROWS) {
        const row = rowOf(id)
        expect(row, `${id} must be mounted, or the capability is not offered at all`).toBeDefined()
        // `true`/`undefined`: the selector answered "off" and the Loader never
        // imported the module. A row that failed to import reads `false` with no
        // fiber, which is exactly what a plain `disabled: false` produced here.
        expect(stateOf(row), `${id} must be closed rather than failed`).toBe('true/undefined')
      }

      // And the question those rows ask has to be answerable at all: the selectors
      // name the service this plugin provides, so a composition that mounts the rows
      // without the plugin leaves them off for the right reason (nothing answers the
      // selector) rather than by luck. Asked through the same accessor the patch's
      // expression uses, because that is what decides whether a row can start.
      const capabilities = (scaffold.ctx as unknown as { get(name: string): unknown }).get('freecodegoCapabilities') as
        { usable(moduleName: string): boolean; report(): readonly { readonly id: string; readonly ready: boolean }[] } | undefined
      expect(capabilities, 'the selectors ask this service, so the plugin has to provide it').toBeDefined()
      expect(capabilities?.usable('@deepseek-ai/dsh-browser-use')).toBe(false)
      expect(capabilities?.report().map(readiness => `${readiness.id}:${String(readiness.ready)}`))
        .toEqual(['browser:false', 'computer:false'])

      const history = rowOf('tool-session-query')
      expect(String(history?.options.name)).toBe('freecodego/tool-session-query')
      // Serving: this bundle's own artifact of upstream's package, mounted with no
      // dependency of its own to install.
      expect(String(history?.fiber?.uid), 'session-history retrieval must serve').not.toBe('null')
      const names = scaffold.ctx.tools.schemas().map(schema => schema.name)
      expect(names.filter(name => SESSION_HISTORY_TOOLS.includes(name as typeof SESSION_HISTORY_TOOLS[number])).sort())
        .toEqual([...SESSION_HISTORY_TOOLS].sort())
    } finally {
      await scaffold.close().catch(() => undefined)
    }
  }, 120_000)
})
