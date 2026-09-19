/**
 * A tool name the plugin treats as reachable must still be a tool it registers.
 *
 * Why this is a gate rather than a convention
 * -------------------------------------------
 * The plugin withholds most of its tool schemas by default
 * (`deferredToolSchemasEnabled` defaults to true): `deferred-tools.ts` denies
 * every deferrable tool to each Agent on `agent/created` and hands the model
 * `tool_search` instead. Access to a deferred tool therefore has two halves — the
 * schema the model receives, and the instruction that tells it the tool exists —
 * and neither half may name something the other cannot satisfy.
 *
 * `ALWAYS_IMMEDIATE` is the exception list that keeps that promise for the
 * tools the plugin's own prompt text has to name. It is a list of *strings*, so
 * it fails silently in one direction: rename a tool and its entry survives as a
 * dead name while the tool quietly becomes deferrable again — in exactly the
 * situation the entry was added for. Nothing else in the repository notices,
 * because a name that no longer matches anything simply stops being read.
 *
 * What it checks
 * --------------
 * 1. Every `ALWAYS_IMMEDIATE` name is still registered somewhere in this
 *    package, so a rename fails here instead of in production. Both spellings
 *    the package uses count: `name: '<x>'` and `name: SOME_CONST`, the latter
 *    resolved through the module-level `const SOME_CONST = '<x>'`. Reading only
 *    literals made this check report `edit_and_run` — registered by
 *    `src/edit-and-run.ts:318` as `name: EDIT_AND_RUN_TOOL_NAME` — as a dead
 *    name, i.e. the check was wrong about the one tool it should have cleared.
 * 2. Every `ALWAYS_IMMEDIATE` name is covered by a reason in the doc comment
 *    above the set. An unexplained entry is how a list like this rots.
 * 3. Every name in it is genuinely non-deferrable, which is the property the
 *    list is asserting. Note what the list protects *against*: `eligible()`
 *    consults it before the explicit `deferredToolNames` setting, so it is not
 *    only an exception to the prefix rule — `tool_search` and
 *    `headroom_retrieve` are outside the prefixed families and are in the set
 *    precisely so an operator's explicit list can never defer them.
 * 4. The deferrable prefixes are the three documented plugin-owned families —
 *    the rule the exemption is an exception to.
 *
 * What it deliberately does not check
 * -----------------------------------
 * It does not scan the package for tool-name literals. That was the first
 * attempt and it is the wrong shape: 151 legitimate mentions exist (definition
 * sites, Plan Mode allow/deny tables, `toolDeny` role tables, dispatch cases,
 * read-only allowlists), so the check would have needed a 151-entry exemption
 * table — a mirror of the code, which is worse than no gate. The property that
 * actually matters — *a prompt names only tools its Agent's inventory carries* —
 * is not textual, and it is verified behaviourally in `engine-prompts.spec.ts`
 * by calling both prompt builders with a poisoned inventory.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/tool-reachability
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDeferrableByPrefix } from '../src/deferred-tools.ts'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const SRC_ROOT = join(PACKAGE_ROOT, 'src')

/** Every `.ts` file under the package's `src`, excluding build output. */
function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) found.push(path)
    }
  }
  walk(SRC_ROOT)
  return found.sort()
}

const SOURCES = sourceFiles().map(path => ({
  path: relative(PACKAGE_ROOT, path).replace(/\\/gu, '/'),
  text: readFileSync(path, 'utf8'),
}))

/** The `ALWAYS_IMMEDIATE` set, read from the module that owns it. */
function alwaysImmediate(): readonly string[] {
  const owner = SOURCES.find(source => source.path === 'src/deferred-tools.ts')!.text
  const block = /const ALWAYS_IMMEDIATE: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/u.exec(owner)
  if (block === null) throw new Error('deferred-tools.ts no longer declares ALWAYS_IMMEDIATE in the expected shape')
  return [...block[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]!)
}

/** The deferrable prefixes, read from the module that owns the rule. */
function deferredPrefixes(): readonly string[] {
  const owner = SOURCES.find(source => source.path === 'src/deferred-tools.ts')!.text
  const block = /const DEFERRED_PREFIXES: readonly string\[\] = \[([^\]]*)\]/u.exec(owner)
  if (block === null) throw new Error('deferred-tools.ts no longer declares DEFERRED_PREFIXES in the expected shape')
  return [...block[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]!)
}

/**
 * Every tool name this package registers, from both spellings it uses.
 *
 * `name: '<x>'` is the common form. The other is `name: SOME_CONST`, where the
 * constant is a module-level `const SOME_CONST = '<x>'` — `edit_and_run` and
 * `engineering_team_verify` are registered that way, and a literal-only scan
 * reports both as unregistered. A check that is wrong about a live tool is worse
 * than no check: it fails on a correct entry, and the next person deletes the
 * entry rather than fixing the scan.
 */
function registeredNames(): ReadonlySet<string> {
  const constants = new Map<string, string>()
  for (const source of SOURCES) {
    for (const match of source.text.matchAll(/const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/gu)) constants.set(match[1]!, match[2]!)
  }
  const names = new Set<string>()
  for (const source of SOURCES) {
    for (const match of source.text.matchAll(/name:\s*'([^']+)'/gu)) names.add(match[1]!)
    for (const match of source.text.matchAll(/name:\s*([A-Z][A-Z0-9_]*)\b/gu)) {
      const resolved = constants.get(match[1]!)
      if (resolved !== undefined) names.add(resolved)
    }
  }
  return names
}

describe('ALWAYS_IMMEDIATE', () => {
  it('parses the set, so an empty scan cannot pass silently', () => {
    // Six today: the discovery entry point, the diagnostics pair, the first-turn
    // orientation tool, the plan-mode tool, the advisor, and the compression
    // marker. A parse that returned nothing would make every wall below vacuous.
    const immediate = alwaysImmediate()
    expect(immediate.length).toBeGreaterThanOrEqual(6)
    expect(immediate).toContain('tool_search')
    expect(immediate).toContain('engineering_plan_mode')
    expect(deferredPrefixes()).toStrictEqual(['engineering_', 'advisor_', 'freecodego_'])
  })

  it('keeps only names this package still registers', () => {
    // A renamed tool leaves a dead entry behind and silently becomes deferrable,
    // which is the state these entries exist to prevent.
    const registered = registeredNames()
    // An empty or truncated scan would make the wall below vacuous, so pin what
    // it must have seen: the two constant-registered names plus the literal ones.
    expect(registered.size).toBeGreaterThan(40)
    expect(registered).toContain('edit_and_run')
    expect(registered).toContain('engineering_team_verify')
    expect(registered).toContain('read_document')
    const stale = alwaysImmediate().filter(name => !registered.has(name))
    expect(stale).toStrictEqual([])
  })

  it('explains every entry', () => {
    const owner = SOURCES.find(source => source.path === 'src/deferred-tools.ts')!.text
    const explained = owner.slice(owner.indexOf('Tools that stay in the wire schema'), owner.indexOf('const ALWAYS_IMMEDIATE'))
    expect(alwaysImmediate().filter(name => !explained.includes(name))).toStrictEqual([])
  })

  it('is non-deferrable in full, and covers the discovery entry point', () => {
    for (const name of alwaysImmediate()) expect(isDeferrableByPrefix(name), name).toBe(false)
    // `tool_search` is the entry point of the whole mechanism: deferring it
    // would be a lockout, because the only way to fetch a deferred schema would
    // be a tool that is itself deferred.
    expect(alwaysImmediate()).toContain('tool_search')
    expect(isDeferrableByPrefix('tool_search')).toBe(false)
    // And the predicate must defer what the prefixes say it should, or the set
    // above would be protecting nothing.
    for (const prefix of deferredPrefixes()) expect(isDeferrableByPrefix(`${prefix}probe`), prefix).toBe(true)
  })
})
