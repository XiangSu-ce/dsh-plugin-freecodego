/**
 * Every FreeCodeGo package's `tests/` must be type-checked, by a project that
 * references at least what the package project does.
 *
 * Why this is a gate rather than a convention
 * ------------------------------------------
 * Each FreeCodeGo package carries two projects: `tsconfig.json` (the build face,
 * `include: ["src"]`) and `tsconfig.test.json` (type-only, `include: ["src",
 * "tests"]`). The test project cannot inherit the package project's
 * `references` — `extends` does not carry them — so the list is written twice.
 * Nine packages' worth of duplicated lists is exactly the kind of thing that
 * drifts in the one direction nobody looks, and the symptom is misleading: a
 * missing reference makes TypeScript inline the dependency's *sources* instead
 * of resolving the referenced project's declarations, so the errors appear in
 * `vendor/**` or another package's files rather than in the config that is
 * wrong. Measured on `harness-plugin`: dropping one reference produced 11
 * immediate errors in `vendor/hmr/src`.
 *
 * What it checks
 * --------------
 * 1. A package with specs has a `tsconfig.test.json` that includes `tests`.
 * 2. That project references every path the package project references.
 * 3. Every test project's list is byte-for-byte what
 *    `scripts/gen-freecodego-test-tsconfig.ts` derives from the package project.
 *    This is the check that matters most: containment (2) can only report a
 *    missing entry after the fact, whereas (3) makes the hand-copied list
 *    impossible — the derived list is the only one that passes.
 * 4. The root `build:freecodego` script builds both projects of every package,
 *    so the gate is actually reached by `npm run build:lib:host`.
 *
 * @module scripts/freecodego-tsconfig-families
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { derivedReferences, driftedPackages, guardedPackages } from './gen-freecodego-test-tsconfig.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const FREECODEGO_ROOT = join(REPO_ROOT, 'packages/freecodego')

/** The strict-read shape of a tsconfig document; every field this guard reads. */
interface TsConfigDocument {
  readonly include?: readonly string[]
  readonly references?: readonly { readonly path: string }[]
}

/**
 * Parse one tsconfig file.
 *
 * `JSON.parse` cannot read these documents — they carry `//` commentary, which
 * is why the repository uses `.json` files that are not strict JSON. The strip
 * is line-oriented and sufficient here: this guard reads `include` and
 * `references`, and no FreeCodeGo tsconfig puts a `//` inside a string.
 */
function readTsConfig(path: string): TsConfigDocument {
  const raw = readFileSync(path, 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(stripped) as TsConfigDocument
}

/** Every FreeCodeGo package directory that carries a `tsconfig.json`. */
function packageDirectories(): readonly string[] {
  return readdirSync(FREECODEGO_ROOT)
    .filter(name => statSync(join(FREECODEGO_ROOT, name)).isDirectory())
    .filter(name => statSync(join(FREECODEGO_ROOT, name, 'tsconfig.json'), { throwIfNoEntry: false }) !== undefined)
    .sort()
}

/** Whether a package ships at least one spec, in `tests/` or beside its source. */
function hasSpecs(directory: string): boolean {
  const testsDirectory = join(FREECODEGO_ROOT, directory, 'tests')
  if (statSync(testsDirectory, { throwIfNoEntry: false })?.isDirectory() !== true) return false
  return readdirSync(testsDirectory).some(name => name.endsWith('.spec.ts') || name.endsWith('.spec.tsx'))
}

/** The sibling test project's path, or `undefined` when it is absent. */
function testConfigPath(directory: string): string | undefined {
  const candidate = join(FREECODEGO_ROOT, directory, 'tsconfig.test.json')
  return statSync(candidate, { throwIfNoEntry: false }) === undefined ? undefined : candidate
}

/** The `tsc -b` argument list the root build script passes. */
function builtProjectList(): readonly string[] {
  const manifest = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  const parsed = JSON.parse(manifest) as { readonly scripts?: Record<string, string> }
  const script = parsed.scripts?.['build:freecodego']
  if (script === undefined) throw new Error('package.json has no build:freecodego script')
  return script.split(' ').filter(token => /^packages\/freecodego\/.*tsconfig.*\.json$/u.test(token))
}

describe('FreeCodeGo tsconfig families', () => {
  it('finds the packages to guard, so an empty scan cannot pass silently', () => {
    // A guard that iterates nothing is green forever; this pins the scan itself.
    expect(packageDirectories().length).toBeGreaterThanOrEqual(9)
    expect(packageDirectories()).toContain('harness-plugin')
    expect(packageDirectories()).toContain('root-agent')
  })

  it.each(packageDirectories())('%s: a package with specs has a test project that includes them', (directory) => {
    if (!hasSpecs(directory)) return
    const testConfig = testConfigPath(directory)
    expect(testConfig, `${directory} ships specs but has no tsconfig.test.json`).toBeDefined()
    expect(readTsConfig(testConfig!).include).toContain('tests')
    // `src` too: the tests import the package's own modules, and a project that
    // compiled only `tests` would report every one of them as unresolvable.
    expect(readTsConfig(testConfig!).include).toContain('src')
  })

  it.each(packageDirectories())('%s: the test project references everything the package project does', (directory) => {
    const testConfig = testConfigPath(directory)
    if (testConfig === undefined) return
    const packageReferences = (readTsConfig(join(FREECODEGO_ROOT, directory, 'tsconfig.json')).references ?? [])
      .map(reference => reference.path)
      .sort()
    const testReferences = (readTsConfig(testConfig).references ?? []).map(reference => reference.path).sort()
    // Containment, not equality: a test project may resolve the type of an event
    // vocabulary the package itself never imports (the plugin's suites do), and
    // forbidding that would push the extra reference into a production
    // dependency instead. What must never happen is the other direction.
    expect({ directory, missing: packageReferences.filter(path => !testReferences.includes(path)) })
      .toEqual({ directory, missing: [] })
  })

  it('derives every test project\'s reference list from its package project', () => {
    // A non-empty result names the files whose list was edited by hand; the
    // message from the generator says which side to fix.
    expect(driftedPackages()).toStrictEqual([])
  })

  it('guards every package that has a test project, and no others', () => {
    const withTestProject = packageDirectories().filter(directory => testConfigPath(directory) !== undefined).sort()
    expect(guardedPackages()).toStrictEqual(withTestProject)
    // The scan must not be empty: a generator over nothing is green forever.
    expect(guardedPackages().length).toBeGreaterThanOrEqual(9)
  })

  it('derives a list for a package whose project declares references', () => {
    // `native-runtime-protocol` is the one package with no references at all;
    // it must stay that way rather than gain an invented empty array.
    expect(derivedReferences('native-runtime-protocol')).toStrictEqual([])
    expect(testConfigPath('native-runtime-protocol')).toBeDefined()
    expect(readFileSync(testConfigPath('native-runtime-protocol')!, 'utf8')).not.toContain('"references"')
    expect(derivedReferences('harness-plugin').length).toBeGreaterThan(20)
  })

  it('builds both projects of every package, so the gate is actually reached', () => {
    const built = builtProjectList()
    const unbuilt = packageDirectories().flatMap((directory) => {
      const expected = [`packages/freecodego/${directory}/tsconfig.json`]
      if (testConfigPath(directory) !== undefined) expected.push(`packages/freecodego/${directory}/tsconfig.test.json`)
      return expected.filter(project => !built.includes(project))
    })
    expect(unbuilt).toEqual([])
  })

  it('references only projects that exist, so a typo fails here instead of in tsc', () => {
    /**
     * Whether a reference path resolves, following TypeScript's own rule: a
     * reference is either a directory holding `tsconfig.json` or an explicit
     * config file (`harness-ui` points at sibling `tsconfig.client.json`s).
     */
    const resolves = (configDirectory: string, target: string): boolean => {
      const from = join(configDirectory, target)
      return target.endsWith('.json')
        ? statSync(from, { throwIfNoEntry: false }) !== undefined
        : statSync(join(from, 'tsconfig.json'), { throwIfNoEntry: false }) !== undefined
    }
    const broken = packageDirectories().flatMap((directory) => {
      const testConfig = testConfigPath(directory)
      if (testConfig === undefined) return []
      const configDirectory = join(FREECODEGO_ROOT, directory)
      return (readTsConfig(testConfig).references ?? [])
        .map(reference => ({
          from: relative(REPO_ROOT, testConfig).replace(/\\/gu, '/'),
          target: reference.path,
          exists: resolves(configDirectory, reference.path),
        }))
        .filter(entry => !entry.exists)
    })
    expect(broken).toEqual([])
  })
})
