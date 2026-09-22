/**
 * Bounded, project-declared verification runner plus the adversarial-probe
 * contract for `engineering_team_verify`, the name this plugin registers it under.
 *
 * Two rules from Claude Code's verification protocol are enforced here rather
 * than left to a reader's judgement:
 *
 * 1. **A stage result is evidence, not a claim.** Every passing stage carries
 *    the command that ran and the exit status it returned (`command` +
 *    `exitCode`); a stage that could not run says `skipped`/`unavailable` and is
 *    never counted as a pass. "Tests are context, not evidence — the thing that
 *    wrote the code is also an LLM."
 * 2. **Green declared stages are not sufficient.** A verification is only
 *    `verified` when at least one adversarial probe ran and held its
 *    expectation. A probe is an independent check authored against the change
 *    (a boundary, a concurrency case, an idempotency re-run, an orphaned
 *    operation) whose expectation is declared *before* it runs.
 *
 * The verdict is computed here so "all green" stops being an inference. See
 * {@link summarizeEngineeringVerification}.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { COMPILED_BUILT_IN_COMMAND_POLICY, commandPolicyDenial, type CompiledCommandPolicy } from './command-policy.ts'
import { childProcessEnvironment } from './engineering-graphify.ts'
import { classifyVerificationCommand, exitStatusIsAttributable } from './verification-evidence.ts'
import type { FreeCodeGoEngineeringVerificationStage } from './types.ts'

/**
 * Internal alias of the public union.
 *
 * A second hand-written union was the reason a stage could exist in one half of
 * the system and not the other: this one is declared against the public type, so
 * the two cannot drift. `scriptForStage` below is typed with it as a total record,
 * which is what makes "a new stage fails to compile until it can be run" true.
 */
export type EngineeringVerificationStage = FreeCodeGoEngineeringVerificationStage

/** Observed state of one process this module ran. */
type ProcessState = 'pass' | 'fail' | 'skipped' | 'unavailable' | 'cancelled' | 'refused'

/** One declared stage's result, carrying the evidence it rests on. */
export type EngineeringVerificationStageResult = {
  readonly id: EngineeringVerificationStage
  readonly state: ProcessState
  readonly command?: readonly string[]
  /** Exit status of `command`. Absent exactly when nothing ran, which is what
   * makes a pass with no command detectable instead of merely suspicious. */
  readonly exitCode?: number
  readonly durationMs: number
  /** The observed output tail. Empty output is a legitimate observation (a
   * silent `tsc` success prints nothing); a missing command is not. */
  readonly summary: string
}

/**
 * One adversarial probe: an independent check the verifier declares before it
 * runs, whose expectation is inspectable afterwards.
 */
export type EngineeringVerificationProbe = {
  readonly id: string
  readonly command: readonly string[]
  /** Whether the command is expected to succeed or to fail. `fail` is the
   * interesting half: a guard that never fires is indistinguishable from a
   * guard that was never wired up. */
  readonly expectation: 'pass' | 'fail'
  /** What breakage this probe would catch. Required, because a probe nobody can
   * explain is a probe nobody can check. */
  readonly rationale: string
}

/** One probe's outcome, paired with the probe it was declared as. */
export type EngineeringVerificationProbeResult = EngineeringVerificationProbe & {
  readonly state: ProcessState
  readonly exitCode?: number
  readonly durationMs: number
  readonly summary: string
  /** Whether the observed exit status matched the declared expectation. */
  readonly held: boolean
}

/**
 * `verified` requires every declared stage to pass *and* at least one probe to
 * have held. `failed` means something observed contradicted its expectation — a
 * failed stage, or a probe that did not hold. `unverified` means the run was
 * incomplete or unfalsified: stages skipped, a probe refused, nothing ran at
 * all, or no probe was offered.
 */
export type EngineeringVerificationVerdict = 'verified' | 'unverified' | 'failed'

/** Everything one verification run observed, and the verdict it reached. */
export type EngineeringVerificationResult = {
  readonly cwd: string
  readonly stages: readonly EngineeringVerificationStageResult[]
  readonly probes: readonly EngineeringVerificationProbeResult[]
  readonly verdict: EngineeringVerificationVerdict
  /** Every reason the verdict is not `verified`, in a stable order. */
  readonly unmet: readonly string[]
}

const OUTPUT_LIMIT = 16_000
const STAGE_TIMEOUT_MS = 5 * 60_000
const STATUS_TIMEOUT_MS = 10_000
/** Network fetches and publishes: the two families with no reading of their own. */
const UNSAFE_SCRIPT_PATTERN = /(?:\bcurl\b|\bwget\b|invoke-webrequest|invoke-restmethod|\bgit\b(?:\s+-C\s+\S+|\s+-c\s+\S+|\s+--git-dir=\S+|\s+--work-tree=\S+|\s+--no-pager)*\s+push\b|\b(?:npm|pnpm|yarn|bun)\s+publish\b)/i

/**
 * Destructive deletes, in the spelling the caller actually wrote.
 *
 * Matching only `rm -rf` is how a verification step gets to delete a workspace:
 * `rm -fr`, `rm -r -f`, `rm -Rf`, and `rm --recursive --force` are the same
 * command, and `rmdir /s`/`rd /s`/`del /s` are its Windows spellings — the flag
 * matching in `command-policy.ts` had to be widened for exactly this reason.
 *
 * The Windows spellings do not stop at `cmd`. A declared script runs under
 * whichever shell the project uses, and PowerShell names the same operation with
 * its own verb — `Remove-Item -Recurse -Force` — while `erase` is `del`'s other
 * name in `cmd`. The network half of this control already carried
 * `invoke-webrequest`/`invoke-restmethod`, so leaving these out was an omission
 * rather than a decision about PowerShell; `Remove-Item -Recurse -Force build`
 * was judged a safe verification script, which is the whole failure this pattern
 * exists to refuse.
 *
 * The **recursive** flag is what makes a delete destructive, so it is the flag
 * and not the verb that is required: `rm -f ./tmp.txt` removes one named file
 * and stays allowed, which is what keeps this control from turning every real
 * project's verification into a refusal.
 */
const UNSAFE_DELETE_VERBS = '\\brm\\b|\\brmdir\\b|\\brd\\b|\\bdel\\b|\\berase\\b|\\bremove-item\\b'
const UNSAFE_DELETE_TAIL = '[^\\n;&|]*(?:-[a-z]*r[a-z]*\\b|--recursive\\b|\\/s\\b)'
// Split across three lines rather than written as one literal: the two verbs
// added above pushed the single-line form past the `max-len` budget, and a
// regex the linter wants reflowed is a regex somebody reflows by hand.
const UNSAFE_DELETE_PATTERN = new RegExp(`(?:${UNSAFE_DELETE_VERBS})${UNSAFE_DELETE_TAIL}`, 'i')

/**
 * The command-policy denial for one probe's argv, or `undefined` to let it run.
 *
 * A probe's argv is judged here rather than by the tool guard because the two
 * transports differ: the guard's `bashCommandOf` reads a *command line* out of a
 * shell tool's arguments, and a probe carries an argv that is spawned without a
 * shell. Reusing `commandPolicyDenial` — the same function the `bash` guard
 * calls — is what keeps one rule from becoming two, and its contract (only
 * `forbidden` is a denial) is the right one here for the same reason it is right
 * there: a probe has nowhere to ask, but the built-in policy's `forbidden`
 * family is the destructive set, and everything it merely prompts about is
 * judged by the probe's own declared expectation.
 *
 * Exported so the tool boundary can check the model's argv against the
 * repository's own policy before the run starts: the job runner has no policy
 * source, and a refusal the model can read and correct is worth more than one
 * recorded inside a verdict it has to parse.
 *
 * @param command - the probe's argv, program first.
 * @param policy - the repository's compiled policy, when the caller has one.
 * @returns the denial text, or undefined when the argv may run.
 */
export function probeCommandDenial(command: readonly string[], policy?: CompiledCommandPolicy): string | undefined {
  // Joined with spaces because `commandPolicyDenial` parses a command line, and
  // the program — the token every destructive rule is anchored at — is argv[0]
  // in either reading. An argv whose *argument* happens to contain a separator
  // can therefore be judged as two commands and refused for a command it would
  // not run; that is the fail-closed direction, and probes spawn without a shell,
  // so nothing here can compose.
  const line = command.join(' ')
  return commandPolicyDenial(COMPILED_BUILT_IN_COMMAND_POLICY, line) ?? (policy === undefined ? undefined : commandPolicyDenial(policy, line))
}

/** Run one verification: the declared stages, then the independent probes.
 * @param input - the workspace, stages, probes, and cancellation signal.
 * @returns the verification result and verdict.
 */
export async function runEngineeringVerification(input: {
  readonly cwd: string
  readonly stages?: readonly EngineeringVerificationStage[]
  /** Independent checks the caller declares before any of them runs. */
  readonly probes?: readonly EngineeringVerificationProbe[]
  readonly signal?: AbortSignal
  /**
   * Fewer probes than this leaves the run `unverified`.
   *
   * The caller is the tier plan: a `thorough` change is supposed to be falsified
   * twice, and a plan that says "2" while the runner accepts 1 would leave that
   * number decoration. Only a caller that knows the floor for its own scope sets
   * it, so the default stays the global rule: one probe, or unverified.
   */
  readonly minProbes?: number
  /** Permit declared scripts to leave a workspace diff; defaults to false. */
  readonly allowWorkspaceChanges?: boolean
  /**
   * The repository's own command policy, applied to probe argv on top of the
   * built-in one. Never instead of it: a project rule may add a denial.
   */
  readonly policy?: CompiledCommandPolicy
}): Promise<EngineeringVerificationResult> {
  const requested = input.stages === undefined || input.stages.length === 0
    ? ['scope'] as const
    : [...new Set(input.stages)]
  const packageInfo = await readPackageInfo(input.cwd)
  const results: EngineeringVerificationStageResult[] = []
  for (const stage of requested) {
    if (input.signal?.aborted) {
      results.push({ id: stage, state: 'cancelled' as const, durationMs: 0, summary: 'Verification was cancelled before this stage started.' })
      continue
    }
    if (stage === 'scope') {
      results.push(await runStage(input.cwd, ['git', 'diff', '--name-only'], stage, input.signal))
      continue
    }
    const script = scriptForStage(stage, packageInfo?.scripts)
    if (script === undefined) {
      results.push({ id: stage, state: packageInfo === undefined ? 'unavailable' as const : 'skipped' as const, durationMs: 0, summary: packageInfo === undefined ? 'No package.json was found for this workspace.' : `No declared ${stage} script was found.` })
      continue
    }
    const scriptCommand = packageInfo?.scripts[script]
    if (scriptCommand !== undefined && isUnsafeVerificationScript(scriptCommand)) {
      results.push({ id: stage, state: 'refused' as const, command: [...packageManager(input.cwd), 'run', script], durationMs: 0, summary: 'The declared verification script contains a blocked network, publish, or destructive command.' })
      continue
    }
    // A content revision, not a status digest: a stage that rewrites a file the
    // tree had *already* modified changes no path and no status letter, so the
    // status set could not tell "this check left the tree alone" from "this check
    // rewrote an already-dirty file" — and the pass was counted as evidence about
    // a tree the check had just changed. Cost is accepted here and paid only on a
    // dirty tree, in a run that already spawns a build.
    const before = input.allowWorkspaceChanges === true ? undefined : await readWorkspaceRevision(input.cwd)
    const result = await runStage(input.cwd, [...packageManager(input.cwd), 'run', script], stage, input.signal)
    const after = input.allowWorkspaceChanges === true ? undefined : await readWorkspaceRevision(input.cwd)
    if (before !== undefined && after !== undefined && before !== after && result.state === 'pass') {
      results.push({ ...result, state: 'fail', summary: `${result.summary}\nVerification changed workspace files; changes are not allowed by default.` })
    } else {
      results.push(result)
    }
  }
  const probes = await runEngineeringProbes({
    cwd: input.cwd,
    probes: input.probes ?? [],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  })
  const { verdict, unmet } = summarizeEngineeringVerification({
    stages: results,
    probes,
    ...(input.minProbes === undefined ? {} : { minProbes: input.minProbes }),
    workspaceRoot: input.cwd,
  })
  return { cwd: input.cwd, stages: results, probes, verdict, unmet }
}

/** Most probes one verification will accept; more is a sign of a script, not a check. */
export const MAX_ENGINEERING_VERIFICATION_PROBES = 5

/**
 * Coerce untrusted tool input into probes, dropping anything unusable.
 *
 * Lengths are bounded because probe text reaches the durable audit record and
 * the settings page, and a dropping (not throwing) policy because one malformed
 * probe must not void the three well-formed ones beside it: a dropped entry is
 * visible as a missing probe, whereas a refusal would look like a contract bug.
 *
 * @param input - the raw `probes` argument from a tool call.
 * @returns the accepted probes, in the order given.
 */
export function normalizeEngineeringProbes(input: unknown): readonly EngineeringVerificationProbe[] {
  if (!Array.isArray(input)) return []
  const probes: EngineeringVerificationProbe[] = []
  for (const entry of input.slice(0, MAX_ENGINEERING_VERIFICATION_PROBES)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const candidate = entry as { readonly id?: unknown; readonly command?: unknown; readonly expectation?: unknown; readonly rationale?: unknown }
    const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 120) : ''
    const rationale = typeof candidate.rationale === 'string' ? candidate.rationale.trim().slice(0, 1_000) : ''
    // Empty arguments are preserved, not dropped: `git commit -m ""` and
    // `git commit -m` are different commands, and a normalizer that silently
    // rewrites the caller's argv is how a probe ends up testing something else.
    const parts = Array.isArray(candidate.command)
      ? candidate.command.slice(0, 32).map(part => typeof part === 'string' ? part.slice(0, 500) : undefined)
      : []
    const program = parts[0]
    if (id === '' || rationale === '' || parts.length === 0 || parts.some(part => part === undefined) || program === undefined || program.trim() === '') continue
    probes.push({ id, command: parts as readonly string[], expectation: candidate.expectation === 'fail' ? 'fail' : 'pass', rationale })
  }
  return probes
}

/**
 * Run each declared probe and record whether it did what it was declared to do.
 *
 * A probe is model-authored, so the controls are explicit and all fail closed:
 * an empty command, a command matching the blocked-script families (network,
 * publish, destructive delete), a command the command policy forbids, or a
 * missing expectation is recorded as `refused` with `held: false`, which forces
 * the whole verdict to `failed` rather than quietly dropping the check. Commands spawn without a shell, so
 * shell metacharacters are inert arguments rather than composition, and the
 * workspace's content is revised on both sides of each probe so a check that mutates the tree
 * cannot also be the evidence that the tree is fine.
 * @param input - the workspace, probes, signal, and optional project policy.
 * @returns the engineering Verification Probe Result rows, in backend order.
 */
export async function runEngineeringProbes(input: {
  readonly cwd: string
  readonly probes: readonly EngineeringVerificationProbe[]
  readonly signal?: AbortSignal
  /** The repository's compiled command policy, added to the built-in one. */
  readonly policy?: CompiledCommandPolicy
}): Promise<readonly EngineeringVerificationProbeResult[]> {
  const results: EngineeringVerificationProbeResult[] = []
  for (const probe of input.probes) {
    const declared = {
      id: typeof probe.id === 'string' ? probe.id.trim() : '',
      command: Array.isArray(probe.command) ? probe.command.map(part => typeof part === 'string' ? part : '') : [],
      expectation: probe.expectation === 'fail' ? 'fail' as const : 'pass' as const,
      rationale: typeof probe.rationale === 'string' ? probe.rationale.trim() : '',
    }
    const refuse = (reason: string): void => {
      results.push({ ...declared, state: 'refused', durationMs: 0, summary: reason, held: false })
    }
    if (declared.id === '' || declared.command.length === 0 || (declared.command[0] ?? '').trim() === '' || declared.rationale === '') {
      refuse('Probe needs a non-empty id, program, and rationale; it was not run.')
      continue
    }
    if (isUnsafeVerificationScript(declared.command.join(' '))) {
      refuse('Probe command contains a blocked network, publish, or destructive operation; it was not run.')
      continue
    }
    // The command policy, at the point of spawning rather than only at the tool
    // boundary: this function is exported, so the next caller that assembles an
    // argv from anything less trustworthy than the model's own tool call reaches
    // the same refusal. See `probeCommandDenial`.
    const forbidden = probeCommandDenial(declared.command, input.policy)
    if (forbidden !== undefined) {
      refuse(`${forbidden} The probe was not run.`)
      continue
    }
    if (input.signal?.aborted === true) {
      results.push({ ...declared, state: 'cancelled', durationMs: 0, summary: 'Verification was cancelled before this probe started.', held: false })
      continue
    }
    const before = await readWorkspaceRevision(input.cwd)
    const outcome = await runProcess(input.cwd, declared.command, input.signal)
    const after = await readWorkspaceRevision(input.cwd)
    const mutated = before !== undefined && after !== undefined && before !== after
    // `held` compares the *observed* exit status against the declaration, which
    // is what makes an `expectation: 'fail'` probe falsifiable: a guard that
    // stops firing turns this into a failure of the run, not a silent pass.
    const observedPass = outcome.state === 'pass'
    // Whether the probe actually produced an exit status to compare against.
    const ran = outcome.state === 'pass' || outcome.state === 'fail'
    const held = ran && !mutated && observedPass === (declared.expectation === 'pass')
    // A probe that never ran — a program that is not installed, a signal that
    // arrived first — observed nothing, so it keeps the state `runProcess` saw.
    // Folding it into `fail` made "the caller cancelled mid-probe" read as
    // "verification FAILED", which is the overreach the stage rule already
    // refuses and which `engineering-jobs.ts` reads as a cancellation signal.
    const state: ProcessState = ran ? (held ? 'pass' : 'fail') : outcome.state
    results.push({
      ...declared,
      state,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      durationMs: outcome.durationMs,
      summary: mutated
        ? `${outcome.summary}\nThe probe changed workspace files, so it cannot be evidence that the workspace is correct.`
        : outcome.state === 'unavailable' || outcome.state === 'cancelled'
          ? outcome.summary
          : `${outcome.summary}\nExpected the command to ${declared.expectation === 'pass' ? 'succeed' : 'fail'}; it ${observedPass ? 'succeeded' : 'failed'}.`,
      held,
    })
  }
  return results
}

/**
 * Turn recorded evidence into a verdict.
 *
 * Kept pure and exported so the rule can be tested directly instead of only
 * through a real process run — the rule is the part that must not drift.
 *
 * @param input - the stage and probe results of one verification run.
 * @returns the verdict and every reason it is not `verified`.
 */
export function summarizeEngineeringVerification(input: {
  readonly stages: readonly EngineeringVerificationStageResult[]
  readonly probes: readonly EngineeringVerificationProbeResult[]
  /** Floor on the number of probes that ran; fewer leaves the run `unverified`. */
  readonly minProbes?: number
  /**
   * The workspace the run happened in, when the caller knows it.
   *
   * It only sharpens the evidence reading below — whether an interpreter's
   * script argument is a file this workspace owns. Absent, that question is
   * answered as unstated rather than guessed at.
   */
  readonly workspaceRoot?: string
}): { readonly verdict: EngineeringVerificationVerdict; readonly unmet: readonly string[] } {
  const contradicted: string[] = []
  const incomplete: string[] = []
  for (const stage of input.stages) {
    if (stage.state === 'fail') contradicted.push(`Stage "${stage.id}" failed.`)
    // Cancellation is incomplete, not contradicted. A run somebody stopped did
    // not observe anything about the change, and calling it `failed` asserts a
    // verdict against the code that nobody reached — the class of overreach this
    // verdict taxonomy exists to prevent. `unverified` is the honest reading, and
    // the job store already records the run itself as cancelled.
    else if (stage.state === 'cancelled') incomplete.push(`Stage "${stage.id}" was cancelled before it finished, so it established nothing.`)
    else if (stage.state === 'refused') contradicted.push(`Stage "${stage.id}" was refused as unsafe.`)
    else if (stage.state === 'skipped') incomplete.push(`Stage "${stage.id}" did not run: no declared script for it.`)
    else if (stage.state === 'unavailable') incomplete.push(`Stage "${stage.id}" could not run: ${stage.summary}`)
    else if (stage.command === undefined || stage.exitCode === undefined) contradicted.push(`Stage "${stage.id}" passed without a recorded command and exit status.`)
    // A record can also disagree with *itself*, and that is the half this function
    // used to wave through. Note which way the asymmetry ran: a **missing** field was
    // refused above, while a **conflicting** one was accepted — so the weaker record
    // was the safer one to submit. These fields are persisted and replayed (that is
    // why `fake-green-audit.ts` exists at all), so a `pass` shipped beside a non-zero
    // status is read as a failure of the record, not as a pass on someone's word.
    else if (stage.exitCode !== 0) contradicted.push(`Stage "${stage.id}" says it passed but recorded exit status ${stage.exitCode}, so the record contradicts itself.`)
    else if (stage.id !== 'scope') {
      // `scope` is the change record itself, not a check — `verification-tier.ts`
      // includes it in every tier for exactly that reason — so it is the one
      // stage whose command is expected not to be a verification.
      const reading = readCommandEvidence(stage.command, input.workspaceRoot)
      if (reading !== undefined) incomplete.push(`Stage "${stage.id}" ${reading}`)
    }
  }
  for (const probe of input.probes) {
    if (probe.state === 'refused') contradicted.push(`Probe "${probe.id}" was refused: ${probe.summary}`)
    else if (probe.state === 'cancelled') incomplete.push(`Probe "${probe.id}" was cancelled before it finished, so it established nothing.`)
    else if (probe.state === 'unavailable') incomplete.push(`Probe "${probe.id}" could not run: ${probe.summary}`)
    else if (!probe.held) contradicted.push(`Probe "${probe.id}" did not hold its expectation (${probe.rationale}).`)
    else {
      // The same self-disagreement rule as the stage above, read against the
      // probe's own declaration: `held` claims the observed status matched the
      // expectation, so a status that says otherwise makes the record incoherent.
      //
      // An *absent* status is deliberately not a contradiction here, unlike the stage
      // rule: `held` is true for an `expectation: 'fail'` probe whose program was
      // killed by a signal (it did fail, which is what was declared), and that run
      // records no exit code. Refusing it would turn a legitimate falsification into
      // a `failed` verdict — the report lying about the run instead of about itself.
      const expectedZero = probe.expectation === 'pass'
      if (probe.exitCode !== undefined && (probe.exitCode === 0) !== expectedZero) {
        contradicted.push(`Probe "${probe.id}" held, but its exit status ${probe.exitCode} contradicts its declared expectation (${probe.expectation}).`)
      }
      // A probe that held is only evidence if its command could have contradicted
      // it. `node -e "process.exit(0)"` holds every expectation it is handed, so
      // without this check the cheapest way to reach `verified` was a probe whose
      // program cannot fail — the run would claim a falsification that was never
      // available to it.
      const reading = readCommandEvidence(probe.command, input.workspaceRoot)
      if (reading !== undefined) incomplete.push(`Probe "${probe.id}" ${reading}`)
    }
  }
  // Green declared stages say the project's own gates still pass. They say
  // nothing about the new failure mode the change introduced, which is what a
  // probe exists to falsify.
  if (input.probes.length === 0) incomplete.push('No adversarial probe ran, so nothing about the change was independently falsified.')
  // A tier that declares how many probes it needs is a scope claim, so running
  // fewer than it promised has to leave the run unverified rather than pass at a
  // scope nobody applied.
  else if (input.minProbes !== undefined && input.probes.length < input.minProbes) {
    incomplete.push(`This scope requires ${input.minProbes} independent probes and ${input.probes.length} ran, so the change was under-falsified.`)
  }
  if (input.stages.length === 0) incomplete.push('No verification stage was requested.')
  if (contradicted.length > 0) return { verdict: 'failed', unmet: [...contradicted, ...incomplete] }
  if (incomplete.length > 0) return { verdict: 'unverified', unmet: incomplete }
  return { verdict: 'verified', unmet: [] }
}

/**
 * Why a command is not evidence, or `undefined` when it is.
 *
 * Two questions, asked in the order the report reads best: whether the command
 * is a check at all, then whether the exit status it carried belongs to that
 * check rather than to a filter after it.
 *
 * @param command - the argv the run recorded.
 * @param workspaceRoot - the workspace, when the caller knows it.
 * @returns the reason this command established nothing, or `undefined`.
 */
function readCommandEvidence(command: readonly string[], workspaceRoot: string | undefined): string | undefined {
  const classified = classifyVerificationCommand(command, workspaceRoot)
  if (!classified.verification) {
    return `held, but ${classified.reason}, so it established nothing about the change.`
  }
  const attributed = exitStatusIsAttributable(command)
  if (!attributed.attribuable) {
    return `held, but ${attributed.reason}, so its exit status is not evidence that the check passed.`
  }
  return undefined
}

async function readPackageInfo(cwd: string): Promise<{ readonly scripts: Readonly<Record<string, string>> } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const scripts = (parsed as { scripts?: unknown }).scripts
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return { scripts: {} }
    return { scripts: Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')) }
  } catch { return undefined }
}

/**
 * Whether a project-declared verification script is allowed to run.
 *
 * Exported because it is a security control, and a control that can only be
 * exercised through a full verification run is a control nobody re-checks. The
 * three blocked families are network fetches, publishes, and destructive
 * deletes: a verification step is supposed to observe the workspace, not change
 * it or ship it.
 *
 * @param script - the declared script body from package.json.
 * @returns true when the script must be refused.
 */
export function isUnsafeVerificationScript(script: string): boolean {
  return UNSAFE_SCRIPT_PATTERN.test(script) || UNSAFE_DELETE_PATTERN.test(script)
}

/**
 * Resolve a verification stage to a declared package script.
 *
 * Exported because the alias list is a contract: a project that names its type
 * check `check:types` rather than `typecheck` silently stops being type-checked
 * if an alias is dropped, and nothing else in the system would report that.
 *
 * @param stage - the stage to satisfy, excluding `scope` which needs no script.
 * @param scripts - the workspace's declared scripts.
 * @returns the script name to run, or undefined when the project declares none.
 */
export function scriptForStage(stage: Exclude<EngineeringVerificationStage, 'scope'>, scripts: Readonly<Record<string, string>> | undefined): string | undefined {
  if (scripts === undefined) return undefined
  const candidates: Readonly<Record<Exclude<EngineeringVerificationStage, 'scope'>, readonly string[]>> = {
    build: ['build'],
    types: ['typecheck', 'check:types', 'types'],
    lint: ['lint'],
    tests: ['test', 'tests'],
  }
  return candidates[stage].find(candidate => scripts[candidate] !== undefined)
}

function packageManager(cwd: string): readonly string[] {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return ['pnpm']
  if (existsSync(join(cwd, 'yarn.lock'))) return ['yarn']
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return ['bun']
  return ['npm']
}

/** One spawned process's outcome, before it is attributed to a stage or probe. */
interface ProcessOutcome {
  readonly state: 'pass' | 'fail' | 'unavailable' | 'cancelled'
  readonly exitCode?: number
  readonly durationMs: number
  readonly summary: string
}

/**
 * Run one bounded process and report its exit status with an output tail.
 *
 * `exitCode` is recorded separately from `summary` on purpose: the exit status
 * is the machine-checkable half of the evidence contract, and a stage result
 * that carries one is trivially distinguishable from a stage that never ran.
 */
async function runProcess(cwd: string, command: readonly string[], signal: AbortSignal | undefined): Promise<ProcessOutcome> {
  const started = Date.now()
  if (signal?.aborted) return { state: 'cancelled', durationMs: 0, summary: 'Verification was cancelled.' }
  return new Promise((resolve) => {
    const invocation = commandForPlatform(command)
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childProcessEnvironment({ CI: '1', NO_COLOR: '1', FREECODEGO_ENGINEERING_VERIFY: '1', FREECODEGO_VERIFY_NETWORK: 'disabled' }),
      // Own process group on POSIX so the tree kill reaches build/test grandchildren.
      detached: process.platform !== 'win32',
    })
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer | string): void => { output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const cancel = (): void => { terminateProcessTree(child) }
    signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => { timedOut = true; terminateProcessTree(child) }, STAGE_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      resolve({ state: signal?.aborted ? 'cancelled' : 'unavailable', durationMs: Date.now() - started, summary: error.message })
    })
    // 'close' (not 'exit') so the piped output is fully drained before the summary.
    child.once('close', (code) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      const summary = timedOut ? `Verification stage exceeded the ${Math.round(STAGE_TIMEOUT_MS / 1000)} second timeout.` : output.trim().split(/\r?\n/u).filter(Boolean).slice(-12).join('\n') || `Process exited with code ${code ?? 1}.`
      resolve({
        state: signal?.aborted ? 'cancelled' : timedOut ? 'unavailable' : code === 0 ? 'pass' : 'fail',
        ...(code === null || code === undefined ? {} : { exitCode: code }),
        durationMs: Date.now() - started,
        summary,
      })
    })
  })
}

async function runStage(cwd: string, command: readonly string[], id: EngineeringVerificationStage, signal: AbortSignal | undefined): Promise<EngineeringVerificationStageResult> {
  const outcome = await runProcess(cwd, command, signal)
  return {
    id,
    state: outcome.state,
    command,
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    durationMs: outcome.durationMs,
    summary: outcome.summary,
  }
}

/** One changed path, with the facts a scan selection needs about it. */
export interface WorkspaceChangeEntry {
  /** Repository-relative path, as git spelled it. */
  readonly path: string
  /** The two porcelain status letters, e.g. `M `, `??`, `D `. */
  readonly status: string
  /** True when the file is gone, so there is no content left to scan. */
  readonly deleted: boolean
  /** True for a path git does not track yet. */
  readonly untracked: boolean
}

/** A workspace's uncommitted change size: the input to tier selection. */
export interface WorkspaceChangeScope {
  readonly changedPaths: readonly string[]
  readonly linesChanged: number
  /**
   * One entry per changed path, in the order git reported them.
   *
   * Separate from {@link WorkspaceChangeScope.changedPaths} rather than replacing
   * it, because the two answer different questions: that field answers *which*
   * files, and this one answers *what happened to each*. Scan selection has to ask
   * the second — a deletion has no content and must leave the scan's denominator —
   * and deriving it from a second `git status` read is how two answers to the first
   * question start to disagree.
   */
  readonly entries: readonly WorkspaceChangeEntry[]
}

/**
 * Cap on one untracked file we will read to size it.
 *
 * A new file is counted by its own length because it is exactly the case that
 * most deserves a real check, and a repository that happens to have generated a
 * large artefact must not turn that into an unbounded read.
 */
const UNTRACKED_SIZE_LIMIT_BYTES = 256 * 1024
/** Cap on a git read; past this the answer is "unknown", not a partial list. */
const GIT_OUTPUT_LIMIT = 4_000_000

/**
 * Size the workspace's uncommitted change, for proportional verification.
 *
 * `status --porcelain` — not `diff` — decides *what* changed, because an
 * untracked file is the case that matters most and it does not appear in a diff
 * until it is staged. `diff --numstat HEAD` then supplies line counts for the
 * tracked portion, and each untracked path contributes its own length, bounded.
 *
 * Returns `undefined` when git is unavailable or `cwd` is not a repository, so a
 * caller keeps its own stages rather than guessing at a change size it cannot
 * see. A partial answer would be worse than none: the whole point of the tier is
 * that an unknown shape is not quietly under-checked.
 * @param signal - aborts the request when the caller cancels.
 * @param cwd - working directory the command runs in.
 * @returns the workspace change scope, or `undefined` when git cannot answer.
 */
export async function readWorkspaceChangeScope(cwd: string, signal?: AbortSignal): Promise<WorkspaceChangeScope | undefined> {
  const status = await readGitOutput(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], signal)
  if (status === undefined) return undefined
  const changedPaths: string[] = []
  const untracked: string[] = []
  const entries: WorkspaceChangeEntry[] = []
  for (const line of status.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const entry = line.slice(3).trim()
    if (entry === '') continue
    // A rename is reported as `old -> new`. Only the destination exists now, and
    // counting both spellings would inflate the file count the tier reads.
    const raw = entry.includes(' -> ') ? entry.slice(entry.lastIndexOf(' -> ') + 4) : entry
    const path = unquoteGitPath(raw)
    const status = line.slice(0, 2)
    changedPaths.push(path)
    if (line.startsWith('??')) untracked.push(path)
    // `D` can sit in either column (staged `D `, unstaged ` D`), so both are
    // read. A deleted path is the one case where "changed" and "has content left"
    // disagree, and a caller deciding what to scan needs the difference.
    entries.push({ path, status, deleted: status.includes('D'), untracked: line.startsWith('??') })
  }
  let linesChanged = 0
  const numstat = await readGitOutput(cwd, ['diff', '--numstat', 'HEAD'], signal)
  if (numstat !== undefined) {
    for (const line of numstat.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      const [added, removed] = line.split('\t')
      // Binary files report `-` for both counts: changed, but not in lines.
      linesChanged += (added === undefined || added === '-' ? 0 : Number(added) || 0)
        + (removed === undefined || removed === '-' ? 0 : Number(removed) || 0)
    }
  }
  for (const path of untracked) linesChanged += await countFileLines(join(cwd, path))
  return { changedPaths, linesChanged, entries }
}

/** Per-file byte ceiling for the revision: larger untracked files contribute stat metadata only. */
const REVISION_FILE_MAX_BYTES = 1_000_000
/** Total byte ceiling across hashed untracked files; past it the rest fall back to metadata. */
const REVISION_TOTAL_MAX_BYTES = 32_000_000
/** Wall clock for one read of the revision, matching a status read's budget. */
const REVISION_TIMEOUT_MS = 10_000
const execFileAsync = promisify(execFile)

/**
 * A content-sensitive identity for the workspace's uncommitted state.
 *
 * {@link readWorkspaceChangeScope} answers *which* files changed and by how
 * much; this answers *whether the content is still the one somebody looked at*.
 * The two questions come apart exactly where evidence is at stake: re-editing a
 * file that was already modified changes no path and no status letter, so a
 * path-only identity cannot tell the revision a check measured from the next
 * one. The council's approval binding needs the content answer (a report whose
 * workspace has moved cannot be approved), and so does anything that treats a
 * passing check as evidence about the current tree.
 *
 * Three reads, all bounded: `HEAD`, the tracked diff (`--binary`, so a changed
 * binary is never invisible), and the untracked file list, whose content enters
 * the digest up to a per-file and a cumulative budget — larger, or
 * budget-exhausted, files contribute stat metadata instead, so a workspace full
 * of artifacts cannot balloon memory to the sum of its file sizes.
 *
 * @param cwd - the workspace, when the caller has one.
 * @returns a hex digest, or `undefined` when git cannot answer for this
 *   workspace — no repository, no `HEAD`, an oversized read. `undefined` is not
 *   "unchanged", and never a match: a caller that cannot compare revisions has
 *   no evidence that the tree is the one it measured.
 */
export async function readWorkspaceRevision(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd.trim() === '') return undefined
  try {
    // `HEAD` first, alone: a caller that reads the revision around every stage and
    // probe of a verification would otherwise spend three spawned processes per
    // boundary to learn "no repository here" in a workspace that simply is not
    // one — and on Windows each of those children holds the directory handle for
    // a moment after it exits. The two reads that follow are independent of each
    // other and still run together.
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: REVISION_TIMEOUT_MS, windowsHide: true })
    const [tracked, untracked] = await Promise.all([
      execFileAsync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], { cwd, timeout: REVISION_TIMEOUT_MS, windowsHide: true, maxBuffer: 4_000_000 }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, timeout: REVISION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1_000_000 }),
    ])
    const root = resolve(cwd)
    let remaining = REVISION_TOTAL_MAX_BYTES
    const untrackedPayload = await Promise.all(untracked.stdout.split('\0').filter(Boolean).slice(0, 1_000).map(async (file) => {
      const fullPath = resolve(root, file)
      if (fullPath !== root && !fullPath.startsWith(`${root}\\`) && !fullPath.startsWith(`${root}/`)) return `${file}:outside-workspace`
      try {
        const info = await stat(fullPath)
        if (info.isFile() && info.size <= REVISION_FILE_MAX_BYTES && info.size <= remaining) {
          remaining -= info.size
          return `${file}\0${(await readFile(fullPath)).toString('utf8')}`
        }
        return `${file}\0stat:${info.size}:${info.mtimeMs}`
      } catch { return `${file}:unreadable` }
    }))
    return createHash('sha256').update(head.stdout).update(tracked.stdout).update(untrackedPayload.join('\n')).digest('hex')
  } catch { return undefined }
}

/** Run git with a bounded, timeout-guarded read. `undefined` when it cannot answer. */
async function readGitOutput(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined
  return await new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    let overrun = false
    const timer = setTimeout(() => { terminateProcessTree(child); resolve(undefined) }, STATUS_TIMEOUT_MS)
    const cancel = (): void => { terminateProcessTree(child) }
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout?.on('data', (chunk) => {
      if (overrun) return
      output += String(chunk)
      if (output.length > GIT_OUTPUT_LIMIT) overrun = true
    })
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(undefined) })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      // A non-zero status means no usable list (not a repository, no HEAD yet);
      // an overrun means the answer is truncated, which is not an answer.
      resolve(code !== 0 || overrun ? undefined : output)
    })
  })
}

/** Lines in one untracked file, or 0 when it is unreadable or oversized. */
async function countFileLines(path: string): Promise<number> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > UNTRACKED_SIZE_LIMIT_BYTES) return 0
    const content = await readFile(path, 'utf8')
    if (content === '') return 0
    // A file that does not end in a newline still has a last line.
    return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  } catch { return 0 }
}

/** Porcelain C-quotes paths with special characters; the raw path is what we size. */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  return path.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
}

function commandForPlatform(command: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  const manager = command[0]
  if (process.platform !== 'win32' || (manager !== 'npm' && manager !== 'pnpm' && manager !== 'yarn' && manager !== 'bun')) {
    return { command: manager!, args: command.slice(1) }
  }
  // Windows cannot reliably spawn package-manager .cmd shims directly. Every
  // segment here is host-selected (not tool input), so cmd receives no model
  // supplied text while retaining npm/pnpm/yarn compatibility.
  return { command: process.env.ComSpec?.trim() || 'cmd.exe', args: ['/d', '/c', command.join(' ')] }
}

function terminateProcessTree(child: { kill(signal?: NodeJS.Signals | number): boolean; pid?: number | undefined }): void {
  if (child.pid === undefined) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => { child.kill() })
    return
  }
  // The child leads its own process group (spawned detached), so the signal
  // reaches npm/pnpm and their jest/tsc grandchildren.
  const pid = child.pid
  try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* group already exited */ }
  }, 2_000)
}
