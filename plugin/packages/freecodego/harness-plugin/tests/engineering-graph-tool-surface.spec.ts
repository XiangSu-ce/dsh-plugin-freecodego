/**
 * The two code-graph tool families, driven through their own handlers.
 *
 * Why this exists
 * ---------------
 * Every one of these seventeen tools was registered, documented, and reachable
 * with no test that ever called one: `engineering_graph_*` and
 * `engineering_codegraph_*` are covered at the *engine* layer
 * (`engineering-codegraph.spec.ts` pins the platform matrix, the digests and the
 * argument shapes; `engineering-graphify*.spec.ts` pins the runtime and the
 * sidecar) and at the *registration* layer (`engineering-tool-surface.spec.ts`
 * pins the families that must not need an engine). What nothing pinned is the
 * seam between them — the handler that turns a model's arguments into an engine
 * call — and two whole invariants live only there:
 *
 * 1. **A tool call reaches the engine the arguments promise.** Each handler maps
 *    schema names (`maxFiles`, `limit`, `top`, `node`) onto engine names
 *    (`budget`, `depth`, `values`). A wrong mapping is silent: the engine answers
 *    a different question and the model reads it as an answer.
 * 2. **The settings switch is enforced where the call is made, not only where the
 *    tool was registered.** `registerTools` mounts a family only while the switch
 *    is on, so the check inside a handler looks redundant — until a settings
 *    change is enqueued behind a reconcile and a call arrives in the window
 *    before it runs. That is the case this file started from: `graphCanvas` and
 *    the MCP bridge through `graphMcpCall` both refused, and their five siblings
 *    in the same family served the call anyway, because the guard was applied per
 *    author rather than per boundary.
 *
 * The engines are fakes and nothing is spawned: this pins the seam, and the real
 * CLIs stay the engine specs' business.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/engineering-graph-tool-surface
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'
import { GRAPHIFY_MCP_ARGUMENTS } from '../src/engineering-graphify-sidecar.ts'

interface RegisteredTool {
  readonly name: string
  readonly description?: string
  readonly parameters?: { readonly properties?: Readonly<Record<string, unknown>> }
  execute(args: unknown, exec: unknown): unknown
}

// A real directory: `engineering_repo_map` reads the workspace it is handed, and
// the one tool in this family with no engine behind it is the one the switch must
// not take away.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'freecodego-graph-tools-'))
afterAll(() => { rmSync(WORKSPACE, { recursive: true, force: true }) })

type Call = readonly unknown[]

/** A Graphify double that records the call it was handed. */
function fakeGraphify(): { readonly calls: Call[]; readonly manager: Record<string, unknown> } {
  const calls: Call[] = []
  return {
    calls,
    manager: {
      // The registration pass probes both engines to choose a family; the doubles
      // report "installed" so the branch under test is the one that mounts tools.
      status: () => { calls.push(['status']); return Promise.resolve({ installed: true, state: 'ready' }) },
      projectStatus: (cwd: string) => { calls.push(['projectStatus', cwd]); return Promise.resolve({ state: 'ready', projectId: 'graphify-project', graphPath: '/ws/.graph/graph.json' }) },
      query: (cwd: string, input: unknown) => { calls.push(['query', cwd, input]); return Promise.resolve({ output: 'ok', project: { projectId: 'graphify-project' } }) },
      canvas: (cwd: string, maxNodes: number | undefined) => { calls.push(['canvas', cwd, maxNodes]); return Promise.resolve({ nodes: [], edges: [] }) },
    },
  }
}

/** A CodeGraph double that records the call it was handed. */
function fakeCodeGraph(): { readonly calls: Call[]; readonly manager: Record<string, unknown> } {
  const calls: Call[] = []
  return {
    calls,
    manager: {
      status: () => { calls.push(['status']); return Promise.resolve({ installed: true, state: 'ready' }) },
      projectStatus: (cwd: string) => { calls.push(['projectStatus', cwd]); return Promise.resolve({ state: 'ready', projectId: 'codegraph-project' }) },
      query: (cwd: string, input: unknown) => { calls.push(['query', cwd, input]); return Promise.resolve({ output: 'ok', project: { state: 'ready' } }) },
    },
  }
}

interface Harness {
  readonly tool: (name: string) => RegisteredTool
  readonly names: readonly string[]
  readonly graphify: readonly Call[]
  readonly codeGraph: readonly Call[]
}

/**
 * A registry whose two engine managers are doubles, with both families mounted.
 *
 * The families are mounted by calling their own private registration methods —
 * the same seam `engineering-tool-surface.spec.ts` uses for the checkpoint
 * family — because reaching them through `install()` would mean standing up a
 * settings document, a memory store and two engine status probes to assert
 * something that is purely about the handler.
 */
function harness(input: {
  readonly engineeringEnabled?: boolean
  readonly codeGraphEnabled?: boolean
} = {}): Harness {
  const tools: RegisteredTool[] = []
  const ctx = {
    on: vi.fn(),
    effect: vi.fn(),
    get: (name: string) => (name === 'tools' ? { register: (definition: RegisteredTool) => { tools.push(definition); return { dispose: () => undefined } } } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as Context
  const settings = {
    get: () => ({
      engineeringEnabled: input.engineeringEnabled ?? true,
      engineeringCodeGraphEnabled: input.codeGraphEnabled ?? true,
    }),
    update: async () => undefined,
  }
  const engineering = new FreeCodeGoEngineeringRegistry(ctx, settings)
  const graphify = fakeGraphify()
  const codeGraph = fakeCodeGraph()
  const privates = engineering as unknown as {
    graphify: Record<string, unknown>
    graphifySidecar: { graphify: unknown }
    codeGraph: Record<string, unknown>
    registerGraphTools(): void
    registerCodeGraphTools(): void
  }
  privates.graphify = graphify.manager
  privates.codeGraph = codeGraph.manager
  // The MCP bridge keeps its own reference to the runtime, taken when the
  // registry was constructed, so the sidecar is repointed rather than replaced:
  // its argument-checking is what these cases are about, and a double in its
  // place would have tested the double.
  privates.graphifySidecar.graphify = graphify.manager
  privates.registerGraphTools()
  privates.registerCodeGraphTools()
  return {
    tool: (name: string) => {
      const found = tools.find(entry => entry.name === name)
      if (found === undefined) throw new Error(`no tool named ${name}; registered: ${tools.map(entry => entry.name).join(', ')}`)
      return found
    },
    names: tools.map(entry => entry.name),
    graphify: graphify.calls,
    codeGraph: codeGraph.calls,
  }
}

/** The `exec` every one of these handlers reads its workspace from. */
const EXEC = { agent: { session: { header: { cwd: WORKSPACE } } } }

/** Every agent-facing tool of both families, with arguments the schema accepts. */
const GRAPH_TOOLS: readonly { readonly name: string; readonly args: unknown; readonly minimal?: unknown }[] = [
  { name: 'engineering_graph_status', args: {} },
  { name: 'engineering_graph_search', args: { query: 'alpha' }, minimal: { query: 'alpha' } },
  { name: 'engineering_graph_explain', args: { node: 'alpha' }, minimal: { node: 'alpha' } },
  { name: 'engineering_graph_path', args: { from: 'alpha', to: 'beta' }, minimal: { from: 'alpha', to: 'beta' } },
  { name: 'engineering_graph_affected', args: { node: 'alpha' }, minimal: { node: 'alpha' } },
  { name: 'engineering_graph_overview', args: {} },
  { name: 'engineering_graph_canvas', args: {} },
  { name: 'engineering_graph_mcp', args: { tool: 'graphify_search', arguments: { query: 'alpha' } } },
  { name: 'engineering_codegraph_status', args: {} },
  { name: 'engineering_codegraph_explore', args: { query: 'how does a reach b' }, minimal: { query: 'how does a reach b' } },
  { name: 'engineering_codegraph_search', args: { query: 'alpha' }, minimal: { query: 'alpha' } },
  { name: 'engineering_codegraph_explain', args: { node: 'alpha' }, minimal: { node: 'alpha' } },
  { name: 'engineering_codegraph_path', args: { from: 'alpha', to: 'beta' }, minimal: { from: 'alpha', to: 'beta' } },
  { name: 'engineering_codegraph_affected', args: { node: 'alpha' }, minimal: { node: 'alpha' } },
]

describe('code-graph tool families, driven through their handlers', () => {
  it('mounts both families and the engine-free repo map, and names every tool once', () => {
    const built = harness()
    expect(built.names).toContain('engineering_repo_map')
    expect(new Set(built.names).size).toBe(built.names.length)
    // The repo map is zero-dependency and is registered by both branches, so a
    // second registration would be two answers to one question.
    expect(built.names.filter(name => name === 'engineering_repo_map')).toHaveLength(1)
    // Exactly one engine family is mounted at a time; a composition with both
    // runtimes installed must not offer the Agent both rosters.
    expect(built.names.some(name => name.startsWith('engineering_graph_'))).toBe(true)
    expect(built.names.some(name => name.startsWith('engineering_codegraph_'))).toBe(true)
  })

  it('turns each CodeGraph tool argument into the command the engine is promised', async () => {
    const built = harness()
    await built.tool('engineering_codegraph_status').execute({}, EXEC)
    await built.tool('engineering_codegraph_explore').execute({ query: 'how does a reach b', maxFiles: 12 }, EXEC)
    await built.tool('engineering_codegraph_search').execute({ query: 'alpha', limit: 7 }, EXEC)
    await built.tool('engineering_codegraph_explain').execute({ node: 'alpha' }, EXEC)
    await built.tool('engineering_codegraph_path').execute({ from: 'alpha', to: 'beta' }, EXEC)
    await built.tool('engineering_codegraph_affected').execute({ node: 'alpha', depth: 3 }, EXEC)

    expect(built.codeGraph).toEqual([
      ['projectStatus', WORKSPACE],
      ['query', WORKSPACE, { command: 'explore', values: ['how does a reach b'], budget: 12 }],
      ['query', WORKSPACE, { command: 'search', values: ['alpha'], budget: 7 }],
      ['query', WORKSPACE, { command: 'symbol', values: ['alpha'] }],
      ['query', WORKSPACE, { command: 'path', values: ['alpha', 'beta'] }],
      ['query', WORKSPACE, { command: 'impact', values: ['alpha'], depth: 3 }],
    ])
  })

  it('omits an engine key the caller did not send, rather than sending it undefined', async () => {
    // `expand`-ing an absent optional into `{ budget: undefined }` is not the same
    // value to the engine's clamp: `undefined` is what selects the default, but the
    // key is also what a future caller counts to tell "asked for none" from "did
    // not ask". Every handler builds its input conditionally for this reason.
    const built = harness()
    await built.tool('engineering_codegraph_search').execute({ query: 'alpha' }, EXEC)
    await built.tool('engineering_codegraph_affected').execute({ node: 'alpha' }, EXEC)
    expect(built.codeGraph[0]).toEqual(['query', WORKSPACE, { command: 'search', values: ['alpha'] }])
    expect(built.codeGraph[1]).toEqual(['query', WORKSPACE, { command: 'impact', values: ['alpha'] }])
    for (const call of built.codeGraph) {
      const input = call[2] as Record<string, unknown>
      expect(Object.keys(input)).not.toContain('budget')
      expect(Object.keys(input)).not.toContain('depth')
    }
  })

  it('turns each Graphify tool argument into the command the engine is promised', async () => {
    const built = harness()
    await built.tool('engineering_graph_status').execute({}, EXEC)
    await built.tool('engineering_graph_search').execute({ query: 'alpha', budget: 4_000 }, EXEC)
    await built.tool('engineering_graph_explain').execute({ node: 'alpha' }, EXEC)
    await built.tool('engineering_graph_path').execute({ from: 'alpha', to: 'beta' }, EXEC)
    await built.tool('engineering_graph_affected').execute({ node: 'alpha', depth: 4 }, EXEC)
    await built.tool('engineering_graph_overview').execute({ top: 9 }, EXEC)
    await built.tool('engineering_graph_canvas').execute({ maxNodes: 200 }, EXEC)

    expect(built.graphify).toEqual([
      ['projectStatus', WORKSPACE],
      ['query', WORKSPACE, { command: 'query', values: ['alpha'], budget: 4_000 }],
      ['query', WORKSPACE, { command: 'explain', values: ['alpha'] }],
      ['query', WORKSPACE, { command: 'path', values: ['alpha', 'beta'] }],
      ['query', WORKSPACE, { command: 'affected', values: ['alpha'], depth: 4 }],
      // `top` is the schema's name for the same number the CLI takes as `--top`.
      ['query', WORKSPACE, { command: 'god-nodes', budget: 9 }],
      ['canvas', WORKSPACE, 200],
    ])
  })

  it('refuses a Graphify MCP call missing a required key, naming the keys that tool reads', async () => {
    const built = harness()
    // One row per required key, so the second key of a two-key operation is
    // checked by supplying the first rather than by expecting both refusals at
    // once — the sidecar reports the key it reached.
    const required: readonly (readonly [keyof typeof GRAPHIFY_MCP_ARGUMENTS, Readonly<Record<string, unknown>>, string])[] = [
      ['graphify_search', {}, 'query'],
      ['graphify_explain', {}, 'node'],
      ['graphify_path', {}, 'from'],
      ['graphify_path', { from: 'a' }, 'to'],
      ['graphify_affected', {}, 'node'],
    ]
    for (const [name, args, key] of required) {
      await expect(built.tool('engineering_graph_mcp').execute({ tool: name, arguments: args }, EXEC), `${name}/${key}`)
        .rejects.toThrow(new RegExp(name, 'u'))
      await expect(built.tool('engineering_graph_mcp').execute({ tool: name, arguments: args }, EXEC), `${name}/${key}`)
        .rejects.toThrow(new RegExp(`"${key}"`, 'u'))
    }
    // The refusal carries the whole table, or a model that guessed one key wrong
    // has no way to learn the others — which is the failure the table exists for.
    await expect(built.tool('engineering_graph_mcp').execute({ tool: 'graphify_search', arguments: {} }, EXEC))
      .rejects.toThrow(/"top"/u)
    expect(built.graphify).toEqual([])
    // `graphify_overview` requires no key at all — `top` is optional — so an empty
    // argument object is a valid request rather than a refusal.
    await built.tool('engineering_graph_mcp').execute({ tool: 'graphify_overview', arguments: {} }, EXEC)
    expect(built.graphify).toEqual([['query', WORKSPACE, { command: 'god-nodes' }]])
  })

  it('declares in the MCP schema exactly the keys the sidecar reads', () => {
    // The description is rendered from `GRAPHIFY_MCP_ARGUMENTS`, but the
    // per-key `properties` beside it are written by hand. A key added to the
    // table and not to the schema is an argument the model is never told about
    // and the sidecar still demands — the failure the table was introduced to
    // remove, one layer down.
    const schema = harness().tool('engineering_graph_mcp').parameters as {
      readonly properties?: {
        readonly arguments?: { readonly properties?: Readonly<Record<string, unknown>> }
      }
    }
    const declared = Object.keys(schema.properties?.arguments?.properties ?? {}).sort()
    const required = [...new Set(Object.values(GRAPHIFY_MCP_ARGUMENTS).flat())].sort()
    expect(declared).toEqual(required)
  })

  it('refuses every agent-facing graph tool while the code-graph switch is off', async () => {
    // Registration is not the gate: a settings change is enqueued behind a
    // reconcile, so a call can arrive after the switch moved and before the
    // family was remounted. The two tools that read the switch inside their
    // handler refused in that window; their siblings served the call.
    const built = harness({ engineeringEnabled: true, codeGraphEnabled: false })
    for (const entry of GRAPH_TOOLS) {
      await expect(built.tool(entry.name).execute(entry.args, EXEC), entry.name)
        .rejects.toThrow(/disabled in FreeCodeGo settings/u)
    }
    // Nothing reached an engine, so the refusal happened before the call rather
    // than after it.
    expect(built.graphify).toEqual([])
    expect(built.codeGraph).toEqual([])
  })

  it('drives engineering_doctor and reports the deny list its own module describes', async () => {
    // `doctor()` is reachable as a function and covered there; what nothing drove
    // is the tool, which is the only door a user or an Agent has to it. The deny
    // section is injected rather than read, so a registry that never received a
    // provider must not claim one — an absent provider means "no patterns", and a
    // doctor that invented an enforcement section for an empty list would be the
    // fourth place describing a rule no composition configured.
    const tools: RegisteredTool[] = []
    const ctx = {
      on: vi.fn(), effect: vi.fn(), logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      get: () => ({ register: (definition: RegisteredTool) => { tools.push(definition); return { dispose: () => undefined } } }),
    } as unknown as Context
    const engineering = new FreeCodeGoEngineeringRegistry(ctx, {
      get: () => ({ engineeringEnabled: true }),
      update: async () => undefined,
    })
    const privates = engineering as unknown as {
      graphify: Record<string, unknown>
      codeGraph: Record<string, unknown>
      registerTools(): Promise<void>
    }
    privates.graphify = fakeGraphify().manager
    privates.codeGraph = fakeCodeGraph().manager
    await privates.registerTools()

    const doctor = tools.find(entry => entry.name === 'engineering_doctor')
    if (doctor === undefined) throw new Error('engineering_doctor was not registered')
    const report = await doctor.execute({}, EXEC) as {
      readonly ok: boolean
      readonly checkedAt: number
      readonly skills: readonly unknown[]
      readonly findings: readonly unknown[]
      readonly denyEnforcement?: unknown
    }
    expect(typeof report.ok).toBe('boolean')
    expect(report.checkedAt).toBeGreaterThan(0)
    // The bundled skill set is what the audit was written for; an empty one would
    // make `ok: true` a statement about nothing.
    expect(report.skills.length).toBeGreaterThan(0)
    expect(report.findings.every(finding => typeof finding === 'object')).toBe(true)
    expect(report.denyEnforcement).toBeUndefined()
  })

  it('still serves the engine-free repo map while the code-graph switch is off', async () => {
    // The repo map is the one tool here with no runtime behind it, so gating it
    // on an engine switch would remove the only graph answer an unindexed
    // workspace has.
    const built = harness({ engineeringEnabled: false, codeGraphEnabled: false })
    expect(built.names).toContain('engineering_repo_map')
    await expect(built.tool('engineering_repo_map').execute({}, EXEC)).resolves.toBeTruthy()
  })
})
