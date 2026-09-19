import { describe, expect, it } from 'vitest'
import { codexThreadSandboxParams } from '../src/sandbox-mode.ts'

describe('Codex thread sandbox params', () => {
  it('sends the session mode through untranslated', () => {
    // The App Server's SandboxMode enum is the Harness vocabulary verbatim, so
    // any translation here would be a second spelling to drift.
    expect(codexThreadSandboxParams({ sandboxMode: 'workspace-write' })).toEqual({ sandbox: 'workspace-write' })
    expect(codexThreadSandboxParams({ sandboxMode: 'danger-full-access' })).toEqual({ sandbox: 'danger-full-access' })
  })

  it('keeps a user-chosen read-only session able to escalate', () => {
    // The Harness's own read-only sessions escalate through an approval
    // (ESCALATION_TARGETS); `never` would make the request impossible to express
    // and turn the mode into a dead end.
    expect(codexThreadSandboxParams({ sandboxMode: 'read-only' })).toEqual({ sandbox: 'read-only', approvalPolicy: 'on-request' })
  })

  it('closes the council child to approvals the floor forbids', () => {
    expect(codexThreadSandboxParams({ readOnly: true })).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
    // The floor also outranks a wider logged mode on the same wire message.
    expect(codexThreadSandboxParams({ readOnly: true, sandboxMode: 'danger-full-access' })).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
  })

  it('leaves the engine default alone when no policy crossed the boundary', () => {
    expect(codexThreadSandboxParams({})).toEqual({})
    expect(codexThreadSandboxParams({ readOnly: false })).toEqual({})
    // An unreadable value is not a restriction: the App Server keeps its own
    // default rather than being handed a mode nobody chose.
    expect(codexThreadSandboxParams({ sandboxMode: 'workspace_write' })).toEqual({})
  })

  it('passes no approval policy for the two wider modes', () => {
    // The Harness's `ask | never` has no lossless Codex counterpart, so picking
    // one would change how often users are prompted. Only read-only needs a
    // policy, and it is decided above.
    for (const mode of ['workspace-write', 'danger-full-access'] as const) {
      expect(codexThreadSandboxParams({ sandboxMode: mode }).approvalPolicy).toBeUndefined()
    }
  })
})
