import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionResult, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  EDIT_AND_RUN_TOOL_NAME,
  THEN_RUN_SKIPPED,
  composeEditAndRun,
  editCallArguments,
  parseEditAndRunArgs,
  registerEditAndRunTool,
  renderEditAndRunValue,
  verificationDecision,
  verifyCallArguments,
  type EditAndRunRegistry,
} from '../src/edit-and-run.ts'

const ok = (text: string, value: unknown = { path: 'a.ts', before: 'x', after: 'y' }): ToolExecutionResult =>
  ({ isError: false, value, content: [{ type: 'text', text }] }) as unknown as ToolExecutionResult
const failed = (text: string): ToolExecutionResult =>
  ({ isError: true, error: { message: text }, content: [{ type: 'text', text }] }) as unknown as ToolExecutionResult

const ARGS = { file_path: 'a.ts', old_string: 'x', new_string: 'y', command: 'npm test' }

describe('what the composite accepts', () => {
  it('rejects a call it cannot dispatch before anything is touched', () => {
    // Failing here costs nothing: no file is written and no process starts.
    expect(() => parseEditAndRunArgs({ ...ARGS, command: '' })).toThrow(/invalid command/)
    expect(() => parseEditAndRunArgs({ ...ARGS, file_path: '  ' })).toThrow(/invalid file_path/)
    expect(() => parseEditAndRunArgs({ ...ARGS, old_string: '' })).toThrow(/invalid old_string/)
    expect(() => parseEditAndRunArgs({ ...ARGS, timeout_ms: 0 })).toThrow(/invalid timeout_ms/)
    expect(() => parseEditAndRunArgs({ ...ARGS, timeout_ms: 'soon' })).toThrow(/invalid timeout_ms/)
  })

  it('allows an empty replacement, because that is how a deletion is expressed', () => {
    // Requiring text here would make the composite unable to delete a line, which
    // the builtin edit it delegates to can do.
    expect(parseEditAndRunArgs({ ...ARGS, new_string: '' }).new_string).toBe('')
  })

  it('maps onto each delegate\u2019s own schema rather than one of its own', () => {
    // The delegate is called with the argument names it declares. If these drifted,
    // the nested call would fail validation at dispatch and the tool would be worse
    // than absent.
    const parsed = parseEditAndRunArgs({ ...ARGS, replace_all: true, timeout_ms: 5_000 })
    expect(editCallArguments(parsed)).toEqual({ file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true })
    expect(verifyCallArguments(parsed)).toEqual({ command: 'npm test', timeoutMs: 5_000 })
    // No `timeoutMs` when none was asked for: the delegate's own default should apply.
    expect(verifyCallArguments(parseEditAndRunArgs(ARGS))).toEqual({ command: 'npm test' })
  })
})

describe('whether the check runs', () => {
  it('runs the command only when the edit landed', () => {
    // The point of the whole tool: a check against an unchanged file reports on the
    // previous state of the world, and reading its failure as evidence about this
    // change is exactly the confusion the composite exists to remove.
    expect(verificationDecision(ok('edited'))).toEqual({ run: true })
    const skipped = verificationDecision(failed('old_string not found'))
    expect(skipped.run).toBe(false)
    expect(!skipped.run && skipped.note.startsWith(THEN_RUN_SKIPPED)).toBe(true)
  })

  it('says the edit did not land instead of reporting a check that never ran', () => {
    const value = composeEditAndRun({ edit: failed('old_string not found'), command: 'npm test', verify: undefined })
    expect(value.check).toBe('not-run')
    expect(value.edited).toBe(false)
    expect(value.status).toContain(THEN_RUN_SKIPPED)
    expect(value.status).not.toContain('FAILED')
  })
})

describe('what the model is told', () => {
  it('forwards each phase\u2019s content verbatim rather than paraphrasing it', () => {
    // A paraphrase of a failing command is exactly where the line that explains the
    // failure goes missing, so both phases arrive as their delegates rendered them.
    const value = composeEditAndRun({
      edit: ok('The file a.ts has been updated successfully.'),
      command: 'npm test',
      verify: failed('FAIL suite/login\n  expected 200, got 500'),
    })
    expect(value.check).toBe('failed')
    expect(value.edited).toBe(true)
    const rendered = renderEditAndRunValue(value).map(block => block.type === 'text' ? block.text : '')
    expect(rendered).toContain('The file a.ts has been updated successfully.')
    expect(rendered).toContain('FAIL suite/login\n  expected 200, got 500')
    // The status line names the phase outcome, and it comes first.
    expect(rendered[0]).toContain('FAILED')
  })

  it('reports a failed check as a call that did its job', () => {
    // The value is returned either way: a red test is information, not a broken
    // tool, and making the call an error would drag it into the loop's error
    // accounting. `check` carries the signal instead.
    for (const check of ['passed', 'failed'] as const) {
      const value = composeEditAndRun({ edit: ok('edited'), command: 'npm test', verify: check === 'passed' ? ok('all green') : failed('boom') })
      expect(value.check).toBe(check)
    }
    expect(composeEditAndRun({ edit: ok('edited'), command: 'npm test', verify: ok('all green') }).status).toContain('passed')
  })

  it('survives a value that is not the shape it expects', () => {
    // render is the tool's output projection; throwing there would lose the output.
    expect(() => renderEditAndRunValue(null)).not.toThrow()
    expect(renderEditAndRunValue({ status: 's', phases: [{ content: undefined }] })).toHaveLength(1)
    expect(renderEditAndRunValue('raw')).toEqual([{ type: 'text', text: 'raw' }])
  })
})

describe('registration and nested dispatch', () => {
  const ctx = (): Context => ({ logger: { debug: () => {} }, systemPrompt: { section: () => () => {} } }) as unknown as Context
  // The registry mints its execution token as a symbol, so the fixture does too:
  // asserting the forwarded `parent` against a symbol identity is a stronger
  // check than a string literal that only ever looked like a token.
  const EXEC_TOKEN = Symbol('dsh.tool.execution') as ToolExecutionToken
  const exec: ToolRunContext = {
    token: EXEC_TOKEN,
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    name: 'edit_and_run',
    arguments: ARGS,
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  }

  const harness = (available: readonly string[], outcomes: Readonly<Record<string, ToolExecutionResult>>) => {
    const calls: { name: string; arguments: unknown; parent: unknown; callId: string; rootCallId: string }[] = []
    let definition: ToolDefinition | undefined
    const registry: EditAndRunRegistry = {
      register: (registered) => { definition = registered; return () => {} },
      get: name => (available.includes(name) ? {} : undefined),
      execute: async (input) => {
        calls.push({ name: input.name, arguments: input.arguments, parent: input.parent, callId: input.callId, rootCallId: input.rootCallId })
        const outcome = outcomes[input.name]
        if (outcome === undefined) throw new Error(`no stubbed outcome for ${input.name}`)
        return outcome
      },
    }
    return { registry, calls, tool: () => definition }
  }

  it('is not registered when it has nothing to delegate to', () => {
    // A registered tool that always fails is worse than an absent one: the model
    // keeps choosing it, and every choice wastes a round trip.
    expect(registerEditAndRunTool({ ctx: ctx(), registry: harness(['bash'], {}).registry })).toBeUndefined()
    expect(registerEditAndRunTool({ ctx: ctx(), registry: harness(['edit'], {}).registry })).toBeUndefined()
    expect(registerEditAndRunTool({ ctx: ctx(), registry: harness(['edit', 'bash'], {}).registry })).toBeDefined()
  })

  it('declares the parameters the model needs as a JSON Schema object', () => {
    // The registered `parameters` is what the provider turns into the model's
    // `input_schema`, so a malformed one is invisible here and expensive there.
    // This literal was once the bare field map — `{ file_path: …, command: … }`
    // with `required: true` inside each field — which is not a schema at all:
    // `required` is a sibling array, not a per-property flag, so every parameter
    // reached the model as optional and the object had no declared `type`. A cast
    // hid it from the type checker; nothing asserted it at runtime either.
    const { registry, tool } = harness(['edit', 'bash'], {})
    registerEditAndRunTool({ ctx: ctx(), registry })
    const parameters = tool()!.parameters as {
      readonly type?: unknown
      readonly properties?: Readonly<Record<string, Record<string, unknown>>>
      readonly required?: unknown
    }
    expect(parameters.type, 'a schema must declare its root type').toBe('object')
    const properties = parameters.properties ?? {}
    expect(Object.keys(properties).sort()).toEqual(['command', 'file_path', 'new_string', 'old_string', 'replace_all', 'timeout_ms'])
    // The four the composite cannot run without. Asserted as a set, because the
    // order is not part of the contract and a missing entry is the actual failure.
    expect([...(parameters.required as readonly string[])].sort()).toEqual(['command', 'file_path', 'new_string', 'old_string'])
    // Every required name must exist in `properties`, or the schema is unsatisfiable.
    for (const name of parameters.required as readonly string[]) expect(properties).toHaveProperty(name)
    // The per-field form: `required: true` inside a property is silently ignored by
    // a JSON Schema validator, so it would look present and mean nothing.
    for (const [name, property] of Object.entries(properties)) {
      expect(property, `${name} still carries a per-field required flag`).not.toHaveProperty('required')
    }
  })

  it('dispatches the edit and then the check, as sub-calls of one root call', () => {
    const { registry, calls, tool } = harness(['edit', 'bash'], { edit: ok('edited'), bash: ok('all green') })
    registerEditAndRunTool({ ctx: ctx(), registry })
    return tool()!.execute(ARGS, exec).then((value) => {
      expect(value).toMatchObject({ check: 'passed', edited: true, command: 'npm test' })
      expect(calls.map(call => call.name)).toEqual(['edit', 'bash'])
      expect(calls[0]!.arguments).toEqual({ file_path: 'a.ts', old_string: 'x', new_string: 'y' })
      expect(calls[1]!.arguments).toEqual({ command: 'npm test' })
      // The parent token is the registry's documented way to identify a nested
      // dispatch, and the root call id keeps the tree under the model's call.
      for (const call of calls) {
        expect(call.parent).toBe(EXEC_TOKEN)
        expect(call.rootCallId).toBe('call-1')
      }
      // Distinct sub-call identities, so the two dispatches are separate log entries.
      expect(calls[0]!.callId).not.toBe(calls[1]!.callId)
    })
  })

  it('does not spawn the verification command when the edit did not land', () => {
    // The load-bearing behaviour, asserted on the registry rather than on the text:
    // if the command were dispatched anyway, a failing check would look like
    // evidence about a change that never happened.
    const { registry, calls, tool } = harness(['edit', 'bash'], { edit: failed('old_string not found'), bash: ok('all green') })
    registerEditAndRunTool({ ctx: ctx(), registry })
    return tool()!.execute(ARGS, exec).then((value) => {
      expect(calls.map(call => call.name)).toEqual(['edit'])
      expect(value).toMatchObject({ check: 'not-run', edited: false })
    })
  })

  it('prefers bash over pwsh when both are mounted', () => {
    const { registry, calls, tool } = harness(['edit', 'bash', 'pwsh'], { edit: ok('edited'), bash: ok('ok') })
    registerEditAndRunTool({ ctx: ctx(), registry })
    return tool()!.execute(ARGS, exec).then(() => {
      expect(calls[1]!.name).toBe('bash')
    })
  })

  it('falls back to pwsh on a composition without bash', () => {
    const { registry, calls, tool } = harness(['edit', 'pwsh'], { edit: ok('edited'), pwsh: ok('ok') })
    registerEditAndRunTool({ ctx: ctx(), registry })
    return tool()!.execute(ARGS, exec).then(() => {
      expect(calls.map(call => call.name)).toEqual(['edit', 'pwsh'])
    })
  })

  it('registers under a name the model can choose', () => {
    const { registry, tool } = harness(['edit', 'bash'], {})
    registerEditAndRunTool({ ctx: ctx(), registry })
    expect(tool()!.name).toBe(EDIT_AND_RUN_TOOL_NAME)
    // The guidance has to reach the model, or it has no reason to prefer this over
    // the two calls it already knows.
    const sections: unknown[] = []
    const withPrompt = { logger: { debug: () => {} }, systemPrompt: { section: (section: unknown) => { sections.push(section); return () => {} } } } as unknown as Context
    registerEditAndRunTool({ ctx: withPrompt, registry })
    expect(sections).toHaveLength(1)
  })
})
