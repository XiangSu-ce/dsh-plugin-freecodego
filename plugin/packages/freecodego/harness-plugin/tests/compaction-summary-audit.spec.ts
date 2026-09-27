/**
 * The compaction summary audit, driven with the payload the Harness actually commits.
 *
 * Why this file exists
 * --------------------
 * The audit had never run. It read `compaction/summary` as
 * `typeof data.summary === 'string'`, while `compaction-basic` commits the
 * replacement through `session.append('compaction/summary', { summary, … })` with
 * `summary` a **`ContentBlock[]`** — so every real event returned at the first guard
 * and the check, its setting, its log line and its status field were all dead code
 * that a unit test of the audit function could not notice. The first case below is
 * that regression: the payload shape is the fixture, not a string built for the test.
 *
 * The rest of the file pins the two halves of what the audit reports:
 *
 * - **Faithfulness** (`accepted`): a quotation the replaced history never contained.
 * - **Completeness** (`sectionsMissing`): the checkpoint's fixed structure, which the
 *   summariser is told to keep field by field and write `(none)` into when empty. A
 *   dropped field is a different defect from a fabricated quotation, so it is a
 *   separate field, a separate log level, and — through
 *   `rehydration.checkpointSkeleton` — a sentence in the body injected after the
 *   compaction, because an absent field reads to the resuming model exactly like the
 *   `(none)` that means "there was none".
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { COMPACTION_SUMMARY_SECTIONS } from '../src/compaction-fidelity.ts'
import { pluginConfig, provideHostService, provideHostServiceAs, registrationHandle, runContext, type AgentEnginesFace, type CommandsFace } from './support/host-services.ts'

/** The token meter as the plugin probes it, so the budget tool has a report to answer with. */
type TokenMeterFace = { measure(session: unknown): { readonly totalTokens: number; readonly baseline: { readonly kind: string } } }

/** One message the replaced history held, as the session log keeps it. */
const ARCHIVED = [
  { seq: 4, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'npm ERR! code EBADENGINE' }] } } },
  { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The failure is in src/client/dashboard.tsx' }] } } },
]

/**
 * The structure the summariser is told to emit, filled in.
 * @param options - `drop` names the fields this summary leaves out entirely, and
 *   `bodies` replaces a section's body with the given text.
 */
function structured(options: { readonly drop?: readonly string[]; readonly bodies?: Readonly<Record<string, string>> } = {}): string {
  const bodies: Record<string, string> = {
    'Primary Request and Intent': '- fix the build failure in src/client/dashboard.tsx',
    'Key Technical Concepts': '- (none)',
    'Files and Code': '- src/client/dashboard.tsx',
    'Errors and Fixes': '- (none)',
    'Pending Jobs': '- (none)',
    'Current Work': '- the audit',
    'Next Step': '- run the suite',
    'Critical Context': '- (none)',
    ...options.bodies,
  }
  const dropped = new Set(options.drop ?? [])
  return COMPACTION_SUMMARY_SECTIONS
    .filter(name => !dropped.has(name))
    .map(name => `## ${name}\n${bodies[name] ?? '- (none)'}`)
    .join('\n\n')
}

interface AuditHarness {
  /** The registered tools, by name, for a case that calls one the way the Host would. */
  readonly tools: ReadonlyMap<string, ToolDefinition>
  /** Every line the boot and the audit logged at `warn`. */
  readonly warnings: readonly string[]
  /** Every line logged at `debug`, where the dropped-field finding goes. */
  readonly debug: readonly string[]
  /** What rehydration injected after a compaction, in order. */
  readonly injected: readonly unknown[]
  /** Fire one session event at every registered listener, as the Host does. */
  readonly fire: (event: { readonly type: string; readonly data: unknown }) => Promise<void>
  readonly dispose: () => Promise<void>
}

/** The real plugin, booted against fakes that record what it says and what it injects. */
async function auditHarness(): Promise<AuditHarness> {
  const home = mkdtempSync(join(tmpdir(), 'freecodego-summary-audit-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const warnings: string[] = []
  const debug: string[] = []
  const injected: unknown[] = []
  const tools = new Map<string, ToolDefinition>()
  const listeners: ((...args: never[]) => unknown)[] = []
  const session = {
    id: 'session-1',
    header: { cwd: process.cwd() },
    snapshotEvents: () => ARCHIVED,
    requestContext: () => ({ contextWindow: 128_000 }),
  }
  const agent = { id: 'session-1', session, status: 'idle', ctx: { agentOptions: {} }, inject: (message: unknown) => { injected.push(message) } }
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { list: () => [], get: () => agent as never })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => session as never, list: () => [] })
    provideHostService(scope, 'llm', {
      registerAdapter: () => registrationHandle(),
      stream(_generation: GenerateOptions): AsyncIterable<StreamChunk> {
        return (async function* empty(): AsyncGenerator<StreamChunk> { /* no case here makes a request */ })()
      },
    })
    provideHostService(scope, 'tools', {
      register: (tool) => { tools.set(tool.name, tool); return () => undefined },
      guard: () => () => undefined,
      schemas: () => [],
    })
    provideHostServiceAs<CommandsFace>(scope, 'commands', { register: () => () => undefined })
    provideHostService(scope, 'systemPrompt', { section: () => () => undefined })
    provideHostServiceAs<TokenMeterFace>(scope, 'tokenMeter', { measure: () => ({ totalTokens: 1_000, baseline: { kind: 'usage' } }) })
  })
  const innerWarn = ctx.logger.warn.bind(ctx.logger)
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(argument => String(argument)).join(' '))
    ;(innerWarn as (...forwarded: unknown[]) => void)(...args)
  })
  // The dropped-field finding is a debug line on purpose: a faithful summary that lost
  // a field is not the fabrication the warning above reports, and this case is what
  // keeps the two levels from collapsing into one.
  const debugSink = ctx.logger as { debug?: (...args: unknown[]) => void }
  if (typeof debugSink.debug === 'function') {
    vi.spyOn(debugSink, 'debug').mockImplementation((...args: unknown[]) => {
      debug.push(args.map(argument => String(argument)).join(' '))
    })
  }
  // The plugin registers its listeners onto the context it is constructed with, and a
  // test cannot make the Host dispatch for it: the handlers are captured here and
  // called directly, which is what the Host does with the same arguments. The real
  // registration still happens underneath, so teardown disposes it as usual.
  const originalOn = ctx.on.bind(ctx)
  vi.spyOn(ctx, 'on').mockImplementation(((name: string, handler: (...args: never[]) => unknown) => {
    if (name === 'session/event') listeners.push(handler)
    return (originalOn as (event: string, listener: (...args: never[]) => unknown) => () => void)(name, handler)
  }) as typeof ctx.on)
  // Constructed for its registrations; the reference itself is not what a case reads.
  void new FreeCodeGoHarnessPlugin(ctx, pluginConfig({ engineeringEnabled: true, engineeringMemoryEnabled: true }))
  return {
    tools,
    warnings,
    debug,
    injected,
    fire: async (event) => {
      for (const handler of [...listeners]) await (handler as (...values: unknown[]) => Promise<unknown>)(session, event)
    },
    dispose: async () => {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

/** Commit one summary the way the engine does: content blocks, with the replaced sequences. */
async function commitSummary(harness: AuditHarness, text: string): Promise<void> {
  await harness.fire({
    type: 'compaction/summary',
    data: { compactionId: 'c1', shadowedSeqs: [4, 5], summary: [{ type: 'text', text }] },
  })
}

/** The verdict the plugin reports for this session, through the budget tool. */
async function reportedVerdict(harness: AuditHarness): Promise<Record<string, unknown> | undefined> {
  const tool = harness.tools.get('engineering_context_budget')
  if (tool === undefined) throw new Error('engineering_context_budget was not registered')
  const result = await tool.execute({}, runContext({
    agent: { id: 'session-1', session: { requestContext: () => ({ contextWindow: 128_000 }) } },
  })) as { readonly lastCompactionSummary?: Record<string, unknown> }
  return result.lastCompactionSummary
}

describe('the compaction summary audit reads what the Harness commits', () => {
  let harness: AuditHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('records a verdict from a summary committed as content blocks', async () => {
    // The regression: `summary` is `ContentBlock[]` in the event the engine appends,
    // and the audit used to require a string — so it returned before doing anything on
    // every compaction, for as long as it has existed.
    harness = await auditHarness()
    await commitSummary(harness, structured({
      bodies: { 'Files and Code': '- src/client/dashboard.tsx, quoting "npm ERR! code EBADENGINE" verbatim' },
    }))
    const verdict = await reportedVerdict(harness)
    expect(verdict).toBeDefined()
    expect(verdict?.accepted).toBe(true)
    expect(verdict?.quotesVerified).toBeGreaterThan(0)
    expect(verdict?.sectionsMissing).toEqual([])
    expect(harness.warnings.some(line => line.includes('not faithful'))).toBe(false)
  })

  it('reports a fabricated quotation as unfaithful', async () => {
    harness = await auditHarness()
    await commitSummary(harness, structured({
      bodies: { 'Errors and Fixes': '- the build failed with "ENOTFOUND registry.npmjs.org", which the log never said' },
    }))
    const verdict = await reportedVerdict(harness)
    expect(verdict?.accepted).toBe(false)
    expect(harness.warnings.some(line => line.includes('not faithful to the history'))).toBe(true)
  })

  it('reports a dropped field at its own level, without calling it unfaithful', async () => {
    // Every quotation here is in the archive — the summary is faithful. It is also
    // incomplete, and one word for both findings would name neither: the model
    // resuming from it reads the missing field as the `(none)` the contract prescribes.
    harness = await auditHarness()
    await commitSummary(harness, structured({
      bodies: { 'Files and Code': '- src/client/dashboard.tsx, quoting "npm ERR! code EBADENGINE" verbatim' },
      drop: ['Pending Jobs', 'Next Step'],
    }))
    const verdict = await reportedVerdict(harness)
    expect(verdict?.accepted).toBe(true)
    expect(verdict?.sectionsMissing).toEqual(['Pending Jobs', 'Next Step'])
    expect(harness.warnings.some(line => line.includes('not faithful'))).toBe(false)
    expect(harness.debug.some(line => line.includes('dropped 2 checkpoint field(s)') && line.includes('Pending Jobs'))).toBe(true)
    // And the verdict names what it kept, not only what it lost.
    expect(verdict?.sectionsPresent).toContain('Files and Code')
  })

  it('tells the resuming model which fields the checkpoint dropped', async () => {
    // The end of the wire: the same skeleton the log names reaches the body injected
    // after `compaction/end`. Read from the audit rather than parsed again, so the two
    // surfaces cannot disagree about which field was lost.
    harness = await auditHarness()
    await commitSummary(harness, structured({ drop: ['Pending Jobs'] }))
    await harness.fire({ type: 'compaction/end', data: { compactionId: 'c1' } })
    const body = harness.injected.map(message => JSON.stringify(message)).join('\n')
    expect(body).toContain('Fields the checkpoint above dropped')
    expect(body).toContain('It does not carry: Pending Jobs.')
    expect(body).toContain('An absent field is not the same as')
  })

  it('leaves the injected body alone when the checkpoint kept every field', async () => {
    harness = await auditHarness()
    await commitSummary(harness, structured())
    await harness.fire({ type: 'compaction/end', data: { compactionId: 'c1' } })
    expect(harness.injected.map(message => JSON.stringify(message)).join('\n')).not.toContain('Fields the checkpoint above dropped')
  })

  it('says nothing about a compaction it could not read the replaced events for', async () => {
    // An audit over an empty archive would report every quotation as invented, so a
    // session log whose shape this does not recognise stays silent rather than
    // accusing — the failure mode that made the string check worth fixing.
    harness = await auditHarness()
    await harness.fire({
      type: 'compaction/summary',
      data: { compactionId: 'c1', shadowedSeqs: [99], summary: [{ type: 'text', text: structured() }] },
    })
    expect(await reportedVerdict(harness)).toBeUndefined()
    expect(harness.warnings.some(line => line.includes('not faithful'))).toBe(false)
  })
})
