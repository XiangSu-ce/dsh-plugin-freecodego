/**
 * The bundled agent presets have to be composable against the Harness they ship for.
 *
 * Harness preset discovery resolves every row's package against the installed
 * harness (`packages/preset/agent-presets/src/discovery.ts`, `compositionProblem`)
 * and reports the **whole preset** as broken when one enabled row cannot be
 * resolved. That verdict is what the roster card renders as "Failed to load":
 * the preset stays listed, and it can be neither selected nor duplicated.
 *
 * The failure this spec exists for is a row naming a package the Harness no
 * longer ships. Both bundled presets named
 * `@deepseek-ai/dsh-workflow-worker-thread`, which no 0.1.6 line installs — the
 * composition was copied from a pre-0.1.6 surface rather than from the shipped
 * `standard` preset, so it also carried that surface's `ralph` row and lacked
 * the rows `standard` has. Discovery could only report the first of those as a
 * name it cannot resolve; the rest were silent capability differences.
 *
 * So there are two checks, and they fail for different reasons:
 *
 * 1. every enabled row names something this checkout ships;
 * 2. the two presets still hold the same rows as `standard`, which is the claim
 *    their own headers make ("mirrors `standard/agent.cordis.yml` row for row;
 *    only the persona section differs").
 *
 * The checkout's own package set is what check 1 resolves against, and it is the
 * right denominator to resolve against: the assets are read from this package
 * and the bundle mounts the packages this checkout builds.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/agent-preset-composition
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { BUNDLED_PRESET_IDS } from '../src/agent-preset-install.ts'

/** The checkout root — the Harness these presets are composed against, four levels above `tests/`. */
const HARNESS_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The bundled preset assets, beside the package root the installer reads. */
const PRESET_ROOT = fileURLToPath(new URL('../assets/presets', import.meta.url))

/** The composition file that makes a preset directory a preset. */
const COMPOSITION_FILE = 'agent.cordis.yml'

/** The shipped composition the bundled presets mirror. */
const STANDARD_COMPOSITION = join(HARNESS_ROOT, 'packages', 'preset', 'agent-presets', 'presets', 'standard', COMPOSITION_FILE)

/**
 * The composition loader's expression tag, `!!js`.
 *
 * Health skips a row whose `disabled` is truthy, and `!!js` resolves to an
 * expression object rather than a boolean — which is exactly why
 * `disabled: !!js process.platform === 'win32'` is a row discovery deliberately
 * does not judge. The tag and the constructed shape are copied from the loader's
 * own schema (`vendor/include/src/index.ts`), so the two dialects cannot drift.
 */
const JS_EXPRESSION = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: string): { __jsExpr: string } => ({ __jsExpr: data }),
})

/** The dialect a preset composition is parsed with — the loader's own. */
const COMPOSITION_SCHEMA = JSON_SCHEMA.extend(JS_EXPRESSION)

/** The fields of one composition row this spec reads. */
interface CompositionRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly group?: unknown
  readonly config?: unknown
  readonly disabled?: unknown
}

/**
 * Every row of a composition, with groups flattened, in document order.
 *
 * Groups recurse for the same reason the loader does: a row nested inside
 * `cordis:group` is started like any other, so a preset is only as resolvable as
 * its deepest row.
 * @param compositionPath - absolute path of a preset's composition file.
 * @returns the top-level rows and every row nested in a group.
 */
function rowsOf(compositionPath: string): CompositionRow[] {
  const document: unknown = load(readFileSync(compositionPath, 'utf8'), { schema: COMPOSITION_SCHEMA })
  const flatten = (rows: unknown): CompositionRow[] => {
    if (!Array.isArray(rows)) return []
    const collected: CompositionRow[] = []
    for (const entry of rows) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const row = entry as CompositionRow
      collected.push(row)
      if (row.group === true) collected.push(...flatten(row.config))
    }
    return collected
  }
  return flatten(document)
}

/**
 * Whether the loader would start this row.
 *
 * The loader's own test is `Boolean(options.disabled) === false`, so `disabled: 0`
 * names a row that does start and must be checked, while a `!!js` expression —
 * an object, hence truthy — is skipped here exactly as discovery skips it.
 * @param row - one composition row.
 * @returns true when the row's module has to resolve for the preset to be healthy.
 */
function starts(row: CompositionRow): boolean {
  return !row.disabled
}

/**
 * Where a row's `name` reaches its module, classified as the loader does.
 *
 * Copied from `packages/preset/agent-presets/src/specifier.ts` rather than
 * approximated: a classification that disagrees with the loader's reports a
 * preset healthy that then fails to load, which is the failure this spec is
 * here to prevent. `cordis:group` is a Loader builtin nothing resolves.
 * @param specifier - a row's `name`, exactly as the composition writes it.
 * @returns the kind, deciding which base the row is resolved from.
 */
function kindOf(specifier: string): 'builtin' | 'file' | 'package' {
  if (specifier.startsWith('cordis:')) return 'builtin'
  if (specifier.startsWith('.') || specifier.startsWith('file:') || isAbsolute(specifier)) return 'file'
  return 'package'
}

/**
 * The package a specifier names, subpath dropped.
 * @param specifier - a row's `name`, already classified as a package row.
 * @returns the scope and name, as a manifest would spell them.
 */
function packageOf(specifier: string): string {
  const segments = specifier.split('/')
  return (specifier.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)).join('/')
}

/**
 * Whether a row naming a file resolves, from the preset's own directory.
 *
 * Discovery resolves a preset-relative row against the composition's directory
 * (`Include` rewrites `baseUrl` to it) and an absolute or `file:` row as it
 * stands, so both pass through here.
 * @param specifier - a row's `name`, already classified as a file row.
 * @param presetDirectory - the directory holding the composition.
 * @returns true when the row names an existing file.
 */
function fileResolves(specifier: string, presetDirectory: string): boolean {
  if (specifier.startsWith('file:')) return existsSync(fileURLToPath(specifier))
  return existsSync(isAbsolute(specifier) ? specifier : join(presetDirectory, specifier))
}

/**
 * Every package name this checkout ships.
 *
 * A preset row resolves against the installed harness's `node_modules`, which in
 * this repository is the workspace: the packages under these roots are the ones
 * a bundle mounts. An empty answer would make every row look resolvable, which is
 * why the caller asserts the set is non-trivial.
 * @returns the names of every workspace package, by its manifest's own `name`.
 */
function shippedPackageNames(): Set<string> {
  const names = new Set<string>()
  const walk = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = join(directory, entry.name)
      try {
        const name: unknown = JSON.parse(readFileSync(join(child, 'package.json'), 'utf8')).name
        if (typeof name === 'string') names.add(name)
      } catch {
        // No manifest, or not JSON: this directory is not a package.
      }
      if (depth > 0) walk(child, depth - 1)
    }
  }
  for (const root of ['packages', 'vendor', 'apps', 'native']) {
    const directory = join(HARNESS_ROOT, root)
    if (existsSync(directory)) walk(directory, 2)
  }
  return names
}

/** The shipped package names, resolved once. */
const SHIPPED_PACKAGES = shippedPackageNames()

/**
 * Why one preset's rows cannot all be composed, as human-readable lines.
 *
 * A row naming a package this checkout does not ship is the failure discovery
 * itself reports; a row naming a file that is not there is the other one. A
 * `cordis:` builtin resolves to the Loader and is not judged, exactly as
 * discovery skips it.
 * @param compositionPath - absolute path of a preset's composition file.
 * @returns one line per row that cannot be composed; empty when every row can.
 */
function compositionProblems(compositionPath: string): string[] {
  const presetDirectory = dirname(compositionPath)
  const problems: string[] = []
  for (const row of rowsOf(compositionPath)) {
    if (!starts(row)) continue
    if (typeof row.name !== 'string' || row.name === '') {
      problems.push(`${label(row)} names no plugin`)
      continue
    }
    const kind = kindOf(row.name)
    if (kind === 'builtin') continue
    if (kind === 'file') {
      if (!fileResolves(row.name, presetDirectory)) {
        problems.push(`${label(row)} names a file that is not there: ${row.name}`)
      }
      continue
    }
    if (!SHIPPED_PACKAGES.has(packageOf(row.name))) {
      problems.push(`${label(row)} names a plugin this checkout does not ship: ${row.name}`)
    }
  }
  return problems
}

/**
 * A row's label for a diagnostic, matching discovery's own wording.
 * @param row - one composition row.
 * @returns `row "id"` when the row declares an id.
 */
function label(row: CompositionRow): string {
  return typeof row.id === 'string' && row.id !== '' ? `row "${row.id}"` : 'a row'
}

/**
 * The `id`, `name` and enabled-ness of every row, as comparable strings.
 *
 * Compared as a multiset (`toStrictEqual` on a sorted array) rather than a set:
 * a row added twice is a difference too, and one the composition's own header
 * would still call a mirror.
 * @param compositionPath - absolute path of a preset's composition file.
 * @returns one `id | name | starts` line per row, sorted.
 */
function rowShapes(compositionPath: string): string[] {
  return rowsOf(compositionPath)
    .map(row => `${String(row.id ?? '')} | ${String(row.name ?? '')} | ${String(starts(row))}`)
    .sort()
}

describe('bundled agent preset compositions', () => {
  it('has a denominator: this checkout ships the packages the rows are resolved against', () => {
    expect(SHIPPED_PACKAGES.size).toBeGreaterThan(200)
    expect(SHIPPED_PACKAGES.has('@deepseek-ai/dsh-persona')).toBe(true)
    expect(SHIPPED_PACKAGES.has('@deepseek-ai/dsh-workflow-ptc')).toBe(true)
  })

  it('sees every row it judges, including grouped and disabled ones', () => {
    for (const presetId of BUNDLED_PRESET_IDS) {
      const rows = rowsOf(join(PRESET_ROOT, presetId, COMPOSITION_FILE))
      // A parse that silently produced nothing would pass every resolvability
      // check below, so the scanner's own coverage is asserted first: the row
      // count, a row that only exists inside a group, and a row the loader
      // starts only off Windows (whose `!!js` value must land as an object).
      expect(rows.length).toBeGreaterThan(20)
      expect(rows.some(row => row.id === 'plan-mode')).toBe(true)
      expect(rows.some(row => row.id === 'tool-bash' && typeof row.disabled === 'object')).toBe(true)
      expect(rows.some(row => !starts(row))).toBe(true)
      // A builtin row is the one `compositionProblems` skips by design, so its
      // presence is what makes that skip an exercised branch rather than a hole.
      expect(rows.some(row => row.name === 'cordis:group')).toBe(true)
    }
  })

  it('names only plugins this checkout ships, in every enabled row', () => {
    for (const presetId of BUNDLED_PRESET_IDS) {
      expect(compositionProblems(join(PRESET_ROOT, presetId, COMPOSITION_FILE))).toStrictEqual([])
    }
  })

  it('keeps mirroring the shipped standard composition, row for row', () => {
    // The standard preset is upstream source: absent in a checkout synced
    // without it, and this spec has nothing to compare against there.
    if (!existsSync(STANDARD_COMPOSITION)) return
    const standard = rowShapes(STANDARD_COMPOSITION)
    for (const presetId of BUNDLED_PRESET_IDS) {
      expect(rowShapes(join(PRESET_ROOT, presetId, COMPOSITION_FILE)), presetId).toStrictEqual(standard)
    }
  })
})
