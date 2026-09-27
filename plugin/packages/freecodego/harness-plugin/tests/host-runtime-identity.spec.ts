/**
 * A package that mounts a host runtime takes the installation's copy, never one
 * of its own.
 *
 * Why this file exists
 * --------------------
 * Two Harness runtimes carry identity in module-local state: `dsh-scope` mints
 * the symbol its scope tags are written under, and `dsh-mcp-client` keeps its
 * live `serverName` reservations. Both are correct while one copy of the module
 * exists in the process and silently wrong the moment two do.
 *
 * A profile install is exactly that accident. The profile installs a plugin
 * from npm beside the dsh installation, pnpm resolves the plugin's own
 * `dependencies`, and the second copy's `createScope` writes a tag the
 * installation's registries never read: every Agent's browser tools register in
 * the global tool layer, the first Agent owns the names, and each later Session
 * fails to create with `mcp-client(playwright-mcp): initial connection or tool
 * synchronization failed`.
 *
 * So the declaration is the whole defence, and this file holds it to one rule
 * per consumer:
 *
 *  - **A peer, never a dependency.** A `dependencies` entry guarantees the
 *    second copy; a `peerDependencies` entry is satisfied by whatever provides
 *    the runtime, which is the installation.
 *  - **A dev copy in the packages this repository publishes.** They are built
 *    and tested on their own, where no installation is present to satisfy the
 *    peer.
 *
 * Detection reads import statements rather than mentions, because a package
 * names itself in its own `@module` header, and self-reference through its own
 * `exports` map is not a second copy. Two packages declare a shared runtime
 * without importing it and are outside the rule by construction: the
 * installation (`@deepseek-ai/dsh`) lists it as a dependency because that list
 * is where the single instance comes from, and the standalone minimal SDK
 * bundle (`@deepseek-ai/dsh-sdk-minimal`) ships its own runtime because no
 * installation is there to provide one.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/host-runtime-identity
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

/** The Harness checkout root: this package sits at `packages/freecodego/<name>`. */
const CHECKOUT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Runtimes whose module-local state must stay a single instance. */
const SHARED_RUNTIMES = ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-mcp-client'] as const

/** The packages this repository publishes, which also build and test standalone. */
const OWN_PACKAGES = new Set([
  '@deepseek-ai/dsh-freecodego-harness-plugin',
  '@deepseek-ai/dsh-freecodego-root-agent',
])

/** The manifest fields this rule reads. */
interface Manifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** One package that mounts one shared runtime. */
interface Consumer {
  readonly name: string
  readonly runtime: string
  readonly manifest: Manifest
}

/**
 * Whether a module imports this runtime, as a statement rather than a mention.
 *
 * @param source - the package's combined TypeScript source.
 * @param runtime - the package name to look for.
 * @returns true for a static import, a type import, or a dynamic `import()`.
 */
function importsRuntime(source: string, runtime: string): boolean {
  // Only `.` needs escaping here: the pattern is built as text, so `/` and `-`
  // are literal, and escaping them is invalid under the `u` flag.
  const escaped = runtime.replace(/\./gu, '\\.')
  return new RegExp(`(?:from\\s*|import\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`, 'u').test(source)
}

/**
 * Every package in the checkout that imports a shared runtime.
 *
 * @returns one entry per package and runtime, in manifest-path order.
 */
function consumers(): Consumer[] {
  const manifestPaths = [
    ...globSync('packages/*/*/package.json', { cwd: CHECKOUT, exclude: ['**/node_modules/**', '**/lib/**'] }),
    ...globSync('apps/*/package.json', { cwd: CHECKOUT, exclude: ['**/node_modules/**', '**/lib/**'] }),
  ].sort()
  const found: Consumer[] = []
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(join(CHECKOUT, manifestPath), 'utf8')) as Manifest
    const directory = join(CHECKOUT, dirname(manifestPath))
    const texts = globSync('src/**/*.ts', { cwd: directory })
      .map(file => readFileSync(join(directory, file), 'utf8'))
      .join('\n')
    for (const runtime of SHARED_RUNTIMES) {
      // A package reaching itself through its own `exports` map shares its own
      // instance by definition.
      if (manifest.name === runtime) continue
      if (importsRuntime(texts, runtime)) found.push({ name: manifest.name, runtime, manifest })
    }
  }
  return found
}

const FOUND = consumers()

describe('the shared host runtimes stay the installation\'s', () => {
  test('the scan reaches the packages this repository publishes', () => {
    // Without this, a moved checkout or a stale glob would turn every rule below
    // into a vacuous pass.
    const names = new Set(FOUND.map(consumer => consumer.name))
    expect([...OWN_PACKAGES].filter(name => !names.has(name))).toEqual([])
  })

  test('no consumer installs a copy of its own', () => {
    const violations = FOUND
      .filter(consumer => consumer.manifest.dependencies?.[consumer.runtime] !== undefined)
      .map(consumer => `${consumer.name} imports ${consumer.runtime} but declares it as a dependency (${consumer.manifest.dependencies?.[consumer.runtime]})`)
    expect(violations, `\nthese consumers would install a second identity-bearing runtime:\n  ${violations.join('\n  ')}\n`).toEqual([])
  })

  test('every consumer takes the runtime as a peer', () => {
    const violations = FOUND
      .filter(consumer => consumer.manifest.peerDependencies?.[consumer.runtime] === undefined)
      .map(consumer => `${consumer.name} imports ${consumer.runtime} without a peerDependencies entry`)
    expect(violations, `\nthese consumers leave the peer to be resolved for them:\n  ${violations.join('\n  ')}\n`).toEqual([])
  })

  test('every published package here declares a dev copy as well', () => {
    const violations = FOUND
      .filter(consumer => OWN_PACKAGES.has(consumer.name))
      .filter(consumer => consumer.manifest.devDependencies?.[consumer.runtime] === undefined)
      .map(consumer => `${consumer.name} imports ${consumer.runtime} without a devDependencies entry to build and test against`)
    expect(violations, `\n  ${violations.join('\n  ')}\n`).toEqual([])
  })
})
