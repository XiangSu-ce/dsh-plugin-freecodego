/**
 * Proportional verification: pay for the check the change deserves.
 *
 * Why
 * ---
 * Verification currently costs the same whether the change is a one-line guard
 * or a rewrite of the scheduler, so the cheap case is over-charged and — worse —
 * the expensive case gets no more evidence than the cheap one. oh-my-claudecode's
 * `verification/tier-selector.ts` scales the effort from change metadata
 * (`filesChanged`, `linesChanged`, security and architectural flags, test
 * coverage) and names, per tier, both the model and the evidence it must
 * produce. The idea is right; the boundary is what matters.
 *
 * Two invariants this module will not cross:
 *
 * 1. **A tier may reduce the stages that run. It may never reduce what counts as
 *    evidence.** A skipped stage still reports `skipped`, a pass still needs a
 *    command and an exit code, and a verification with no probe is still
 *    `unverified`. Otherwise "light verification" would become a way to turn a
 *    weaker check into a stronger claim, which is the failure this whole
 *    evidence contract exists to prevent.
 * 2. **The tier is reported with what it omitted.** A `light` plan that skipped
 *    `tests` produces a verdict that is only meaningful *relative to that scope*,
 *    so the plan always carries `omitted` and a sentence saying what it did not
 *    establish. A caller that drops the tier from its report turns a scoped claim
 *    into an unscoped one.
 *
 * Security and architectural changes are never downgraded, and neither is an
 * unfamiliar shape: anything not clearly small and clearly covered lands on
 * `standard`, because the cost of the middle tier is bounded and the cost of
 * under-checking a real change is not.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/verification-tier
 */

import type { EngineeringVerificationStage } from './engineering-quality.ts'
// The stage vocabulary is one list: this module used to hold its own copy, which
// is how a tier could omit a stage the validator accepted.
import { VERIFICATION_STAGES } from './engineering-remote-utils.ts'

export type VerificationTier = 'light' | 'standard' | 'thorough'

export interface ChangeMetadata {
  readonly filesChanged: number
  readonly linesChanged: number
  readonly hasSecurityImplications: boolean
  readonly hasArchitecturalChanges: boolean
  readonly testCoverage: 'none' | 'partial' | 'full'
}

export interface VerificationTierPlan {
  readonly tier: VerificationTier
  /** Stages this tier runs, in the order the runner should consider them. */
  readonly stages: readonly EngineeringVerificationStage[]
  /** Stages this tier deliberately leaves out, so the claim stays scoped. */
  readonly omitted: readonly EngineeringVerificationStage[]
  /**
   * Independent probes this tier requires. The runner enforces it as a floor
   * (fewer probes leaves the run `unverified`), on top of the global rule that a
   * run with no probe at all is never `verified`.
   */
  readonly expectedProbes: number
  /** Why this tier was chosen, in the order the reasons read best. */
  readonly reasons: readonly string[]
  /** Plain-language statement of what passing at this tier does NOT establish. */
  readonly scope: string
}

/** Stages per tier. `scope` is always included: it is the change record itself. */
const TIER_STAGES: Readonly<Record<VerificationTier, readonly EngineeringVerificationStage[]>> = {
  // A small, fully covered change still gets type checking — that is the check
  // most likely to catch a real mistake in a small change, and it is cheap.
  light: ['scope', 'types'],
  standard: ['scope', 'build', 'types', 'tests'],
  thorough: VERIFICATION_STAGES,
}

const TIER_PROBES: Readonly<Record<VerificationTier, number>> = { light: 1, standard: 1, thorough: 2 }

const TIER_SCOPE: Readonly<Record<VerificationTier, string>> = {
  light: 'Passing at this tier establishes that the change is scoped as described and type-checks. It does not establish that the build succeeds, that lint is clean, or that any test passes.',
  standard: 'Passing at this tier establishes that the change builds and that the test suite passes. It does not establish that lint is clean, and it is not a security or architectural review.',
  thorough: 'Passing at this tier establishes the full declared pipeline: scope, build, types, lint, and tests, plus the declared probes.',
}

/**
 * Path fragments that force `thorough` however small the change is.
 *
 * Chosen for signal, not completeness: each fragment names something whose
 * failure mode is not "a test goes red". Matching is case-insensitive, and a
 * false positive here only ever *raises* the tier — the direction that costs a
 * pipeline rather than a missed defect — so a fragment that also catches
 * `AuthService.ts` is worth keeping.
 */
export const SECURITY_PATH_PATTERNS: readonly string[] = [
  '.env', 'credential', 'secret', 'private-key', 'keystore', 'password',
  'oauth', 'authn', 'authz', 'crypto', 'payment', 'billing', 'signing',
]

/**
 * Path fragments that mark a change as structural.
 *
 * Build manifests, lockfiles, CI definitions, and schema or migration files
 * change what the whole repository does rather than one behaviour, so their
 * blast radius is not visible from the diff size.
 */
export const ARCHITECTURAL_PATH_PATTERNS: readonly string[] = [
  'package.json', 'tsconfig', 'pnpm-lock', 'package-lock', 'yarn.lock',
  'go.mod', 'cargo.toml', 'pyproject.toml', 'dockerfile', '.github/workflows',
  'migrations/', 'schema.sql', 'eslint', 'vitest.config', 'vite.config',
]

/** Files-changed count above which a change is treated as too broad to check lightly. */
export const THOROUGH_FILE_THRESHOLD = 20
/** Files-changed count below which a change may qualify for light verification. */
export const LIGHT_FILE_MAX = 5
/** Lines-changed count below which a change may qualify for light verification. */
export const LIGHT_LINE_MAX = 100

/**
 * Choose a tier from change metadata.
 *
 * Every downgrade to `light` requires *all* of its conditions: few files, few
 * lines, and full test coverage. Any one missing sends it to `standard`, so an
 * unknown shape is never quietly under-checked.
 */
export function selectVerificationTier(metadata: ChangeMetadata): VerificationTierPlan {
  const reasons: string[] = []
  let tier: VerificationTier

  if (metadata.hasSecurityImplications || metadata.hasArchitecturalChanges) {
    tier = 'thorough'
    if (metadata.hasSecurityImplications) reasons.push('the change has security implications')
    if (metadata.hasArchitecturalChanges) reasons.push('the change has architectural implications')
  } else if (metadata.filesChanged > THOROUGH_FILE_THRESHOLD) {
    tier = 'thorough'
    reasons.push(`${metadata.filesChanged} files changed, above the ${THOROUGH_FILE_THRESHOLD}-file breadth threshold`)
  } else if (metadata.filesChanged < LIGHT_FILE_MAX && metadata.linesChanged < LIGHT_LINE_MAX && metadata.testCoverage === 'full') {
    tier = 'light'
    reasons.push(`${metadata.filesChanged} files and ${metadata.linesChanged} lines changed, with full test coverage`)
  } else {
    tier = 'standard'
    if (metadata.testCoverage !== 'full') reasons.push(`test coverage is ${metadata.testCoverage}`)
    else if (metadata.filesChanged >= LIGHT_FILE_MAX) reasons.push(`${metadata.filesChanged} files changed, at or above the ${LIGHT_FILE_MAX}-file light threshold`)
    else reasons.push(`${metadata.linesChanged} lines changed, at or above the ${LIGHT_LINE_MAX}-line light threshold`)
  }

  const stages = TIER_STAGES[tier]
  const omitted = VERIFICATION_STAGES.filter(stage => !stages.includes(stage))
  return {
    tier,
    stages,
    omitted,
    expectedProbes: TIER_PROBES[tier],
    reasons,
    scope: TIER_SCOPE[tier],
  }
}

/**
 * Derive change metadata from a `git diff --stat`-style summary.
 *
 * Kept separate from the tier decision so the decision stays a pure function of
 * facts, and so a caller that knows its metadata better can supply it directly
 * instead of parsing anything.
 */
export function changeMetadataFromDiff(input: {
  readonly changedPaths: readonly string[]
  readonly linesChanged: number
  readonly testCoverage: 'none' | 'partial' | 'full'
  /** Paths matching a security-sensitive family; the caller decides what counts. */
  readonly securityPaths?: readonly string[]
  readonly architecturalPaths?: readonly string[]
}): ChangeMetadata {
  // Compared lowercased because path casing is a platform convention, not
  // meaning: `src/Auth/session.ts` and `src/auth/session.ts` are the same
  // signal, and a Windows checkout must not tier differently from a Linux one.
  const paths = input.changedPaths.map(path => path.toLowerCase())
  const matches = (patterns: readonly string[]): boolean => patterns.length > 0 && paths.some(path => patterns.some(pattern => path.includes(pattern.toLowerCase())))
  return {
    filesChanged: paths.length,
    linesChanged: Math.max(0, input.linesChanged),
    hasSecurityImplications: matches(input.securityPaths ?? []),
    hasArchitecturalChanges: matches(input.architecturalPaths ?? []),
    testCoverage: input.testCoverage,
  }
}

/**
 * Whether a changed path is one this repository would run as a test.
 *
 * Deliberately generous about spelling (`tests/`, `__tests__/`, `*.test.ts`,
 * `test_*.py`, `*_test.go`) and deliberately not clever: a path list can only
 * say where code lives, and a language-aware test detector here would make the
 * tier depend on a heuristic nobody can review.
 */
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|specs?)\//u

/**
 * Infer test coverage from the paths in a change.
 *
 * A proxy, and named as one: this reads *which files moved*, not whether the
 * tests exercise the change. `full` therefore means "the change arrived with a
 * test-file change", which is the strongest claim a path list can support and
 * exactly what the light-tier gate asks for. `partial` is never inferred — a
 * path list cannot tell a half-covered change from a covered one — so a caller
 * that knows real coverage should pass it directly rather than route it here.
 */
export function testCoverageFromChangedPaths(changedPaths: readonly string[]): 'none' | 'partial' | 'full' {
  if (changedPaths.length === 0) return 'none'
  return changedPaths.some(path => isTestPath(path)) ? 'full' : 'none'
}

/** Whether one path is a test file by the path conventions above. */
export function isTestPath(path: string): boolean {
  return TEST_FILE_PATTERN.test(path)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
    || /(?:^|\/)test_[^/]+\.(?:py|rb)$/u.test(path)
    || /_test\.go$/u.test(path)
}

/** One-line summary for the verification report. */
export function describeVerificationTier(plan: VerificationTierPlan): string {
  const stages = plan.stages.join('+')
  const omitted = plan.omitted.length === 0 ? '' : `; omitted ${plan.omitted.join('+')}`
  return `${plan.tier} verification (${stages}${omitted}) because ${plan.reasons.join(' and ')}`
}
