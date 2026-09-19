/**
 * The fake-green audit: does a verification claim actually cover this change?
 *
 * Why this is separate from the verdict
 * -------------------------------------
 * `verification-evidence.ts` answers a question *inside* one run — was there an
 * attributable probe, is the exit status the check's own, does the command
 * mention the change. `engineering-quality.ts` folds that into a verdict. What
 * neither can see is the claim's *reach*, because the answer changes after the
 * run ends: the workspace can be edited again, and a record that was true when
 * it was written becomes a green light for work it never saw.
 *
 * That is the failure this module exists for, and it is the reason the audit is
 * taken at the moment of asking rather than at the moment of running:
 *
 *   1. **The record can be about a different change.** A verification of
 *      yesterday's three files is not evidence about today's one file, and
 *      comparing the path sets is the only way to tell.
 *   2. **A skipped stage is not a pass.** `unavailable`, `refused` and
 *      `cancelled` all leave the question open, and a report that counts them as
 *      green is the same bug in a different costume.
 *   3. **Some paths can be named by nothing at all.** A command that mentions no
 *      changed path proves nothing about it. This is the plan's headline case:
 *      three files changed, one exercised, and the run still says verified.
 *
 * Every finding is a *statement about the evidence*, never about the code. The
 * audit cannot say a change is broken; it can only say the claim is thinner than
 * it looks, which is exactly the distinction that keeps it from being a second
 * verdict that can disagree with the first.
 *
 * @module @deepseek-ai/dsh-freecodego/harness-plugin/fake-green-audit
 */

import type { FreeCodeGoEngineeringFinding, FreeCodeGoEngineeringVerificationResult } from './types.ts'
import { classifyVerificationCommand, exitStatusIsAttributable, verificationCoversChange } from './verification-evidence.ts'

/** What the audit is asked, at the moment it is asked. */
export interface FakeGreenAuditInput {
  /**
   * The most recent verification recorded for this workspace.
   *
   * Absent is a real answer, not a missing input: it means the workspace changed
   * and nothing was run.
   */
  readonly verification?: FreeCodeGoEngineeringVerificationResult
  /**
   * Paths that run covered, as the caller recorded them when it ran.
   *
   * Kept by the caller because a verification result is a *report*, and the
   * change scope it was measured against is a separate fact that has to survive
   * it. Absent when the caller cannot say, which is reported as unstated rather
   * than assumed to match.
   */
  readonly verifiedPaths?: readonly string[]
  /** Paths the workspace has changed right now. */
  readonly changedPaths: readonly string[]
}

/** The audit's answer, in the doctor's own finding shape. */
export interface FakeGreenAudit {
  /**
   * Whether \"this change is verified\" survives.
   *
   * False when any finding is `high` or `critical`; warnings and infos are
   * reported without failing the claim, because a full-suite run genuinely
   * covers a change it does not name.
   */
  readonly holds: boolean
  /** Changed paths no stage command and no probe named. */
  readonly uncoveredPaths: readonly string[]
  readonly findings: readonly FreeCodeGoEngineeringFinding[]
}

/** Paths compared in the spelling the workspace reports, so two spellings meet. */
function comparablePaths(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.map(path => path.replace(/\\/gu, '/').replace(/^\.\//u, '').trim()).filter(path => path !== ''))
}

/**
 * Source-file suffixes, the only ones that scope a check.
 *
 * An explicit list rather than "has an extension": `npx tsc -p tsconfig.json`
 * names a config file, not the change, and treating that as a scoped run would
 * report every path as uncovered on a perfectly good type check.
 */
const SOURCE_FILE_SUFFIX = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|php|c|cc|cpp|h|hpp|swift|scala|ex|exs|sh|vue|svelte)$/u

/**
 * Whether a command is the project's whole gate rather than a run scoped to
 * something.
 *
 * The distinction is what makes `uncovered-paths` honest in both directions: a
 * gate covers every path *because it names none*, while `pnpm vitest run
 * src/a.test.ts` is a targeted run however it is spelled, and its silence about
 * `src/b.ts` is real information.
 */
/**
 * Flags whose value is the *next* token and names a configuration or output
 * artifact rather than the subject of the run.
 *
 * Only the unambiguous half is listed, and the direction of the remaining error is
 * deliberate: a flag that is absent from this table keeps its value, so the worst it
 * can cause is the false `uncovered-paths` below — an over-strict audit. Dropping a
 * value that was actually a positional argument would do the opposite and *hide* a
 * targeted run, which is the lie this audit exists to catch. `--root`/`--dir` are
 * excluded on those grounds: they scope a gate to a subproject, and "which paths did
 * this run really see" is not a question a lexical reader may answer either way.
 */
const PATH_VALUED_FLAGS: ReadonlySet<string> = new Set([
  '-p', '--project', '--tsconfig', '-c', '--config', '-o', '--output', '--outputFile',
  '--reporter', '--junit-output', '--coverage-directory', '--cache-dir',
])

/**
 * Whether a token names a path (so it scopes a run to something rather than
 * leaving it the whole project's gate).
 */
function namesAPath(token: string): boolean {
  return token.includes('/') || token.includes('\\') || SOURCE_FILE_SUFFIX.test(token)
}

/**
 * The tokens a command could read as arguments, with flags and their values gone.
 *
 * Two things had to be dropped here, and only one of them used to be. A `--flag`
 * spelled as its own token is not a path — `--coverage` would otherwise scope a
 * whole-project run — but a flag's *value* was left in the list and judged like a
 * positional argument, so `pnpm vitest run --reporter=junit
 * --outputFile=reports/junit.xml` was read as a run scoped to `reports/junit.xml`.
 * The audit then reported `uncovered-paths` at `severity: 'high'` for a suite that
 * had in fact run over everything: a **false accusation**, which costs the report
 * the credibility the real findings need in order to be read at all.
 * @param command - the argv the run recorded, program included.
 * @returns the remaining tokens.
 */
function positionalArguments(command: readonly string[]): readonly string[] {
  const tokens: string[] = []
  for (let index = 1; index < command.length; index += 1) {
    const raw = command[index]!
    // `--flag=value` is self-contained, so the `=` form is unambiguous: drop the
    // whole token, value included.
    if (/^-{1,2}[\w-]+=/u.test(raw)) continue
    if (/^-{1,2}[\w-]+$/u.test(raw)) {
      // A bare flag: not a path. Its value is only known to be a value for the
      // spellings above, and there it is dropped with it.
      if (PATH_VALUED_FLAGS.has(raw)) index += 1
      continue
    }
    tokens.push(raw)
  }
  return tokens
}

function isWholeProjectGate(command: readonly string[]): boolean {
  const kind = classifyVerificationCommand(command).kind
  if (kind !== 'tests' && kind !== 'types' && kind !== 'lint' && kind !== 'build') return false
  return !positionalArguments(command).some(namesAPath)
}

/**
 * Audit one verification claim against the workspace it is being used to
 * describe.
 *
 * @param input - the recorded run, the paths it covered, and the paths that are
 *   changed now.
 * @returns the findings, the paths nothing named, and whether the claim holds.
 */
export function auditVerificationClaim(input: FakeGreenAuditInput): FakeGreenAudit {
  const findings: FreeCodeGoEngineeringFinding[] = []
  const changed = comparablePaths(input.changedPaths)
  const verification = input.verification
  if (verification === undefined) {
    if (changed.size > 0) {
      findings.push({
        rule: 'no-verification',
        severity: 'warning',
        message: `${changed.size} path(s) changed with no verification recorded, so \"green\" describes nothing about this change.`,
      })
    }
    return { holds: true, uncoveredPaths: [...changed], findings }
  }
  const verdict = verification.verdict
  if (verdict !== 'verified') {
    findings.push({
      rule: 'verdict-not-verified',
      severity: 'high',
      message: verdict === undefined
        ? 'The recorded run predates the verdict field, so it cannot be read as verified.'
        : `The recorded run came back ${verdict.toUpperCase()}.`,
    })
  }
  const held = (verification.probes ?? []).filter(probe => probe.state === 'pass' && probe.held)
  if (held.length === 0) {
    findings.push({
      rule: 'no-probe',
      severity: 'high',
      message: 'No probe held in the recorded run, so the change was exercised by no counterexample.',
    })
  }
  // A stage that did not run leaves its question open. Named individually so the
  // reader knows which question, not that something somewhere was skipped.
  for (const stage of verification.stages) {
    if (stage.state === 'pass') continue
    const severity = stage.state === 'skipped' ? 'warning' : 'high'
    findings.push({
      rule: 'stage-not-pass',
      severity,
      message: `Stage ${stage.id} finished ${stage.state.toUpperCase()}${stage.state === 'skipped' ? ', and a skipped stage is not a pass' : ''}: ${stage.summary}`,
      location: stage.id,
    })
  }
  // A command whose status came from a pipeline tail reports the tail's status.
  for (const stage of verification.stages) {
    const command = stage.command
    if (command === undefined || stage.state !== 'pass') continue
    const attribution = exitStatusIsAttributable(command)
    if (attribution.attribuable) continue
    findings.push({
      rule: 'unattributable-status',
      severity: 'high',
      message: `Stage ${stage.id} passed on an exit status that is not the check's own: ${attribution.reason}`,
      location: stage.id,
    })
  }
  if (input.verifiedPaths !== undefined) {
    const verified = comparablePaths(input.verifiedPaths)
    const added = [...changed].filter(path => !verified.has(path))
    const removed = [...verified].filter(path => !changed.has(path))
    if (added.length > 0 || removed.length > 0) {
      findings.push({
        rule: 'changed-since-verification',
        severity: 'high',
        message: `The record covers a different change set than the workspace has now (${added.length} path(s) changed since, ${removed.length} no longer changed).`,
      })
    }
  }
  // The headline check: a path is covered by a *command that names it*. The
  // classification pass decides whether the command is a check at all and
  // whether it targets what changed, so a whole-suite gate counts as a suite
  // rather than as an omission — it is a superset, not a gap.
  const commands = verification.stages
    .map(stage => stage.command)
    .filter((command): command is readonly string[] => command !== undefined)
  // A whole-project gate is a superset of any one change, so its presence
  // answers every path at once — computed once rather than per path.
  const gateRan = commands.some(isWholeProjectGate)
  const uncovered: string[] = []
  for (const path of changed) {
    // A whole-project gate answers every path at once.
    if (gateRan) continue
    // Otherwise the path is covered only when some command targets it — read
    // through the spellings a literal comparison cannot see, like a test file
    // that names its subject by infix. A command that merely *mentions* the path
    // (a `cat`, a log line) is deliberately not coverage: reading a file is not
    // verifying it.
    if (commands.some(command => verificationCoversChange(command, [path]) === 'targeted')) continue
    uncovered.push(path)
  }
  if (uncovered.length > 0) {
    findings.push({
      rule: 'uncovered-paths',
      severity: 'high',
      message: `${uncovered.length} changed path(s) were named by no stage and no probe and no whole-project gate ran: ${uncovered.slice(0, 5).join(', ')}${uncovered.length > 5 ? ` and ${uncovered.length - 5} more` : ''}.`,
    })
  }
  return { holds: !findings.some(finding => finding.severity === 'high' || finding.severity === 'critical'), uncoveredPaths: uncovered, findings }
}
