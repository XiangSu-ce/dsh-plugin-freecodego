/**
 * The static gate's contract, and above all its *boundary*: what may reject a
 * script and what may only be reported.
 *
 * A gate that refuses a script which would have run is worse than no gate, so the
 * tests that matter most here are the ones proving that ordinary JavaScript —
 * including code the checker dislikes — still passes. The second-most important
 * group is the wiring: a gate this good that nothing calls is worth nothing, so
 * the last block asserts it is reachable from the shipped seam.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SCRIPT_EPILOGUE,
  SCRIPT_PRELUDE,
  UNAVAILABLE_SCRIPT_GLOBALS,
  WORKFLOW_FACADE_DTS,
  type ScriptDiagnostic,
  analyzeWorkflowScript,
  formatScriptDiagnostics,
  workflowScriptRefusal,
} from '../src/workflow-static-check.ts'

/**
 * The engine's own runtime, read across packages.
 *
 * Read rather than re-declared: the checker must mirror the wrapper the engine
 * really compiles, and a second copy of that assumption is a copy that drifts. The
 * same cross-package read is what `cache-cold.spec.ts` does for the pruner's config.
 */
const ENGINE_RUNTIME = readFileSync(new URL('../../../workflow/workflow-ptc/src/runtime.ts', import.meta.url), 'utf8')

/** The host's parse gate, which wraps the body the same way before compiling it. */
const ENGINE_INDEX = readFileSync(new URL('../../../workflow/workflow-ptc/src/index.ts', import.meta.url), 'utf8')

/**
 * The guest bundle, which is the copy that actually runs the script.
 *
 * Generated from `runtime.ts` (its `//#region` markers say so) and checked in, so it
 * can go stale without anything else noticing.
 */
const ENGINE_GUEST = readFileSync(new URL('../../../workflow/workflow-ptc/src/guest-source.ts', import.meta.url), 'utf8')

/**
 * The wrapper as it appears in the engine's *source*: a template literal with escaped
 * newlines and the body placeholder.
 *
 * The engine source is what is compared, so the escapes stay escaped here on purpose —
 * `\n` in this file is a backslash and an `n` in the engine's text.
 */
const ENGINE_WRAPPER_SOURCE = '`(async () => {\\n${body}\\n})()`'

/** The shipped plugin, whose wiring is asserted below. */
const PLUGIN_INDEX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** Blocking findings for one body. */
const blocking = (body: string): readonly ScriptDiagnostic[] =>
  analyzeWorkflowScript(body).diagnostics.filter(diagnostic => diagnostic.blocking)

/** The reasons that fired, in order. */
const reasons = (body: string): (string | undefined)[] => blocking(body).map(diagnostic => diagnostic.reason)

/** A refusal for one body, failing the test when the body was not refused. */
const refusalFor = (body: string): string => {
  const refusal = workflowScriptRefusal({ script: body })
  expect(refusal, `this body should have been refused: ${body}`).toBeTypeOf('string')
  return refusal ?? ''
}

describe('the wrapper the checker mirrors', () => {
  it('adds exactly one line, which is what makes body line numbers come out right', () => {
    // The engine wraps the body the same way with `lineOffset: -1`; the checker gets
    // the same cancellation for free only while the prelude stays one line long.
    expect(SCRIPT_PRELUDE.match(/\n/g)).toHaveLength(1)
    expect(SCRIPT_EPILOGUE).toBe('\n})()')
    expect(`${SCRIPT_PRELUDE}x${SCRIPT_EPILOGUE}`.split('\n')).toHaveLength(3)
  })

  it('is exactly the text the engine wraps a body in', () => {
    // Pinned as a whole rather than by substring: a wrapper that gained a line, or lost
    // its newlines, would keep passing a `toContain('(async () => {')` check while every
    // line number this gate reports quietly stopped matching the failure the model gets.
    expect(`${SCRIPT_PRELUDE}BODY${SCRIPT_EPILOGUE}`).toBe('(async () => {\nBODY\n})()')
  })

  it('is the wrapper both engine entry points really compile', () => {
    // Read out of the engine's own source instead of trusting a second copy of the same
    // assumption. There are two wrappers in the package and both matter: `index.ts`
    // parses with it, `runtime.ts` compiles with it, and they must be the same text for a
    // reported line to mean the same thing before and after the run starts.
    expect(ENGINE_INDEX, 'the host parse gate no longer wraps the body as mirrored').toContain(ENGINE_WRAPPER_SOURCE)
    expect(ENGINE_RUNTIME, 'the guest compile no longer wraps the body as mirrored').toContain(ENGINE_WRAPPER_SOURCE)
    // The line-number cancellation travels with the wrapper: without `-1` the prelude line
    // is counted as body line 1 and every position is off by one.
    expect(ENGINE_INDEX).toContain('lineOffset: -1')
    expect(ENGINE_RUNTIME).toContain('lineOffset: -1')
  })

  it('is the wrapper the checked-in guest bundle carries too', () => {
    // The bundle is generated from `runtime.ts` and committed, so it can go stale. It is
    // also the copy that actually executes the script, which makes it the worst one to
    // let drift — asserted by shape here, because inside a JSON string literal the escapes
    // are doubled and a literal comparison would be about the escaping rather than the code.
    expect(ENGINE_GUEST).toMatch(/async \(\) => \{/u)
    expect(ENGINE_GUEST).toContain('${body}')
    expect(ENGINE_GUEST).toContain('lineOffset: -1')
  })
})

describe('a script that runs', () => {
  it('passes a realistic fan-out untouched', () => {
    const body = [
      'phase("audit")',
      'const files = args.files',
      'log(`auditing ${files.length} files`)',
      'const results = await pipeline(',
      '  files,',
      '  async (previous, file) => agent(`review ${file}`, { label: file, phase: "audit" }),',
      '  async (previous, file) => ({ file, verdict: await agent(`confirm ${file}`) }),',
      ')',
      'const failed = await parallel(results.map(result => async () => agent(`explain ${result.file}`)))',
      'console.log("done")',
      'return { results: results.filter(Boolean), failed }',
    ].join('\n')
    expect(blocking(body)).toEqual([])
  })

  it('leaves the ECMAScript intrinsics the VM really has alone', () => {
    // The lib pin is what makes this work: `lib.es2022.d.ts` describes exactly the
    // surface a bare contextified VM provides, so no intrinsic is ever misreported.
    const body = [
      'const seen = new Map()',
      'const set = new Set([1, 2, 3])',
      'const now = Date.now()',
      'const stable = JSON.parse(JSON.stringify({ set: [...set], now }))',
      'const rounded = Math.round(Object.keys(stable).length)',
      'return Promise.all([Promise.resolve(rounded), Promise.resolve(new Error("x").message)])',
    ].join('\n')
    expect(blocking(body)).toEqual([])
  })
})

describe('names the VM does not install', () => {
  it('rejects every unavailable global, with a line and a repair-free explanation', () => {
    for (const name of UNAVAILABLE_SCRIPT_GLOBALS) {
      const found = blocking(`const value = ${name}`)
      expect(found, `${name} should be blocking`).toHaveLength(1)
      expect(found.at(0)?.reason).toBe('unavailable-global')
      expect(found.at(0)?.message).toContain(name)
    }
  })

  it('allows console, which the VM really does install', () => {
    // The one name that most looks forbidden and is not: `console` is present in a bare
    // contextified VM, so listing it would reject a script that works. This is the
    // regression test for that measurement.
    expect(blocking('console.log("hello")')).toEqual([])
  })

  it('sees through a member access and a call, not just a bare reference', () => {
    const body = [
      'const key = process.env.SECRET',
      'await fetch("https://example.com")',
      'const data = Buffer.from("x")',
    ].join('\n')
    expect(reasons(body)).toEqual(['unavailable-global', 'unavailable-global', 'unavailable-global'])
    expect(blocking(body).map(diagnostic => diagnostic.line)).toEqual([1, 2, 3])
  })

  it('keeps an unresolved name that the VM would not install advisory', () => {
    // "Cannot find name" is not the same finding as "the VM does not have it". A typo'd
    // name is a script bug the engine reports on its own, and this gate only owns the
    // host globals — so an unrecognized name must report and continue.
    const found = analyzeWorkflowScript('const x = someNameNobodyDeclared').diagnostics
    expect(found).not.toEqual([])
    expect(found.every(diagnostic => !diagnostic.blocking)).toBe(true)
  })

  it('does not reject a script that shadows an unavailable global with its own value', () => {
    // Resolution decides, not spelling: a script that defines `process` locally is
    // referencing its own binding, and refusing it would be a false rejection.
    const body = [
      'const process = { pid: 1 }',
      'const fetch = (url) => url',
      'return { pid: process.pid, echo: fetch("x") }',
    ].join('\n')
    expect(blocking(body)).toEqual([])
  })
})

describe('calls that always fail', () => {
  it('rejects a dynamic import, which no name-based rule could see', () => {
    const body = [
      'const a = 1',
      'const fs = await import("node:fs")',
    ].join('\n')
    const found = blocking(body)
    expect(found).toHaveLength(1)
    expect(found.at(0)?.reason).toBe('dynamic-import')
    expect(found.at(0)?.line).toBe(2)
    expect(found.at(0)?.message).toContain('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING')
  })

  it('leaves a static import statement to the parse gate that already owns it', () => {
    // `vm.Script` refuses a static import as a syntax error, so the engine's parse gate
    // rejects it first. This gate must not claim the same case under a different rule.
    expect(reasons('import fs from "node:fs"')).not.toContain('dynamic-import')
  })

  it('rejects an agent() option the runtime would reject', () => {
    const body = [
      'const a = await agent("do it", { label: "ok" })',
      'const b = await agent("do it", { effort: "high" })',
      'const c = await agent("do it", { nonsense: 1 })',
    ].join('\n')
    const found = blocking(body)
    expect(found.map(diagnostic => diagnostic.line)).toEqual([2, 3])
    expect(found.every(diagnostic => diagnostic.reason === 'unsupported-agent-option')).toBe(true)
    expect(found.at(0)?.message).toContain('deferred')
    expect(found.at(1)?.message).toContain('not recognized')
  })

  it('accepts every option the runtime accepts', () => {
    const body = 'const a = await agent("do it", { label: "l", phase: "p", provider: "pr", model: "m", schema: { type: "object" } })'
    expect(blocking(body)).toEqual([])
  })

  it('does not try to police an agent() options bag it cannot see statically', () => {
    // The runtime rejects the same call; this gate only claims what it can prove, and a
    // spread or a variable is not provably wrong.
    expect(blocking('const opts = { effort: "high" }\nconst a = await agent("do it", opts)')).toEqual([])
  })
})

describe('what the gate must never reject', () => {
  it('does not block on ordinary type complaints', () => {
    // The load-bearing property of the whole design. Each of these bodies parses and
    // runs; a JS engine does not care. Blocking any of them would turn advice into a
    // refusal to work.
    const bodies = [
      'const helper = (value) => value * 2\nreturn helper(2)',
      'const record = {}\nrecord.missing = 1\nreturn record',
      'const list = [1, 2, 3]\nreturn list[0].toFixed(2)',
      'return (undefined).anything',
      'return 1 + "two"',
      'const fn = function (a, b) { return a + b }\nreturn fn(1, 2)',
    ]
    for (const body of bodies) expect(blocking(body), body).toEqual([])
  })

  it('does not reject a call to a hook name the script shadows with its own function', () => {
    // Resolution decides here too, for the same reason as the global case. A script that
    // binds its own `agent` is calling its own function, so the guest never sees this
    // options bag and nothing about the call is fatal.
    const body = [
      'const agent = (prompt, options) => `${prompt}:${options.effort}`',
      'return agent("go", { effort: "high" })',
    ].join('\n')
    expect(blocking(body)).toEqual([])
    // And it is not a workflow hook call, so it is not a reported site either.
    expect(analyzeWorkflowScript(body).sites).toEqual([])
  })

  it('reports a type complaint without enforcing it', () => {
    const found = analyzeWorkflowScript('const helper = (value) => value * 2\nreturn helper(2)').diagnostics
    // Advisory findings are allowed to exist; they are simply not fatal.
    expect(found.every(diagnostic => !diagnostic.blocking)).toBe(true)
  })
})

describe('line and column coordinates', () => {
  it('reports the first body line as line 1', () => {
    expect(blocking('fetch("https://example.com")').at(0)?.line).toBe(1)
  })

  it('counts body lines, not wrapped lines', () => {
    const body = ['', '// a comment', '', 'const x = process.pid'].join('\n')
    expect(blocking(body).at(0)?.line).toBe(4)
  })

  it('reports a column inside the line, 1-based', () => {
    const found = blocking('const a = 1; const b = process.pid').at(0)
    expect(found?.line).toBe(1)
    expect(found?.column).toBe(24)
  })
})

describe('the hook site table', () => {
  it('numbers each hook independently, in source order', () => {
    const body = [
      'await agent("one")',
      'await agent("two")',
      'await phase("p")',
      'await agent("three")',
    ].join('\n')
    const sites = analyzeWorkflowScript(body).sites
    expect(sites.map(site => `${site.name}#${site.ordinal}`)).toEqual(['agent#1', 'agent#2', 'phase#1', 'agent#3'])
    expect(sites.map(site => site.line)).toEqual([1, 2, 3, 4])
  })

  it('finds hook calls nested inside combinators', () => {
    const body = [
      'const results = await pipeline(args.files, async (prev, file) => agent(`review ${file}`))',
    ].join('\n')
    const names = analyzeWorkflowScript(body).sites.map(site => site.name)
    expect(names).toContain('pipeline')
    expect(names).toContain('agent')
  })

  it('does not mistake the `args` value for a hook call', () => {
    const sites = analyzeWorkflowScript('const files = args.files\nreturn files').sites
    expect(sites).toEqual([])
  })
})

describe('which calls the gate applies to', () => {
  it('gates any call whose arguments carry a string script, whatever the tool is called', () => {
    // Shape, not name: the workflow tool's name is a documented configuration knob, so a
    // name-keyed rule stops guarding the moment a deployment renames it.
    expect(workflowScriptRefusal({ script: 'await fetch("https://example.com")' })).toBeTypeOf('string')
  })

  it('leaves a call with no script argument alone, which is what keeps `ralph` out of it', () => {
    // `ralph`'s body is a fixed constant compiled into the engine, so there is nothing
    // for this gate to check and nothing it should refuse.
    expect(workflowScriptRefusal({ objective: 'iterate', maxRounds: 3 })).toBeUndefined()
  })

  it('leaves a blank or absent script to the engine, which owns the request shape', () => {
    expect(workflowScriptRefusal({ script: '   ' })).toBeUndefined()
    expect(workflowScriptRefusal({ script: 42 })).toBeUndefined()
    expect(workflowScriptRefusal({})).toBeUndefined()
  })

  it('leaves arguments that are not an object alone', () => {
    expect(workflowScriptRefusal(undefined)).toBeUndefined()
    expect(workflowScriptRefusal('script')).toBeUndefined()
    expect(workflowScriptRefusal(null)).toBeUndefined()
  })

  it('lets a runnable script through', () => {
    expect(workflowScriptRefusal({ script: 'return await agent("go")' })).toBeUndefined()
  })
})

describe('the refusal the model sees', () => {
  it('names the line, the cause, and the fact that nothing was started', () => {
    const refusal = refusalFor(['const a = 1', 'await fetch("https://example.com")'].join('\n'))
    expect(refusal).toContain('2:7')
    expect(refusal).toContain('fetch')
    expect(refusal).toContain('not available to a workflow script')
    expect(refusal).toContain('no child agent was started')
  })

  it('says how to repair a deferred agent() option', () => {
    const refusal = refusalFor('const a = await agent("do it", { effort: "high" })')
    expect(refusal).toContain('deferred')
    expect(refusal).toContain('supported: label, phase, schema, provider, model')
  })

  it('caps a long list and says how many were omitted', () => {
    const diagnostics: ScriptDiagnostic[] = Array.from({ length: 25 }, (_, index) => ({
      line: index + 1, column: 1, code: 0, blocking: true,
      reason: 'unavailable-global', message: `problem ${index + 1}`,
    }))
    const rendered = formatScriptDiagnostics(diagnostics, 20)
    expect(rendered).toContain('problem 20')
    expect(rendered).not.toContain('problem 21')
    expect(rendered).toContain('and 5 more findings')
  })
})

describe('the façade', () => {
  it('is a global declaration file, so the hooks are ambient', () => {
    // A top-level import or export would turn this into a module and every hook
    // reference would become "Cannot find name" for a name that plainly exists.
    expect(WORKFLOW_FACADE_DTS).not.toMatch(/^\s*(import|export)\b/m)
    for (const hook of ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'console']) {
      expect(WORKFLOW_FACADE_DTS).toContain(hook)
    }
  })

  it('declares a closed options bag, which is what rejects an unknown option', () => {
    expect(WORKFLOW_FACADE_DTS).toContain('interface WorkflowAgentOptions')
    for (const option of ['label', 'phase', 'provider', 'model', 'schema']) {
      expect(WORKFLOW_FACADE_DTS).toContain(`${option}?:`)
    }
  })
})

describe('a gate that cannot run', () => {
  it('refuses instead of throwing across the seam', () => {
    // The branch that only ever runs on a machine whose install is broken. It is
    // reached here through the analyzer seam, because a throw would leave the outcome
    // to whatever the host does with a failing `tools/pre-execute` listener — and
    // "whatever the host does" is exactly the thing a gate must not delegate.
    const refusal = workflowScriptRefusal({ script: 'return await agent("go")' }, () => {
      throw new Error('typescript is not installed')
    })
    expect(refusal).toContain('typescript is not installed')
    expect(refusal).toContain('not run')
  })

  it('names the install, not the script, so nobody repairs the wrong thing', () => {
    const refusal = workflowScriptRefusal({ script: 'return 1' }, () => {
      throw new Error("Cannot find module 'typescript'")
    })
    expect(refusal).toContain('`typescript` package at runtime')
    // It must not read like the model's body was at fault: the script here is fine.
    expect(refusal).not.toContain('Fix these and call the tool again')
  })

  it('still lets a script through when the analyzer finds nothing', () => {
    expect(workflowScriptRefusal({ script: 'return 1' }, () => ({ diagnostics: [], sites: [] })))
      .toBeUndefined()
  })
})

describe('the wiring that makes it reach users', () => {
  it('refuses on the pre-execute seam the plugin actually ships', () => {
    // This block is the reason the module lives here rather than in the engine: a gate
    // added to upstream core never ships, and a gate nothing calls is worth nothing.
    const seam = PLUGIN_INDEX.indexOf("ctx.on('tools/pre-execute'")
    const call = PLUGIN_INDEX.indexOf('workflowScriptRefusal(exec.arguments)')
    expect(seam).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(seam)
  })

  it('refuses before the checkpoint capture, so a refused call leaves none behind', () => {
    expect(PLUGIN_INDEX.indexOf('workflowScriptRefusal(exec.arguments)'))
      .toBeLessThan(PLUGIN_INDEX.indexOf('checkpointAutoCapture(cwd, exec.name)'))
  })

  it('is the plugin\'s own pre-execute hook, not a second waterfall of its own', () => {
    // One hook, two refusals: a separate `ctx.on('tools/pre-execute')` for this would
    // make the ordering of the plugin's refusals depend on registration order.
    const occurrences = PLUGIN_INDEX.split("ctx.on('tools/pre-execute'").length - 1
    expect(occurrences).toBe(1)
  })
})
