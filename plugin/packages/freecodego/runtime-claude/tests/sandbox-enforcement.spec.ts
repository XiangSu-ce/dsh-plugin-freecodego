import { describe, expect, it } from 'vitest'
import { claudeSandboxDenial } from '../src/sandbox-enforcement.ts'

describe('Claude read-only enforcement', () => {
  it('refuses every built-in that can write or run an unconfined process', () => {
    // The SDK's own tools never pass through the Harness sandbox, so this callback
    // is the only place the session's mode can reach them.
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      const denial = claudeSandboxDenial({ sandboxMode: 'read-only' }, tool)
      expect(denial, tool).toBeDefined()
      // The message has to name the tool, the reason, and the way forward; a bare
      // "denied" leaves the model retrying the same call.
      expect(denial).toContain(tool)
      expect(denial).toContain('read-only')
      expect(denial).toContain('sandbox mode')
    }
  })

  it('leaves reads and everything the mode does not take away on the approval path', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode', 'Task', 'mcp__other__tool', 'SomeFutureTool']) {
      expect(claudeSandboxDenial({ sandboxMode: 'read-only' }, tool), tool).toBeUndefined()
    }
  })

  it('recognizes the council floor as read-only too', () => {
    // The floor and the user's mode resolve through one rule, so a council child
    // that somehow reached this check would still be refused a write.
    expect(claudeSandboxDenial({ readOnly: true }, 'Write')).toBeDefined()
  })

  it('does not restrict the two wider modes', () => {
    for (const mode of ['workspace-write', 'danger-full-access'] as const) {
      for (const tool of ['Write', 'Edit', 'Bash']) {
        expect(claudeSandboxDenial({ sandboxMode: mode }, tool), `${mode}:${tool}`).toBeUndefined()
      }
    }
  })

  it('stays out of the way when no policy crossed the boundary', () => {
    // No readable mode means no restriction this module can honestly claim; the
    // call keeps its existing approval path.
    for (const fields of [{}, { readOnly: false }, { sandboxMode: 'workspace_write' }, { sandboxMode: 3 }]) {
      expect(claudeSandboxDenial(fields, 'Write')).toBeUndefined()
      expect(claudeSandboxDenial(fields, 'Bash')).toBeUndefined()
    }
  })
})
