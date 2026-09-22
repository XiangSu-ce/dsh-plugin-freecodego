import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
      readonly dsh?: {
        readonly bootstrap?: { readonly export?: string }
        readonly client?: { readonly inject?: readonly string[] }
      }
    }
    const patch = await readFile(resolve(bundleDirectory, 'cordis.patch.yml'), 'utf8')

    expect(manifest.name).toBe('freecodego')
    expect(manifest.freecodego?.harnessBaseline).toBe('0.1.6-alpha.2')
    expect(manifest.dsh?.bootstrap?.export).toBe('bootstrapFreeCodeGoHarness')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(manifest.dependencies).toEqual({
      '@anthropic-ai/claude-agent-sdk': '0.3.246',
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
    // for the LLM route, so a fresh profile's default model named nothing.
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

  it('mounts the optional Harness capabilities only as disabled rows, one provider each', async () => {
    // Browser and desktop control are the Harness's own experimental providers.
    // They are not in this bundle's `peerDependencies` — the list that *is* the
    // install contract — and upstream documents them as activating "only when
    // explicitly mounted", so an enabled row would name a package the Harness
    // need not supply. What that costs depends on the grain: in a preset, one
    // unresolvable enabled row makes the whole preset unselectable
    // (`agent-presets/src/discovery.ts`, `unresolvableRows`, skips a row only
    // while `Boolean(row.disabled)`), while a host-plane row that cannot load
    // fails that entry alone. This file's own composition therefore holds them
    // disabled, and the recipe is asserted here so a later edit cannot quietly
    // turn one on — or add a second provider, which both registries reject.
    const manifest = JSON.parse(await readFile(resolve(bundleDirectory, 'package.json'), 'utf8')) as {
      readonly peerDependencies: Readonly<Record<string, string>>
    }
    const patch = compositionRows(read(resolve(bundleDirectory, 'cordis.patch.yml')), 'freecodego/bundle-latest/cordis.patch.yml')
    const harnessRows = patch.filter(row => row.name?.startsWith('@deepseek-ai/dsh-') === true)
    expect(harnessRows.length).toBeGreaterThan(0)

    // The rule, not the instance: an enabled row may only name a package the
    // install contract promises.
    expect(
      harnessRows
        .filter(row => row.disabled !== true && manifest.peerDependencies[row.name ?? ''] === undefined)
        .map(row => `${row.id}: ${row.name}`),
    ).toStrictEqual([])

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

  it('mounts session-history tools as an opt-in whose services the base already supplies', async () => {
    // The row is only the *whole* opt-in while the base composition keeps
    // supplying what the tools inject. Nothing in the Loader checks that pairing:
    // a missing `ctx.sessionQuery` would leave this row permanently pending, and a
    // missing provider would leave it failing, both silently as far as this file
    // is concerned. So the pair is asserted rather than assumed — together with
    // the one caveat that makes the row useful only half-way, which is why this
    // file states the `openAt` override next to it.
    const patch = compositionRows(read(resolve(bundleDirectory, 'cordis.patch.yml')), 'freecodego/bundle-latest/cordis.patch.yml')
    const row = patch.find(entry => entry.id === 'tool-session-query')
    expect(row?.name).toBe('@deepseek-ai/dsh-tool-session-query')
    expect(row?.disabled).toBe(true)

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

  it('does not depend on unpublished Harness source subpaths', async () => {
    const files = ['agnes.ts', 'openai-compatible-adapter.ts', 'engineering.ts']
    const sources = await Promise.all(files.map(file => readFile(resolve(sourceDirectory, file), 'utf8')))
    expect(sources.join('\n')).not.toContain('@deepseek-ai/dsh-llm-deepseek/src/')
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
 * The two plugin rows are the ones that consume the Harness's subagent backends
 * rather than supplying their own — the point of the plugin's team tool is to
 * name `subagent-spawn-in-process` / `subagent-fork-in-process`, which is why a
 * disable of either of those has to fail here too.
 */
const providerRegistries = [
  { row: 'agent-default-model', key: 'provider', api: 'registerAdapter' },
  { row: 'tool-subagent', key: 'provider', api: 'registerProvider' },
  { row: 'tool-subagent-fork', key: 'provider', api: 'registerProvider' },
  { row: 'workflow-ptc', key: 'provider', api: 'registerProvider' },
  { row: 'tool-ralph', key: 'subagentProvider', api: 'registerProvider' },
  { row: 'freecodego-tool-agent-team', key: 'freshProvider', api: 'registerProvider' },
  { row: 'freecodego-tool-agent-team', key: 'forkProvider', api: 'registerProvider' },
  { row: 'web', key: 'searchProvider', api: 'registerSearchProvider' },
  { row: 'web', key: 'fetchProvider', api: 'registerFetchProvider' },
] as const

interface CompositionRow {
  readonly id: string
  readonly name: string | undefined
  /** Undefined when the row states nothing, which is how a patch inherits. */
  readonly disabled: boolean | undefined
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
 * the id and calls that registry's registration API. Both are read from the
 * package's sources rather than inferred from its name, because the name says
 * nothing about which registry it registers into.
 */
function supplies(name: string, providerId: string, api: string): boolean {
  const source = packageSource(name)
  if (source === undefined) return false
  const declared = source.includes(`'${providerId}'`) || source.includes(`"${providerId}"`)
  return declared && source.includes(`.${api}(`)
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
