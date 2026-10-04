/**
 * The batch registrar, and the two failures a `map` over the definitions causes.
 *
 * This file exists because the review tools registered their four definitions as
 * `reviewToolDefinitions({…}).map(tool => tools.register(tool))`. The good-day
 * path is identical to the helper's; the interesting path is the one where the
 * registry refuses one definition:
 *
 * - the `map` aborts, so every definition *after* the refused one is never even
 *   attempted — three missing tools reported as one log line, and
 * - the handles of the definitions that *did* register are lost with the thrown
 *   stack frame, so the disposal effect is never registered and those tools stay
 *   mounted after the plugin is gone.
 *
 * Both are asserted here directly, against the shared helper every batch
 * registration now goes through.
 */

import { describe, expect, it, vi } from 'vitest'

import { disposeToolRegistration, registerToolDefinitions, type ToolRegistration } from '../src/tool-registration.ts'
import type { ToolDefinitionShape } from '../src/tool-definition.ts'

/** Four definitions, as the review batch is. */
const DEFINITIONS: readonly ToolDefinitionShape[] = ['a', 'b', 'c', 'd'].map(name => ({
  name: `engineering_${name}`,
  description: `tool ${name}`,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
}))

/** A registry that records what it mounted and can refuse one name. */
function registryHolding(refuse?: string): {
  readonly mounted: Set<string>
  readonly tools: { register(tool: ToolDefinitionShape): ToolRegistration }
} {
  const mounted = new Set<string>()
  return {
    mounted,
    tools: {
      register(tool) {
        if (tool.name === refuse) throw new Error(`${tool.name} exploded`)
        mounted.add(tool.name)
        return () => { mounted.delete(tool.name) }
      },
    },
  }
}

describe('registerToolDefinitions', () => {
  it('registers every definition on the happy path and disposes them together', () => {
    const { mounted, tools } = registryHolding()
    const cleanup = registerToolDefinitions(tools, DEFINITIONS, () => { throw new Error('no refusal expected') })
    expect([...mounted]).toEqual(['engineering_a', 'engineering_b', 'engineering_c', 'engineering_d'])
    cleanup()
    expect([...mounted]).toEqual([])
  })

  it('keeps registering the definitions after a refusal instead of abandoning the batch', () => {
    const { mounted, tools } = registryHolding('engineering_b')
    const failures: [string, unknown][] = []
    registerToolDefinitions(tools, DEFINITIONS, (name, error) => { failures.push([name, error]) })
    // The old `map` shape stopped at `engineering_b`: `c` and `d` were never tried.
    expect([...mounted]).toEqual(['engineering_a', 'engineering_c', 'engineering_d'])
    expect(failures.map(([name]) => name)).toEqual(['engineering_b'])
  })

  it('returns a teardown for the definitions that registered, so a refusal does not leak them', () => {
    const { mounted, tools } = registryHolding('engineering_b')
    // The batch deliberately does not throw, so the caller reaches the effect
    // that will dispose it. Under the old shape the throw escaped before that
    // effect was registered, and the two mounted tools outlived the plugin.
    const cleanup = registerToolDefinitions(tools, DEFINITIONS, () => undefined)
    expect([...mounted]).toEqual(['engineering_a', 'engineering_c', 'engineering_d'])
    cleanup()
    expect([...mounted]).toEqual([])
  })

  it('reports the refused name with its error, because only the caller knows what it costs', () => {
    const { tools } = registryHolding('engineering_c')
    const onFailure = vi.fn()
    registerToolDefinitions(tools, DEFINITIONS, onFailure)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0]?.[0]).toBe('engineering_c')
    expect(String(onFailure.mock.calls[0]?.[1])).toContain('exploded')
  })

  it('is a no-op teardown when every definition was refused', () => {
    const tools: { register(): ToolRegistration } = { register: () => { throw new Error('nope') } }
    const cleanup = registerToolDefinitions(tools, DEFINITIONS, () => undefined)
    expect(() => cleanup()).not.toThrow()
  })
})

describe('disposeToolRegistration', () => {
  it('runs a function handle', () => {
    const dispose = vi.fn()
    disposeToolRegistration(dispose)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('claims an object handle\u2019s promise so a failing teardown is not an unhandled rejection', async () => {
    // A teardown that returns a rejected promise and is called for its side effect
    // would otherwise take the process down on `Stand the pack down`.
    const rejected: Promise<void>[] = []
    const onUnhandled = (promise: Promise<void>): void => { rejected.push(promise) }
    process.on('unhandledRejection', onUnhandled)
    try {
      disposeToolRegistration({ dispose: () => Promise.reject(new Error('teardown failed')) })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(rejected).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('tolerates an object handle with no dispose at all', () => {
    expect(() => disposeToolRegistration({})).not.toThrow()
  })
})
