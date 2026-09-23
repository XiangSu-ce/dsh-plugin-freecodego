/**
 * The bare `catch` blocks in `src/index.ts` that guard a *registration*.
 *
 * Each of them was already right about one thing — a failed registration must not
 * take the plugin down — and wrong about another: the surface simply was not
 * there, and nothing said so. A tool that was never offered to the model is
 * indistinguishable, from inside a session, from a tool with nothing to report.
 *
 * The fix is a log line and never a rethrow, so every case below asserts two
 * things at once: the failure is now visible, **and** the boot carried on (the
 * neighbouring registrations still happened). The second half is what keeps this
 * an observability change rather than a control-flow change.
 *
 * Each case is a mutation probe: restore the bare `catch {` and the case fails on
 * its first assertion.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import type { UpstreamPlanMode } from '../src/plan-mode.ts'
import { pluginConfig, provideHostService, provideHostServiceAs, registrationHandle, runContext, sessionAt, type AgentEnginesFace, type CommandsFace } from './support/host-services.ts'

const CWD = '/workspace'

/** A registered tool, kept so a case can call it the way the Host would. */
interface RegistrationHarness {
  readonly plugin: FreeCodeGoHarnessPlugin
  /** Every `logger.warn` line the boot produced, in order. */
  readonly warnings: string[]
  /** The names the tool registry was asked to register, whether or not it agreed. */
  readonly attempted: readonly string[]
  /** The names the tool registry accepted. */
  readonly registered: readonly string[]
  /** The registered tools, by name, for a case that needs to call one. */
  readonly tools: ReadonlyMap<string, ToolDefinition>
  readonly dispose: () => Promise<void>
}

/**
 * The real plugin, booted against registries that can be made to refuse.
 *
 * `failTools` names the tool registrations that throw; everything else is
 * accepted, which is what makes the "the boot carried on" assertions meaningful —
 * a registry that threw for every call would prove nothing about ordering.
 *
 * `tools` is provided at all only because the registration paths read it through
 * `ctx.get`: a composition that mounts no tool registry skips every one of them
 * before the `try` is even entered, and none of these catches would run.
 */
async function registrationHarness(options: {
  readonly failTools?: readonly string[]
  /** The message a refused registration throws; defaults to naming the tool. */
  readonly refusalDetail?: string
  readonly failCommands?: boolean
  readonly failSections?: boolean
  readonly planMode?: 'absent' | 'working' | 'refusing-write'
} = {}): Promise<RegistrationHarness> {
  const home = mkdtempSync(join(tmpdir(), 'freecodego-registration-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const warnings: string[] = []
  const attempted: string[] = []
  const registered: string[] = []
  const tools = new Map<string, ToolDefinition>()
  const refusing = new Set(options.failTools ?? [])
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { list: () => [], get: () => undefined })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => sessionAt(CWD), list: () => [] })
    provideHostService(scope, 'llm', {
      registerAdapter: () => registrationHandle(),
      stream(_generation: GenerateOptions): AsyncIterable<StreamChunk> {
        return (async function* empty(): AsyncGenerator<StreamChunk> { /* the boot makes no request */ })()
      },
    })
    provideHostService(scope, 'tools', {
      register: (tool) => {
        attempted.push(tool.name)
        if (refusing.has(tool.name)) throw new Error(options.refusalDetail ?? `registry refused ${tool.name}`)
        registered.push(tool.name)
        tools.set(tool.name, tool)
        return () => undefined
      },
      guard: () => () => undefined,
      schemas: () => [],
    })
    provideHostServiceAs<CommandsFace>(scope, 'commands', {
      register: (definition) => {
        if (options.failCommands === true) throw new Error(`command registry refused ${definition.name}`)
        return () => undefined
      },
    })
    provideHostService(scope, 'systemPrompt', {
      section: (section) => {
        if (options.failSections === true) throw new Error(`prompt registry refused ${section.name}`)
        return () => undefined
      },
    })
    // Only mounted when a case asks for it: an upstream authority that is present
    // changes which of the two plan-mode records the plugin reads and writes, so
    // providing it unconditionally would make every other case test a different
    // composition than the one it names.
    if (options.planMode !== undefined && options.planMode !== 'absent') {
      // The plugin's own declared face for this probe (`findUpstreamPlanMode`
      // resolves it through `ctx.get`, so no `Context` member covers it).
      provideHostServiceAs<UpstreamPlanMode>(scope, 'planMode', {
        get: () => ({ active: false }),
        set: () => {
          if (options.planMode === 'refusing-write') throw new Error('the harness plan-mode write was refused')
          return 'committed'
        },
      })
    }
  })
  const inner = ctx.logger.warn.bind(ctx.logger)
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(argument => String(argument)).join(' '))
    ;(inner as (...forwarded: unknown[]) => void)(...args)
  })
  const plugin = new FreeCodeGoHarnessPlugin(ctx, pluginConfig({ engineeringEnabled: true, engineeringMemoryEnabled: true, advisorProvider: 'opencode', advisorModel: 'auto' }))
  return {
    plugin,
    warnings,
    attempted,
    registered,
    tools,
    dispose: async () => {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

/** The warning lines that name a surface, so a case does not assert on prose. */
function naming(warnings: readonly string[], surface: string): readonly string[] {
  return warnings.filter(line => line.includes(surface))
}

describe('a refused tool registration is logged, and the boot continues', () => {
  let harness: RegistrationHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('names engineering_plan_mode, and the other tools still register', async () => {
    // Mutation: restoring `} catch {` in `registerPlanModeTool` leaves `warnings`
    // empty and this case fails on the first assertion.
    harness = await registrationHarness({ failTools: ['engineering_plan_mode'] })
    const lines = naming(harness.warnings, 'engineering_plan_mode')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('registry refused engineering_plan_mode')
    // The half that proves control flow did not change: the tool that was refused
    // is absent, and every sibling registration still ran.
    expect(harness.registered).not.toContain('engineering_plan_mode')
    expect(harness.registered).toContain('engineering_inspect')
    expect(harness.registered).toContain('engineering_context_budget')
  })

  it('names engineering_inspect, and /inspect still registers', async () => {
    harness = await registrationHarness({ failTools: ['engineering_inspect'] })
    expect(naming(harness.warnings, 'engineering_inspect')).toHaveLength(1)
    expect(harness.registered).not.toContain('engineering_inspect')
    // The command is a separate registration with its own catch: the tool's
    // failure must not have been turned into the command's.
    expect(naming(harness.warnings, '/inspect command')).toHaveLength(0)
  })

  it('names the /inspect command, and the tool still registers', async () => {
    // Mutation: restoring `} catch {` in `registerInspectCommand` makes this fail
    // while the case above still passes — the two doors are independently wired.
    harness = await registrationHarness({ failCommands: true })
    const lines = naming(harness.warnings, '/inspect command')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('command registry refused inspect')
    expect(harness.registered).toContain('engineering_inspect')
  })

  it('names engineering_surface_report', async () => {
    harness = await registrationHarness({ failTools: ['engineering_surface_report'] })
    expect(naming(harness.warnings, 'engineering_surface_report')).toHaveLength(1)
    expect(harness.registered).not.toContain('engineering_surface_report')
  })

  it('masks a credential the registry echoed back in its refusal', async () => {
    // The repo already enforces this rule at the sibling site — see the guard
    // probe "the registration failure message masks the backend body it is built
    // from" (`guard-probes.spec.ts`, anchored on `managed-catalog-utils.ts`). A
    // registry that quotes the definition it refused can echo arbitrary backend
    // text into this log line, so the rule has to hold at every registration site
    // rather than at one of them.
    //
    // Mutation: reverting any of the ten `was not registered` warnings in
    // `src/index.ts` to `${String(error)}` leaves the key verbatim and fails the
    // first assertion.
    const secret = `sk-ant-api03-${'a'.repeat(40)}`
    harness = await registrationHarness({
      failTools: ['engineering_plan_mode'],
      refusalDetail: `registry refused engineering_plan_mode; the credential it carried was ${secret}`,
    })
    const lines = naming(harness.warnings, 'engineering_plan_mode')
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(secret)
    expect(lines[0]).toContain('[redacted credential]')
    // The half that keeps this an observability change: the failure is still
    // named, so masking did not replace the message with a placeholder.
    expect(lines[0]).toContain('engineering_plan_mode was not registered')
  })

  it('masks the error at every registration site, not only the one a case can drive', async () => {
    // A harness case can only reach the registration sites it has a seam for, so
    // the remaining warnings are covered structurally — the same technique
    // `guard-probes.spec.ts` uses for its anchors. Without this, a new
    // registration added without masking would pass every behavioural case here.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const warnings = source.split('\n').filter(line => line.includes('was not registered'))
    expect(warnings.length).toBeGreaterThanOrEqual(10)
    for (const line of warnings) {
      expect(line, `unmasked registration warning: ${line.trim()}`).not.toContain('${String(error)}')
      expect(line, `registration warning without a mask: ${line.trim()}`).toContain('redactCredentialShapes(String(error))')
    }
  })

  it('names spill_recall, and says what its absence costs', async () => {
    harness = await registrationHarness({ failTools: ['spill_recall'] })
    const lines = naming(harness.warnings, 'spill_recall')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('parked results cannot be read back')
  })

  it('names the context budget tool and the prompt composition tool separately', async () => {
    harness = await registrationHarness({ failTools: ['engineering_context_budget', 'engineering_context_prompt'] })
    expect(naming(harness.warnings, 'context budget tool')).toHaveLength(1)
    expect(naming(harness.warnings, 'prompt composition tool')).toHaveLength(1)
  })
})

describe('a refused per-definition registration names the one that failed', () => {
  let harness: RegistrationHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('keeps the other worktree tools when one is refused', async () => {
    // Mutation: restoring `} catch {` in `registerWorktreeTools` loses the name,
    // and the count assertion below fails even though the others still register.
    harness = await registrationHarness({ failTools: ['engineering_worktree_enter'] })
    const lines = naming(harness.warnings, 'engineering_worktree_enter')
    expect(lines).toHaveLength(1)
    expect(harness.registered).not.toContain('engineering_worktree_enter')
    // "One failed registration must not remove the other three" — asserted rather
    // than trusted, because that is the promise the catch was written to keep.
    expect(harness.registered).toContain('engineering_worktree_exit')
    expect(harness.registered).toContain('engineering_worktree_status')
    expect(harness.registered).toContain('engineering_worktree_list')
  })

  it('keeps the other persona tools when one is refused', async () => {
    harness = await registrationHarness({ failTools: ['engineering_persona_list'] })
    expect(naming(harness.warnings, 'engineering_persona_list')).toHaveLength(1)
    expect(harness.registered).not.toContain('engineering_persona_list')
    expect(harness.registered).toContain('engineering_subagent_start')
  })
})

describe('the prompt surfaces are registrations too', () => {
  let harness: RegistrationHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('says when read_document could not finish registering', async () => {
    // Mutation: restoring `} catch {` in `registerReadDocumentTool` makes this
    // fail. The tool itself landed before the section did, so the log line has to
    // report a *partial* registration rather than a missing tool.
    harness = await registrationHarness({ failSections: true })
    const lines = naming(harness.warnings, 'read_document')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('may be callable without its prompt line')
    expect(harness.registered).toContain('read_document')
  })

  it('says when the headroom verbosity steering never reached the prompt', async () => {
    // Mutation: restoring `} catch {` at the end of `startOutputShaper` makes this
    // fail. A level the settings hold and the prompt never forwards is the exact
    // "I set it and it did not apply" failure the level provider replaced.
    harness = await registrationHarness({ failSections: true })
    const lines = naming(harness.warnings, 'verbosity steering')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('will not reach the model')
  })

  it('logs nothing about the prompt surfaces when the registry accepts them', async () => {
    // The other direction: a working registry must stay silent, or the log line
    // would be noise on every boot rather than a signal.
    harness = await registrationHarness()
    expect(naming(harness.warnings, 'read_document')).toHaveLength(0)
    expect(naming(harness.warnings, 'verbosity steering')).toHaveLength(0)
  })
})

describe('a refused plan-mode write is logged rather than silently re-homed', () => {
  let harness: RegistrationHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('says the fence may disagree with the record that was actually written', async () => {
    // Mutation: restoring `catch { /* fall through to the store */ }` in
    // `applyPlanMode` leaves the divergence unlogged and this case fails.
    harness = await registrationHarness({ planMode: 'refusing-write' })
    const tool = harness.tools.get('engineering_plan_mode')
    expect(tool?.execute).toBeDefined()
    const result = await tool!.execute({ action: 'enter' }, runContext({ agent: { id: 'session-1' } })) as { readonly mode?: string }
    // The transition still happened — through the plugin's own store, which is
    // the fallback the design chose — and that is precisely why the log line
    // matters: the mode is now recorded in the authority the fence does not read.
    expect(result.mode).toBe('plan')
    const lines = naming(harness.warnings, 'plan-mode write failed')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('the harness plan-mode write was refused')
  })

  it('logs nothing when the harness write succeeds', async () => {
    harness = await registrationHarness({ planMode: 'working' })
    const tool = harness.tools.get('engineering_plan_mode')
    await tool!.execute({ action: 'enter' }, runContext({ agent: { id: 'session-1' } }))
    expect(naming(harness.warnings, 'plan-mode write failed')).toHaveLength(0)
  })
})
