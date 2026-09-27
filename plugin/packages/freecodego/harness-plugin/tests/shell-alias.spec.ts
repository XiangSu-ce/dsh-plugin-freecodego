import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionResult, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  registerShellAliasTools,
  resolveShellToolName,
  shellAliasArguments,
  shellAliasCallView,
  shellAliasFailure,
  type ShellAliasRegistry,
} from '../src/shell-alias.ts'

const ok = (text: string): ToolExecutionResult =>
  ({ isError: false, value: { text }, content: [{ type: 'text', text }] }) as unknown as ToolExecutionResult
const failed = (content: ToolExecutionResult['content']): ToolExecutionResult =>
  ({ isError: true, error: { message: 'x' }, content }) as unknown as ToolExecutionResult

describe('which delegate answers the aliases', () => {
  const registry = (available: readonly string[]): ShellAliasRegistry =>
    ({ register: () => () => {}, get: name => (available.includes(name) ? {} : undefined), execute: async () => ok('') })

  it('is the host shell tool this composition actually registered', () => {
    // The set (`SHELL_TOOL_NAMES`) is read in its own order, so a host that ships both
    // keeps the delegate its tool list offered first rather than the last one looked at.
    expect(resolveShellToolName(registry(['pwsh', 'read']))).toBe('pwsh')
    expect(resolveShellToolName(registry(['bash', 'pwsh']))).toBe('bash')
    expect(resolveShellToolName(registry(['read', 'grep']))).toBeUndefined()
  })
})

describe('what one alias call forwards', () => {
  it('renames the command to the field the delegate declares', () => {
    // The measured dialect: the model's `shell` prior sends `cmd`, and `pwsh` requires
    // `command`. Without this rename the call would fail the delegate's own validation.
    expect(shellAliasArguments({ cmd: 'git status', description: 'd', workdir: 'w' }))
      .toEqual({ command: 'git status', description: 'd', workdir: 'w' })
    expect(shellAliasArguments({ command: 'git status' })).toEqual({ command: 'git status' })
    // `cmd` wins when a caller sends both, because that is the spelling this name exists for.
    expect(shellAliasArguments({ cmd: 'a', command: 'b' })).toEqual({ command: 'a' })
  })

  it('renames the other spelling of the timeout and forwards everything else untouched', () => {
    // `timeout_ms` is what the same callers use for the same idea; anything this module
    // has never heard of (the escalation pair, a future parameter) must reach the
    // delegate still judged by the delegate's schema rather than dropped here.
    expect(shellAliasArguments({ command: 'x', timeout_ms: 5, sandbox_permissions: 'workspace-write' }))
      .toEqual({ command: 'x', timeoutMs: 5, sandbox_permissions: 'workspace-write' })
    expect(shellAliasArguments({ command: 'x', timeoutMs: 7 })).toEqual({ command: 'x', timeoutMs: 7 })
  })

  it('refuses a call that names no command before anything is dispatched', () => {
    expect(() => shellAliasArguments({})).toThrow(/invalid command/)
    expect(() => shellAliasArguments(undefined)).toThrow(/invalid command/)
    expect(() => shellAliasArguments({ cmd: '   ', command: '' })).toThrow(/invalid command/)
  })
})

describe('what a refused command reads as', () => {
  it('drops the delegate envelope instead of doubling it', () => {
    // The delegate's content already carries the envelope the registry adds, and this
    // layer adds one too: forwarding it whole made the model read `Error: Error: …`.
    expect(shellAliasFailure(failed([{ type: 'text', text: 'Error: sandbox denied' }]))).toBe('sandbox denied')
    expect(shellAliasFailure(failed([{ type: 'text', text: 'plain' }]))).toBe('plain')
  })

  it('says so when the delegate explained nothing', () => {
    // An empty error message is the failure nobody can act on, and a failure whose only
    // block is not text explains nothing either.
    expect(shellAliasFailure(failed([]))).toBe('the host shell tool refused this command')
    expect(shellAliasFailure(failed([{ type: 'text', text: '   ' }]))).toBe('the host shell tool refused this command')
    const thought = [{ type: 'reasoning', text: 'thinking about it' }] as unknown as ToolExecutionResult['content']
    expect(shellAliasFailure(failed(thought))).toBe('the host shell tool refused this command')
  })
})

describe('how the call is shown', () => {
  it('presents a command as the terminal card it is', () => {
    expect(shellAliasCallView({ cmd: 'ls', description: 'List files', workdir: 'sub' }))
      .toEqual({ card: 'terminal', title: 'ls', description: 'List files', cwd: 'sub' })
    expect(shellAliasCallView({ command: 'ls' })).toEqual({ card: 'terminal', title: 'ls' })
  })

  it('falls back to a generic card when there is no command to title it by', () => {
    // A terminal card has no other title slot, and a call the model made with no command
    // — or one whose arguments have not arrived yet — still has to render as something.
    expect(shellAliasCallView({})).toEqual({ card: 'generic', title: 'Run shell command', kind: 'execute' })
    expect(shellAliasCallView(undefined)).toEqual({ card: 'generic', title: 'Run shell command', kind: 'execute' })
  })
})

describe('registration and nested dispatch', () => {
  const ctx = (): Context => ({ logger: { debug: () => {} } }) as unknown as Context
  const EXEC_TOKEN = Symbol('dsh.tool.execution') as ToolExecutionToken
  const exec = (over: Partial<ToolRunContext> = {}): ToolRunContext => ({
    token: EXEC_TOKEN,
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    name: 'shell',
    arguments: {},
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
    ...over,
  })

  const harness = (
    available: readonly string[],
    outcomes: Readonly<Record<string, ToolExecutionResult>> = {},
  ) => {
    const definitions = new Map<string, ToolDefinition>()
    const disposed = new Set<string>()
    const calls: { name: string; arguments: unknown; parent: unknown; callId: string; rootCallId: string; agent: unknown }[] = []
    const registry: ShellAliasRegistry = {
      register: (definition) => {
        definitions.set(definition.name, definition)
        return () => disposed.add(definition.name)
      },
      get: name => (available.includes(name) ? {} : undefined),
      execute: async (input) => {
        calls.push({
          name: input.name,
          arguments: input.arguments,
          parent: input.parent,
          callId: String(input.callId),
          rootCallId: String(input.rootCallId),
          agent: input.agent,
        })
        return outcomes[input.name] ?? ok('ran')
      },
    }
    return { registry, definitions, disposed, calls, tool: (name: string) => definitions.get(name)! }
  }

  const WINDOWS_AGENT = { id: 'agent-1' }

  it('registers each missing name and nothing the host already answers to', () => {
    // Windows: the host ships `pwsh` alone, and both spellings are missing.
    const both = harness(['pwsh', 'read'])
    expect(registerShellAliasTools({ ctx: ctx(), registry: both.registry })).toHaveLength(2)
    expect([...both.definitions.keys()]).toEqual(['shell', 'bash'])

    // POSIX: `bash` is the host's own tool, so only `shell` is a name worth adding.
    const posix = harness(['bash', 'read'])
    expect(registerShellAliasTools({ ctx: ctx(), registry: posix.registry })).toHaveLength(1)
    expect([...posix.definitions.keys()]).toEqual(['shell'])
    // A host that already answers to both names gets a shim for neither: a second
    // registration of one name is not a registration at all.
    const complete = harness(['bash', 'shell'])
    const disposers = registerShellAliasTools({ ctx: ctx(), registry: complete.registry })
    expect(disposers).toEqual([])
    expect([...complete.definitions.keys()]).toEqual([])
  })

  it('registers nothing when there is no shell tool to delegate to', () => {
    // A registered alias that always fails is worse than an absent one: the model keeps
    // choosing it, and every choice wastes a round trip.
    const { registry, definitions } = harness(['read', 'grep'])
    expect(registerShellAliasTools({ ctx: ctx(), registry })).toEqual([])
    expect([...definitions.keys()]).toEqual([])
  })

  it('uproots what it registered when the plugin unloads', () => {
    const { registry, disposed } = harness(['pwsh'])
    for (const dispose of registerShellAliasTools({ ctx: ctx(), registry })) dispose()
    expect([...disposed].sort()).toEqual(['bash', 'shell'])
  })

  it('declares the parameters a caller sends, as a JSON Schema object', () => {
    // `parameters` is what the provider turns into the model's input schema, so a field
    // missing here is a call the model cannot make: `cmd` is what the measured caller
    // sends, and `cmd` is therefore the required one.
    const { registry, tool } = harness(['pwsh'])
    registerShellAliasTools({ ctx: ctx(), registry })
    const parameters = tool('shell').parameters as {
      readonly type?: unknown
      readonly properties?: Readonly<Record<string, unknown>>
      readonly required?: readonly string[]
    }
    expect(parameters.type).toBe('object')
    expect([...(parameters.required ?? [])]).toEqual(['cmd'])
    expect(Object.keys(parameters.properties ?? {}).sort())
      .toEqual(['cmd', 'command', 'description', 'run_in_background', 'timeoutMs', 'timeout_ms', 'workdir'])
    for (const name of parameters.required ?? []) expect(parameters.properties).toHaveProperty(name)
    expect((tool('bash').parameters as { readonly required?: readonly string[] }).required).toEqual(['command'])
  })

  it('presents both names as the command they run', () => {
    // The declaration a UI reads is the tool's own, so neither alias may rely on the
    // other's name being recognised by a renderer.
    const { registry, tool } = harness(['pwsh'])
    registerShellAliasTools({ ctx: ctx(), registry })
    for (const name of ['shell', 'bash']) {
      expect(tool(name).presentCall?.({ cmd: 'ls', description: 'List' }))
        .toEqual({ card: 'terminal', title: 'ls', description: 'List' })
      expect(tool(name).presentCall?.({ command: 'ls' })).toEqual({ card: 'terminal', title: 'ls' })
    }
  })

  it('dispatches the delegate as a sub-call of the model\'s own call', () => {
    const { registry, calls, tool } = harness(['pwsh'])
    registerShellAliasTools({ ctx: ctx(), registry })
    const args = { cmd: 'git status', description: 'Show the tree', workdir: 'sub' }
    return tool('shell').execute(args, exec({ agent: WINDOWS_AGENT as never })).then((value) => {
      expect(value).toEqual({ content: [{ type: 'text', text: 'ran' }] })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.name).toBe('pwsh')
      expect(calls[0]!.arguments).toEqual({ command: 'git status', description: 'Show the tree', workdir: 'sub' })
      // The parent token is the registry's own way to identify a sub-dispatch, and the
      // root call id keeps the tree under the call the model actually made.
      expect(calls[0]!.parent).toBe(EXEC_TOKEN)
      expect(calls[0]!.rootCallId).toBe('call-1')
      expect(calls[0]!.callId).toBe('call-1:shell')
      expect(calls[0]!.agent).toBe(WINDOWS_AGENT)
    })
  })

  it('carries no agent when the call has none, and no context to defer', () => {
    // Both are optional on the execution, and forwarding `undefined` for either would be
    // a shape the registry never mints.
    const { registry, calls, tool } = harness(['bash'])
    registerShellAliasTools({ ctx: ctx(), registry })
    // Cast rather than declared: `ToolRunContext` requires `deferContext`, and this is
    // the shape the module's own structural slice admits — the optional call is what
    // keeps a composition that omits it from throwing.
    const bare = {
      token: EXEC_TOKEN,
      callId: ToolCallId('call-1'),
      rootCallId: ToolCallId('call-1'),
      name: 'shell',
      arguments: {},
      signal: new AbortController().signal,
      concludeTurn: () => {},
    } as unknown as ToolRunContext
    return tool('shell').execute({ cmd: 'ls' }, bare).then(() => {
      expect(calls[0]!.agent).toBeUndefined()
      expect(calls[0]!.callId).toBe('call-1:shell')
    })
  })

  it('answers the second name through the same delegate', () => {
    const { registry, calls, tool } = harness(['pwsh'])
    registerShellAliasTools({ ctx: ctx(), registry })
    return tool('bash').execute({ command: 'ls' }, exec({ name: 'bash' })).then(() => {
      expect(calls[0]!.name).toBe('pwsh')
      expect(calls[0]!.arguments).toEqual({ command: 'ls' })
      expect(calls[0]!.callId).toBe('call-1:bash')
    })
  })

  it('hands a deferred context from the nested call to this one', async () => {
    // Swallowing it would drop an instruction the model was supposed to receive.
    const seen: unknown[] = []
    const context = { role: 'user', content: [{ type: 'text', text: 'note' }] }
    const carried = {
      isError: false,
      value: { text: 'ran' },
      content: [{ type: 'text', text: 'ran' }],
      additionalContexts: [context],
    } as unknown as ToolExecutionResult
    const { registry, tool } = harness(['pwsh'], { pwsh: carried })
    registerShellAliasTools({ ctx: ctx(), registry })
    await tool('shell').execute({ cmd: 'ls' }, exec({ deferContext: value => seen.push(value) }))
    expect(seen).toEqual([context])
  })

  it('fails this call when the delegate refused the command', async () => {
    // A refusal is the delegate's answer, and the model must read it as this call's
    // failure rather than as output that succeeded.
    const { registry, tool } = harness(['pwsh'], { pwsh: failed([{ type: 'text', text: 'Error: Auto review rejected tool "pwsh"' }]) })
    registerShellAliasTools({ ctx: ctx(), registry })
    await expect(tool('shell').execute({ cmd: 'ls' }, exec())).rejects
      .toThrow('Auto review rejected tool "pwsh"')
  })

  it('projects the delegate\'s blocks through its own output declaration', () => {
    // The declaration is what the registry renders the canonical value with, and a
    // render that threw would lose the very output the model needs.
    const { registry, tool } = harness(['pwsh'])
    registerShellAliasTools({ ctx: ctx(), registry })
    const render = tool('shell').output.render
    const blocks = [{ type: 'text', text: 'out' }]
    const value = (content: unknown): Parameters<typeof render>[1] => ({ content } as Parameters<typeof render>[1])
    expect(render({}, value(blocks))).toEqual(blocks)
    expect(render({}, value(undefined))).toEqual([])
    expect(render({}, null)).toEqual([])
  })
})
