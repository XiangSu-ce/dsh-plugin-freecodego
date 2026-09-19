/**
 * The audit's whole value is that it fails exactly when a green claim is thinner
 * than it looks, so the tests are pairs: one where the claim is honest, one
 * where it is not, differing only in the thing the check reads.
 */

import { describe, expect, it } from 'vitest'
import { auditVerificationClaim } from '../src/fake-green-audit.ts'
import type { FreeCodeGoEngineeringVerificationResult } from '../src/types.ts'

type RunOverrides = Partial<FreeCodeGoEngineeringVerificationResult> & { readonly command?: readonly string[] }

function run(overrides: RunOverrides = {}): FreeCodeGoEngineeringVerificationResult {
  const { command, ...rest } = overrides
  return {
    id: 'verify_1',
    checkedAt: 1,
    stages: [{ id: 'tests', state: 'pass', command: command ?? ['pnpm', 'vitest', 'run', 'src/a.test.ts'], exitCode: 0, durationMs: 1, summary: 'ok' }],
    probes: [{ id: 'probe-1', command: ['pnpm', 'vitest', 'run', 'src/a.test.ts'], expectation: 'pass', rationale: 'exercises the change', state: 'pass', exitCode: 0, durationMs: 1, summary: 'ok', held: true }],
    verdict: 'verified',
    unmet: [],
    ...rest,
  }
}

const rules = (input: Parameters<typeof auditVerificationClaim>[0]) => auditVerificationClaim(input).findings.map(finding => finding.rule)

describe('fake-green audit', () => {
  it('says nothing when nothing changed', () => {
    const audit = auditVerificationClaim({ changedPaths: [] })
    expect(audit.findings).toEqual([])
    expect(audit.holds).toBe(true)
  })

  it('reports a change with no verification recorded, without calling the claim false', () => {
    // A warning, not a failure: "nothing was run" is an omission to surface, and
    // the caller decides. Failing the claim outright would make the audit a
    // second verdict that can disagree with the first.
    const audit = auditVerificationClaim({ changedPaths: ['src/a.ts'] })
    expect(rules({ changedPaths: ['src/a.ts'] })).toEqual(['no-verification'])
    expect(audit.holds).toBe(true)
    expect(audit.uncoveredPaths).toEqual(['src/a.ts'])
  })

  it('accepts a claim whose run exercised the change that is still there', () => {
    const audit = auditVerificationClaim({ verification: run(), changedPaths: ['src/a.ts'] })
    expect(audit.findings).toEqual([])
    expect(audit.holds).toBe(true)
    expect(audit.uncoveredPaths).toEqual([])
  })

  it('reports the paths nothing the run did could have executed', () => {
    // The headline case: three files changed, the run named one of them.
    const verification = run({ command: ['pnpm', 'vitest', 'run', 'src/a.test.ts'] })
    const audit = auditVerificationClaim({ verification, changedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
    expect(audit.holds).toBe(false)
    expect(audit.uncoveredPaths).toEqual(['src/b.ts', 'src/c.ts'])
    const finding = audit.findings.find(entry => entry.rule === 'uncovered-paths')
    expect(finding?.severity).toBe('high')
    expect(finding?.message).toContain('src/b.ts')
  })

  it('treats a whole-project gate as covering every path, because it is a superset', () => {
    // The control for the check above: the same three changed paths, but the run
    // is the project's own gate, which cannot omit a path by naming another.
    const verification = run({ command: ['pnpm', 'vitest', 'run'] })
    const audit = auditVerificationClaim({ verification, changedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
    expect(audit.uncoveredPaths).toEqual([])
    expect(audit.holds).toBe(true)
  })

  it('does not read a flag value as the subject of a whole-project gate', () => {
    // The audit's own failure mode, and the expensive one: a suite that really did
    // run over everything was reported as `uncovered-paths` at `severity: 'high'`
    // because a flag *value* was judged like a positional argument. The flag name was
    // stripped and its value was not, so `--outputFile=reports/junit.xml` scoped the
    // run to a file nobody targeted. A false accusation costs the report the
    // credibility the real findings need in order to be read at all.
    for (const argv of [
      ['--reporter=junit', '--outputFile=reports/junit.xml'],
      ['--reporter', 'junit', '--outputFile', 'reports/junit.xml'],
      ['--coverage'],
      ['-p', 'packages/app/tsconfig.json'],
    ] as const) {
      const verification = run({ command: ['pnpm', 'vitest', 'run', ...argv] })
      const audit = auditVerificationClaim({ verification, changedPaths: ['src/a.ts'] })
      expect(audit.uncoveredPaths, argv.join(' ')).toEqual([])
      expect(audit.holds, argv.join(' ')).toBe(true)
    }
    // The direction that must not change: a run that really names a path is still
    // scoped, however many flags surround it. Dropping a *positional* argument by
    // mistake would hide a targeted run, which is the lie this audit exists to catch.
    const scoped = run({ command: ['pnpm', 'vitest', 'run', '--reporter=junit', 'src/b.test.ts'] })
    const audit = auditVerificationClaim({ verification: scoped, changedPaths: ['src/b.ts', 'src/c.ts'] })
    // `src/b.ts` was named (through its test-file infix) and `src/c.ts` was not, so
    // the run is still read as scoped — to exactly what it named.
    expect(audit.uncoveredPaths).toEqual(['src/c.ts'])
    expect(audit.holds).toBe(false)
  })

  it('counts a path named through its test file infix', () => {
    // `src/a.test.ts` is the test *for* `src/a.ts`; a literal containment check
    // would call the most common targeted run an omission.
    const verification = run({ command: ['pnpm', 'vitest', 'run', 'src/a.test.ts'] })
    const audit = auditVerificationClaim({ verification, changedPaths: ['src/a.ts'] })
    expect(audit.uncoveredPaths).toEqual([])
    expect(audit.holds).toBe(true)
  })

  it('reads a shell-line command through to the program it runs', () => {
    // The classifier descends `bash -c` rather than judging the shell, so a
    // project's own script counts as targeting what it names.
    const verification = run({ command: ['bash', '-c', './scripts/verify.sh src/b.ts'] })
    const audit = auditVerificationClaim({ verification, changedPaths: ['src/b.ts'] })
    expect(audit.uncoveredPaths).toEqual([])
    expect(audit.findings.map(entry => entry.rule)).not.toContain('uncovered-paths')
  })

  it('does not read an unverified verdict as a green light', () => {
    const audit = auditVerificationClaim({ verification: run({ verdict: 'unverified' }), changedPaths: ['src/a.ts'] })
    expect(audit.holds).toBe(false)
    expect(rules({ verification: run({ verdict: 'unverified' }), changedPaths: ['src/a.ts'] })).toContain('verdict-not-verified')
  })

  it('reports a verification whose probe never held', () => {
    const held = run().probes?.[0]
    const verification = run({ probes: [{ ...held!, held: false, state: 'fail' as const }] })
    const audit = auditVerificationClaim({ verification, changedPaths: ['src/a.ts'] })
    expect(audit.holds).toBe(false)
    expect(audit.findings.map(entry => entry.rule)).toContain('no-probe')
  })

  it('reports a skipped stage as a warning and an unavailable one as a failure', () => {
    // A skipped stage leaves its question open; the severity differs because
    // "not applicable here" is a smaller claim than "could not run".
    const skipped = run({ stages: [{ id: 'lint', state: 'skipped', durationMs: 0, summary: 'no linter configured' }] })
    const skippedFindings = auditVerificationClaim({ verification: skipped, changedPaths: ['src/a.ts'] }).findings.find(entry => entry.rule === 'stage-not-pass')
    expect(skippedFindings?.severity).toBe('warning')
    expect(skippedFindings?.message).toContain('a skipped stage is not a pass')

    const unavailable = run({ stages: [{ id: 'lint', state: 'unavailable', durationMs: 0, summary: 'linter missing' }] })
    expect(auditVerificationClaim({ verification: unavailable, changedPaths: ['src/a.ts'] }).holds).toBe(false)
  })

  it('rejects a pass whose exit status belongs to a pipeline tail', () => {
    // `pnpm test | tail -20` exits 0 after a failing run, so the stage's "pass"
    // is the tail reporting, not the check.
    const verification = run({ command: ['bash', '-c', 'pnpm vitest run src/a.test.ts | tail -20'], stages: [{ id: 'tests', state: 'pass', command: ['bash', '-c', 'pnpm vitest run src/a.test.ts | tail -20'], exitCode: 0, durationMs: 1, summary: 'ok' }] })
    const audit = auditVerificationClaim({ verification, changedPaths: ['src/a.ts'] })
    expect(audit.holds).toBe(false)
    expect(audit.findings.map(entry => entry.rule)).toContain('unattributable-status')
  })

  it('rejects a record that covers a different change set than the workspace has', () => {
    const audit = auditVerificationClaim({ verification: run(), verifiedPaths: ['src/a.ts', 'src/b.ts'], changedPaths: ['src/a.ts'] })
    expect(audit.holds).toBe(false)
    const finding = audit.findings.find(entry => entry.rule === 'changed-since-verification')
    expect(finding?.message).toContain('different change set')
  })

  it('compares paths in the spelling the workspace reports', () => {
    // Windows separators and a `./` prefix name the same file; without folding
    // them every run on Windows would look like it covered a different change.
    const audit = auditVerificationClaim({ verification: run(), verifiedPaths: ['src\\a.ts'], changedPaths: ['./src/a.ts'] })
    expect(audit.findings.map(entry => entry.rule)).not.toContain('changed-since-verification')
  })

  it('reports an unstated change set as unstated rather than as a match', () => {
    // No `verifiedPaths` means the caller cannot say, and the audit says nothing
    // instead of assuming the record is about the current change.
    const audit = auditVerificationClaim({ verification: run(), changedPaths: ['src/other.ts'] })
    expect(audit.findings.map(entry => entry.rule)).not.toContain('changed-since-verification')
  })
})
