/**
 * Graphify MCP sidecar: the argument contract and the routing.
 *
 * What these cases protect
 * ------------------------
 * The model reaches this sidecar through one free-form `arguments` object, so the
 * key names are the only thing standing between a call and a refusal — and four of
 * the five operations require one. The schema used to declare that object with no
 * properties and no description, so nothing told the model what to send and a
 * `graphify_search` failed on a missing `query` with no way to learn the name.
 *
 * The first case therefore pins the table against the *reader*: every key the help
 * text advertises must be a key the operation actually reads, so a renamed key
 * fails here instead of in a user's session. The routing case pins each operation
 * to the graphify command it claims (`god-nodes` in particular takes its count as
 * `budget`, not `top`, and a refactor that "fixed" that name would silently return
 * the default ten hubs).
 */

import { describe, expect, it } from 'vitest'
import { GRAPHIFY_MCP_ARGUMENTS, GraphifyMcpSidecar, graphifyMcpArgumentsHelp, type GraphifyMcpToolName } from '../src/engineering-graphify-sidecar.ts'
import type { GraphifyRuntimeManager } from '../src/engineering-graphify.ts'

const OPERATIONS = Object.keys(GRAPHIFY_MCP_ARGUMENTS) as GraphifyMcpToolName[]

/** The keys a call may omit, because the sidecar supplies the graphify default. */
const REQUIRED_KEY: Record<GraphifyMcpToolName, string | undefined> = {
  graphify_search: 'query',
  graphify_explain: 'node',
  graphify_path: 'from',
  graphify_affected: 'node',
  graphify_overview: undefined,
}

/** Well-typed values for every documented key, one operation's worth at a time. */
const SAMPLE: Record<GraphifyMcpToolName, Record<string, unknown>> = {
  graphify_search: { query: 'checkpoint store', budget: 500 },
  graphify_explain: { node: 'src/engineering.ts' },
  graphify_path: { from: 'src/index.ts', to: 'src/policy.ts' },
  graphify_affected: { node: 'src/policy.ts', depth: 3 },
  graphify_overview: { top: 12 },
}

function harness(): { readonly sidecar: GraphifyMcpSidecar; readonly calls: unknown[] } {
  const calls: unknown[] = []
  const graphify = {
    query: async (_cwd: string, input: unknown) => {
      calls.push(input)
      return { output: 'graphify output', project: { projectId: 'project-1' } }
    },
  } as unknown as GraphifyRuntimeManager
  return { sidecar: new GraphifyMcpSidecar(graphify), calls }
}

describe('Graphify MCP sidecar', () => {
  it('advertises exactly the keys each operation reads', () => {
    const help = graphifyMcpArgumentsHelp()
    for (const name of OPERATIONS) {
      // The help text is what the tool schema shows the model, so every key the
      // sample passes has to appear there and in the table itself.
      expect(help).toContain(name)
      expect(Object.keys(SAMPLE[name]).sort()).toEqual([...GRAPHIFY_MCP_ARGUMENTS[name]].sort())
      for (const key of GRAPHIFY_MCP_ARGUMENTS[name]) expect(help).toContain(`"${key}"`)
    }
  })

  it('accepts every documented key and routes each operation to its graphify command', async () => {
    const { sidecar, calls } = harness()
    for (const name of OPERATIONS) {
      await expect(sidecar.call('/workspace', name, SAMPLE[name])).resolves.toEqual({ output: 'graphify output', projectId: 'project-1' })
    }
    expect(calls).toEqual([
      { command: 'query', values: ['checkpoint store'], budget: 500 },
      { command: 'explain', values: ['src/engineering.ts'] },
      { command: 'path', values: ['src/index.ts', 'src/policy.ts'] },
      { command: 'affected', values: ['src/policy.ts'], depth: 3 },
      // `god-nodes` counts hubs with `--top`, which this seam names `budget`.
      { command: 'god-nodes', budget: 12 },
    ])
  })

  it('omits an optional key rather than sending a default of its own', async () => {
    const { sidecar, calls } = harness()
    await expect(sidecar.call('/workspace', 'graphify_search', { query: 'policy' })).resolves.toBeDefined()
    await expect(sidecar.call('/workspace', 'graphify_overview', {})).resolves.toBeDefined()
    expect(calls).toEqual([
      { command: 'query', values: ['policy'] },
      { command: 'god-nodes' },
    ])
  })

  it('refuses a missing required key by naming it and the operation', async () => {
    const { sidecar, calls } = harness()
    for (const name of OPERATIONS) {
      const key = REQUIRED_KEY[name]
      if (key === undefined) continue
      await expect(sidecar.call('/workspace', name, {})).rejects.toThrow(`Graphify MCP ${name} needs a non-empty "${key}"`)
    }
    // The refusals must not reach the subprocess: a rejected call is not a query.
    expect(calls).toEqual([])
  })

  it('refuses a blank or oversized string where a non-empty one is required', async () => {
    const { sidecar } = harness()
    await expect(sidecar.call('/workspace', 'graphify_explain', { node: '   ' })).rejects.toThrow('needs a non-empty "node"')
    await expect(sidecar.call('/workspace', 'graphify_search', { query: 'x'.repeat(1_001) })).rejects.toThrow('needs a non-empty "query"')
  })
})
