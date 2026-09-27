import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// Read from the plugin rather than restated: the patch's selectors and this table
// are two halves of one decision, and a spec that spelled the ids out would keep
// passing while the two drifted apart.
import { CAPABILITIES, CAPABILITY_ENTRY_IDS, CAPABILITY_ROW_SERVICE } from '../src/capability-rows.ts'
import { OFFICIAL_ROW_SERVICE } from '../src/stand-in-rows.ts'

const bundleDirectory = resolve(import.meta.dirname, '../../bundle-latest')
const sourceDirectory = resolve(import.meta.dirname, '../src')
const clientEntry = resolve(import.meta.dirname, '../../harness-ui/src/client/index.ts')
const workspaceDirectory = resolve(import.meta.dirname, '../../../..')

describe('FreeCodeGo RC.1 composition', () => {
  it('uses RC.1 public seams, the official picker, and no archived runtime graph', async () => {
    const manifest = JSON.parse(await readFile(resolve(bundleDirectory, 'package.json'), 'utf8')) as {
      readonly name: string
      readonly dependencies: Readonly<Record<string, string>>
      readonly peerDependencies: Readonly<Record<string, string>>
      readonly freecodego?: { readonly harnessBaseline?: string }
      readonly dsh?: Readonly<Record<string, unknown>> & {
        readonly client?: { readonly inject?: readonly string[] }
      }
    }
    const patch = await readFile(resolve(bundleDirectory, 'cordis.patch.yml'), 'utf8')

    expect(manifest.name).toBe('freecodego')
    expect(manifest.freecodego?.harnessBaseline).toBe('0.1.7-rc.2')
    // `dsh.bootstrap` used to be declared here, naming `bootstrapFreeCodeGoHarness`. It was
    // never part of the Harness contract — `DshManifest` declares `bundle`, `profile` and
    // `client` — and no reader anywhere resolved it, so the pre-Loader window it advertised
    // could not happen: both of that function's effects come from composition rows, and this
    // plugin is itself a Loader entry. Pinned absent so a declared entry point with no loader
    // behind it cannot come back unnoticed.
    expect(manifest.dsh).not.toHaveProperty('bootstrap')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(manifest.dependencies).toEqual({
      '@anthropic-ai/claude-agent-sdk': '0.3.246',
      // The Codex subagent provider locates its `app-server` binary through this
      // package's manifest, so it is a runtime dependency of the two provider
      // artifacts this bundle ships — not a build-time one.
      '@openai/codex': '0.153.4',
      'eventsource-parser': '^3.1.0',
      'js-yaml': '^4.2.0',
      tar: '7.5.2',
      // The workflow script gate type-checks a model's script against the façade
      // before the run publishes a child, so the compiler is a real dependency of
      // the published artifact and not a build-time one. Loaded lazily, on the
      // first call that actually carries a script.
      typescript: '^6.0.3',
      zod: '^4.4.3',
    })
    expect(Object.keys(manifest.peerDependencies)).toContain('@deepseek-ai/cordis')
    expect(patch).toContain("name: 'freecodego'")
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-freecodego-agent-engine-router'")
    expect(patch).toContain('freeCodeGoSessionEvents')
    expect(patch).toContain("name: 'freecodego/session-events'")
    expect(patch).toContain('powered by FreeCodeGo')
    expect(patch).not.toContain('{{model}}')
    expect(patch).not.toContain("name: '@freecodego/dsh-client-ui-model-selection'")
    expect(patch).not.toMatch(/dsh-agent-engine|dsh-client-runtime|registerFactory|v012/)
  })

  it('mounts the plugin as its own Loader entry rather than from the bundle', async () => {
    // The settings plane only reaches a plugin that *is* a Loader entry: the service
    // addresses it by entry id, reads `entry.fiber.config`, and validates a write against
    // that entry's `Config`. Mounted with `ctx.plugin()` from the bundle's `apply`, this
    // plugin inherited the `freecodego` row instead — which has no schema — so every write
    // was refused with `No configurable plugin entry "freecodego"` and every read answered
    // the empty document. The row below is what makes the FreeCodeGo settings tab work, and
    // it is also the id `harness-ui` and `plugin-conflicts.ts` name, so a regression here is
    // silent in production and only visible as switches that will not stay on.
    const manifest = JSON.parse(await readFile(resolve(bundleDirectory, 'package.json'), 'utf8')) as {
      readonly exports?: Readonly<Record<string, string>>
      readonly files?: readonly string[]
    }
    const patch = read(resolve(bundleDirectory, 'cordis.patch.yml'))
    const entry = read(resolve(bundleDirectory, 'src/index.ts'))

    const row = compositionRows(patch, 'freecodego/bundle-latest/cordis.patch.yml')
      .find(candidate => candidate.id === 'freecodego-harness-plugin')
    expect(row?.name).toBe('freecodego/harness-plugin')
    expect(row?.body).toMatch(/^\s+config:/mu)
    // The plugin has to be the *default* export of what the row names, so the row must not
    // share the bundle's entry module: that one default-exports nothing and bundles `apply`.
    expect(row?.name).not.toBe('freecodego')
    expect(manifest.exports?.['./harness-plugin']).toBe('./dist/harness-plugin.js')
    expect(manifest.files).toContain('dist/harness-plugin.js')
    // And the programmatic mount must be gone, or the plugin would be constructed twice.
    expect(entry).not.toContain('ctx.plugin(FreeCodeGoHarnessPlugin')
    expect(entry).toContain('export { FreeCodeGoHarnessPlugin,')
  })

  it('supplies every provider the composed tree names, from a row it keeps mounted', () => {
    // A `disabled: true` line reads like housekeeping, and it is not: the
    // composition refers to rows through provider ids (`web.searchProvider`,
    // `agent-default-model.provider`), and nothing in the loader checks that a
    // *mounted* row still supplies the id that is named. Disabling the supplier
    // therefore does not degrade one feature, it makes the capability throw:
    // `web-search-deepseek` is the only row supplying `deepseek-official` for
    // `searchProvider`, so disabling it turned every `web_search` into the
    // Harness's own `WEB_PROVIDER_CONFIGURED_MISSING`
    // (`packages/web/web/src/index.ts`), and `llm-deepseek` supplies the same id
    // for the LLM route, so a fresh profile's default model named nothing. Since
    // 0.1.7-rc.2 that row mounts `@deepseek-ai/dsh-llm-deepseek-api-key` and a
    // second row registers `deepseek-account` beside it, which is why the
    // supplier scan below follows one import hop (see `supplies`).
    //
    // The rule this asserts is the one the plugin's composition follows: a row
    // is disabled only when the id it supplied is still supplied by a row that
    // stays mounted — the replacement exists *before* the disable does. When a
    // deployment wants a capability gone, it drops the reference with the row,
    // and this keeps failing until it does, because a reference with no supplier
    // is not a degraded feature but a broken one.
    const basePath = resolve(workspaceDirectory, 'packages/bundle/base/cordis.patch.yml')
    // The base composition is upstream source, absent in a checkout synced
    // without it, and there is nothing to compose against there.
    if (!existsSync(basePath)) return
    const base = compositionRows(read(basePath), 'bundle/base/cordis.patch.yml')
    const patch = compositionRows(read(resolve(bundleDirectory, 'cordis.patch.yml')), 'freecodego/bundle-latest/cordis.patch.yml')

    // A patch row modifies the row of the same id: it states only what it
    // changes, so `name` comes from whichever file declared it and an unstated
    // `disabled` inherits.
    const byId = new Map(base.map(row => [row.id, row] as const))
    for (const row of patch) {
      const declared = byId.get(row.id)
      byId.set(row.id, {
        ...row,
        name: row.name ?? declared?.name,
        disabled: row.disabled ?? declared?.disabled ?? false,
      })
    }
    const mounted = [...byId.values()].filter(row => !row.disabled)

    // Both denominators are read out of text, so a parser that stopped matching
    // would let everything below pass over an empty tree.
    const references: Array<{ readonly row: CompositionRow; readonly key: string; readonly id: string; readonly api: string }> = []
    const unmodelled: string[] = []
    for (const row of mounted) {
      for (const reference of providerReferences(row.body)) {
        const registry = providerRegistries.find(entry => entry.row === row.id && entry.key === reference.key)
        if (registry === undefined) {
          unmodelled.push(`${row.id}.${reference.key}`)
          continue
        }
        references.push({ row, key: reference.key, id: reference.id, api: registry.api })
      }
    }
    expect(unmodelled).toStrictEqual([])
    expect(references.length).toBeGreaterThan(0)
    expect(mounted.length).toBeGreaterThan(0)
    // Every Harness row must resolve to a package, or the supplier scan below
    // would report a missing supplier for a row that is right there.
    expect(
      [...byId.values()]
        .filter(row => row.name?.startsWith('@deepseek-ai/dsh-') === true && packageSource(row.name) === undefined)
        .map(row => `${row.id}: ${row.name}`),
    ).toStrictEqual([])

    const unsupplied: string[] = []
    for (const reference of references) {
      const suppliers = [...byId.values()].filter(row => row.name !== undefined && supplies(row.name, reference.id, reference.api))
      if (suppliers.some(row => !row.disabled)) continue
      const disabled = suppliers.map(row => `${row.id} (${row.source})`)
      unsupplied.push(
        `${reference.row.id}.${reference.key} names "${reference.id}", which no mounted row supplies` +
          (disabled.length > 0 ? `; it was supplied by ${disabled.join(', ')}` : ''),
      )
    }
    expect(unsupplied).toStrictEqual([])
  })

  it('mounts the optional Harness capabilities behind the install probe, one provider each', async () => {
    // Browser and desktop control are the Harness's own experimental providers.
    // They are not in this bundle's `peerDependencies` — the list that *is* the
    // install contract — and upstream documents them as activating "only when
    // explicitly mounted". What an unresolvable *enabled* row costs depends on the
    // grain: in a preset, one makes the whole preset unselectable
    // (`agent-presets/src/discovery.ts`, `unresolvableRows`, skips a row only
    // while `Boolean(row.disabled)`), while a host-plane row that cannot load fails
    // that entry alone and is reported as `did not activate` on every boot. So
    // these rows are neither plainly enabled nor plainly off: they carry this
    // plugin's capability selector (`capability-rows.ts`), whose fallback is `true`
    // and which the plugin answers from whether the packages resolve.
    //
    // Two rules are pinned here, and they are the rule rather than the instance.
    // First, a row outside the install contract may only be enabled by *that*
    // selector: a later edit that writes `disabled: false` on one of them, or adds
    // a row naming another package the Harness need not supply, fails here.
    // Second, the patch and the plugin's table have to agree in both directions,
    // because either half alone is inert — a table entry with no selector is a
    // capability the plugin would start and the patch would keep off, and a
    // selector with no table entry is a row that can never be answered.
    const manifest = JSON.parse(await readFile(resolve(bundleDirectory, 'package.json'), 'utf8')) as {
      readonly peerDependencies: Readonly<Record<string, string>>
    }
    const patch = compositionRows(read(resolve(bundleDirectory, 'cordis.patch.yml')), 'freecodego/bundle-latest/cordis.patch.yml')
    const harnessRows = patch.filter(row => row.name?.startsWith('@deepseek-ai/dsh-') === true)
    expect(harnessRows.length).toBeGreaterThan(0)

    expect(
      harnessRows
        .filter(row => row.disabled !== true && row.selector === undefined && manifest.peerDependencies[row.name ?? ''] === undefined)
        .map(row => `${row.id}: ${row.name}`),
    ).toStrictEqual([])

    const capabilityRows = harnessRows.filter(row => row.selector?.includes(CAPABILITY_ROW_SERVICE) === true)
    expect(capabilityRows.map(row => row.id).sort()).toStrictEqual([...CAPABILITY_ENTRY_IDS].sort())
    // Each selector asks about the capability its *own* row names, so the answer
    // a row gets is about the code that row imports and not about its neighbour's.
    for (const row of capabilityRows) {
      expect(row.selector).toContain(`usable('${row.name ?? ''}')`)
    }
    // And every specifier the probe checks has to be answerable from the patch as
    // it stands: either the install contract promises it, or it is a row the
    // selector gates (so "it resolves" and "its row may start" are the same
    // question), or it is a dependency of one of those rows and says which. A
    // specifier with none of the three would be a requirement no edit to this
    // composition could satisfy.
    const rowNames = new Set(capabilityRows.map(row => row.name))
    for (const capability of CAPABILITIES) {
      for (const module_ of capability.modules) {
        const answerable = manifest.peerDependencies[module_.specifier] !== undefined
          || rowNames.has(module_.specifier)
          || module_.from !== undefined
        expect(answerable, `${capability.id}: ${module_.specifier}`).toBe(true)
      }
    }

    const named = new Map(harnessRows.map(row => [row.id, row.name ?? ''] as const))
    expect(named.get('browser-use')).toBe('@deepseek-ai/dsh-browser-use')
    expect(named.get('browser-use-playwright-mcp')).toBe('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')
    expect(named.get('computer-use')).toBe('@deepseek-ai/dsh-computer-use')
    expect(named.get('computer-use-cua-driver-native')).toBe('@deepseek-ai/dsh-experimental-computer-use-cua-driver-native')

    // `ctx.browserUse` and `ctx.computerUse` each hold exactly one slot and
    // reject a second registration, so an alternative provider is a swap: two
    // rows here would be a composition that fails at mount rather than a
    // deployment with a choice.
    const browsers = harnessRows.filter(row => /browser-use-(?:playwright-mcp|chrome-devtools-mcp|stagehand-native)$/u.test(row.name ?? ''))
    const desktops = harnessRows.filter(row => /computer-use-cua-driver-(?:native|mcp)$/u.test(row.name ?? ''))
    expect(browsers.map(row => row.id)).toStrictEqual(['browser-use-playwright-mcp'])
    expect(desktops.map(row => row.id)).toStrictEqual(['computer-use-cua-driver-native'])

    // `mode` is required by the Playwright provider and has no default, so the
    // row is only a working opt-in while it states one; the native desktop
    // provider takes no configuration at all.
    expect(browsers[0]?.body).toMatch(/^\s+mode:\s*launch\s*$/mu)
    expect(harnessRows.find(row => row.id === 'computer-use-cua-driver-native')?.body).not.toMatch(/^\s+config:\s*$/mu)
  })

  it('mounts session-history tools on by default without naming the official package', async () => {
    // This row is the one mount in this bundle that needs nothing installed, so it
    // is on by default rather than selected: the package injects services the base
    // already mounts, and no upstream bundle mounts the tool package itself. It
    // names this bundle's own build of upstream's source (`freecodego/tool-session-query`)
    // so the capability works on an install with nothing else added, and it still
    // stands down for a composition that mounts the official package — which is what
    // the selector asks about, so a later edit cannot quietly mount both and hand the
    // model two copies of the same five tools.
    //
    // The pairing with the base is asserted rather than assumed: a missing
    // `ctx.sessionQuery` would leave this row permanently pending, and a missing
    // provider would leave it failing, both silently as far as this file is
    // concerned — together with the one caveat that makes the row useful only
    // half-way, which is why this file states the `openAt` override next to it.
    const patchText = read(resolve(bundleDirectory, 'cordis.patch.yml'))
    const patch = compositionRows(patchText, 'freecodego/bundle-latest/cordis.patch.yml')
    const row = patch.find(entry => entry.id === 'tool-session-query')
    expect(row?.name).toBe('freecodego/tool-session-query')
    expect(row?.disabled).toBeUndefined()
    expect(row?.selector).toContain(OFFICIAL_ROW_SERVICE)
    expect(row?.selector).toContain('@deepseek-ai/dsh-tool-session-query')
    // The second switch, and it is this file's own layer: the base keeps SQLite
    // closed on purpose, so the pair has to be turned on here or the two search
    // tools answer SESSION_QUERY_SEARCH_DISABLED for good.
    const override = patch.filter(entry => entry.id === 'session-query-sqlite')
    expect(override).toHaveLength(1)
    expect(override[0]?.body).toMatch(/^\s+openAt:\s*first-search\s*$/mu)
    expect(override[0]?.body).toMatch(/^\s+path:\s*!!js\s+dshHomePath\('session-index\.db'\)\s*$/mu)

    const toolEntry = resolve(workspaceDirectory, 'packages/session-query/tool-session-query/src/index.ts')
    const basePath = resolve(workspaceDirectory, 'packages/bundle/base/cordis.patch.yml')
    if (!existsSync(toolEntry) || !existsSync(basePath)) return

    // Read from the package rather than restated here: an injection list this
    // spec guessed would be a second answer to what the row needs.
    const injected = /export const inject = \[([^\]]*)\]/u.exec(read(toolEntry))?.[1] ?? ''
    const services = [...injected.matchAll(/'([^']+)'/gu)].map(match => match[1])
    expect(services).toContain('sessionQuery')
    expect(services).toContain('sessionProjections')

    const base = compositionRows(read(basePath), 'bundle/base/cordis.patch.yml')
    const owner = base.find(entry => entry.name === '@deepseek-ai/dsh-session-query-sqlite')
    expect(owner).toBeDefined()
    expect(base.some(entry => entry.name === '@deepseek-ai/dsh-session-projection')).toBe(true)
    // Content search is off in the base on purpose, and `openAt: never` is how it
    // says so: the service stays mounted while SQLite is never opened, so the two
    // search tools answer SESSION_QUERY_SEARCH_DISABLED until a later patch layer
    // overrides it. If that ever becomes the base's active default, the caveat
    // this file documents would be stale rather than the row broken — which is
    // exactly the kind of drift a note cannot catch on its own.
    expect(owner?.body).toMatch(/^\s+openAt:\s*never\s*$/mu)
  })

  it('enables the Harness scheduler instead of mounting a second copy of it', async () => {
    // 0.1.7-rc.2 declares `schedule` and `time-context` in the Web composition and
    // leaves them disabled; alpha.2 declared neither, which is why this plugin used
    // to compile the scheduler package into its own payload and mount a row of its
    // own for it. Two mounts of one service is the failure this avoids, and the
    // premise it depends on is upstream's, so the premise is read from upstream's
    // file rather than restated: if rc.3 stops declaring either row, the override
    // below becomes a stderr warning and the capability silently disappears — a
    // note cannot catch that.
    const webAppPath = resolve(workspaceDirectory, 'packages/bundle/web-app/cordis.patch.yml')
    const patch = compositionRows(read(resolve(bundleDirectory, 'cordis.patch.yml')), 'freecodego/bundle-latest/cordis.patch.yml')

    expect(patch.find(row => row.id === 'schedule')?.disabled).toBe(false)
    expect(patch.find(row => row.id === 'time-context')?.disabled).toBe(false)
    // And no scheduler row of this bundle's own: the copy that used to sit here is
    // deleted, because with the Web composition's rows enabled it could only ever
    // have been a second mount of one service. This is the assertion that a
    // reintroduced copy has to fail.
    expect(patch.find(row => row.name === 'freecodego/schedule')).toBeUndefined()

    if (!existsSync(webAppPath)) return
    const webApp = compositionRows(read(webAppPath), 'bundle/web-app/cordis.patch.yml')
    expect(webApp.find(row => row.id === 'schedule')?.name).toBe('@deepseek-ai/dsh-schedule')
    expect(webApp.find(row => row.id === 'time-context')?.name).toBe('@deepseek-ai/dsh-time-context')
    // The override is only an *enable* while upstream keeps them off by default.
    expect(webApp.find(row => row.id === 'schedule')?.disabled).toBe(true)
    expect(webApp.find(row => row.id === 'time-context')?.disabled).toBe(true)
    // No upstream bundle may declare the scheduler a second time, or enabling one
    // row would leave the other as a competing mount this file cannot see.
    expect(webApp.filter(row => row.name === '@deepseek-ai/dsh-schedule')).toHaveLength(1)
  })

  it('does not depend on unpublished Harness source subpaths', async () => {
    const files = ['agnes.ts', 'openai-compatible-adapter.ts', 'engineering.ts']
    const sources = await Promise.all(files.map(file => readFile(resolve(sourceDirectory, file), 'utf8')))
    expect(sources.join('\n')).not.toContain('@deepseek-ai/dsh-llm-deepseek/src/')

    // Every source file, not just those three. `./src/*` is a development alias the
    // Harness packages grant for their own internal imports, and their published `files`
    // ship `lib/**` alone -- so a bundle built from a `…/src/…` specifier loads in this
    // workspace and dies in a packaged runtime with `Cannot find module`. One such import
    // (the meter's `src/estimate.ts`) failed the Desktop bundle outright: the shared
    // Host refused `sessionPersistence`, and every entry that waits on a service the
    // plugin's rows provide stayed pending behind it.
    const specifiers = [...(readSources(sourceDirectory) ?? '')
      .matchAll(/['"](@deepseek-ai\/[a-z0-9-]+\/src\/[^'"]+)['"]/gu)]
    expect(specifiers.map(match => match[1])).toEqual([])
  })

  it('declares the conversation service used by Agent progress rendering', async () => {
    const source = await readFile(clientEntry, 'utf8')
    expect(source).toMatch(/export const inject = \[[^\]]*'uiConversation'/u)
  })
})

/**
 * Which registry a provider reference resolves against.
 *
 * A provider id is only meaningful inside its registry, and two registries can
 * share one string: `deepseek-official` names both the LLM route
 * (`ctx.llm.registerAdapter`, referenced as `provider:` by `agent-default-model`)
 * and the web search provider (`ctx.web.registerSearchProvider`, referenced as
 * `searchProvider:` by `web`). Matching suppliers on the id alone would let one
 * registry satisfy the other's reference — the break this exists to catch — so
 * the registration call is part of the match.
 *
 * A provider reference on a mounted row that is not listed here fails the test
 * rather than being skipped: an unmodelled registry would otherwise be a hole
 * that a new composition walks straight through. `tool-ralph` is listed though
 * the base disables it, because a profile patch may re-enable it.
 *
 * The plugin's own rows are absent on purpose, and one of them used to be here.
 * `freecodego/tool-agent-team` named `subagent-spawn-in-process` /
 * `subagent-fork-in-process` in its config, which is why a disable of either had
 * to fail: that row delegated through the Harness's own backends. The row is gone
 * — the official team bundle mounts the same module by name — and the plugin's
 * remaining team tooling reaches engines through `ctx.agents`, not through a
 * configured provider id, so no plugin row states one to model here.
 */
const providerRegistries = [
  { row: 'agent-default-model', key: 'provider', api: 'registerAdapter' },
  { row: 'tool-subagent', key: 'provider', api: 'registerProvider' },
  { row: 'tool-subagent-fork', key: 'provider', api: 'registerProvider' },
  { row: 'workflow-ptc', key: 'provider', api: 'registerProvider' },
  { row: 'tool-ralph', key: 'subagentProvider', api: 'registerProvider' },
  { row: 'web', key: 'searchProvider', api: 'registerSearchProvider' },
  { row: 'web', key: 'fetchProvider', api: 'registerFetchProvider' },
] as const

interface CompositionRow {
  readonly id: string
  readonly name: string | undefined
  /** Undefined when the row states nothing, which is how a patch inherits. */
  readonly disabled: boolean | undefined
  /**
   * The `!!js` expression a row states instead of a value, when it states one.
   *
   * Kept beside {@link disabled} rather than folded into it because the two are not
   * the same statement: a boolean is what a deployment decided, while an expression
   * is a question the Loader re-asks at every recomposition. {@link disabled} is
   * `undefined` for a selector row, which is why the rule below reads them apart.
   */
  readonly selector?: string | undefined
  readonly body: string
  readonly source: string
}

/**
 * The `- id: <row>` entries of a composition patch, each with the lines that
 * belong to it. Rows nest (`config:` holds further rows), and a nested row is a
 * row in its own right, so every `- id:` line starts one and a row's own
 * properties stop at the next: scoping by indentation would fold a nested row's
 * `disabled:` into its parent's.
 */
function compositionRows(text: string, source: string): CompositionRow[] {
  const lines = text.split('\n')
  const rows: CompositionRow[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^(\s*)- id:\s*(\S+)\s*$/u.exec(lines[index] ?? '')
    if (head === null) continue
    const indent = head[1]?.length ?? 0
    const own = [lines[index] ?? '']
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? ''
      if (/^\s*- id:/u.test(line)) break
      const lineIndent = line.length - line.trimStart().length
      if (line.trim() !== '' && lineIndent <= indent) break
      own.push(line)
    }
    const body = own.join('\n')
    const stated = /^\s+disabled:\s*(true|false)\s*$/mu.exec(body)?.[1]
    rows.push({
      id: head[2] ?? '',
      name: /^\s+name:\s*'([^']+)'/mu.exec(body)?.[1],
      disabled: stated === undefined ? undefined : stated === 'true',
      selector: /^\s+disabled:\s*!!js\s+"([^"]*)"\s*$/mu.exec(body)?.[1],
      body,
      source,
    })
  }
  return rows
}

/**
 * Every `…Provider:` / `provider:` assignment a row states, comments excluded.
 * `subagentProvider` is a key in its own right, not a `provider` under a
 * prefix, so the match takes the whole key word.
 */
function providerReferences(body: string): Array<{ readonly key: string; readonly id: string }> {
  const found: Array<{ key: string; id: string }> = []
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    const match = /(?:^|\s)(\w*[Pp]rovider)\s*:\s*['"]?([\w@/.-]+)/u.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    found.push({ key: match[1], id: match[2] })
  }
  return found
}

/**
 * Whether a package supplies a provider id for a registry: the package declares
 * the id and reaches that registry's registration API — itself, or through a
 * helper it imports from another Harness package. Both are read from the
 * package's sources rather than inferred from its name, because the name says
 * nothing about which registry it registers into.
 *
 * The helper hop is `0.1.7-rc.2`'s shape. The DeepSeek route is two rows now,
 * and the api-key row (`@deepseek-ai/dsh-llm-deepseek-api-key`) declares
 * `'deepseek-official'` while registering through `registerDeepSeekProvider`,
 * imported from `@deepseek-ai/dsh-llm-deepseek` — the package whose body calls
 * `ctx.llm.registerAdapter`. A scan that read only the row's own package
 * reported the base's `agent-default-model.provider` as unsupplied with that row
 * mounted: a guard failing on a composition that is correct, which is worse than
 * the break it exists to catch, because it gets "fixed" by widening the disable
 * it was protecting. The hop stays one import deep and only counts bindings the
 * imported package actually exports, so "declares the id somewhere, imports
 * something" is not enough to be read as a supplier.
 */
function supplies(name: string, providerId: string, api: string): boolean {
  const source = packageSource(name)
  if (source === undefined) return false
  const declared = source.includes(`'${providerId}'`) || source.includes(`"${providerId}"`)
  if (!declared) return false
  return [source, ...importedHelperSources(source, name)].some(text => text.includes(`.${api}(`))
}

/**
 * The sources of packages a package imports named bindings from, one hop deep.
 * A specifier counts only when the binding is exported by the package it names,
 * which keeps a re-exported constant and a look-alike name out of the match.
 */
function importedHelperSources(source: string, name: string): string[] {
  const sources = new Set<string>()
  for (const statement of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@deepseek-ai\/dsh-[^'"]+)['"]/gu)) {
    const specifier = statement[2]
    if (specifier === undefined || specifier === name) continue
    const imported = packageSource(specifier)
    if (imported === undefined) continue
    const bindings = (statement[1] ?? '').split(',')
    if (!bindings.some(binding => {
      const symbol = binding.trim().split(/\s+as\s+/u)[0]?.replace(/^type\s+/u, '').trim() ?? ''
      return symbol !== '' && new RegExp(`export[^\n]*\\b${symbol}\\b`, 'u').test(imported)
    })) continue
    sources.add(imported)
  }
  return [...sources]
}

/** Name → directory for every package the working checkout holds. */
const packageDirectories = new Map<string, string>()
function packageDirectory(name: string): string | undefined {
  if (packageDirectories.size === 0) {
    const packages = resolve(workspaceDirectory, 'packages')
    for (const scope of existsSync(packages) ? readdirSync(packages, { withFileTypes: true }) : []) {
      if (!scope.isDirectory()) continue
      for (const entry of readdirSync(resolve(packages, scope.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const manifest = resolve(packages, scope.name, entry.name, 'package.json')
        if (!existsSync(manifest)) continue
        const declared = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly name?: string }
        if (declared.name !== undefined) packageDirectories.set(declared.name, resolve(packages, scope.name, entry.name))
      }
    }
  }
  // A row may mount a package subpath (`…dsh-tool-subagent-control/list-agents`).
  const trimmed = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
  return packageDirectories.get(trimmed)
}

/** A package's `src` sources, concatenated once and reused across references. */
const packageSources = new Map<string, string | undefined>()
function packageSource(name: string): string | undefined {
  const directory = packageDirectory(name)
  if (directory === undefined) return undefined
  const key = directory
  if (!packageSources.has(key)) packageSources.set(key, readSources(resolve(directory, 'src')))
  return packageSources.get(key)
}

function readSources(directory: string): string | undefined {
  if (!existsSync(directory)) return undefined
  const parts: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = readSources(resolve(directory, entry.name))
      if (nested !== undefined) parts.push(nested)
      continue
    }
    if (entry.name.endsWith('.ts')) parts.push(read(resolve(directory, entry.name)))
  }
  return parts.join('\n')
}

function read(path: string): string {
  // Line endings are normalized in the reader rather than in the patterns: this
  // checkout's working copies mix LF and CRLF, and a `\n` baked into a pattern
  // is how a guard comes to pass over a file it no longer reads.
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
}
