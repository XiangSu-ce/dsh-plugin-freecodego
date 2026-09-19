/**
 * Deterministic scan selection: which changed files a scan will look at, and why
 * the rest will not be looked at.
 *
 * Why selection is code and not a prompt
 * --------------------------------------
 * "Review the changed files" is a language instruction, and a language
 * instruction has no answer to three questions a user eventually asks: *which*
 * files, *why not* the others, and *did anything get skipped*. A run that
 * answers them by re-deriving them per attempt cannot be previewed before it
 * spends tokens, cannot be reproduced after it spends them, and cannot say what
 * it never looked at. Those are the three failures this module exists to remove,
 * and they are removed by making selection a **pure function**: the same
 * candidates and the same options always produce the same decisions.
 *
 * The split this follows — engineering for the steps that must not be wrong, the
 * model for the steps that need judgement — is the one Alibaba's
 * `open-code-review` uses (Apache-2.0; `internal/agent/selection.go` and the
 * `ocr delegate preview` interface). Its own reason for keeping selection pure is
 * worth keeping in mind here: preview and the real run each derived their own
 * answer, the two drifted, and the drift was a bug report. One function, two
 * readers, is the fix.
 *
 * The denominator is sealed here, not later
 * -----------------------------------------
 * {@link ScanSelection.selected} is the set that must be accounted for. A file
 * excluded here is excluded *with a reason*; a file that leaves the scan with
 * neither is the silent skip this module is arranged to make impossible. That is
 * the rule `fake-green-audit.ts` applies to verification claims and
 * `verification-evidence.ts` applies to probes, applied one stage earlier — a
 * scan that quietly drops a file has told the user nothing about it while
 * looking like it told them something.
 *
 * Unknown size is not small
 * -------------------------
 * A file whose size could not be judged stays **selected** and is reported as
 * unchecked ({@link ScanDecision.sizeUnchecked}). Excluding it would be a budget
 * that passes by not looking, and it would do that in the one case — an
 * unreadable or vanished file — where a user most needs to hear about it.
 *
 * One deliberate difference from the upstream default table
 * ---------------------------------------------------------
 * `open-code-review` excludes test files by default. This plugin does not, and
 * the reason is specific to it: the defect class this repository watches hardest
 * is a test that asserts nothing while reporting green — `fake-green-audit.ts`
 * exists for it and `FREECODEGO-ENHANCEMENT-PLAN.md` records several found by
 * hand. A scan that never opens a test file cannot see one. A caller that wants
 * the upstream default passes it through `exclude`.
 *
 * What this module never does
 * ---------------------------
 * No IO, no git, no LLM, no file contents: it prices sizes the caller already
 * measured and reads no file in order to measure one. Everything it decides is a
 * function of its arguments, which is what makes it testable without a
 * filesystem and what lets `engineering_inspect` show the same answer a run
 * would act on rather than a second opinion about it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/scan-selection
 */

import { matchesGlob } from 'node:path'
import { tokensFromChars } from './token-estimate.ts'
import { isCredentialPath } from './tool-guards.ts'

/** Every exclusion reason, in the order a report lists them. */
export const SCAN_EXCLUSIONS = ['none', 'deleted', 'credential', 'excluded-by-pattern', 'too-large'] as const

/**
 * Why a changed file is not part of the scan. `none` means it is.
 *
 * Derived from {@link SCAN_EXCLUSIONS} rather than written twice, so a reason
 * cannot exist as a type without existing as a list entry.
 */
export type ScanExclusion = typeof SCAN_EXCLUSIONS[number]

/**
 * Default per-file ceiling: 256 KiB.
 *
 * The same number `engineering-quality.ts` uses to bound the one untracked read
 * it performs, and reused rather than re-derived because two different ceilings
 * for "a file too large to read wholesale" would mean one of them is wrong. It
 * is deliberately generous: the gate is here to keep a single generated artefact
 * out of a scan, not to make a judgement about long source files.
 */
export const DEFAULT_SCAN_MAX_FILE_BYTES = 256 * 1024

/** One exclusion rule: a glob and the reason a report gives for it. */
export interface ScanExcludeRule {
  /** Repository-relative glob; `**`, `*`, `?` and `{a,b}` are supported. */
  readonly pattern: string
  /** Short phrase a report shows beside the path. */
  readonly reason: string
}

/**
 * Patterns excluded unless the caller says otherwise.
 *
 * Every one is a path convention rather than a content rule, so a reader can
 * predict what this list excludes without running anything — and so a caller who
 * disagrees can replace the list rather than argue with a classifier. These are
 * the paths where a finding could not be acted on: installed dependencies,
 * vendored source, build output, generated metadata.
 *
 * Test files are deliberately absent; see the module header for why.
 *
 * Deliberately NOT here, and registered rather than forgotten: the reconciliation
 * half of the ledger. {@link ScanSelection.selected} seals what must be accounted
 * for, but nothing in this plugin records a per-file *scan* outcome yet — the
 * council and advisor reports carry findings, not the set of files they covered
 * (`FreeCodeGoEngineeringCouncilFinding` has prose `evidence` and no paths). An
 * `unaccountedScanPaths(selection, accountedFor)` reader over the sealed
 * denominator is the obvious next shape and is not written here, because this
 * repository already has a name for a module with no runtime consumer (see the
 * enhancement plan's rounds on unwired modules). It belongs with the change that
 * makes the review paths record outcomes.
 */
export const DEFAULT_SCAN_EXCLUDE_RULES: readonly ScanExcludeRule[] = [
  { pattern: '**/node_modules/**', reason: 'installed dependency' },
  { pattern: '**/vendor/**', reason: 'vendored source' },
  { pattern: '**/dist/**', reason: 'build output' },
  { pattern: '**/build/**', reason: 'build output' },
  { pattern: '**/coverage/**', reason: 'generated coverage report' },
  { pattern: '**/__snapshots__/**', reason: 'generated snapshot' },
  { pattern: '**/*.min.js', reason: 'minified output' },
  { pattern: '**/*.map', reason: 'generated source map' },
  { pattern: '**/*.generated.*', reason: 'generated source' },
  { pattern: '**/*.tsbuildinfo', reason: 'generated build metadata' },
  { pattern: '**/*.lock', reason: 'generated lockfile' },
  { pattern: '**/pnpm-lock.yaml', reason: 'generated lockfile' },
  { pattern: '**/package-lock.json', reason: 'generated lockfile' },
]

/** One changed path, as the caller already knows it. */
export interface ScanCandidate {
  /**
   * Repository-relative path. Forward slashes and a leading `./` are both
   * accepted and normalized; absolute paths are the caller's business to
   * relativize, because only the caller knows the repository root.
   */
  readonly path: string
  /**
   * True when the change is a deletion.
   *
   * There is no content left to scan, so the path leaves the denominator — but
   * it stays in `decisions`, which is what lets a report show the whole change
   * set rather than only the part that survived it.
   */
  readonly deleted?: boolean
  /**
   * Size in bytes, or `undefined` when it could not be judged.
   *
   * `undefined` is a real answer and is treated as one — see the module header.
   * It is never read as `0`.
   */
  readonly bytes?: number
}

/** How a caller narrows the selection. */
export interface ScanSelectionOptions {
  /**
   * Exclusion rules, in order. The first one whose pattern matches supplies the
   * reported reason, so a caller with a more specific rule about a path puts it
   * before the broader one.
   */
  readonly exclude?: readonly ScanExcludeRule[]
  /**
   * Per-file ceiling in bytes; `0` disables the size gate entirely.
   *
   * Disabling it is a supported choice rather than a hole: the decisions still
   * carry every file's size, so a run that wants to price the whole change set
   * before deciding can do so and is not forced to guess here.
   */
  readonly maxFileBytes?: number
}

/** One candidate's outcome. */
export interface ScanDecision {
  readonly path: string
  readonly exclusion: ScanExclusion
  /** The rule's pattern, when a rule excluded it. */
  readonly pattern?: string
  /** The rule's reason, when a rule excluded it. */
  readonly reason?: string
  /** Size in bytes, when the gate judged it. */
  readonly bytes?: number
  /**
   * A display estimate from the shared token estimator, when bytes were known.
   *
   * The ceiling is on bytes, not on this number: bytes are what the caller can
   * actually measure, and the estimator is reused here so this module cannot become
   * a second place that prices text.
   *
   * Named for the unit mismatch it is: the estimator takes a *character* count and
   * is handed the byte count, because measuring characters would mean reading the
   * file and this module reads nothing. For UTF-8 bytes are never fewer than
   * characters, so the figure errs high — the safe direction for a number a reader
   * uses to judge how much a scan would read.
   */
  readonly tokens?: number
  /** True when the size gate could not judge this file, so it was not applied. */
  readonly sizeUnchecked?: boolean
}

/** The whole selection: every candidate's decision, plus the sealed denominator. */
export interface ScanSelection {
  /** One decision per candidate, in input order. */
  readonly decisions: readonly ScanDecision[]
  /**
   * The coverage denominator: the unique selected paths, in input order.
   *
   * Unique rather than one-per-decision, because git can name the same path
   * twice in workspace mode (a staged deletion followed by an untracked
   * recreation). There is one file on disk now, so there is one thing to account
   * for. {@link ScanSelection.counts} counts *decisions* and can therefore sum to
   * more than this list is long; that is the duplicate, not a discrepancy.
   */
  readonly selected: readonly string[]
  /** The decisions that leave the denominator, in input order. */
  readonly excluded: readonly ScanDecision[]
  /** How many decisions landed on each reason, including `none`. */
  readonly counts: Readonly<Record<ScanExclusion, number>>
  /** The ceiling the size gate used; `0` when the gate was disabled. */
  readonly maxFileBytes: number
}

/**
 * Decide what a scan covers.
 * @param candidates - the workspace's changed paths, as the caller knows them.
 * @param options - exclusion rules and the size ceiling.
 * @returns one decision per candidate in input order, the sealed denominator, and
 *   the per-reason counts. Never throws: a malformed candidate is decided, not
 *   rejected, so one bad entry cannot take the whole selection down.
 */
export function selectScanFiles(
  candidates: readonly ScanCandidate[],
  options: ScanSelectionOptions = {},
): ScanSelection {
  const rules = options.exclude ?? DEFAULT_SCAN_EXCLUDE_RULES
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SCAN_MAX_FILE_BYTES
  const decisions = candidates.map(candidate => decideScanFile(candidate, rules, maxFileBytes))
  // Written out rather than derived from SCAN_EXCLUSIONS so that adding a reason
  // without deciding how it counts is a type error instead of a silent zero.
  const counts: Record<ScanExclusion, number> = {
    none: 0,
    deleted: 0,
    credential: 0,
    'excluded-by-pattern': 0,
    'too-large': 0,
  }
  for (const decision of decisions) counts[decision.exclusion] += 1
  return {
    decisions,
    selected: [...new Set(decisions.filter(decision => decision.exclusion === 'none').map(decision => decision.path))],
    excluded: decisions.filter(decision => decision.exclusion !== 'none'),
    counts,
    maxFileBytes,
  }
}

/**
 * One candidate's decision, with the gates in the order they must run.
 *
 * The order is the substance of the function, so it is stated rather than
 * implied: a deletion has no content, a credential file must not be read at all,
 * a pattern names a path a finding could not be acted on, and only then is size
 * worth asking about.
 */
function decideScanFile(candidate: ScanCandidate, rules: readonly ScanExcludeRule[], maxFileBytes: number): ScanDecision {
  const path = normalizeScanPath(candidate.path)
  if (candidate.deleted === true) return { path, exclusion: 'deleted' }
  // Before the pattern rules on purpose: a credential file that also matches
  // `**/vendor/**` is reported as a credential, because that is the reason that
  // explains why nobody looked at it.
  if (isCredentialPath(path)) return { path, exclusion: 'credential' }
  for (const rule of rules) {
    // Matched twice, and the second test is the one this module used to be missing.
    // `matchesGlob` gives a wildcard no way to match a dot-named segment — `*` and
    // `**` both refuse one, at any depth — so every pattern in the default table
    // silently missed the paths under a hidden directory: `node_modules/.bin/vite`
    // stayed in the denominator, `dist/.staging/chunk.js` was priced as source, and
    // `src/.hidden/app.min.js` was not recognized as minified output. The table's own
    // spec never showed it, because every sample it fed in has undotted segments.
    //
    // Fixed by reading both spellings rather than by rewriting thirteen patterns:
    // the path as it is, and the same path with a leading dot removed from each
    // segment. The first test is unchanged, so no rule can stop matching what it
    // matched before; the second only ever adds a match. That is the right reading of
    // the table, because every pattern in it names a directory or a suffix —
    // "installed dependency", "build output", "minified output" — and none of them
    // names hidden-ness. A caller's own table gets the same treatment, and its own
    // dot-patterns keep working, because the unprojected path is still tried first.
    if (matchesGlob(path, rule.pattern) || matchesGlob(withoutHiddenSegments(path), rule.pattern)) {
      return { path, exclusion: 'excluded-by-pattern', pattern: rule.pattern, reason: rule.reason }
    }
  }
  if (candidate.bytes === undefined) {
    // Selected and flagged, never dropped: "not measured" and "small" are
    // different answers and only one of them is a reason to look away.
    return { path, exclusion: 'none', sizeUnchecked: true }
  }
  const priced = { bytes: candidate.bytes, tokens: tokensFromChars(candidate.bytes) }
  if (maxFileBytes > 0 && candidate.bytes > maxFileBytes) return { path, exclusion: 'too-large', ...priced }
  return { path, exclusion: 'none', ...priced }
}

/**
 * Forward slashes, and no leading `./`.
 *
 * `matchesGlob` accepts either separator, but a report that spells the same file
 * two ways depending on the platform is one a reader has to translate, and every
 * pattern in {@link DEFAULT_SCAN_EXCLUDE_RULES} is written with forward slashes.
 */
function normalizeScanPath(path: string): string {
  const slashed = path.replaceAll('\\', '/')
  return slashed.startsWith('./') ? slashed.slice(2) : slashed
}

/**
 * The same path with a leading dot removed from every segment.
 *
 * A second spelling to match a rule against, not a rewrite of the path: the
 * reported decision still carries the path as it is. Its one limit is worth
 * stating — a *file* whose own name starts with a dot (`.tsbuildinfo`) is read as
 * `tsbuildinfo`, so the table's own tsbuildinfo rule, which names the dot in its
 * last segment, matches a sibling `tsconfig.tsbuildinfo` and not that file.
 * Directories are the case this exists for, and no file in the default table is
 * spelled with a leading dot.
 *
 * @param path - a normalized, repository-relative path.
 * @returns the same path with dot-named segments un-dotted.
 */
function withoutHiddenSegments(path: string): string {
  return path.split('/').map(segment => (segment.startsWith('.') ? segment.slice(1) : segment)).join('/')
}
