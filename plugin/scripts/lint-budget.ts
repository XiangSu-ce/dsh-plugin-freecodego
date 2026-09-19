/**
 * Lint budget ratchet.
 *
 * The `packages/freecodego` tree carries a large, measured lint debt. Clearing it
 * is manual work, and a rule that only ever reports "red" cannot tell a new
 * offender from the backlog — which is how the same class of finding was
 * re-introduced three rounds in a row. This turns the backlog into a committed
 * budget: `scripts/lint-budget.baseline.json` records the count per rule and per
 * file, and this script fails only when a count **grows**.
 *
 * Counts move with the build-output state of `lib/`, because the type-aware rules
 * resolve workspace types through it. That is why the comparison is per rule and
 * per file rather than a single total: a rule that legitimately drops while
 * another rises is still visible, and a stale baseline is a one-line refresh
 * (`--write`) rather than a mystery.
 *
 * @module scripts/lint-budget
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const BASELINE_PATH = join(REPOSITORY_ROOT, 'scripts', 'lint-budget.baseline.json')
const OXLINT_CLI = join(REPOSITORY_ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint')
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024 * 1024

/** The committed budget: a total, a count per rule, and a count per file and rule. */
export interface LintBudget {
  readonly version: 1
  readonly generatedBy: string
  readonly total: number
  readonly rules: Readonly<Record<string, number>>
  readonly files: Readonly<Record<string, Readonly<Record<string, number>>>>
}

/** The subset of an Oxlint JSON diagnostic this budget depends on. */
export interface LintDiagnostic {
  readonly code?: string
  readonly filename?: string
  readonly labels?: readonly { readonly file?: string }[]
}

/** One rule whose count grew, with the files that account for the growth. */
export interface LintIncrease {
  readonly rule: string
  readonly baseline: number
  readonly current: number
  readonly files: readonly string[]
}

/** The path a diagnostic belongs to, preferring the labelled file over the message file. */
function diagnosticPath(diagnostic: LintDiagnostic): string {
  const labelled = diagnostic.labels?.[0]?.file
  return labelled ?? diagnostic.filename ?? '(unknown)'
}

/** Count diagnostics by rule and by file, sorted so the committed file is stable. */
export function aggregate(diagnostics: readonly LintDiagnostic[], generatedBy: string): LintBudget {
  const rules: Record<string, number> = {}
  const files: Record<string, Record<string, number>> = {}
  for (const diagnostic of diagnostics) {
    const rule = diagnostic.code ?? '(unknown)'
    const path = diagnosticPath(diagnostic).split('\\').join('/')
    rules[rule] = (rules[rule] ?? 0) + 1
    const perFile = files[path] ?? {}
    perFile[rule] = (perFile[rule] ?? 0) + 1
    files[path] = perFile
  }
  const byKey = <T>(source: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(source).sort(([left], [right]) => (left < right ? -1 : 1)))
  return {
    version: 1,
    generatedBy,
    total: diagnostics.length,
    rules: byKey(rules),
    files: byKey(Object.fromEntries(Object.entries(files).map(([path, counts]) => [path, byKey(counts)]))),
  }
}

/**
 * Rules that grew past the baseline.
 *
 * A rule absent from the baseline counts as growth from zero, so a newly enabled
 * rule cannot slip in under a total that happens to stay level.
 */
export function increases(baseline: LintBudget, current: LintBudget): readonly LintIncrease[] {
  const found: LintIncrease[] = []
  for (const [rule, count] of Object.entries(current.rules)) {
    const allowed = baseline.rules[rule] ?? 0
    if (count <= allowed) continue
    const files = Object.entries(current.files)
      .map(([path, counts]) => ({ path, grew: (counts[rule] ?? 0) - (baseline.files[path]?.[rule] ?? 0) }))
      .filter(entry => entry.grew > 0)
      .sort((left, right) => right.grew - left.grew || (left.path < right.path ? -1 : 1))
      .map(entry => `${entry.path} (+${entry.grew})`)
    found.push({ rule, baseline: allowed, current: count, files })
  }
  return found.sort((left, right) => right.current - right.baseline - (left.current - left.baseline))
}

/** Parse the JSON a `--format=json` run writes. */
export function diagnosticsFrom(raw: unknown): readonly LintDiagnostic[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { diagnostics?: unknown }).diagnostics)) {
    throw new Error('lint-budget: expected an Oxlint JSON report with a diagnostics array')
  }
  return (raw as { diagnostics: LintDiagnostic[] }).diagnostics
}

/** Run the repository lint and return the budget it reports. */
function measureLintBudget(): LintBudget {
  const result = spawnSync(process.execPath, [OXLINT_CLI, '--format=json', '.'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURED_OUTPUT_BYTES,
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`lint-budget: oxlint was killed by ${result.signal}`)
  return aggregate(diagnosticsFrom(JSON.parse(result.stdout)), 'npx oxlint --format=json --type-aware .')
}

function main(): void {
  const write = process.argv.includes('--write')
  const current = measureLintBudget()
  if (write) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`)
    process.stdout.write(`lint-budget: baseline refreshed at ${current.total} diagnostics\n`)
    return
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as LintBudget
  const grown = increases(baseline, current)
  if (grown.length === 0) {
    process.stdout.write(`lint-budget: ${current.total} diagnostics, no rule above its budget (${baseline.total} recorded)\n`)
    return
  }
  process.stderr.write(`lint-budget: ${grown.length} rule(s) above budget\n`)
  for (const increase of grown) {
    process.stderr.write(`  ${increase.rule}: ${increase.baseline} -> ${increase.current}\n`)
    for (const file of increase.files.slice(0, 5)) process.stderr.write(`      ${file}\n`)
  }
  process.stderr.write('Fix the new findings, or refresh deliberately with `npm run verify-lint-budget -- --write`.\n')
  process.exitCode = 1
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === resolve(import.meta.filename)) main()

/** The baseline path, exported so a spec can read the same file the CLI writes. */
export const lintBudgetBaselinePath = relative(REPOSITORY_ROOT, BASELINE_PATH)
