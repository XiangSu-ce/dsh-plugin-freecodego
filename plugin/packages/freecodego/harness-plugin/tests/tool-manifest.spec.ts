/**
 * The manifest is the whole of this plugin's tool surface, and the only place a
 * name is written down.
 *
 * Why this file exists
 * --------------------
 * A tool's name used to be restated in several places that never read each
 * other: the registration literal, `plan-mode.ts`'s three lists, a role fence this
 * plugin no longer carries, and the READMEs. Every restatement was a claim about
 * the same tool, and each time the tool moved one of them was left behind — the
 * fence refusing the readers its own guidance recommends, a read-only role holding
 * a tool that deletes a worktree, a README documenting a tool that does not exist
 * under that name.
 *
 * So the declaration lives in `src/tool-manifest.ts`, one row per tool, and this
 * file is what makes the table trustworthy rather than merely central. It reads
 * the registration literals out of this package's source and holds the two
 * directions apart:
 *
 *  - **Every registration has a row.** A tool with no row is refused by Plan Mode
 *    as unclassified and held by nobody, which is a decision nothing states.
 *  - **Every row is a registration.** A row with no tool is a promise the fence
 *    makes about a name that does not exist, and a name that is never refused or
 *    granted because nothing will ever call it.
 *
 * The third direction is the one no import can check: **the documentation**. The
 * READMEs name tools, and a README is where a renamed tool survives longest,
 * because nothing runs it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/tool-manifest
 */

import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import {
  PLUGIN_TOOL_MANIFEST,
  PLUGIN_TOOL_NAMES,
  pluginToolCapability,
  pluginToolsNeedingAuthority,
  pluginToolsWithPlanMode,
  pluginToolsWithoutPrefix,
} from '../src/tool-manifest.ts'
import {
  PLAN_MODE_ALLOWED_PLUGIN_TOOLS,
  PLAN_MODE_MUTATING_PLUGIN_TOOLS,
  PLAN_MODE_MUTATING_TOOLS,
  PLAN_MODE_PLUGIN_TOOL_PREFIXES,
  PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS,
} from '../src/plan-mode.ts'
import { VERIFICATION_TOOL_NAME, WORKSPACE_MUTATING_TOOLS } from '../src/verify-on-stop.ts'
import { describeTools, registeredTools } from './support/registered-tools.ts'
import { sourceFiles } from './support/source-files.ts'

/** The documents that name tools, and the shapes a name can take in them. */
const DOCUMENTS = ['README.md', 'README.zh.md'] as const

describe('the manifest and the registrations agree', () => {
  test('every tool this package registers has a row', async () => {
    const rows = new Set(PLUGIN_TOOL_NAMES)
    const missing = (await registeredTools()).filter(tool => !rows.has(tool.name))
    // Naming the site matters more than naming the tool here: a reader has to
    // know which module to open, and the site is the whole discovery.
    expect(missing, `\nregistered with no manifest row: ${describeTools(missing)}\n`).toEqual([])
  })

  test('every row names a tool this package registers', async () => {
    const discovered = new Set((await registeredTools()).map(tool => tool.name))
    const phantom = PLUGIN_TOOL_NAMES.filter(name => !discovered.has(name))
    expect(phantom, `\nmanifest rows with no registration: ${phantom.join(', ')}\n`).toEqual([])
  })

  test('no name is declared twice', () => {
    expect(new Set(PLUGIN_TOOL_NAMES).size).toBe(PLUGIN_TOOL_NAMES.length)
    // A name on both sides of the Plan Mode fence would make the fence's answer
    // depend on which branch is read first, which is an ordering guarantee nobody
    // has a reason to know.
    const mutating = new Set(pluginToolsWithPlanMode('refuse'))
    expect(pluginToolsWithPlanMode('allow').filter(name => mutating.has(name))).toEqual([])
  })

  test('a row that keeps a real authority while planning says why', () => {
    // The two fields disagree for a legitimately reasoned set of tools — a council
    // starts child Agents that are themselves started read-only, so planning may
    // dispatch one. A reason left unwritten is how the next reader "corrects" the
    // row, so wherever the disagreement is not self-evident the row has to carry it.
    const unexplained = PLUGIN_TOOL_MANIFEST
      .filter(tool => tool.capability !== 'read' && tool.planMode === 'allow' && tool.note === undefined)
      .map(tool => tool.name)
    expect(unexplained, `\nallows a tool that needs authority, with no note: ${unexplained.join(', ')}\n`).toEqual([])
  })

  test('the discovery can see every row, which is what makes the two directions usable', async () => {
    // The sweep is prefix-driven for its first pass, so a row whose name carries an
    // undeclared prefix would be found by the other passes but not by that one — and
    // the fence reads prefixes to decide what is this plugin's own. `edit_and_run` is
    // registered with no prefix at all and is reached through its constant, which is
    // why the unprefixed list is an explicit declaration rather than a prefix test.
    const unprefixed = new Set(pluginToolsWithoutPrefix(PLAN_MODE_PLUGIN_TOOL_PREFIXES))
    const unreachable = PLUGIN_TOOL_NAMES.filter(name => !unprefixed.has(name)
      && !PLAN_MODE_PLUGIN_TOOL_PREFIXES.some(prefix => name.startsWith(prefix)))
    expect(unreachable, `\nnames no declared prefix and no unprefixed declaration covers: ${unreachable.join(', ')}\n`).toEqual([])
    expect([...unprefixed].sort()).toStrictEqual([...PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS].sort())
  })
})

describe('the fences read the manifest rather than a second copy of it', () => {
  test('the Plan Mode lists are the manifest, not a list beside it', () => {
    expect([...PLAN_MODE_ALLOWED_PLUGIN_TOOLS]).toStrictEqual([...pluginToolsWithPlanMode('allow')])
    expect([...PLAN_MODE_MUTATING_PLUGIN_TOOLS]).toStrictEqual([...pluginToolsWithPlanMode('refuse')])
    expect([...PLAN_MODE_ALLOWED_PLUGIN_TOOLS, ...PLAN_MODE_MUTATING_PLUGIN_TOOLS].sort()).toStrictEqual([...PLUGIN_TOOL_NAMES].sort())
  })

  test('no fence states a plugin tool name of its own beside the manifest', async () => {
    // The regression this stops is the one that happened four times: a name added
    // to one reader's list and not the others. A quoted plugin-prefixed literal in a
    // fence module is that copy coming back, so it fails here rather than waiting to
    // be found by whichever reader it was not added to.
    //
    // The *registration* literals are not covered, and should not be: they live in
    // the modules that own each tool and they are the definition, which the two
    // directions above hold the table against. What is checked here is the narrower
    // claim — that a module whose job is to *answer questions about* names has no
    // names of its own beyond the table.
    const fences = ['plan-mode.ts', 'verify-on-stop.ts']
    const prefixPattern = new RegExp(`'((?:${PLAN_MODE_PLUGIN_TOOL_PREFIXES.join('|')})[a-z0-9_]+)'`, 'gu')
    const offenders: string[] = []
    for (const file of await sourceFiles()) {
      if (!fences.includes(file.path)) continue
      for (const match of file.text.matchAll(prefixPattern)) {
        if (match[1] === undefined) continue
        // One exception, and it is checked rather than trusted: `verify-on-stop.ts`
        // names the verification tool once so its nudge text and its evidence reader
        // cannot disagree about it. That constant has to be a manifest row — asserted
        // here and not assumed — so the exemption cannot hide a name no row grants.
        if (file.path === 'verify-on-stop.ts' && match[1] === VERIFICATION_TOOL_NAME) continue
        offenders.push(`${match[1]} (${file.path})`)
      }
    }
    expect(PLUGIN_TOOL_NAMES, 'the named verification tool must be a manifest row').toContain(VERIFICATION_TOOL_NAME)
    expect(offenders, `\na fence holds its own copy of a plugin tool name: ${offenders.join(', ')}\n`).toEqual([])
  })

  test('verify-on-stop carries every name that needs authority, and the Plan Mode refusals', () => {
    const missing = pluginToolsNeedingAuthority().filter(name => !WORKSPACE_MUTATING_TOOLS.has(name))
    expect(missing, `\nneeds authority but cannot be a workspace change: ${missing.join(', ')}\n`).toEqual([])
    // The weaker direction, for the reason that module's header gives: a name Plan
    // Mode refuses reaches the machine by definition, so a turn that only called one
    // still has to be checked for changed paths.
    const unfenced = PLAN_MODE_MUTATING_TOOLS.filter(name => !WORKSPACE_MUTATING_TOOLS.has(name))
    expect(unfenced, `\nrefused by Plan Mode but not read as a change: ${unfenced.join(', ')}\n`).toEqual([])
  })
})

describe('the documentation reads the manifest too', () => {
  test('every tool a README names is a tool this package registers', async () => {
    // Both directions of rot are caught here. A tool that was renamed leaves prose
    // that names a name nobody answers to; a tool that was deleted leaves the same.
    // Families (`engineering_team_*`) are allowed, but only if they still cover at
    // least one row, because a family wildcard is how a README lists tools without
    // listing them.
    const root = new URL('../', import.meta.url)
    const offenders: string[] = []
    for (const document of DOCUMENTS) {
      const text = await readFile(new URL(document, root), 'utf8')
      for (const match of text.matchAll(/`([a-z][a-z0-9_]*(?:\*)?)`/gu)) {
        const token = match[1]
        if (token === undefined) continue
        const family = token.endsWith('*') ? token.slice(0, -1) : undefined
        const named = family !== undefined
          ? PLUGIN_TOOL_NAMES.some(name => name.startsWith(family))
          : PLUGIN_TOOL_NAMES.includes(token)
        const mine = family !== undefined
          ? PLAN_MODE_PLUGIN_TOOL_PREFIXES.some(prefix => family.startsWith(prefix))
          : PLAN_MODE_PLUGIN_TOOL_PREFIXES.some(prefix => token.startsWith(prefix)) || token === 'edit_and_run'
        if (mine && !named) offenders.push(`${token} (${document})`)
      }
    }
    expect(offenders, `\ndocumented tool names no manifest row answers to: ${offenders.join(', ')}\n`).toEqual([])
  })

  test('the check above is not vacuous', async () => {
    // A pattern that matched nothing would pass the case above forever. Counting the
    // names it does read is the cheapest way to keep it honest.
    const root = new URL('../', import.meta.url)
    let seen = 0
    for (const document of DOCUMENTS) {
      const text = await readFile(new URL(document, root), 'utf8')
      for (const match of text.matchAll(/`([a-z][a-z0-9_]*(?:\*)?)`/gu)) {
        const token = match[1]
        if (token === undefined) continue
        if (PLAN_MODE_PLUGIN_TOOL_PREFIXES.some(prefix => token.startsWith(prefix)) || token === 'edit_and_run') seen += 1
      }
    }
    expect(seen).toBeGreaterThan(50)
  })
})

describe('the capability axis carries the authority question', () => {
  test('a name that needs authority is never filed as a read', () => {
    // Stated on the manifest alone, so the table is what a reader has to change:
    // the capability column is the one place a tool's authority is declared.
    const authority = pluginToolsNeedingAuthority()
    expect(authority.length).toBeGreaterThan(5)
    for (const name of authority) {
      expect(pluginToolCapability(name), name).not.toBe('read')
      expect(pluginToolCapability(name), name).toBeDefined()
    }
  })
})
