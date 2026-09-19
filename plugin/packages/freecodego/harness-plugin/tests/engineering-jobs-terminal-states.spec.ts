/**
 * Every terminal state is terminal for every reader.
 *
 * The store has two pollers: `awaitSettlement`, which the native job registry
 * awaits, and the loop inside `run()`, which is what the Agent tool call
 * actually waits on. The first names all four terminal states; the second named
 * three and left out `completed` — the state a *successful* run produces.
 *
 * The two disagree only on a row that says `completed` and carries no
 * `verification_json`, and that row cannot come from this build's writer:
 * `execute` writes the state and the evidence in one statement. It is what a
 * row written by a build whose evidence shape differs looks like — the table
 * outlives the build that wrote it, and `parseVerification` returns `undefined`
 * for anything that does not match its guard. A second connection is how such a
 * row arrives, the same way the kind test in `engineering-jobs.spec.ts` writes
 * its foreign row.
 *
 * The cost of the disagreement is not a wrong answer but no answer: `run()`
 * polls at 100ms with no deadline, so the Agent's verification call never
 * returns while the registry-visible job has already settled.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EngineeringVerificationJobs } from '../src/engineering-jobs.ts'

// A run that never finishes on its own. The row has to be settled from the
// outside *while it is still executing*, and a promise that neither resolves
// nor holds a timer leaves the store holding a row in `running` without
// keeping the event loop alive.
vi.mock('../src/engineering-quality.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engineering-quality.ts')>()
  return {
    ...actual,
    runEngineeringVerification: async () => await new Promise<never>(() => undefined),
  }
})

const directories: string[] = []
const stores: EngineeringVerificationJobs[] = []
const connections: DatabaseSync[] = []
afterEach(async () => {
  // Close before unlinking: a still-open SQLite handle on Windows makes the
  // removal fail with EBUSY, and that failure would be reported as this file's
  // fault rather than as a leaked handle.
  for (const connection of connections.splice(0)) {
    try { connection.close() } catch { /* already closed by the case */ }
  }
  for (const store of stores.splice(0)) {
    try { store.close() } catch { /* the case already closed it */ }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('a row that settled without an evidence body', () => {
  it('is terminal for the caller waiting on run(), not only for the job registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-job-terminal-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    stores.push(jobs)
    await jobs.open()
    const side = new DatabaseSync(join(directory, 'jobs', 'engineering-jobs.sqlite'))
    connections.push(side)

    const pending = jobs.run(directory, ['build'])
    // Wait for the row to be executing, then settle it from the outside. The
    // write happens between `execute`'s `running` update and its settlement, so
    // nothing in this build overwrites it before `run()` reads it.
    let id = ''
    for (let attempt = 0; attempt < 100 && id === ''; attempt += 1) {
      const row = side.prepare("SELECT id FROM engineering_jobs WHERE state = 'running'").get() as { readonly id?: string } | undefined
      if (typeof row?.id === 'string') id = row.id
      else await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(id, 'no row reached the running state').not.toBe('')
    side.prepare("UPDATE engineering_jobs SET state = 'completed', finished_at = ?, summary = ? WHERE id = ?")
      .run(Date.now(), 'Settled without evidence by another build.', id)

    const result = await pending
    // The caller is told the run did not complete, and told why — the summary
    // column is the only place the row carries that.
    expect(result.stages[0]?.state).toBe('unavailable')
    expect(result.stages[0]?.summary).toContain('Settled without evidence')
  }, 20_000)
})
