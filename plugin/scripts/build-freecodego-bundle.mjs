#!/usr/bin/env node

/** Build the single public FreeCodeGo npm artifact from private workspace libs. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const bundle = join(root, 'packages', 'freecodego', 'bundle-latest')
const output = join(bundle, 'dist')
// Built-in engineering Skills ship as static assets next to the bundled
// bootstrap; MODULE_DIRECTORY-based lookup resolves `dist/assets/...`.
const harnessAssets = join(root, 'packages', 'freecodego', 'harness-plugin', 'assets')

/**
 * Workspace libraries the bundle inlines, by package directory.
 *
 * Only the directory is written here. The file each package resolves to is read
 * back from that package's own manifest, because a second hand-written copy of
 * an entry path is a copy that drifts: this map used to spell out
 * `runtime-claude/lib/index.js` and `runtime-codex/lib/index.js`, which are the
 * stale `.js` files left beside those two packages' current `.mjs` output — so
 * the bundle silently inlined a day-old runtime instead of the built one.
 */
const ownPackages = {
  '@deepseek-ai/dsh-freecodego-api': 'packages/freecodego/freecodego-api',
  '@deepseek-ai/dsh-freecodego-native-runtime-host': 'packages/freecodego/native-runtime-host',
  '@deepseek-ai/dsh-freecodego-native-runtime-protocol': 'packages/freecodego/native-runtime-protocol',
  '@deepseek-ai/dsh-freecodego-root-agent': 'packages/freecodego/root-agent',
  '@deepseek-ai/dsh-freecodego-runtime-claude': 'packages/freecodego/runtime-claude',
  '@deepseek-ai/dsh-freecodego-runtime-codex': 'packages/freecodego/runtime-codex',
  '@deepseek-ai/dsh-freecodego-agent-engine-router': 'packages/freecodego/agent-engine-router',
  '@deepseek-ai/dsh-freecodego-harness-plugin': 'packages/freecodego/harness-plugin',
  '@deepseek-ai/dsh-experimental-agent-team': 'packages/experimental/agent-team',
  '@deepseek-ai/dsh-experimental-tool-agent-team': 'packages/experimental/tool-agent-team',
}

/**
 * Upstream Harness packages this bundle ships, by package directory.
 *
 * The Harness's cross-engine subagent providers (`ctx.subagents.registerProvider`
 * under the names `codex` and `claude-code`) are the official way to put a Codex
 * or Claude child behind `spawn_teammate`, and no upstream bundle mounts either
 * — the base composition mounts only `subagent-spawn-in-process` and
 * `-fork-in-process`, so an unmodified install can reach no engine but its own.
 *
 * `tool-session-query` is the same shape of gap for session history: the base
 * mounts `session-query-sqlite` and `session-projection`, so the services exist,
 * but no bundle mounts the package that turns them into model-facing tools and it
 * is absent from the `dsh` install contract too — so an unmodified install can
 * search no prior session at all. It ships here rather than as a row naming the
 * official package because it has to work with nothing installed.
 *
 * Shipping these artifacts and mounting their rows is what closes each gap
 * without this plugin owning a second implementation of anything.
 *
 * They are artifacts rather than aliases because their rows name *this* bundle's
 * subpath (`freecodego/subagent-codex`), which is a real module the Loader
 * imports on its own; an alias only rewrites an import inside another build.
 */
const upstreamArtifacts = {
  '@deepseek-ai/dsh-subagent-codex': 'packages/subagent/subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code': 'packages/subagent/subagent-claude-code',
  '@deepseek-ai/dsh-tool-session-query': 'packages/session-query/tool-session-query',
}

/**
 * Harness packages these artifacts' sources import that the published install
 * does not carry, by package directory.
 *
 * These are workspace packages used across the Harness, but they are not in the
 * package set a `dsh` install resolves from — `dsh-timeout`, `dsh-sdk-protocol`,
 * and `dsh-subprocess` are absent while `dsh-subprocess-local`, the provider of
 * the same `subprocess` service, is present. Left external they would be bare
 * specifiers nothing links, and the row would fail to import on every real
 * install; `verifyExternalsResolvable` below would also fail this build, because
 * a bare `@deepseek-ai/*` import has to be declared as a dependency or a peer.
 * Inlining them is what makes these artifacts self-contained.
 */
const inlinedHarnessDeps = {
  '@deepseek-ai/dsh-timeout': 'packages/util/timeout',
  '@deepseek-ai/dsh-sdk-protocol': 'packages/sdk/protocol',
  '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess',
}

/**
 * Resolve a workspace package's declared entry to the file on disk.
 * @param directory - repository-relative package directory.
 * @param subpath - export key to resolve; `.` is the package entry.
 * @returns Absolute path of the built entry.
 */
function builtEntry(directory, subpath = '.') {
  const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))
  const exported = manifest.exports?.[subpath]
  const entry = typeof exported === 'string'
    ? exported
    : exported?.default ?? (subpath === '.' ? manifest.main : undefined)
  if (typeof entry !== 'string' || entry === '') {
    throw new Error(`${directory} declares no "${subpath}" entry; run the library build first`)
  }
  const absolute = resolve(root, directory, entry)
  if (!existsSync(absolute)) {
    throw new Error(`${directory} resolves "${subpath}" to ${entry}, which is not built: ${absolute}`)
  }
  return absolute
}

function runEsbuild(args) {
  const command = process.platform === 'win32'
    ? process.execPath
    : 'pnpm'
  const commandArgs = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js'), 'exec', 'esbuild', ...args]
    : ['exec', 'esbuild', ...args]
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`esbuild exited with ${String(result.status ?? result.signal)}`)
}

function aliasArgs() {
  return Object.entries(ownPackages).flatMap(([name, directory]) => [
    `--alias:${name}=${builtEntry(directory)}`,
  ])
}

/**
 * Aliases that inline one of the Harness's own packages into an artifact.
 *
 * Applied to the provider artifacts only. A global alias would put a second copy
 * of `dsh-subprocess`'s service definition into `bootstrap.js`, where the
 * published `dsh-subprocess-local` already supplies that service under the same
 * name.
 * @returns The `--alias:` arguments for {@link inlinedHarnessDeps}.
 */
function inlinedDependencyArgs() {
  return Object.entries(inlinedHarnessDeps).flatMap(([name, directory]) => [
    `--alias:${name}=${builtEntry(directory)}`,
  ])
}

/**
 * Emit one upstream package as its own artifact.
 *
 * Built from the package's own built entry rather than from a copy: the row in
 * `cordis.patch.yml` names this bundle's subpath, so the module the Loader
 * imports is upstream's, inlined here and updated with it.
 * @param directory - repository-relative package directory of the upstream package.
 * @param name - output file name inside `dist/`.
 */
function buildUpstreamArtifact(directory, name) {
  runEsbuild([
    builtEntry(directory),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, name),
    '--external:@deepseek-ai/*',
    '--external:typescript',
    // The Codex provider resolves its `app-server` binary through the package
    // manifest (`createRequire(...).resolve('@openai/codex/package.json')`), at
    // module scope, so the package has to stay a real install and cannot be
    // inlined. The Claude provider's SDK is already a dependency of this bundle,
    // and stays external for the same reason it does in the Host build.
    '--external:@openai/codex',
    '--external:@anthropic-ai/claude-agent-sdk',
    ...inlinedDependencyArgs(),
  ])
}

function buildHost() {
  runEsbuild([
    resolve(bundle, 'src', 'index.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, 'bootstrap.js'),
    '--external:@deepseek-ai/*',
    '--external:@anthropic-ai/claude-agent-sdk',
    '--external:eventsource-parser', '--external:eventsource-parser/*',
    '--external:js-yaml', '--external:tar', '--external:typescript', '--external:zod',
    ...aliasArgs(),
  ])
}

function buildWorker(input, name, externals) {
  runEsbuild([
    resolve(root, input),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, 'workers', name),
    '--external:@deepseek-ai/*',
    // The workflow static gate loads the compiler at runtime, so it must stay a
    // real dependency rather than being inlined into every worker artifact.
    '--external:typescript',
    ...externals.flatMap(value => [`--external:${value}`]),
  ])
}

function buildPlugin(input, name) {
  runEsbuild([
    resolve(root, input),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, name),
    '--external:@deepseek-ai/*',
    '--external:typescript',
    ...aliasArgs(),
  ])
}

/** Identity the published bundle registers under: the harness resolves the client row by it. */
const BUNDLE_CLIENT_ID = 'freecodego'
/** Workspace package the client is built as; every identity stamp starts life as this name. */
const CLIENT_PACKAGE_ID = '@deepseek-ai/dsh-freecodego-harness-ui'

/**
 * Rename every identity stamp the client preset baked into the bundle.
 *
 * `packages/client/tsdown.client.ts` stamps the package id in three shapes: the
 * `__ModuleLoader__.load` handoff `id`, each `<style data-plugin>` attribution,
 * and each `"<package>/<sheet>"` tag id. The module loader inventories a
 * plugin's sheets by comparing `data-plugin` against the *module id* verbatim
 * (`modules/src/client/system.ts`, `claimStyles`), so renaming only the handoff
 * leaves every sheet attributed to a plugin that does not exist: the loader
 * reports no owned styles and HMR never removes them. Renaming exactly one is
 * what this used to do, because a string pattern in `String.replace` replaces
 * only its first occurrence.
 *
 * An identity stamp is the package name as a *complete* string literal, with or
 * without the preset's `/<sheet>` suffix. Anchoring on the quotes is what makes
 * an unexpected occurrence (an import specifier, a JSDoc `@module`) an error
 * instead of a half-rename nobody notices.
 *
 * @param client - Raw text of the built client bundle.
 * @returns The bundle with every identity stamp renamed.
 */
function renameClientIdentity(client) {
  const escaped = CLIENT_PACKAGE_ID.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const stamp = new RegExp(`"${escaped}(/[^"]*)?"`, 'gu')
  const stamps = client.match(stamp) ?? []
  const occurrences = client.split(CLIENT_PACKAGE_ID).length - 1
  if (stamps.length === 0 || stamps.length !== occurrences) {
    throw new Error(
      `client bundle identity drifted: ${String(occurrences)} occurrence(s) of ${CLIENT_PACKAGE_ID}, `
      + `${String(stamps.length)} of them a complete identity stamp`,
    )
  }
  return client.replace(stamp, (_match, sheet) => `"${BUNDLE_CLIENT_ID}${sheet ?? ''}"`)
}

/** The preset's trailing map reference; the map itself is not part of the payload. */
const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=.*\s*$/u

function buildClient() {
  const source = join(root, 'packages', 'freecodego', 'harness-ui', 'lib', 'client.js')
  if (!existsSync(source)) throw new Error(`missing built FreeCodeGo client bundle: ${source}`)
  const client = renameClientIdentity(readFileSync(source, 'utf8')).replace(SOURCE_MAP_COMMENT, '\n')
  // A `replace` that does not match is a no-op, so the payload would ship a
  // reference to a map that `files` never publishes. Assert the post-condition
  // instead of trusting the pattern to keep matching upstream output.
  if (client.includes('sourceMappingURL')) {
    throw new Error('client bundle still references a source map after stripping; SOURCE_MAP_COMMENT no longer matches the preset output')
  }
  writeFileSync(join(output, 'client.cjs'), client)
}

/** Symbols `dist/session-events.js` imports from the Host bundle. */
const HOST_SHIM_IMPORTS = ['registerFreeCodeGoSessionEventTypes']
/**
 * Symbol `dist/harness-plugin.js` re-exports as the plugin entry's default.
 *
 * A Loader entry's plugin is the module's *default* export, and the row
 * `freecodego-harness-plugin` in `cordis.patch.yml` loads this artifact rather
 * than `bootstrap.js` (whose default export is the bundle's `apply`).
 */
const HOST_ENTRY_DEFAULT = 'FreeCodeGoHarnessPlugin'

/**
 * Named exports of a built ESM artifact.
 *
 * Read from the `export { … }` clauses, never by searching for the symbol: a
 * bundled symbol also appears at its own declaration site, so a substring test
 * reports the export as present even after the clause dropped it. `dist/
 * bootstrap.js` declares this one ~35k lines above the clause that exports it.
 *
 * @param source - Text of the built artifact.
 * @returns Every exported name, with `as` aliases resolved to the public name.
 */
function exportedNames(source) {
  const names = new Set()
  for (const clause of source.matchAll(/^export\s*\{([^}]*)\}/gmu)) {
    for (const binding of clause[1].split(',')) {
      const exported = binding.split(/\s+as\s+/u).at(-1).trim()
      if (exported !== '') names.add(exported)
    }
  }
  return names
}

/**
 * Fail the build when the Host bundle stops exporting what its satellites need.
 *
 * Both consumers are template literals in this file, so nothing else connects
 * them to the bundle they import from: without this check a dropped export
 * surfaces as an entry that fails to load, long after the build reported success.
 */
function verifyHostExports() {
  const exported = exportedNames(readFileSync(join(output, 'bootstrap.js'), 'utf8'))
  const wanted = [
    ...HOST_SHIM_IMPORTS.map(name => [name, 'dist/session-events.js']),
    [HOST_ENTRY_DEFAULT, 'dist/harness-plugin.js'],
  ]
  const missing = wanted.filter(([name]) => !exported.has(name)).map(([name, consumer]) => `${name} (needed by ${consumer})`)
  if (missing.length > 0) throw new Error(`bootstrap.js does not export ${missing.join(', ')}`)
}

/**
 * Fail the build when the emitted artifacts import an undeclared `@deepseek-ai` package.
 *
 * Every build above passes `--external:@deepseek-ai/*`, so those specifiers stay
 * bare in the output and Node resolves them from `dist/` — which walks this
 * package's own `node_modules`, never the consuming profile's. A package the
 * source graph touches but this manifest does not declare is therefore linked
 * nowhere, and the module importing it fails at load rather than at build.
 *
 * Measured 2026-09-23: `bootstrap.js` imported `@deepseek-ai/cosmokit` on its
 * first line, so the whole bundle — and with it the session-event prerequisite,
 * `sessionPersistence`, and every conversation in the product — did not
 * activate, while this script reported success. Declaration is what links a
 * package here, and peers count as much as dependencies.
 */
function verifyExternalsResolvable() {
  const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  const missing = new Set()
  for (const file of readdirSync(output)) {
    if (!file.endsWith('.js') && !file.endsWith('.cjs') && !file.endsWith('.mjs')) continue
    const text = readFileSync(join(output, file), 'utf8')
    const references = /(?:from\s*|require\s*\(\s*|import\s*\()\s*["'`](@deepseek-ai\/[a-z0-9-]+)["'`]/gu
    for (const match of text.matchAll(references)) {
      if (!declared.has(match[1])) missing.add(`${match[1]} (imported by ${file})`)
    }
  }
  if (missing.size > 0) {
    throw new Error(`the bundle imports @deepseek-ai packages its manifest does not declare, so nothing links them: ${[...missing].sort().join(', ')}`)
  }
}

/**
 * Emit the module the `freecodego-harness-plugin` row loads.
 *
 * The row's plugin must be the module's default export, and the class itself
 * lives in `bootstrap.js` — the bundle's single inlined copy of the plugin. A
 * second esbuild pass over `@deepseek-ai/dsh-freecodego-harness-plugin` would
 * publish the plugin twice (and every private workspace library it inlines with
 * it), so this stays a one-line re-export: `harness-plugin.js` and
 * `bootstrap.js` are in the same directory, so Node caches one instance of the
 * plugin whichever of them the Loader imports first.
 */
function buildHarnessPluginEntry() {
  writeFileSync(join(output, 'harness-plugin.js'), `// Generated by scripts/build-freecodego-bundle.mjs — do not edit.\n// The Loader entry \`freecodego-harness-plugin\` loads this module and takes its\n// default export as the plugin, so the class is re-exported from the bundle\n// rather than bundled a second time.\nexport { ${HOST_ENTRY_DEFAULT} as default } from './bootstrap.js'\n`)
}

function buildSessionEvents() {
  writeFileSync(join(output, 'session-events.js'), `import { Service } from '@deepseek-ai/cordis'\nimport { ${HOST_SHIM_IMPORTS.join(', ')} } from './bootstrap.js'\n\n/** Loader prerequisite: install the plugin-owned session event vocabulary. */\nexport default class FreeCodeGoSessionEvents extends Service {\n  constructor(ctx) {\n    super(ctx, 'freeCodeGoSessionEvents')\n    registerFreeCodeGoSessionEventTypes()\n  }\n}\n`)
}

rmSync(output, { recursive: true, force: true })
mkdirSync(join(output, 'workers'), { recursive: true })
buildHost()
// Before spending time on the rest: the Host bundle is what the loader's shim
// imports from, and a missing export only shows up when the plugin loads.
verifyHostExports()
// No `agent-team.js`, `tool-agent-team.js`, or `schedule.js`: all three were
// upstream's own modules compiled into this payload as fallbacks for
// compositions that had not selected the bundle that mounts them, and all three
// are gone (see the patch file's note where their rows used to be). The official
// `@deepseek-ai/dsh-experimental-agent-team-profile` mounts the team pair by name
// and the Web composition declares the scheduler rows, so a copy here only ever
// raced them.
//
// The Auto preset's LLM authorization gate still ships: the official
// `@deepseek-ai/dsh-experimental-auto-review` bundle exists, but no profile this
// plugin ships selects it, so this row is the capability itself rather than a
// copy of a mounted one.
buildPlugin(builtEntry('packages/experimental/auto-review'), 'auto-review.js')
// The Harness's cross-engine subagent providers, which no upstream bundle mounts.
// Mounting them is what lets the official team's `spawn_teammate` create a Codex
// or Claude teammate: the provider registers under `codex`/`claude-code` on
// `ctx.subagents`, and the team tool selects a provider by name.
buildUpstreamArtifact(upstreamArtifacts['@deepseek-ai/dsh-subagent-codex'], 'subagent-codex.js')
buildUpstreamArtifact(upstreamArtifacts['@deepseek-ai/dsh-subagent-claude-code'], 'subagent-claude-code.js')
// The session-history tools. Its own package imports `@deepseek-ai/dsh-timeout`,
// which the published install does not carry, so the artifact inlines it with
// {@link inlinedHarnessDeps} the same way the two providers above do; the rest of
// its imports are services the base composition already mounts.
buildUpstreamArtifact(upstreamArtifacts['@deepseek-ai/dsh-tool-session-query'], 'tool-session-query.js')
// Codex still runs its app-server protocol in a spawned worker, so it is built
// here. Claude does not: its SDK session runs in the Host process,
// `runtime-claude/src/worker.ts` is deleted, and its manifest exports no
// `./worker` — there is no claude worker to build. `freecodego-family.spec.ts`
// pins the same payload, codex worker only.
buildWorker(builtEntry('packages/freecodego/runtime-codex', './worker'), 'codex-worker.js', [])
buildClient()
buildHarnessPluginEntry()
buildSessionEvents()
if (!existsSync(harnessAssets)) throw new Error(`missing FreeCodeGo engineering assets: ${harnessAssets}`)
cpSync(harnessAssets, join(output, 'assets'), { recursive: true })
// After every artifact exists: the check reads the emitted files, not the sources.
verifyExternalsResolvable()
console.log(`freecodego bundle: wrote ${output}`)
