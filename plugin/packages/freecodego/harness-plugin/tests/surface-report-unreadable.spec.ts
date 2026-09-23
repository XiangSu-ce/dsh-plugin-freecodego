/**
 * `engineering_surface_report` against a tool seam that cannot be read.
 *
 * `schemas` is optional on the structural `tools` seam, and a missing method is
 * not an empty list. `collectPluginSurfaces` defaults it to `[]`, so a caller that
 * reads the seam directly makes an *unreadable* tool surface indistinguishable
 * from a plugin that registers no tools.
 *
 * The lock digests one value per group, so the damage is not a list of missing
 * tools — it is `changed: ['tool-schemas']`, the same verdict a genuine prompt
 * edit produces. A tool whose entire purpose is telling a real prompt change from
 * a measurement failure must not answer "changed" when it did not measure.
 *
 * Every case below is a mutation probe: restoring `tools.schemas?.() ?? []` at the
 * call site makes the first assertion of each case fail.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { pluginConfig, provideHostService, provideHostServiceAs, registrationHandle, runContext, sessionAt, type AgentEnginesFace, type CommandsFace } from './support/host-services.ts'

/** The report shape this spec reads, kept structural so the assertions name fields. */
interface SurfaceReportView {
  readonly toolSurface?: string
  readonly diff?: unknown
  readonly summary?: unknown
  readonly note?: string
  readonly groups?: readonly { readonly group: string; readonly entries: number }[]
}

interface SurfaceHarness {
  readonly report: () => Promise<SurfaceReportView>
  readonly dispose: () => Promise<void>
}

/**
 * The real plugin, booted with a tool seam whose `schemas` may be absent.
 *
 * `schemas: undefined` omits the method entirely, which is the composition this
 * spec exists to cover. Providing it as `() => []` would be a different case —
 * a registry that can be read and reports nothing — and the two must not be
 * conflated.
 */
async function surfaceHarness(options: {
  readonly schemas: Context['tools']['schemas'] | undefined
  readonly lock?: unknown
}): Promise<SurfaceHarness> {
  const home = mkdtempSync(join(tmpdir(), 'freecodego-surface-'))
  const workspace = mkdtempSync(join(tmpdir(), 'freecodego-surface-ws-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  if (options.lock !== undefined) {
    mkdirSync(join(workspace, '.freecodego'), { recursive: true })
    writeFileSync(join(workspace, '.freecodego', 'surface-lock.json'), JSON.stringify(options.lock))
  }
  const tools = new Map<string, ToolDefinition>()
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { list: () => [], get: () => undefined })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => sessionAt(workspace), list: () => [] })
    provideHostService(scope, 'llm', {
      registerAdapter: () => registrationHandle(),
      stream(_generation: GenerateOptions): AsyncIterable<StreamChunk> {
        return (async function* empty(): AsyncGenerator<StreamChunk> { /* the boot makes no request */ })()
      },
    })
    provideHostService(scope, 'tools', {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => undefined
      },
      guard: () => () => undefined,
      ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
    })
    provideHostServiceAs<CommandsFace>(scope, 'commands', { register: () => () => undefined })
    provideHostService(scope, 'systemPrompt', { section: () => () => undefined })
  })
  new FreeCodeGoHarnessPlugin(ctx, pluginConfig({ engineeringEnabled: true, engineeringMemoryEnabled: true, advisorProvider: 'opencode', advisorModel: 'auto' }))
  const tool = tools.get('engineering_surface_report')
  if (tool === undefined) throw new Error('engineering_surface_report was not registered')
  const execute = tool.execute
  return {
    report: async () => await execute({}, runContext({ agent: { session: { header: { cwd: workspace } } } })) as SurfaceReportView,
    dispose: async () => {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

describe('engineering_surface_report against a tool seam it cannot read', () => {
  let harness: SurfaceHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('reports the tool half as unread rather than as an empty surface', async () => {
    // Mutation: `const toolSchemas = tools.schemas?.() ?? []` makes this
    // `'measured'`, which is the whole defect — an unread surface reported as a
    // measured one.
    harness = await surfaceHarness({ schemas: undefined })
    const report = await harness.report()
    expect(report.toolSurface).toBe('unreadable')
    expect(report.note).toContain('no `schemas()`')
  })

  it('still measures and diffs when the seam can be read', async () => {
    // The other half of the contract: the guard must not disable the tool on the
    // composition where it works. A fix that always answered `'unreadable'` would
    // pass the case above and fail this one.
    harness = await surfaceHarness({
      schemas: () => [{ name: 'alpha', description: 'a tool', parameters: { type: 'object' } }],
    })
    const report = await harness.report()
    expect(report.toolSurface).toBe('measured')
    expect(report.diff).toBeDefined()
  })

  it('refuses to diff a committed lock it could not measure against', async () => {
    // A lock that names both groups, so a comparison is possible in principle.
    // Comparing an unread surface against it yields `changed: ['tool-schemas']`
    // and the summary "injected surfaces changed" — a prompt-change verdict
    // issued without a measurement. The report must decline instead.
    harness = await surfaceHarness({
      schemas: undefined,
      lock: { version: 1, surfaces: { 'tool-schemas': '0'.repeat(64), 'injected-guidance': '0'.repeat(64) } },
    })
    const report = await harness.report()
    expect(report.diff).toBeUndefined()
    expect(report.summary).toBeUndefined()
    // And the figures it does report are labelled as guidance-only, so a reader
    // cannot take the zero tool count as a statement about registration.
    expect(report.groups?.find(group => group.group === 'tool-schemas')?.entries).toBe(0)
    expect(report.note).toContain('guidance only')
  })
})
