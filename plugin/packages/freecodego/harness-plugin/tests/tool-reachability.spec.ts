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
 * What it does check textually, and why the denominator is the whole argument
 * --------------------------------------------------------------------------
 * A sweep is only as good as what it sweeps, and the cases at the bottom of this
 * file sweep eight descriptions and one guidance string — not the package. They
 * are the text the model is handed *without* a discovery call: an
 * `ALWAYS_IMMEDIATE` tool's description is in the schema from the first request,
 * and the Plan Mode guidance is injected on every plan turn. Text in that
 * position cannot name a deferrable tool, because nothing told the model to fetch
 * it, so "names it" really does mean "cannot call it" there. A deferred tool's
 * description is out of scope for the reason it is not a defect: it arrives with
 * the `tool_search` result that states the rule.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/tool-reachability
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDeferrableByPrefix } from '../src/deferred-tools.ts'
import { PLAN_MODE_ENFORCEMENT_ADDENDUM, PLAN_MODE_GUIDANCE } from '../src/plan-mode.ts'

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
    // Eight today: the discovery entry point, the diagnostics pair, the first-turn
    // orientation tool, the plan-mode tool, the compression marker, and the three
    // tools this plugin's own prompt text names. A parse that returned nothing
    // would make every wall below vacuous.
    const immediate = alwaysImmediate()
    expect(immediate.length).toBeGreaterThanOrEqual(7)
    expect(immediate).toContain('tool_search')
    expect(immediate).toContain('engineering_plan_mode')
    expect(deferredPrefixes()).toStrictEqual(['engineering_', 'freecodego_'])
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

/**
 * Every plugin-owned tool name a block of text mentions.
 *
 * The prefixed families are the deferrable ones, so a name outside them cannot
 * dangle and is not collected.
 */
function namedPluginTools(text: string): readonly string[] {
  return [...text.matchAll(/\b((?:engineering|freecodego)_[a-z0-9_]+)\b/gu)].map(match => match[1]!)
}

/**
 * The registered definition of each named tool, as `{ name, description }`.
 *
 * Two shapes have to be told apart. A *registration* names the tool and then
 * states a `description:` before its `parameters:` schema — that is the text the
 * model receives. A mention in a table or a prompt listing (`tool-manifest.ts`,
 * `review/engine.ts`) has no `parameters:` after it and is not what the model is
 * given, so requiring a following `parameters:` is what keeps a listing from
 * being read as the tool's own description. Both spellings the package uses for
 * the name are resolved, `name: '<x>'` and `name: SOME_CONST`.
 *
 * The `\b` belongs inside the identifier branch only. Placed after the whole
 * alternation it never matches the quoted spelling — the character following the
 * closing quote is a comma, and neither side of that position is a word
 * character — so seven of the eight entries matched nothing and the count
 * assertion in the case below is what caught it. A guard whose parse quietly
 * returns a subset is the failure mode this file exists to prevent.
 */
function definitionsOf(targets: ReadonlySet<string>): readonly { readonly name: string; readonly description: string }[] {
  const constants = new Map<string, string>()
  for (const source of SOURCES) {
    for (const match of source.text.matchAll(/const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/gu)) constants.set(match[1]!, match[2]!)
  }
  const found: { name: string; description: string }[] = []
  const seen = new Set<string>()
  for (const source of SOURCES) {
    for (const match of source.text.matchAll(/name:\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)\b)/gu)) {
      const name = match[1] ?? constants.get(match[2] ?? '')
      if (name === undefined || !targets.has(name) || seen.has(name)) continue
      const at = match.index ?? 0
      const end = source.text.indexOf('parameters:', at)
      if (end < 0) continue
      const window = source.text.slice(at, end)
      const description = /description:\s*'((?:[^'\\]|\\.)*)'/u.exec(window)?.[1]
      if (description === undefined) continue
      seen.add(name)
      found.push({ name, description })
    }
  }
  return found
}

describe('prompt text the model has without a discovery call', () => {
  it('does not name a deferrable tool, in an always-immediate description', () => {
    // Why this case is not the 151-mention sweep this module refuses to do: the
    // denominator is the eight always-immediate tools, not the package.
    //
    // A deferred tool's description is only ever visible after a `tool_search`
    // fetched it, and that result states the rule for the descriptions it returns
    // (`…including one that a description above points you at…`, pinned in
    // `deferred-tools.spec.ts`), so a sibling name in one of those is covered by
    // construction. An `ALWAYS_IMMEDIATE` description is in the schema from the
    // first request and never passes through a discovery call, so a sibling name
    // in one of *those* is a dead pointer whatever the model does — it cannot
    // load a schema nothing told it to fetch. That hole was open and unguarded.
    const immediate = alwaysImmediate()
    const definitions = definitionsOf(new Set(immediate))
    // A parse that found fewer definitions than names would make the wall below
    // vacuous, which is how a check like this rots into a green light.
    expect(definitions.map(entry => entry.name).sort()).toStrictEqual([...immediate].sort())
    expect(definitions.filter(entry => entry.description === '')).toStrictEqual([])
    const offenders = definitions.flatMap(({ name, description }) =>
      namedPluginTools(description)
        .filter(named => named !== name && isDeferrableByPrefix(named))
        .map(named => `${name} names ${named}`),
    )
    expect(offenders).toStrictEqual([])
  })

  it('does not name a deferrable tool, in the Plan Mode guidance', () => {
    // `deferred-tools.ts` used to state that `plan-mode.ts` asserted this against
    // its own predicate. Nothing did — the claim was a guard that did not exist,
    // and a documented guard that is absent is worse than an undocumented gap
    // because it stops the next reader from looking. This is that assertion, and
    // the claim now names this file instead.
    const guidance = [PLAN_MODE_GUIDANCE, PLAN_MODE_ENFORCEMENT_ADDENDUM].join('\n')
    // The text does name `engineering_plan_mode`, which is in `ALWAYS_IMMEDIATE`
    // for exactly this reason, so the two have to keep moving together.
    expect(guidance).toContain('engineering_plan_mode')
    expect(namedPluginTools(guidance).filter(name => isDeferrableByPrefix(name))).toStrictEqual([])
  })

  it('does not name a deferrable tool, in an injected prompt section', () => {
    // The third route into the request, and the one this file was missing.
    //
    // An injected `systemPrompt.section` reaches every request the way an
    // ALWAYS_IMMEDIATE description does, and the two other cases above do not
    // cover it: the Plan Mode case reads one fixed string from `plan-mode.ts`,
    // and the description case reads registrations. So a section could name a
    // deferrable tool and nothing objected — which is what happened.
    //
    // `freecodego_companion_face` shipped exactly that way: the guidance line
    // named the tool, `freecodego_` is a deferred prefix, and two live turns that
    // read the line and ended on a missing file called nothing — the call is
    // refused until a `tool_search` the line never mentioned. The tool is in
    // ALWAYS_IMMEDIATE now; this case is what makes removing it fail loudly
    // rather than quietly returning to the state a live run had to find.
    // A name in prompt text is usually an interpolation, not a literal: the
    // companion line says `Use ${COMPANION_FACE_TOOL_NAME} when…`, so a scan over
    // raw source sees no plugin tool name at all and reports a clean package for
    // the exact defect this case exists for — which it did, on the first run of
    // this case. Resolving the module-level constants first is what makes the
    // scan read the text the model is actually given.
    const constants = new Map<string, string>()
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/gu)) constants.set(match[1]!, match[2]!)
    }
    const sections = SOURCES.flatMap(({ path, text }) => {
      const found: { readonly path: string; readonly text: string }[] = []
      // The optional `?` after `section` is what lets one pattern read all of
      // them: this package spells it `systemPrompt?.section?.({` where the
      // service is optional and `systemPrompt.section({` where it is not, and a
      // pattern requiring the second dot missed two of the four call sites.
      for (const match of text.matchAll(/systemPrompt\??\.section\??\.?\(\{/gu)) {
        const at = match.index ?? 0
        const end = text.indexOf('})', at)
        const block = text.slice(at, end < 0 ? undefined : end)
        found.push({ path, text: block.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (match, id: string) => constants.get(id) ?? match) })
      }
      return found
    })
    // Both spellings this package uses, `systemPrompt.section({` and
    // `systemPrompt?.section?.({`, are matched; four call sites exist today, so
    // a scan that returns far fewer is a parse that stopped working rather than a
    // clean package.
    expect(sections.length).toBeGreaterThanOrEqual(3)
    expect(sections.some(section => section.text.includes('read_document'))).toBe(true)
    const offenders = sections.flatMap(({ path, text }) =>
      namedPluginTools(text)
        .filter(named => isDeferrableByPrefix(named))
        // Naming the tool and stating how to load it is the documented fix; the
        // name has to appear *in* the hint, so a section that hints at some other
        // tool still fails for this one.
        .filter(named => !new RegExp(`deferredToolFetchHint\\([^)]*\\b${named}\\b`, 'u').test(text))
        .map(named => `${path} names ${named} with no fetch hint`),
    )
    expect(offenders).toStrictEqual([])
  })
})
