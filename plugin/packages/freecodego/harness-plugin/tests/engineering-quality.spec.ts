import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isUnsafeVerificationScript,
  normalizeEngineeringProbes,
  runEngineeringProbes,
  runEngineeringVerification,
  summarizeEngineeringVerification,
  type EngineeringVerificationProbeResult,
  type EngineeringVerificationStageResult,
} from '../src/engineering-quality.ts'
import { compileCommandPolicy } from '../src/command-policy.ts'
import { omitRecordKeys } from '../src/record-utils.ts'

const directories: string[] = []
// `maxRetries`/`retryDelay` for the same reason `engineering-eval`'s fixtures carry
// them: the verification stages below spawn a process in the directory, and on
// Windows that process's handle outlives the await that saw it exit — a bare
// `rm` then fails the whole test with `EBUSY: rmdir` after its assertions passed.
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }))) })

async function fixture(scripts: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-quality-'))
  directories.push(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
  return directory
}

const execFileAsync = promisify(execFile)

/**
 * A fixture that is a real repository with one committed file.
 *
 * The mutation control reads the workspace's content, so the case it exists for
 * can only be stated against a repository: `git status` is what a `mkdir` fixture
 * cannot answer, and the bug below is invisible without it.
 */
async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-mutation-'))
  directories.push(directory)
  const git = (args: readonly string[]): Promise<unknown> => execFileAsync('git', [...args], { cwd: directory })
  await git(['init'])
  await git(['config', 'user.email', 'fixture@example.test'])
  await git(['config', 'user.name', 'Fixture'])
  await writeFile(join(directory, 'tracked.txt'), 'committed content\n')
  await git(['add', 'tracked.txt'])
  await git(['commit', '-m', 'fixture commit'])
  return directory
}

/** A file the tree had *already* modified before the check ran: the case a status set cannot see. */
async function dirtyTrackedFile(directory: string): Promise<void> {
  await writeFile(join(directory, 'tracked.txt'), 'dirty before the check ran\n')
}

/** A probe that exits with `code`, declared to do exactly that. */
const probe = (command: readonly string[], expectation: 'pass' | 'fail', id = 'probe-1') => ({
  id,
  command,
  expectation,
  rationale: 'Falsifies the change rather than restating it.',
})

describe('engineering verification', () => {
  it('reports missing declared stages as skipped instead of passing them', async () => {
    const directory = await fixture({})
    const result = await runEngineeringVerification({ cwd: directory, stages: ['build', 'types'] })
    expect(result.stages.map(stage => stage.state)).toEqual(['skipped', 'skipped'])
  })

  it('runs only an explicitly declared package script', async () => {
    const directory = await fixture({ build: 'node -e "process.exit(0)"' })
    const result = await runEngineeringVerification({ cwd: directory, stages: ['build'] })
    expect(result.stages[0]?.state, result.stages[0]?.summary).toBe('pass')
    expect(result.stages[0]?.command).toEqual(['npm', 'run', 'build'])
  })

  it('records the exit status alongside the command, so a pass rests on evidence', async () => {
    // The evidence contract needs both halves: the command that ran and what it
    // returned. Without the exit status a "pass" is indistinguishable from a
    // stage that was never executed.
    const directory = await fixture({ build: 'node -e "process.exit(0)"' })
    const result = await runEngineeringVerification({ cwd: directory, stages: ['build'] })
    expect(result.stages[0]?.exitCode).toBe(0)
    const failing = await fixture({ build: 'node -e "process.exit(2)"' })
    const failed = await runEngineeringVerification({ cwd: failing, stages: ['build'] })
    expect(failed.stages[0]?.state).toBe('fail')
    expect(failed.stages[0]?.exitCode).toBe(2)
  })

  it('fails closed when a declared verification script publishes or reaches the network', async () => {
    const directory = await fixture({ tests: 'curl https://example.test/check' })
    const result = await runEngineeringVerification({ cwd: directory, stages: ['tests'] })
    // `refused` rather than `unavailable`: the stage was rejected as unsafe, not
    // merely impossible to run, and the verdict must not read that as benign.
    expect(result.stages[0]).toMatchObject({ id: 'tests', state: 'refused' })
    expect(result.verdict).toBe('failed')
  })
})

describe('declared verification script safety', () => {
  it('refuses a recursive delete in every spelling, and only the recursive ones', () => {
    // Every case below is the same command as `rm -rf`, and matching only that
    // one spelling is how a verification step gets to delete a workspace.
    for (const script of [
      'rm -rf node_modules',
      'rm -fr node_modules',
      'rm -Rf node_modules',
      'rm -r -f node_modules',
      'rm --recursive --force node_modules',
      'rmdir /s /q build',
      'rd /s /q build',
      'del /s /q build',
      // The Windows spellings do not stop at `cmd`. A declared script runs under
      // whichever shell the project uses, and PowerShell names the same operation
      // with its own verb. `invoke-webrequest` was already in the network half of
      // this control, so the omission here was not a decision about PowerShell.
      'Remove-Item -Recurse -Force build',
      'remove-item -r -fo build',
      'erase /s /q build',
      'git -C repo push origin main',
    ]) expect(isUnsafeVerificationScript(script), script).toBe(true)
    // The recursive flag is what makes a delete destructive: removing one named
    // file is a check, and refusing it would turn verification into a no-op.
    expect(isUnsafeVerificationScript('rm -f ./tmp.txt')).toBe(false)
    expect(isUnsafeVerificationScript('git log --grep push')).toBe(false)
  })
})

describe('engineering verification verdict', () => {
  const stage = (over: Partial<EngineeringVerificationStageResult> = {}): EngineeringVerificationStageResult => ({
    id: 'build',
    state: 'pass',
    command: ['npm', 'run', 'build'],
    exitCode: 0,
    durationMs: 12,
    summary: '',
    ...over,
  })
  const ran = (over: Partial<EngineeringVerificationProbeResult> = {}): EngineeringVerificationProbeResult => ({
    id: 'probe-1',
    // A probe has to be a check that could have come out the other way. `node
    // -e "process.exit(0)"` would satisfy "a probe held" while proving nothing,
    // which is the reading the evidence rule below exists to refuse.
    command: ['node', '--test', 'tests/guard.test.ts'],
    expectation: 'pass',
    rationale: 'checks the guard still fires',
    state: 'pass',
    exitCode: 0,
    durationMs: 5,
    summary: '',
    held: true,
    ...over,
  })
  /**
   * Drop keys from a stage or probe fixture.
   *
   * `exactOptionalPropertyTypes` rejects `command: undefined` for an optional
   * `command?: readonly string[]`, and that rejection is right: a run that
   * recorded no command has no key at all, not a key holding undefined. This
   * makes the removal explicit instead of widening the source type to admit a
   * value the code can never distinguish from absent.
   */
  function without<T extends object, K extends keyof T>(value: T, ...keys: readonly K[]): Omit<T, K> {
    // A bare generic is not itself assignable to `Record<string, unknown>`, so
    // the widened view goes in and the caller's narrowed type comes back out.
    return omitRecordKeys(value as Record<string, unknown>, keys.map(String)) as Omit<T, K>
  }

  it('refuses a record that contradicts itself, which used to be the weaker thing to submit', () => {
    // The asymmetry this closes: a *missing* field was refused while a *conflicting*
    // one was accepted, so the more distorted record was the safer one to hand in.
    // These results are persisted and replayed, and `fake-green-audit.ts` exists
    // because records do get distorted, so the disagreement is caught here rather
    // than assumed away.
    const stageSaysPassWithStatusOne = summarizeEngineeringVerification({ stages: [stage({ exitCode: 1 })], probes: [ran()] })
    expect(stageSaysPassWithStatusOne.verdict).toBe('failed')
    expect(stageSaysPassWithStatusOne.unmet.join(' ')).toContain('contradicts itself')

    const probeSaysHeldWithStatusOne = summarizeEngineeringVerification({ stages: [stage()], probes: [ran({ exitCode: 1 })] })
    expect(probeSaysHeldWithStatusOne.verdict).toBe('failed')
    expect(probeSaysHeldWithStatusOne.unmet.join(' ')).toContain('contradicts its declared expectation')

    // The control that keeps the rule honest: a `fail` probe that held records a
    // non-zero status, and an absent status is *not* a contradiction — a probe whose
    // program was killed by a signal still did fail as declared, and reading that as
    // a contradiction would turn a real falsification into a `failed` verdict.
    const failProbeThatHeld = summarizeEngineeringVerification({ stages: [stage()], probes: [ran({ expectation: 'fail', exitCode: 1 })] })
    expect(failProbeThatHeld.verdict).toBe('verified')
    const heldWithNoStatus = summarizeEngineeringVerification({ stages: [stage()], probes: [without(ran({ expectation: 'fail' }), 'exitCode')] })
    expect(heldWithNoStatus.verdict).toBe('verified')
  })

  it('is unverified when every stage passes but nothing was falsified', () => {
    // Green declared gates say the project's own checks still pass; they say
    // nothing about the failure mode the change itself introduced.
    const result = summarizeEngineeringVerification({ stages: [stage()], probes: [] })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('No adversarial probe ran')
  })

  it('is verified only when the stages pass and a probe held', () => {
    const result = summarizeEngineeringVerification({ stages: [stage()], probes: [ran()] })
    expect(result.verdict).toBe('verified')
    expect(result.unmet).toEqual([])
  })

  it('is unverified when a stage could not run, even with a probe that held', () => {
    const result = summarizeEngineeringVerification({ stages: [without(stage({ id: 'tests', state: 'skipped' }), 'command', 'exitCode')], probes: [ran()] })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.some(reason => reason.includes('"tests"'))).toBe(true)
  })

  it('is failed when a probe did not hold, and says which one', () => {
    const result = summarizeEngineeringVerification({ stages: [stage()], probes: [ran({ held: false, state: 'fail' })] })
    expect(result.verdict).toBe('failed')
    expect(result.unmet.join(' ')).toContain('probe-1')
  })

  it('is failed, not unverified, when a stage passed without recorded evidence', () => {
    const result = summarizeEngineeringVerification({ stages: [without(stage(), 'command', 'exitCode')], probes: [ran()] })
    expect(result.verdict).toBe('failed')
    expect(result.unmet.join(' ')).toContain('without a recorded command')
  })

  it('is unverified when nothing was requested at all', () => {
    expect(summarizeEngineeringVerification({ stages: [], probes: [] }).verdict).toBe('unverified')
  })

  it('refuses a probe whose program cannot fail', () => {
    // The cheapest fake: a program that exits 0 whatever the change did. It
    // "held" its expectation, and the verdict must still not read `verified`.
    const result = summarizeEngineeringVerification({
      stages: [stage()],
      probes: [ran({ command: ['node', '-e', 'process.exit(0)'] })],
    })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('no assertion')
  })

  it('refuses a no-op shell line as a probe', () => {
    const result = summarizeEngineeringVerification({
      stages: [stage()],
      probes: [ran({ command: ['sh', '-c', 'echo ok'] })],
    })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('established nothing')
  })

  it('refuses a probe whose exit status comes from a filter after it', () => {
    // `npm test | tail -20` reports tail's status, so a failing suite reads as a
    // pass. The command is a real check; the number attached to it is not about
    // the check, which is a different failure from "not a check".
    const result = summarizeEngineeringVerification({
      stages: [stage()],
      probes: [ran({ command: ['sh', '-c', 'npm test | tail -20'] })],
    })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('filter')
  })

  it('refuses a probe masked by a trailing no-op', () => {
    // `npm test || true` cannot fail, so it is refused as "not a check" rather
    // than as a misattributed status — the last stage is `true`, and there is no
    // check left for a status to belong to.
    const result = summarizeEngineeringVerification({
      stages: [stage()],
      probes: [ran({ command: ['sh', '-c', 'npm test || true'] })],
    })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('cannot fail on the change')
  })

  it('accepts a probe that runs a real check', () => {
    const result = summarizeEngineeringVerification({
      stages: [stage()],
      probes: [ran({ command: ['npx', 'vitest', 'run', 'src/guard.test.ts'] })],
    })
    expect(result.verdict).toBe('verified')
    expect(result.unmet).toEqual([])
  })

  it('exempts the scope stage, which records the change instead of checking it', () => {
    // Every tier includes `scope`; its command is `git diff --name-only`, which
    // is not a verification and is not pretending to be one.
    const result = summarizeEngineeringVerification({
      stages: [stage({ id: 'scope', command: ['git', 'diff', '--name-only'] }), stage()],
      probes: [ran()],
    })
    expect(result.verdict).toBe('verified')
  })

  it('is unverified, not failed, when a stage was cancelled', () => {
    // A run somebody stopped observed nothing about the change, and `failed`
    // would assert a verdict against code nobody reached. The job store records
    // the run itself as cancelled; the verdict stays honest about the evidence.
    const result = summarizeEngineeringVerification({
      stages: [without(stage({ state: 'cancelled' }), 'command', 'exitCode')],
      // A cancelled probe keeps its `command` — it was declared before the run
      // and is what `summarizeEngineeringVerification` echoes back; only the
      // exit status is absent because nothing ran.
      probes: [without(ran({ state: 'cancelled', held: false }), 'exitCode')],
    })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('cancelled')
  })

  it('is failed when a stage or probe was refused, since refusal is a decision', () => {
    expect(summarizeEngineeringVerification({ stages: [without(stage({ state: 'refused' }), 'command', 'exitCode')], probes: [ran()] }).verdict).toBe('failed')
    expect(summarizeEngineeringVerification({ stages: [stage()], probes: [ran({ state: 'refused', held: false })] }).verdict).toBe('failed')
  })

  it('is unverified when fewer probes ran than the scope requires', () => {
    // A tier that declares how many probes it needs is a scope claim: one probe
    // under a `thorough` plan is not a thorough verification.
    const result = summarizeEngineeringVerification({ stages: [stage()], probes: [ran()], minProbes: 2 })
    expect(result.verdict).toBe('unverified')
    expect(result.unmet.join(' ')).toContain('requires 2 independent probes and 1 ran')
  })

  it('is verified once the scope floor is met', () => {
    const result = summarizeEngineeringVerification({ stages: [stage()], probes: [ran(), ran({ id: 'probe-2' })], minProbes: 2 })
    expect(result.verdict).toBe('verified')
    expect(result.unmet).toEqual([])
  })

  it('keeps the zero-probe wording, not the floor wording, when no probe ran at all', () => {
    const result = summarizeEngineeringVerification({ stages: [stage()], probes: [], minProbes: 2 })
    expect(result.unmet.join(' ')).toContain('No adversarial probe ran')
    expect(result.unmet.join(' ')).not.toContain('independent probes and 0 ran')
  })
})

describe('engineering verification probes', () => {
  const options = async (): Promise<{ cwd: string }> => ({ cwd: await fixture({}) })

  it('holds a probe whose observed failure matches a declared failure', async () => {
    // The interesting half of the contract: a guard that stops firing must turn
    // a green run red, so `expectation: 'fail'` is falsifiable.
    const { cwd } = await options()
    const [result] = await runEngineeringProbes({ cwd, probes: [probe(['node', '-e', 'process.exit(4)'], 'fail')] })
    expect(result?.held).toBe(true)
    expect(result?.state).toBe('pass')
    expect(result?.exitCode).toBe(4)
  })

  it('fails a probe whose declared failure unexpectedly succeeded', async () => {
    const { cwd } = await options()
    const [result] = await runEngineeringProbes({ cwd, probes: [probe(['node', '-e', 'process.exit(0)'], 'fail')] })
    expect(result?.held).toBe(false)
    expect(result?.summary).toContain('Expected the command to fail')
  })

  it('refuses a probe that reaches the network or deletes instead of skipping it', async () => {
    const { cwd } = await options()
    const results = await runEngineeringProbes({ cwd, probes: [
      probe(['curl', 'https://example.test'], 'pass', 'net'),
      probe(['rm', '-rf', '/tmp/whatever'], 'pass', 'del'),
    ] })
    expect(results.map(entry => entry.state)).toEqual(['refused', 'refused'])
    // Refusal is a failure of the run, never a silent omission.
    expect(results.every(entry => !entry.held)).toBe(true)
  })

  it('refuses a probe with no rationale, since a check nobody can explain is uncheckable', async () => {
    const { cwd } = await options()
    const [result] = await runEngineeringProbes({ cwd, probes: [{ id: 'bare', command: ['node', '-e', 'process.exit(0)'], expectation: 'pass', rationale: '  ' }] })
    expect(result?.state).toBe('refused')
  })

  it('does not count a probe that rewrote an already-modified file as evidence', async () => {
    // The hole a status-only fingerprint left open: `tracked.txt` is already
    // modified when the probe runs, so rewriting it adds no status line and the
    // probe looked like it had left the tree alone — a check that changed the
    // workspace was accepted as evidence about it. Content, not the path set, is
    // what tells the two states apart.
    const cwd = await repository()
    await dirtyTrackedFile(cwd)
    const [result] = await runEngineeringProbes({
      cwd,
      probes: [probe(['node', '-e', "require('node:fs').writeFileSync('tracked.txt','written by the probe\\n')"], 'pass')],
    })
    expect(result?.held).toBe(false)
    expect(result?.summary).toContain('changed workspace files')
  })

  it('fails a stage that rewrote an already-modified file instead of counting the pass', async () => {
    // The same control on the stage side, where it protects a `build` or `tests`
    // script: a snapshot-updating or code-generating script rewrites a file the
    // session had already modified, exits zero, and used to be recorded as a
    // pass over a tree it had just changed.
    const cwd = await repository()
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node rewrite.mjs' } }))
    await writeFile(join(cwd, 'rewrite.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('tracked.txt', 'written by the stage\\n')\n")
    await dirtyTrackedFile(cwd)
    const result = await runEngineeringVerification({ cwd, stages: ['build'], probes: [] })
    expect(result.stages[0]?.state).toBe('fail')
    expect(result.stages[0]?.summary).toContain('changed workspace files')
  })

  it('reports a probe that could not run as unavailable, not as a failed check', async () => {
    const { cwd } = await options()
    const [result] = await runEngineeringProbes({ cwd, probes: [probe(['definitely-not-an-installed-program-xyz'], 'pass')] })
    // Nothing was observed, so nothing was contradicted. Folding this into
    // `fail` made an uninstallable or cancelled probe read as "verification
    // FAILED", which is also what `engineering-jobs.ts` reads as a cancellation.
    expect(result?.state).toBe('unavailable')
    expect(result?.held).toBe(false)
    expect(summarizeEngineeringVerification({ stages: [], probes: result === undefined ? [] : [result] }).verdict).toBe('unverified')
  })

  it('refuses a probe argv the command policy forbids, which no script pattern names', async () => {
    // A probe is spawned without a shell, so it never passed through the tool
    // guard that judges `bash`: the argv was screened by the network/publish/
    // delete patterns alone. `chmod -R 777 .` is the case that shows the gap —
    // the script patterns do not name it, the policy's own rule does, and before
    // this check the probe simply ran.
    const { cwd } = await options()
    const [result] = await runEngineeringProbes({ cwd, probes: [probe(['chmod', '-R', '777', '.'], 'pass')] })
    expect(result?.state).toBe('refused')
    expect(result?.held).toBe(false)
    expect(result?.summary).toContain('command policy')
    expect(summarizeEngineeringVerification({ stages: [], probes: result === undefined ? [] : [result] }).verdict).toBe('failed')
  })

  it('adds the repository policy on top of the built-in one', async () => {
    // "On top of", never instead of: a project rule may add a denial and nothing
    // in the shape lets one remove a built-in denial.
    const { cwd } = await options()
    const policy = compileCommandPolicy({
      version: 1,
      rules: [{
        pattern: ['node', '--write-cache'],
        decision: 'forbidden',
        justification: 'The repository refuses it.',
        match: ['node --write-cache'],
        notMatch: ['node --version'],
      }],
    })
    expect(policy.diagnostics).toEqual([])
    const [result] = await runEngineeringProbes({ cwd, probes: [probe(['node', '--write-cache'], 'pass')], policy })
    expect(result?.state).toBe('refused')
    expect(result?.summary).toContain('The repository refuses it.')
  })

  it('still runs a probe neither policy names', async () => {
    // The control on the two cases above: a check that refuses everything is not
    // a check. `node -e` with an exit status is the shape every probe has.
    const { cwd } = await options()
    const [result] = await runEngineeringProbes({ cwd, probes: [probe(['node', '-e', 'process.exit(0)'], 'pass')] })
    expect(result?.state).toBe('pass')
  })

  it('carries a refused probe through to a failed verdict', async () => {
    const { cwd } = await options()
    const results = await runEngineeringProbes({ cwd, probes: [probe(['curl', 'https://example.test'], 'pass')] })
    expect(summarizeEngineeringVerification({ stages: [], probes: results }).verdict).toBe('failed')
  })

  it('keeps empty arguments intact, since dropping them rewrites the command', async () => {
    // Caught by the capability eval: the first version filtered empty strings
    // out of argv, so `node -e ""` became `node -e` and the probe silently
    // tested something else — a passing probe that charged the run for a
    // command nobody asked for.
    const probes = normalizeEngineeringProbes([{ id: 'empty-arg', command: ['git', 'commit', '-m', ''], expectation: 'pass', rationale: 'preserves argv' }])
    expect(probes[0]?.command).toEqual(['git', 'commit', '-m', ''])
  })

  it('drops unusable probes instead of voiding the well-formed ones beside them', () => {
    const probes = normalizeEngineeringProbes([
      { id: '', command: ['node'], expectation: 'pass', rationale: 'no id' },
      { id: 'ok', command: ['node', '-e', 'process.exit(0)'], expectation: 'pass', rationale: 'keeps working' },
      { id: 'blank-program', command: ['  '], expectation: 'pass', rationale: 'nothing to run' },
    ])
    expect(probes.map(entry => entry.id)).toEqual(['ok'])
  })

  it('reads a missing or unknown expectation as a plain pass, never as a declared failure', () => {
    const probes = normalizeEngineeringProbes([{ id: 'a', command: ['node'], rationale: 'r' }])
    expect(probes[0]?.expectation).toBe('pass')
  })

  it('runs probes as part of a verification run and reports them in the result', async () => {
    const directory = await fixture({ build: 'node -e "process.exit(0)"' })
    const result = await runEngineeringVerification({
      cwd: directory,
      stages: ['build'],
      // The probe has to be a command that could have failed. `node -e
      // "process.exit(0)"` would pass this test without running anything that
      // observes the change, which is the reading the evidence rule refuses.
      probes: [probe(['npm', 'run', 'build'], 'pass')],
    })
    expect(result.probes).toHaveLength(1)
    expect(result.verdict).toBe('verified')
  })
})
