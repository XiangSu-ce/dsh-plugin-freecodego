/**
 * Which directory `engineering_inspect` reports.
 *
 * The tool exists so a session can ask "what is loaded *here*". Every other
 * workspace-scoped reader in this plugin answers "here" from the session's
 * `header.cwd`, falling back to the process directory when there is no session —
 * and the sections this tool renders are exactly the ones that read that
 * directory: the trust decision, and the hook, rule and persona files it gates.
 * Collecting with `process.cwd()` unconditionally meant a session whose workspace
 * differed from the Host's launch directory was told about another folder: its
 * trust decision, its hook counts, its rule sizes. The hooks section's claim that
 * its counts are "the counts a dispatch would see" was false in that case, and the
 * trust answer — the one a user reads before deciding to grant a repository — named
 * the wrong repository.
 *
 * Asserted through the registered tool, not through the private collector, because
 * the defect was in the wiring between them: the collector has always taken the
 * workspace from its port, and the port was handed the process directory.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { provideHostService, provideHostServiceAs, runContext, type AgentEnginesFace, type RecordedTool } from './support/host-services.ts'

/** The two services the plugin's boot needs before it reaches tool registration. */
function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

/** One section of a `json: true` report. */
function section(report: unknown, id: string): Record<string, unknown> {
  const sections = (report as { readonly sections: readonly { readonly id: string; readonly data: unknown }[] }).sections
  const found = sections.find(entry => entry.id === id)
  expect(found, `the report must carry a ${id} section`).toBeDefined()
  return found!.data as Record<string, unknown>
}

describe('the inspect tool reports the directory the session is in', () => {
  let home: string
  let previousHome: string | undefined
  let registered: Map<string, RecordedTool>
  let ctx: Context

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'freecodego-inspect-ws-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    registered = new Map<string, RecordedTool>()
    ctx = new Context()
    await ctx.plugin(AgentEngineRegistry)
    // Captures the definitions the plugin registers, so the test can call the tool
    // the way a session would rather than reaching into private state.
    provideHostService(ctx, 'tools', {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => undefined
      },
      schemas: () => [],
      guard: () => () => undefined,
    })
    new FreeCodeGoHarnessPlugin(ctx, {})
  })

  afterEach(async () => {
    // Close the plugin before the home goes: the engineering pack is on by
    // default and opens its SQLite stores under the active home, and Windows
    // will not unlink a database another handle holds open — the removal's
    // retries then never settle. The pack has nothing to do with what this spec
    // asserts; it is only why the order below is load-bearing.
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  /** Run the inspect tool's own `execute`, as the harness would. */
  const inspect = async (workspace: string | undefined): Promise<unknown> => {
    const tool = registered.get('engineering_inspect')
    expect(tool?.execute, 'engineering_inspect must be registered when a tools registry exists').toBeDefined()
    const exec = workspace === undefined
      ? undefined
      : { agent: { session: { header: { cwd: workspace } } } }
    return await tool!.execute({ json: true }, runContext(exec))
  }

  test('names the session workspace, not the process directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-session-'))
    try {
      const trust = section(await inspect(workspace), 'trust')
      expect(trust.workspace).toBe(workspace)
      // The discriminator: the two directories are different, so a report that
      // named the process directory could not also name the session's.
      expect(trust.workspace).not.toBe(process.cwd())
      // And the gate was asked about the session's directory, not merely labelled
      // with it: a temp directory outside any repository is not one.
      expect(trust.reason).toBe('not-a-repository')
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  test('falls back to the process directory when the call has no session', async () => {
    // The Remote and the `/inspect` command collect without one — a settings panel
    // asking about "this Host" is a real question, and it is answered by the same
    // fallback rather than by a second rule.
    expect(section(await inspect(undefined), 'trust').workspace).toBe(process.cwd())
  })

  test('treats a blank session directory as no session rather than as a root', async () => {
    // `''` is what an unset header field looks like when it is present but empty,
    // and resolving trust for it would ask about a directory that does not exist.
    expect(section(await inspect('   '), 'trust').workspace).toBe(process.cwd())
  })
})
