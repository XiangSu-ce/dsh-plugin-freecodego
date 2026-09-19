/**
 * A reopened job store has to behave like an open one.
 *
 * `engineering.ts`'s `reconcile()` closes this store and reopens it — on every
 * settings change, every workspace switch — so a close/reopen cycle is routine
 * rather than an edge case. `close()` latches `closing = true` so that a
 * settlement write arriving after shutdown is skipped instead of touching a
 * closed handle; the comment on that skip says the reopen path will mark the
 * abandoned row `interrupted`, which is true for the rows that existed *before*
 * the close and false for every run started after it.
 *
 * `open()` never cleared the latch. So from the first reconcile onwards
 * `settleQuietly` refused every write, and a verification whose own work threw
 * left its row at `running` forever: `awaitSettlement` then reports a timeout
 * instead of the failure, and the owning agent never learns why the run died.
 * The successful path writes its row directly, which is why only a *failing*
 * run after a reconcile was affected — and why this file drives a throw.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EngineeringVerificationJobs } from '../src/engineering-jobs.ts'

// The run's own work is not what this file is about. `runEngineeringVerification`
// is the one call inside the settlement `try` that a test can make throw
// deterministically, and a throw is exactly the path under test.
vi.mock('../src/engineering-quality.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engineering-quality.ts')>()
  return {
    ...actual,
    runEngineeringVerification: async () => { throw new Error('the verification itself exploded') },
  }
})

const directories: string[] = []
const stores: EngineeringVerificationJobs[] = []
afterEach(async () => {
  // Close before unlinking: a still-open SQLite handle on Windows makes the
  // removal fail with EBUSY, and that failure would be reported as this file's
  // fault rather than as a leaked handle.
  for (const store of stores.splice(0)) {
    try { store.close() } catch { /* the case already closed it */ }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** An open store, registered for teardown. */
async function openStore(directory: string): Promise<EngineeringVerificationJobs> {
  const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
  stores.push(jobs)
  await jobs.open()
  return jobs
}

/** Poll the durable row until the run reaches a terminal state. */
async function waitForJob(jobs: EngineeringVerificationJobs, id: string): Promise<ReturnType<EngineeringVerificationJobs['get']>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = jobs.get(id)
    if (current.state !== 'queued' && current.state !== 'running') return current
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`engineering job did not settle: ${jobs.get(id).state}`)
}

describe('a job store that was closed and reopened', () => {
  it('still writes the terminal row for a run that throws', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-job-reopen-'))
    directories.push(directory)
    const jobs = await openStore(directory)
    // The reconcile cycle, in order.
    jobs.close()
    await jobs.open()

    const settled = await waitForJob(jobs, jobs.start(directory, ['scope'], []).id)

    expect(settled.state).toBe('failed')
    // The message is the only thing that tells the owner what went wrong, so a
    // terminal row that lost it would be a quieter version of the same defect.
    expect(settled.summary).toContain('the verification itself exploded')
  }, 30_000)

  it('settles a run that starts before the close and finishes after the reopen', async () => {
    // The other half of the same latch, and the case the skip was written for:
    // a run whose store went away underneath it. Its row must be settled by the
    // reopen — `open()` marks stale `running` rows `interrupted` — so the owner
    // is never left polling a row nothing will ever move.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-job-reopen-'))
    directories.push(directory)
    const jobs = await openStore(directory)
    const inFlight = jobs.start(directory, ['scope'], [])
    jobs.close()
    await jobs.open()

    const settled = await waitForJob(jobs, inFlight.id)
    expect(settled.state).toBe('interrupted')
  }, 30_000)
})
