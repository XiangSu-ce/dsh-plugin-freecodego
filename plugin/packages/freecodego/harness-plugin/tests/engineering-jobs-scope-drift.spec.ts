/**
 * The drift check the job summary promises must actually be able to fire.
 *
 * `fake-green-audit.ts` opens with the case it exists for: "The record can be
 * about a different change. A verification of yesterday's three files is not
 * evidence about today's one file, and comparing the path sets is the only way
 * to tell." `engineering-jobs.ts` said the same thing in its own comment — the
 * verdict "says nothing about work that landed while it was running" — but it
 * read the change scope exactly once, *after* the run, and handed the audit no
 * `verifiedPaths`. Two reads of the same state make the comparison tautological,
 * so the rule could not fire in production no matter what happened to the
 * workspace while the run was going.
 *
 * Why this spec mocks the scope reader
 * ------------------------------------
 * The defect is a *pair* of reads, and the test has to be able to make them
 * disagree. Landing a real file mid-run cannot do it deterministically: the
 * runner fingerprints the workspace around every stage and every probe, so a
 * file that appears during one is caught by that guard first and the run fails
 * for the wrong reason. What is left is the few milliseconds between the last
 * fingerprint and the final read — a race, not a test. Standing in for the
 * workspace instead makes the two reads differ on demand, which is exactly the
 * condition the rule is about, while everything downstream of the reader (the
 * stages, the probes, the audit itself) stays real.
 *
 * @module @deepseek-ai/dsh-freecodego/harness-plugin/tests/engineering-jobs-scope-drift
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/engineering-quality.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engineering-quality.ts')>()
  return { ...actual, readWorkspaceChangeScope: vi.fn() }
})

import { readWorkspaceChangeScope, type WorkspaceChangeScope } from '../src/engineering-quality.ts'
import { EngineeringVerificationJobs } from '../src/engineering-jobs.ts'

const run = promisify(execFile)
const scopeReader = vi.mocked(readWorkspaceChangeScope)

const directories: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A scope naming the paths a workspace has changed. */
function scopeOf(changedPaths: readonly string[]): WorkspaceChangeScope {
  return { changedPaths, linesChanged: changedPaths.length, entries: changedPaths.map(path => ({ path, status: ' M', deleted: false, untracked: false })) }
}

/** Poll the durable row until the run reaches a terminal state. */
async function waitForJob(jobs: EngineeringVerificationJobs, id: string): Promise<ReturnType<EngineeringVerificationJobs['get']>> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const current = jobs.get(id)
    if (current.state !== 'queued' && current.state !== 'running') return current
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('engineering job did not settle')
}

/**
 * A workspace whose single declared check is `npm run types`, plus one probe that
 * is the same real check.
 *
 * Both are needed for the audit to have anything *else* to say: the job summary
 * appends at most two high findings, so a run that was already `unverified` would
 * push the drift finding out of the note and the assertion would pass on the
 * broken code too. A verified run with no other complaint leaves the drift as the
 * only finding there is.
 */
async function verificationWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-scope-drift-'))
  directories.push(directory)
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  await run('git', ['init'], { cwd: workspace })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { types: 'node -e ""' } }))
  await writeFile(join(workspace, 'src.ts'), 'export const value = 1\n')
  await run('git', ['add', '.'], { cwd: workspace })
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'baseline'], { cwd: workspace })
  return workspace
}

const PROBE = {
  id: 'types-again',
  command: ['npm', 'run', 'types'],
  expectation: 'pass',
  rationale: 'the project type check is the one command whose exit status this run can read',
} as const

describe('the job audit is told which change the verdict was measured against', () => {
  it('reports a workspace that no longer matches the change the run saw', async () => {
    const workspace = await verificationWorkspace()
    // Before the run: one changed path. After it: nothing changed any more. The
    // difference is the drift, and it is only visible if both reads are kept.
    scopeReader.mockResolvedValueOnce(scopeOf(['src.ts'])).mockResolvedValueOnce(scopeOf([]))
    const jobs = new EngineeringVerificationJobs(join(workspace, '..', 'jobs'))
    await jobs.open()
    const settled = await waitForJob(jobs, jobs.start(workspace, ['scope'], [PROBE]).id)
    // The run is otherwise clean, so the drift is the finding under test rather
    // than one item in a list that happens to be truncated.
    expect(settled.verification?.verdict).toBe('verified')
    expect(settled.summary).toContain('path(s) changed since')
    jobs.close()
  })

  it('says nothing about drift when the two reads agree', async () => {
    // The control: the rule must report a *difference*, not merely that it looked.
    const workspace = await verificationWorkspace()
    scopeReader.mockResolvedValue(scopeOf(['src.ts']))
    const jobs = new EngineeringVerificationJobs(join(workspace, '..', 'jobs'))
    await jobs.open()
    const settled = await waitForJob(jobs, jobs.start(workspace, ['scope'], [PROBE]).id)
    expect(settled.verification?.verdict).toBe('verified')
    expect(settled.summary).not.toContain('path(s) changed since')
    jobs.close()
  })
})
