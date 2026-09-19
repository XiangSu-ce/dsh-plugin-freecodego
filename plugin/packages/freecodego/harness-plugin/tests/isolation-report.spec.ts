import { describe, expect, it } from 'vitest'
import { buildIsolationReport, describeIsolation } from '../src/isolation-report.ts'

describe('isolation reporting', () => {
  it('reports both mechanisms when tool scope and the sandbox policy are in effect', () => {
    const report = buildIsolationReport({ requested: 'read-only', policyApplied: true, toolScopeApplied: true })
    expect(report.enforcedBy).toBe('both')
    expect(report.restricted).toBe(true)
    expect(report.fallbackReason).toBeUndefined()
    expect(describeIsolation(report)).toBe('read-only member restricted by tool scope and the session sandbox policy')
  })

  it('credits tool scope alone, which holds on every platform', () => {
    // The role allow-list intersection is enforcement this plugin owns: write and
    // shell tools are removed from the callable set, not merely discouraged.
    const report = buildIsolationReport({ requested: 'read-only', policyApplied: false, toolScopeApplied: true })
    expect(report.enforcedBy).toBe('tool-scope')
    expect(report.restricted).toBe(true)
    expect(report.fallbackReason).toBeUndefined()
    expect(describeIsolation(report)).toContain('no write or shell tools are callable')
  })

  it('does not claim enforcement from a policy we cannot verify', () => {
    const report = buildIsolationReport({ requested: 'read-only', policyApplied: true, toolScopeApplied: false })
    // We set the sandbox mode and it read back, which is reported as applied —
    // not as enforced, because we cannot verify what the platform did with it.
    expect(report.enforcedBy).toBe('harness-policy')
    expect(report.policyApplied).toBe(true)
    expect(report.fallbackReason).toBeUndefined()
  })

  it('names the failure when nothing restricted a read-only member', () => {
    const report = buildIsolationReport({ requested: 'read-only', policyApplied: false, toolScopeApplied: false })
    expect(report.enforcedBy).toBe('none')
    expect(report.restricted).toBe(false)
    expect(report.fallbackReason).toContain('it is not a read-only member')
    expect(describeIsolation(report)).toContain('is NOT restricted')
  })

  it('says a writing member is contained rather than prevented', () => {
    // A workspace-write member in its own worktree writes freely; what isolation
    // buys is that the shared tree is untouched. That is containment, and it is
    // reported as its own fact — `restricted` stays false because neither tool
    // scope nor the sandbox policy is narrowing this member.
    const report = buildIsolationReport({ requested: 'workspace-write', policyApplied: false, toolScopeApplied: false, worktree: '/tmp/wt/m2' })
    expect(report.enforcedBy).toBe('none')
    expect(report.contained).toBe(true)
    expect(report.restricted).toBe(false)
    expect(report.worktree).toBe('/tmp/wt/m2')
    expect(describeIsolation(report)).toBe('workspace-write member with a private worktree at /tmp/wt/m2')
  })

  it('omits the worktree field rather than inventing a path, and says the writer is unconfined', () => {
    // This used to report `restricted: true` and describe "a private worktree" for
    // a member that has none — the report asserted containment it could not back.
    const report = buildIsolationReport({ requested: 'workspace-write', policyApplied: false, toolScopeApplied: false })
    expect('worktree' in report).toBe(false)
    expect(report.contained).toBe(false)
    expect(report.restricted).toBe(false)
    expect(report.fallbackReason).toContain('its writes reach the shared tree')
    expect(describeIsolation(report)).toContain('is NOT contained')
  })

  it('credits the sandbox policy as confinement for a writing member', () => {
    const report = buildIsolationReport({ requested: 'workspace-write', policyApplied: true, toolScopeApplied: false })
    expect(report.restricted).toBe(true)
    expect(report.contained).toBe(true)
    expect(report.fallbackReason).toBeUndefined()
    // No worktree, so the summary must not claim one.
    expect(describeIsolation(report)).toBe('workspace-write member confined to the workspace by the session sandbox policy; it shares the tree with its peers')
  })

  // There is deliberately no case here for a *failed* start. A start that threw
  // has no isolation to report, so `engineering_team_member_start` answers with
  // the throw and records the failure on the roster instead of building a
  // report; a report type for it existed and was unreachable, which meant these
  // two cases asserted a shape nothing produced. The invariant they guarded —
  // never report a failed start as restricted or contained — is held by the
  // absence of a report, and the roster entry is what a later reader sees.
})
