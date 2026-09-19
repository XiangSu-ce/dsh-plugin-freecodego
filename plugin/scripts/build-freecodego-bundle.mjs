#!/usr/bin/env node

/** Build the single public FreeCodeGo npm artifact from private workspace libs. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function buildHost() {
  runEsbuild([
    resolve(bundle, 'src', 'index.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, 'bootstrap.js'),
    '--external:@deepseek-ai/*',
    '--external:@anthropic-ai/claude-agent-sdk',
    '--external:eventsource-parser', '--external:eventsource-parser/*',
    '--external:js-yaml', '--external:tar', '--external:zod',
    ...aliasArgs(),
  ])
}

function buildWorker(input, name, externals) {
  runEsbuild([
    resolve(root, input),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, 'workers', name),
    '--external:@deepseek-ai/*',
    ...externals.flatMap(value => [`--external:${value}`]),
  ])
}

function buildPlugin(input, name) {
  runEsbuild([
    resolve(root, input),
    '--bundle', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=' + join(output, name),
    '--external:@deepseek-ai/*',
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
 * Fail the build when the Host bundle stops exporting what the shim imports.
 *
 * The shim is a template literal in this file, so nothing else connects it to
 * the bundle it imports from: without this check a dropped export surfaces as a
 * plugin that fails to load, long after the build reported success.
 */
function verifyHostExports() {
  const exported = exportedNames(readFileSync(join(output, 'bootstrap.js'), 'utf8'))
  const missing = HOST_SHIM_IMPORTS.filter(name => !exported.has(name))
  if (missing.length > 0) {
    throw new Error(`bootstrap.js does not export ${missing.join(', ')}, which dist/session-events.js imports`)
  }
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
buildPlugin(builtEntry('packages/experimental/agent-team'), 'agent-team.js')
buildPlugin(builtEntry('packages/experimental/tool-agent-team'), 'tool-agent-team.js')
// Harness capabilities this composition mounts and no upstream bundle does: the
// reminder scheduler, and the Auto preset's LLM authorization gate. Mounting the
// Harness's own is why the plugin no longer ships a scheduler beside the first or
// an approval gate beside the second.
buildPlugin(builtEntry('packages/schedule/schedule'), 'schedule.js')
buildPlugin(builtEntry('packages/experimental/auto-review'), 'auto-review.js')
// Codex still runs its app-server protocol in a spawned worker, so it is built
// here. Claude does not: its SDK session runs in the Host process,
// `runtime-claude/src/worker.ts` is deleted, and its manifest exports no
// `./worker` — there is no claude worker to build. `freecodego-family.spec.ts`
// pins the same payload, codex worker only.
buildWorker(builtEntry('packages/freecodego/runtime-codex', './worker'), 'codex-worker.js', [])
buildClient()
buildSessionEvents()
if (!existsSync(harnessAssets)) throw new Error(`missing FreeCodeGo engineering assets: ${harnessAssets}`)
cpSync(harnessAssets, join(output, 'assets'), { recursive: true })
console.log(`freecodego bundle: wrote ${output}`)
