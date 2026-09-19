import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERIFICATION_STAGES } from '../src/engineering-remote-utils.ts'
import {
  ARCHITECTURAL_PATH_PATTERNS,
  LIGHT_FILE_MAX,
  LIGHT_LINE_MAX,
  SECURITY_PATH_PATTERNS,
  THOROUGH_FILE_THRESHOLD,
  changeMetadataFromDiff,
  describeVerificationTier,
  isTestPath,
  selectVerificationTier,
  testCoverageFromChangedPaths,
  type ChangeMetadata,
} from '../src/verification-tier.ts'

const metadata = (overrides: Partial<ChangeMetadata> = {}): ChangeMetadata => ({
  filesChanged: 2,
  linesChanged: 40,
  hasSecurityImplications: false,
  hasArchitecturalChanges: false,
  testCoverage: 'full',
  ...overrides,
})

describe('tier selection', () => {
  it('downgrades only when every light condition holds', () => {
    expect(selectVerificationTier(metadata()).tier).toBe('light')
    // Any single missing condition sends it to the middle tier, so an unknown
    // shape is never quietly under-checked.
    expect(selectVerificationTier(metadata({ filesChanged: LIGHT_FILE_MAX })).tier).toBe('standard')
    expect(selectVerificationTier(metadata({ linesChanged: LIGHT_LINE_MAX })).tier).toBe('standard')
    expect(selectVerificationTier(metadata({ testCoverage: 'partial' })).tier).toBe('standard')
    expect(selectVerificationTier(metadata({ testCoverage: 'none' })).tier).toBe('standard')
  })

  it('never downgrades a security or architectural change', () => {
    const security = selectVerificationTier(metadata({ hasSecurityImplications: true, filesChanged: 1, linesChanged: 3 }))
    expect(security.tier).toBe('thorough')
    expect(security.reasons).toContain('the change has security implications')
    const architectural = selectVerificationTier(metadata({ hasArchitecturalChanges: true, filesChanged: 1, linesChanged: 3 }))
    expect(architectural.tier).toBe('thorough')
    expect(architectural.reasons).toContain('the change has architectural implications')
  })

  it('treats breadth alone as thorough', () => {
    const plan = selectVerificationTier(metadata({ filesChanged: THOROUGH_FILE_THRESHOLD + 1, testCoverage: 'partial' }))
    expect(plan.tier).toBe('thorough')
    expect(plan.reasons[0]).toContain(`${THOROUGH_FILE_THRESHOLD}-file breadth threshold`)
  })

  it('reports the reason for landing in the middle tier', () => {
    expect(selectVerificationTier(metadata({ testCoverage: 'partial' })).reasons[0]).toBe('test coverage is partial')
    expect(selectVerificationTier(metadata({ filesChanged: 9, linesChanged: 20 })).reasons[0]).toContain('9 files changed')
    expect(selectVerificationTier(metadata({ filesChanged: 2, linesChanged: 400 })).reasons[0]).toContain('400 lines changed')
  })

  it('scopes the claim instead of letting a light pass read as a full one', () => {
    const light = selectVerificationTier(metadata())
    expect(light.stages).toEqual(['scope', 'types'])
    expect(light.omitted).toEqual(['build', 'lint', 'tests'])
    // The sentence has to name what passing does NOT establish, or the tier
    // silently upgrades a scoped claim into an unscoped one.
    expect(light.scope).toContain('does not establish that the build succeeds')
    expect(light.scope).toContain('any test passes')
    const thorough = selectVerificationTier(metadata({ hasSecurityImplications: true }))
    expect(thorough.omitted).toEqual([])
    expect(thorough.scope).toContain('full declared pipeline')
  })

  it('keeps every stage accounted for at every tier', () => {
    // stages + omitted must partition the full pipeline, or a stage could vanish
    // from both lists and never be reported as missing.
    for (const meta of [metadata(), metadata({ testCoverage: 'none' }), metadata({ hasSecurityImplications: true })]) {
      const plan = selectVerificationTier(meta)
      expect([...plan.stages, ...plan.omitted].sort()).toEqual(['build', 'lint', 'scope', 'tests', 'types'])
    }
  })

  it('uses the full pipeline at thorough and never omits scope', () => {
    const plan = selectVerificationTier(metadata({ hasSecurityImplications: true }))
    expect(plan.stages).toEqual(['scope', 'build', 'types', 'lint', 'tests'])
    for (const meta of [metadata(), metadata({ testCoverage: 'none' }), metadata({ hasArchitecturalChanges: true })]) {
      expect(selectVerificationTier(meta).stages).toContain('scope')
    }
  })

  it('asks for more probes as the tier rises without touching the global gate', () => {
    // The tier may reduce stages; it may never reduce what counts as evidence.
    // Probe counts are expectations here — the global verdict still refuses
    // `verified` when no probe was declared.
    expect(selectVerificationTier(metadata()).expectedProbes).toBe(1)
    expect(selectVerificationTier(metadata({ testCoverage: 'none' })).expectedProbes).toBe(1)
    expect(selectVerificationTier(metadata({ hasSecurityImplications: true })).expectedProbes).toBe(2)
    expect(describeVerificationTier(selectVerificationTier(metadata()))).toContain('light verification (scope+types; omitted build+lint+tests)')
  })
})

describe('change metadata from a diff', () => {
  it('counts paths and flags sensitive families', () => {
    const meta = changeMetadataFromDiff({
      changedPaths: ['src/auth/session.ts', 'docs/notes.md'],
      linesChanged: 120,
      testCoverage: 'partial',
      securityPaths: ['auth', 'secret'],
      architecturalPaths: ['scheduler'],
    })
    expect(meta.filesChanged).toBe(2)
    expect(meta.linesChanged).toBe(120)
    expect(meta.hasSecurityImplications).toBe(true)
    expect(meta.hasArchitecturalChanges).toBe(false)
    expect(selectVerificationTier(meta).tier).toBe('thorough')
  })

  it('does not treat an empty pattern list as a match', () => {
    // `some` over an empty list is false, but the outer guard makes that explicit:
    // a caller with no security patterns must not accidentally flag everything.
    const meta = changeMetadataFromDiff({ changedPaths: ['src/a.ts'], linesChanged: 5, testCoverage: 'full', securityPaths: [] })
    expect(meta.hasSecurityImplications).toBe(false)
    expect(meta.hasArchitecturalChanges).toBe(false)
  })

  it('clamps a negative line count and handles an empty diff', () => {
    const meta = changeMetadataFromDiff({ changedPaths: [], linesChanged: -5, testCoverage: 'none' })
    expect(meta.linesChanged).toBe(0)
    expect(meta.filesChanged).toBe(0)
  })

  it('matches sensitive families case-insensitively', () => {
    // Path casing is a platform convention, not meaning: a Windows checkout must
    // not tier differently from a Linux one for the same change.
    const meta = changeMetadataFromDiff({
      changedPaths: ['src/Secret/Store.ts'],
      linesChanged: 3,
      testCoverage: 'full',
      securityPaths: SECURITY_PATH_PATTERNS,
      architecturalPaths: ARCHITECTURAL_PATH_PATTERNS,
    })
    expect(meta.hasSecurityImplications).toBe(true)
    expect(selectVerificationTier(meta).tier).toBe('thorough')
  })

  it('never downgrades a build manifest or migration to light', () => {
    const meta = changeMetadataFromDiff({
      changedPaths: ['package.json', 'db/migrations/0042_add_index.sql', 'src/a.spec.ts'],
      linesChanged: 4,
      testCoverage: 'full',
      securityPaths: SECURITY_PATH_PATTERNS,
      architecturalPaths: ARCHITECTURAL_PATH_PATTERNS,
    })
    expect(meta.hasArchitecturalChanges).toBe(true)
    expect(selectVerificationTier(meta).tier).toBe('thorough')
  })
})

describe('coverage inferred from changed paths', () => {
  it('reads a test-file change as coverage and the absence of one as none', () => {
    expect(testCoverageFromChangedPaths(['src/a.ts', 'src/a.spec.ts'])).toBe('full')
    expect(testCoverageFromChangedPaths(['src/a.ts'])).toBe('none')
    // `partial` is never inferred: a path list cannot tell a half-covered change
    // from a covered one, and guessing it would move the tier on a fiction.
    expect(testCoverageFromChangedPaths([])).toBe('none')
  })

  it('recognises the test conventions in use here', () => {
    expect(isTestPath('packages/x/tests/thing.spec.ts')).toBe(true)
    expect(isTestPath('src/__tests__/a.ts')).toBe(true)
    expect(isTestPath('app/test_main.py')).toBe(true)
    expect(isTestPath('pkg/server_test.go')).toBe(true)
    expect(isTestPath('src/contest.ts')).toBe(false)
    expect(isTestPath('src/latest.tsx')).toBe(false)
  })

  it('cannot reach the light tier on a small change that ships no test', () => {
    const meta = changeMetadataFromDiff({
      changedPaths: ['src/tiny.ts'],
      linesChanged: 3,
      testCoverage: testCoverageFromChangedPaths(['src/tiny.ts']),
    })
    expect(selectVerificationTier(meta).tier).toBe('standard')
  })

  it('names the same stages in the public union and in the one runtime list', () => {
    // tsc enforces one direction on its own: every entry of `VERIFICATION_STAGES`
    // must be a member of the union, so a typo or a stray stage is a compile error.
    // The other direction has no such check — a stage added to the union and
    // forgotten in the list compiles, and the remote validator then refuses a stage
    // the public type offers. Reading the union is the only way to see that, and
    // this is the pair that used to be four separate copies.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const text = readFileSync(join(root, 'harness-plugin/src/types.ts'), 'utf8').replace(/\r\n/gu, '\n')
    const declaration = /export type FreeCodeGoEngineeringVerificationStage =([^\n]*)\n/u.exec(text)
    if (declaration === null) throw new Error('FreeCodeGoEngineeringVerificationStage is no longer a single-line union; update this read')
    const union = [...declaration[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1])
    expect(union).toEqual([...VERIFICATION_STAGES])
  })
})
