/**
 * The deny list and a member's isolation, in one report.
 *
 * The invariant behind this file is the plan's: a report must **never** present an
 * optional mechanism as enforced, and a caller must not have to hold two documents
 * side by side to learn the effective limit. The effective limit is the weaker of
 * the two mechanisms, and it is invisible when they are printed apart.
 *
 * The second half is the doctor's section, which reads its answer from
 * `sandbox/profiles.ts` rather than restating it — asserted here by checking that
 * the two agree, since that agreement is the whole reason the injection exists.
 */

import { describe, expect, test } from 'vitest'

import { buildIsolationReport, denyListApplies, describeIsolation } from '../src/isolation-report.ts'
import { describeDenyEnforcement, kernelDenyAvailable } from '../src/sandbox/profiles.ts'

const MEMBER = { requested: 'read-only', policyApplied: true, toolScopeApplied: true } as const

describe('the deny list attached to a member report', () => {
  test('is absent when no deny list is configured, rather than reported as none', () => {
    const report = buildIsolationReport(MEMBER)
    expect(report.denyEnforcement).toBeUndefined()
    expect(denyListApplies(report)).toBe(false)
  })

  test('carries its own reach, including the limits, into the member line', () => {
    const deny = describeDenyEnforcement(['**/.env'])
    const report = buildIsolationReport({ ...MEMBER, denyEnforcement: deny })
    expect(report.denyEnforcement?.enforcedBy).toBe('tool-scope')
    const line = describeIsolation(report)
    expect(line).toContain('read-only member restricted by')
    // The caveat is appended to a *restricted* member too: a line that mentioned
    // it only for the unrestricted case would read as though the confined case had
    // no limits.
    expect(line).toContain('deny list:')
    expect(line).toContain('cannot express a kernel-level deny')
  })

  test('an unrestricted member gets the caveat as well, and neither claim is dropped', () => {
    const report = buildIsolationReport({
      requested: 'workspace-write',
      policyApplied: false,
      toolScopeApplied: false,
      denyEnforcement: describeDenyEnforcement(['**/.env']),
    })
    const line = describeIsolation(report)
    expect(line).toContain('NOT contained')
    expect(line).toContain('deny list:')
  })

  test('a deny list that was entirely dropped still says so', () => {
    // `describeDenyEnforcement` returns `none` for an empty list. A member whose
    // patterns were all unusable must not look denied by anything.
    const report = buildIsolationReport({ ...MEMBER, denyEnforcement: describeDenyEnforcement([]) })
    expect(report.denyEnforcement?.enforcedBy).toBe('none')
    expect(denyListApplies(report)).toBe(false)
    // And with no fallback reason there is nothing to append, so the line is the
    // member's own.
    expect(describeIsolation(report)).toBe(describeIsolation(buildIsolationReport(MEMBER)))
  })

  test('a member restricted by scope is not reported as denied by the list', () => {
    // Two mechanisms, two facts. Collapsing them would make a scope-restricted
    // member look covered by a rule that may have been dropped.
    const report = buildIsolationReport({ ...MEMBER, denyEnforcement: { enforcedBy: 'none' } })
    expect(report.restricted).toBe(true)
    expect(denyListApplies(report)).toBe(false)
  })
})

describe('the doctor section reads the same answer', () => {
  test('the enforcement description and the kernel question have one source', () => {
    // The doctor composes `{ patterns, ...describeDenyEnforcement(deny), kernelDenyAvailable() }`
    // rather than writing its own sentence. This asserts the shape it relies on,
    // so a change to the vocabulary breaks here rather than in a report nobody
    // re-reads.
    const described = describeDenyEnforcement(['**/.env', '**/secrets/**'])
    expect(Object.keys(described).sort()).toEqual(['enforcedBy', 'fallbackReason'])
    expect(typeof kernelDenyAvailable()).toBe('boolean')
    // Stated as a test rather than a comment: the day the seam grows a real
    // kernel-level deny this fails, and the sentence above it has to be rewritten
    // instead of quietly becoming false.
    expect(kernelDenyAvailable()).toBe(false)
  })
})
