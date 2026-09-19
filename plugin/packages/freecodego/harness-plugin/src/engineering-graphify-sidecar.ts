/** Internal MCP-shaped bridge for the official Graphify CLI. It never opens a TCP listener. */

import type { GraphifyRuntimeManager } from './engineering-graphify.ts'

export type GraphifyMcpToolName = 'graphify_search' | 'graphify_explain' | 'graphify_path' | 'graphify_affected' | 'graphify_overview'

/**
 * The argument keys each operation reads.
 *
 * The model reaches this bridge through one free-form `arguments` object, so
 * these names are the whole contract between the caller and
 * {@link GraphifyMcpSidecar.call} — and four of the five operations require
 * one. They live here, beside the reader, and the tool schema is rendered from
 * this same table: while both sides were written by hand the schema named none
 * of them, so nothing told the model what to send and every `graphify_search`
 * failed on a missing `query` with no way to learn the name.
 */
export const GRAPHIFY_MCP_ARGUMENTS: Readonly<Record<GraphifyMcpToolName, readonly string[]>> = {
  graphify_search: ['query', 'budget'],
  graphify_explain: ['node'],
  graphify_path: ['from', 'to'],
  graphify_affected: ['node', 'depth'],
  graphify_overview: ['top'],
}

/** The same table as a sentence, for a schema description or a refusal message. */
export function graphifyMcpArgumentsHelp(): string {
  return Object.entries(GRAPHIFY_MCP_ARGUMENTS).map(([name, keys]) => `${name}: ${keys.map(key => `"${key}"`).join(', ')}`).join('; ')
}

/**
 * This is deliberately an in-process stdio-sidecar equivalent: Harness owns
 * routing, cancellation, audit, and all Agent bridges, while Graphify remains
 * the only subprocess. No listener, external configuration, or workspace write
 * capability is introduced.
 */
export class GraphifyMcpSidecar {
  constructor(private readonly graphify: GraphifyRuntimeManager) {}

  async call(cwd: string, name: GraphifyMcpToolName, args: Record<string, unknown>): Promise<{ readonly output: string; readonly projectId: string }> {
    if (name === 'graphify_search') {
      const query = requiredString(args.query, 'query', name)
      const budget = integer(args.budget, 100, 8_000)
      const value = await this.graphify.query(cwd, { command: 'query', values: [query], ...(budget === undefined ? {} : { budget }) })
      return { output: value.output, projectId: value.project.projectId }
    }
    if (name === 'graphify_explain') {
      const value = await this.graphify.query(cwd, { command: 'explain', values: [requiredString(args.node, 'node', name)] })
      return { output: value.output, projectId: value.project.projectId }
    }
    if (name === 'graphify_path') {
      const value = await this.graphify.query(cwd, { command: 'path', values: [requiredString(args.from, 'from', name), requiredString(args.to, 'to', name)] })
      return { output: value.output, projectId: value.project.projectId }
    }
    if (name === 'graphify_affected') {
      const depth = integer(args.depth, 1, 5)
      const value = await this.graphify.query(cwd, { command: 'affected', values: [requiredString(args.node, 'node', name)], ...(depth === undefined ? {} : { depth }) })
      return { output: value.output, projectId: value.project.projectId }
    }
    const top = integer(args.top, 1, 50)
    const value = await this.graphify.query(cwd, { command: 'god-nodes', ...(top === undefined ? {} : { budget: top }) })
    return { output: value.output, projectId: value.project.projectId }
  }
}

/**
 * A required argument, or a refusal that names it.
 *
 * The message carries the operation's full key list because the caller that got
 * this wrong is a model reading a free-form `arguments` object, and a refusal
 * that only repeats the key it already tried to send leaves it guessing.
 */
function requiredString(value: unknown, name: string, operation: GraphifyMcpToolName): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 1_000) throw new Error(`Graphify MCP ${operation} needs a non-empty "${name}" (arguments: ${graphifyMcpArgumentsHelp()})`)
  return value.trim()
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
}
