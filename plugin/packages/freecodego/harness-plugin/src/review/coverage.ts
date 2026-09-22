/**
 * Coverage accounting: every file that entered a review leaves it accounted for.
 *
 * Why this is a module and not a counter in the pipeline
 * -----------------------------------------------------
 * A review's most damaging failure mode is silent omission. A run that reviewed
 * four of forty changed files reads exactly like a run that reviewed forty, and
 * the difference is invisible in the output — which is why OCR makes coverage
 * accounting mandatory rather than best-effort. Making it a pure function over
 * the outcomes has two consequences that matter: the pipeline cannot finish
 * while a file is still `pending` (the check names the missing files instead of
 * the summary quietly shrinking its denominator), and a test can assert the
 * arithmetic without running a review.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/coverage
 */

/** How one file's review concluded. */
export type ReviewFileOutcomeState = 'pending' | 'reviewed' | 'skipped' | 'failed'

/** One file's fate within a run. */
export interface ReviewFileOutcome {
  /** Repository-relative path the outcome is about. */
  readonly path: string
  /** How the file changed, so a reader knows what was reviewed. */
  readonly change: string
  readonly state: ReviewFileOutcomeState
  /** Why a file was skipped or failed; required for both, absent for the rest. */
  readonly reason?: string
  /** Findings this file produced, which is zero for a file that was skipped. */
  readonly comments: number
}

/** The arithmetic a report and its UI both display. */
export interface ReviewCoverage {
  readonly totalFiles: number
  readonly reviewedFiles: number
  readonly skippedFiles: number
  readonly failedFiles: number
  readonly pendingFiles: number
  /**
   * Reviewed files over total files, in `[0, 1]`.
   *
   * Zero for an empty review rather than `NaN` or `1`: no files is not full
   * coverage, and a number that renders as a percentage must never be one a UI
   * has to special-case.
   */
  readonly coverageRate: number
}

/** Count one set of outcomes. */
export function summarizeCoverage(outcomes: readonly ReviewFileOutcome[]): ReviewCoverage {
  let reviewed = 0
  let skipped = 0
  let failed = 0
  let pending = 0
  for (const outcome of outcomes) {
    switch (outcome.state) {
      case 'reviewed': reviewed += 1; break
      case 'skipped': skipped += 1; break
      case 'failed': failed += 1; break
      case 'pending': pending += 1; break
    }
  }
  const total = outcomes.length
  return {
    totalFiles: total,
    reviewedFiles: reviewed,
    skippedFiles: skipped,
    failedFiles: failed,
    pendingFiles: pending,
    coverageRate: total === 0 ? 0 : reviewed / total,
  }
}

/**
 * The files a finished run has not accounted for.
 *
 * Non-empty means the run is malformed, not merely incomplete: a caller uses
 * this to refuse to publish a report whose files vanished, and the returned
 * paths are what make the refusal actionable.
 */
export function unaccountedFiles(outcomes: readonly ReviewFileOutcome[]): string[] {
  return outcomes.filter(outcome => outcome.state === 'pending').map(outcome => outcome.path)
}

/**
 * Whether an outcome carries the reason its state requires.
 *
 * `skipped` and `failed` are claims about *why* nothing was reported, and a
 * claim without its reason is exactly the silent omission this module exists to
 * prevent. Checked apart from {@link summarizeCoverage} so the arithmetic stays
 * total — a malformed outcome is still counted, it is just reported as malformed.
 */
export function missingReasons(outcomes: readonly ReviewFileOutcome[]): string[] {
  return outcomes
    .filter(outcome => (outcome.state === 'skipped' || outcome.state === 'failed')
      && (outcome.reason === undefined || outcome.reason.trim() === ''))
    .map(outcome => outcome.path)
}
