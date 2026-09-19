import { describe, expect, it } from 'vitest'
import { approvalResponse, isApprovalMethod } from '../src/approval-response.ts'

/**
 * The App Server declares a response schema per approval method, and each one
 * requires a `decision` whose allowed values differ. The Host answers with one
 * neutral outcome object, so this module is the only thing standing between a
 * user's answer and a response the App Server cannot read.
 */
describe('Codex approval response', () => {
  it('answers a command approval in the accept/decline vocabulary', () => {
    expect(approvalResponse('item/commandExecution/requestApproval', { type: 'approved' })).toEqual({ decision: 'accept' })
    expect(approvalResponse('item/commandExecution/requestApproval', { type: 'rejected' })).toEqual({ decision: 'decline' })
    expect(approvalResponse('item/fileChange/requestApproval', { type: 'approved' })).toEqual({ decision: 'accept' })
    expect(approvalResponse('item/fileChange/requestApproval', { type: 'rejected' })).toEqual({ decision: 'decline' })
  })

  it('answers the legacy approval requests in the ReviewDecision vocabulary', () => {
    // `ReviewDecision` declares no `denied` string. Its eight variants are
    // `approved`, `{ approved_execpolicy_amendment }`, `approved_for_session`,
    // `approved_mcp_policy_amendment`, `{ network_policy_amendment }`,
    // `{ denied: { rejection } }`, `timed_out` and `abort`, so a bare
    // `'denied'` matched none of them and the refusal was unreadable.
    expect(approvalResponse('applyPatchApproval', { type: 'approved' })).toEqual({ decision: 'approved' })
    expect(approvalResponse('execCommandApproval', { type: 'approved' })).toEqual({ decision: 'approved' })
    for (const method of ['applyPatchApproval', 'execCommandApproval']) {
      expect(approvalResponse(method, { type: 'rejected' }))
        .toEqual({ decision: { denied: { rejection: 'User denied this request' } } })
    }
  })

  it('carries the reason the Host refused, which is the model\u2019s only account of why', () => {
    // A refusal the Host’s own guard produced arrives as
    // `{ type: 'rejected', message }`, and `rejection` is where that text
    // belongs: without it the model is told it was refused and not why.
    expect(approvalResponse('applyPatchApproval', { type: 'rejected', message: 'blocked by policy' }))
      .toEqual({ decision: { denied: { rejection: 'blocked by policy' } } })
    // An empty message is an absent one, not a refusal that says nothing.
    expect(approvalResponse('execCommandApproval', { type: 'rejected', message: '' }))
      .toEqual({ decision: { denied: { rejection: 'User denied this request' } } })
  })

  it('never turns anything but an explicit approval into a grant', () => {
    for (const outcome of [{ type: 'rejected' }, { type: 'cancelled' }, {}, null, undefined, 'approved', { type: true }]) {
      expect(approvalResponse('item/commandExecution/requestApproval', outcome)).toEqual({ decision: 'decline' })
    }
    expect(approvalResponse('item/commandExecution/requestApproval', { type: 'approved' })).toEqual({ decision: 'accept' })
  })

  it('grants exactly the requested permission profile, scoped to the turn', () => {
    const requested = { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/work/out' } }] }, network: { enabled: true } }
    expect(approvalResponse('item/permissions/requestApproval', { type: 'approved' }, { permissions: requested }))
      .toEqual({ permissions: requested, scope: 'turn' })
    // A refusal has no sentinel in that schema: an empty profile grants nothing,
    // and it must not echo the request back as if it had been approved.
    expect(approvalResponse('item/permissions/requestApproval', { type: 'rejected' }, { permissions: requested }))
      .toEqual({ permissions: {} })
    // A missing request profile still refuses rather than inventing one.
    expect(approvalResponse('item/permissions/requestApproval', { type: 'approved' }, undefined))
      .toEqual({ permissions: {}, scope: 'turn' })
  })

  it('separates the decisions a user can make from the protocol handshakes', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'applyPatchApproval', 'execCommandApproval', 'item/permissions/requestApproval']) {
      expect(isApprovalMethod(method)).toBe(true)
    }
    // Their responses require `token`, `accessToken`, `action`, or `contentItems`
    // — data no approval outcome carries, so prompting for them was a dead end.
    for (const method of ['attestation/generate', 'account/chatgptAuthTokens/refresh', 'mcpServer/elicitation/request', 'item/tool/call', 'item/tool/requestUserInput']) {
      expect(isApprovalMethod(method)).toBe(false)
    }
  })

  it('leaves a method with no readable vocabulary unchanged', () => {
    // Unreachable through the worker's approval path; kept so a future caller
    // cannot turn an unreadable method into a fabricated decision.
    expect(approvalResponse('attestation/generate', { type: 'approved' })).toEqual({ type: 'approved' })
  })
})
