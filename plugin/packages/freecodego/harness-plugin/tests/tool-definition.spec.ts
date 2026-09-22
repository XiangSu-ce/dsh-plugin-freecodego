/**
 * The plugin's tool definitions share one output rendering rule.
 *
 * Nearly every tool answers with data, and the answer is rendered the same way
 * whichever tool produced it: pretty JSON for a value, the text itself when the
 * answer is already a string. That rule was declared separately in `index.ts`
 * (six definitions), `persona/tools.ts`, and `worktree/tools.ts` — copies that
 * agreed, which is exactly why nothing noticed them. They live in
 * `tool-definition.ts` now, typed against the registry's own `output` field,
 * beside the compile-time guard it belongs to.
 *
 * The source half of this file is deliberate: the copies were behaviourally
 * identical, so only the shape of the tree catches a re-introduced one.
 */

import { describe, expect, it } from 'vitest'
import { JSON_TOOL_OUTPUT } from '../src/tool-definition.ts'
import { sourceFiles } from './support/source-files.ts'

/** Modules that register tools whose answer is data. */
const CONSUMERS: readonly string[] = ['index.ts', 'persona/tools.ts', 'worktree/tools.ts']

describe('shared tool output declaration', () => {
  it('renders a value as pretty JSON and a string as itself', () => {
    // A tool that answered with quoted JSON would hand the model an escaped
    // blob, and one that stringified a string would double-quote it.
    expect(JSON_TOOL_OUTPUT.render({}, { a: 1 })).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
    expect(JSON_TOOL_OUTPUT.render({}, 'already text')).toEqual([{ type: 'text', text: 'already text' }])
    expect(JSON_TOOL_OUTPUT.schema).toEqual({ type: 'object', additionalProperties: true })
  })

  it('is declared in exactly one module, and every consumer reads it from there', async () => {
    const files = await sourceFiles()
    expect(files.length, 'the source tree was not read').toBeGreaterThan(100)
    // The rule, not the call: `JSON.stringify(value, null, 2)` alone also appears
    // in the atomic state writes, which indent a document rather than render a
    // tool answer. The passthrough ternary is what makes this the render rule.
    const rule = /typeof value === 'string' \? value : JSON\.stringify\(value, null, 2\)/u
    const declaring = files.filter(file => rule.test(file.text)).map(file => file.path)
    expect(declaring, 'the JSON rendering rule belongs to one module').toEqual(['tool-definition.ts'])
    for (const name of CONSUMERS) {
      const consumer = files.find(file => file.path === name)
      expect(consumer, name).toBeDefined()
      expect(consumer?.text, name).toContain('JSON_TOOL_OUTPUT')
    }
  })
})
