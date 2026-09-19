/**
 * Coverage: every plugin tool is classified for Plan Mode, and every entry names
 * a tool that exists.
 *
 * Why this file exists
 * --------------------
 * Plan Mode refuses a plugin tool it has not classified, and that default is
 * deliberate: it is what stops a newly added mutating tool from becoming callable
 * while the user is only planning. But an undescribed default has a second edge —
 * a *read-only* tool that was never added to the allow list is refused too, and
 * the refusal is reported to the model as "this mode does not classify that tool
 * as safe to run while planning", which reads like a decision rather than an
 * omission.
 *
 * That is not hypothetical. `engineering_inspect` and `engineering_hunks` — the
 * two most direct ways to learn what a workspace actually contains — were both
 * unclassified, so Plan Mode refused exactly the tools its own guidance tells the
 * model to use. Nothing failed: the fence worked, the tests passed, and the
 * behaviour was wrong. What was missing was a check that the three lists cover
 * the tools that exist, which the module header claimed and no test performed.
 *
 * The two directions are both load-bearing:
 *
 *  - **Every discovered tool must be classified.** An omission is a refusal the
 *    user did not ask for (read-only tool) or a fence that only holds by accident
 *    (mutating tool).
 *  - **Every classified name must be a discovered tool.** A typo in the allow
 *    list means the real tool is refused; a typo in the deny list means a mutating
 *    tool is refused only because unclassified ones are. Neither is visible
 *    without this direction.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/plan-mode-coverage
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  PLAN_MODE_ALLOWED_PLUGIN_TOOLS,
  PLAN_MODE_MUTATING_PLUGIN_TOOLS,
  PLAN_MODE_PLUGIN_TOOL_PREFIXES,
  PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS,
  planModeRefusal,
} from '../src/plan-mode.ts'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

/**
 * Plugin-prefixed string literals that are deliberately *not* tool names.
 *
 * Enumerated rather than pattern-matched, so a new one has to be a decision
 * someone wrote down instead of a name the probe quietly skipped. Each entry says
 * where it comes from, because that is what makes it checkable.
 */
const NOT_TOOLS: Readonly<Record<string, string>> = {
  // A model id in the evaluation corpus, not a tool.
  agnes_video_v3: 'a media model id in engineering-eval.ts',
  // MCP tool names offered to the native engines, which never pass through the
  // plugin's tool registry and so are not the fence's subject.
  freecodego_skill_discover: 'an MCP tool name rendered for the Claude runtime',
  freecodego_skill_load: 'an MCP tool name rendered for the Claude runtime',
  // A harness tool this plugin does not register. Its rule on the allow list is
  // inert — the fence only consults that list for names it recognises as the
  // plugin's own — but it is kept because it states the intent, and the reverse
  // direction below has to know that it names nothing this plugin owns.
  tool_search: 'a Harness tool (deferred tool schemas), not one this plugin registers',
}

/** Every `.ts` file under a directory, recursively. */
async function sources(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/**
 * The tool names this plugin registers, discovered from its own source.
 *
 * Discovered rather than imported because the definitions are not exported in one
 * place: they are literals spread across the modules that own them, and several
 * are constants referenced by name. Scanning the literals is what makes a missing
 * entry in either list a failure rather than something a reviewer has to notice.
 * @returns the plugin-prefixed names, sorted, with the documented exceptions removed.
 */
async function discoveredTools(): Promise<readonly string[]> {
  const pattern = new RegExp(`'(${PLAN_MODE_PLUGIN_TOOL_PREFIXES.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})[a-z0-9_]+'`, 'gu')
  const found = new Set<string>()
  for (const file of await sources(sourceRoot)) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(pattern)) found.add(match[0].slice(1, -1))
  }
  // Tools named through a constant carry no literal at the definition site, so
  // the prefix scan cannot see them. Resolving `name: SOME_CONST` back to its
  // initializer is what makes the one tool in that shape — `edit_and_run` —
  // visible to this probe, and a fence that only reads prefixes invisible to it.
  for (const file of await sources(sourceRoot)) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/^\s+name: ([A-Z][A-Z0-9_]*),/gmu)) {
      const constant = match[1]
      const definition = new RegExp(`(?:export )?const ${constant} = '([a-z0-9_]+)'`, 'u').exec(text)
      if (definition?.[1] !== undefined) found.add(definition[1])
    }
  }
  // Tools registered under a name with **no** plugin prefix carry no prefix to scan
  // for, so the two passes above cannot see them. `edit_and_run` is reached by the
  // constant resolution; `inspect`, `spill_recall` and `read_document` are literals
  // in the registration shape and were reached by neither, which is how they sat
  // outside every classification while being callable during planning. Swept here
  // so a new unprefixed tool is a failure rather than an unlooked-at name.
  for (const file of await sources(sourceRoot)) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/^\s+name: '([a-z0-9_]+)',/gmu)) {
      const name = match[1]
      if (name !== undefined) found.add(name)
    }
  }
  for (const name of Object.keys(NOT_TOOLS)) found.delete(name)
  return [...found].sort()
}

describe('Plan Mode classification covers every plugin tool', () => {
  test('nothing is left unclassified', async () => {
    const classified = new Set([...PLAN_MODE_ALLOWED_PLUGIN_TOOLS, ...PLAN_MODE_MUTATING_PLUGIN_TOOLS])
    const unclassified = (await discoveredTools()).filter(name => !classified.has(name))
    expect(unclassified, `unclassified plugin tools: ${unclassified.join(', ')}`).toEqual([])
  })

  test('every registered name carries a prefix the discovery can see', async () => {
    // The discovery is prefix-driven, so a tool registered under a prefix that is
    // not on the list is invisible to it — and invisible means *allowed* while
    // planning, because the fence's "unclassified is refused" branch is reached by
    // prefix in the first place. Today every literal name carries a declared
    // prefix, and this keeps it that way rather than relying on the next author to
    // remember the list. `edit_and_run` is registered without any prefix and is
    // found through its constant by the resolution above, which is why the sweep
    // below reads literals only.
    const exempt = new Set(Object.keys(NOT_TOOLS))
    const declared = new Set(PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS)
    const offenders: string[] = []
    // The discovery's own answer, so a name registered through a constant is not
    // mistaken for a stale declaration.
    const seen = new Set(await discoveredTools())
    for (const file of await sources(sourceRoot)) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/^\s+name: '([a-z0-9_]+)',/gmu)) {
        const name = match[1]
        if (name === undefined || exempt.has(name)) continue
        if (PLAN_MODE_PLUGIN_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) continue
        if (declared.has(name)) continue
        offenders.push(`${name} (${file.slice(sourceRoot.length + 1).replaceAll('\\', '/')})`)
      }
    }
    expect(offenders, `registered names no prefix can discover: ${offenders.join(', ')}`).toEqual([])
    // The other direction, so a declaration cannot outlive its tool: every name on
    // the unprefixed list is a literal this sweep actually saw, and is classified.
    const classified = new Set([...PLAN_MODE_ALLOWED_PLUGIN_TOOLS, ...PLAN_MODE_MUTATING_PLUGIN_TOOLS])
    const stale = PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS.filter(name => !seen.has(name) || !classified.has(name))
    expect(stale, `unprefixed names with no registered tool, or none classified: ${stale.join(', ')}`).toEqual([])
  })

  test('every classified name is a tool that exists', async () => {
    const discovered = new Set(await discoveredTools())
    const exempt = new Set(Object.keys(NOT_TOOLS))
    const stale = [...PLAN_MODE_ALLOWED_PLUGIN_TOOLS, ...PLAN_MODE_MUTATING_PLUGIN_TOOLS]
      .filter(name => !discovered.has(name) && !exempt.has(name))
    expect(stale, `classified names with no registered tool: ${stale.join(', ')}`).toEqual([])
  })

  test('a tool is never on both sides of the fence', () => {
    const mutating = new Set(PLAN_MODE_MUTATING_PLUGIN_TOOLS)
    expect(PLAN_MODE_ALLOWED_PLUGIN_TOOLS.filter(name => mutating.has(name))).toEqual([])
    expect(new Set(PLAN_MODE_ALLOWED_PLUGIN_TOOLS).size).toBe(PLAN_MODE_ALLOWED_PLUGIN_TOOLS.length)
    expect(new Set(PLAN_MODE_MUTATING_PLUGIN_TOOLS).size).toBe(PLAN_MODE_MUTATING_PLUGIN_TOOLS.length)
  })

  test('the exceptions are still real, and still not tools', async () => {
    // Not vacuous: an entry in `NOT_TOOLS` that no longer appears anywhere would
    // be an exemption nobody needs, and exemptions accumulate silently.
    const pattern = new RegExp(`'(${Object.keys(NOT_TOOLS).join('|')})'`, 'gu')
    const seen = new Set<string>()
    for (const file of await sources(sourceRoot)) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(pattern)) {
        // `noUncheckedIndexedAccess`: a capture group is possibly absent by type, and
        // the pattern is built from the keys above, so an absent one would mean the
        // regex changed rather than the file did.
        const captured = match[1]
        if (captured !== undefined) seen.add(captured)
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(NOT_TOOLS).sort())
  })
})

describe('the tools the finding was about', () => {
  test('a mutating tool with no plugin prefix is still refused', () => {
    // The hole this closes: the fence found tools by prefix, so `edit_and_run` —
    // which edits a file and runs a command — was callable while planning.
    expect(planModeRefusal({ mode: 'plan', tool: 'edit_and_run' })?.reason).toBe('mutating-tool')
    expect(planModeRefusal({ mode: 'execute', tool: 'edit_and_run' })).toBeUndefined()
  })

  test('the truth-gathering tools are usable while planning', () => {
    for (const tool of ['engineering_inspect', 'engineering_hunks']) {
      expect(planModeRefusal({ mode: 'plan', tool }), `${tool} must be allowed in plan mode`).toBeUndefined()
    }
  })

  test('undoing a recorded region is refused, by name rather than by omission', () => {
    const refusal = planModeRefusal({ mode: 'plan', tool: 'engineering_hunk_revert' })
    expect(refusal?.reason).toBe('mutating-tool')
    expect(refusal?.message).toContain('Plan Mode')
  })

  test('a tool nobody classified is still refused', () => {
    // The default has to keep working: this is the property that makes the allow
    // list safe to maintain.
    expect(planModeRefusal({ mode: 'plan', tool: 'engineering_brand_new' })?.reason).toBe('unclassified-tool')
  })
})
