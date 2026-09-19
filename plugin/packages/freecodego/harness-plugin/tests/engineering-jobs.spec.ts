import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringVerificationJobs, JOB_RETENTION_MS, MAX_RETAINED_JOBS, type NativeJobRegistry } from '../src/engineering-jobs.ts'

const run = promisify(execFile)

/** Commit a baseline file so the change under test is a real diff. */
async function seedGitRepository(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true })
  await run('git', ['init'], { cwd: workspace })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { types: 'node -e ""' } }))
  await writeFile(join(workspace, 'src.ts'), 'export const value = 1\n')
  await run('git', ['add', '.'], { cwd: workspace })
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'baseline'], { cwd: workspace })
}

const directories: string[] = []
/**
 * Remove a temp directory, retrying briefly.
 *
 * Windows holds the SQLite WAL/SHM handles for a moment after `close()`, so a
 * single recursive delete can fail with EBUSY and fail an otherwise passing
 * run. The retry is bounded so a genuine leak still surfaces.
 */
async function removeDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(directory, { recursive: true, force: true }); return } catch (error) {
      if (attempt === 4) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

afterEach(async () => { await Promise.all(directories.splice(0).map(removeDirectory)) })

/** Poll the durable row until the run reaches a terminal state. */
async function waitForJob(jobs: EngineeringVerificationJobs, id: string): Promise<ReturnType<EngineeringVerificationJobs['get']>> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const current = jobs.get(id)
    if (current.state !== 'queued' && current.state !== 'running') return current
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('engineering job did not settle')
}

describe('engineering verification jobs', () => {
  it('runs declared verification stages and reports passing evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const result = await jobs.run(directory, ['build'])
    expect(result.stages[0]).toMatchObject({ id: 'build', state: 'pass' })
    jobs.close()
  })

  it('marks a verification job failed when a declared stage fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-failed-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(2)"' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const result = await jobs.run(directory, ['build'])
    expect(result.stages[0]?.state).toBe('fail')
    jobs.close()
  })

  it('records a caller cancellation without replaying the interrupted work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-cancelled-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "setTimeout(() => {}, 5_000)"' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const controller = new AbortController()
    const settled = jobs.run(directory, ['build'], controller.signal)
    await new Promise(resolve => setTimeout(resolve, 200))
    controller.abort()
    const result = await settled
    expect(result.stages[0]?.state).toBe('cancelled')
    jobs.close()
  })

  it('publishes the run to the native job registry with the engineering kind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-native-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const specs: Array<{ kind: string; label: string; outputLimitBytes?: number }> = []
    const settlements: Array<Promise<{ readonly status: string }>> = []
    const registry: NativeJobRegistry = {
      start(spec) {
        specs.push({ kind: spec.kind, label: spec.label, ...(spec.outputLimitBytes === undefined ? {} : { outputLimitBytes: spec.outputLimitBytes }) })
        settlements.push(spec.run().done)
        return 'engineering-1'
      },
    }
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'), registry)
    await jobs.open()
    const result = await jobs.run(directory, ['build'])
    expect(result.stages[0]).toMatchObject({ id: 'build', state: 'pass' })
    expect(specs).toHaveLength(1)
    expect(specs[0]?.kind).toBe('engineering')
    expect(specs[0]?.label).toContain('build')
    // The registry-visible settlement must report the durable row's outcome.
    expect(await settlements[0]).toMatchObject({ status: 'completed' })
    jobs.close()
  })

  it('carries the durable summary in the settlement the owning agent reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-settlement-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(2)"' } }))
    const settlements: Array<Promise<{ readonly status: string; readonly output?: string }>> = []
    const registry: NativeJobRegistry = {
      start(spec) {
        settlements.push(spec.run().done)
        return 'engineering-1'
      },
    }
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'), registry)
    await jobs.open()
    const result = await jobs.run(directory, ['build'])
    expect(result.stages[0]?.state).toBe('fail')
    expect(settlements).toHaveLength(1)
    const settlement = await settlements[0]
    // `job_output` renders this field and nothing else, so a settlement carrying
    // only the status left the owning agent with `(no new output)` under a
    // completion notice that says "Read its output with job_output." The summary
    // is also where the fake-green audit reports that the verdict was measured
    // against a different change than the workspace holds.
    expect(settlement?.status).toBe('failed')
    expect(settlement?.output ?? '').toContain('Stage "build" failed.')
    jobs.close()
  })

  it('runs verification normally when no native registry is present', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-noregistry-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const result = await jobs.run(directory, ['build'])
    expect(result.stages[0]).toMatchObject({ id: 'build', state: 'pass' })
    jobs.close()
  })

  it('chooses the stage list from the change size when the caller names none', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-tier-'))
    directories.push(directory)
    // The job store lives outside the workspace so its SQLite files cannot be
    // mistaken for workspace changes by the very measurement under test.
    const workspace = join(directory, 'workspace')
    await seedGitRepository(workspace)
    // A two-file change that ships its own test: the case the light tier exists for.
    await writeFile(join(workspace, 'src.ts'), 'export const value = 2\n')
    await writeFile(join(workspace, 'src.spec.ts'), 'export const check = true\n')
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const job = jobs.start(workspace, undefined)
    const settled = await waitForJob(jobs, job.id)
    // The tier decides the stages, and the summary carries the scope so "no
    // failures" cannot be read as a claim about the checks that were omitted.
    expect(settled.verification?.stages.map(stage => stage.id)).toEqual(['scope', 'types'])
    expect(settled.summary).toContain('light verification')
    expect(settled.summary).toContain('omitted build+lint+tests')
    jobs.close()
  })

  it('keeps the caller\'s stages when the workspace is not a git repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-nogit-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const job = jobs.start(directory, undefined)
    const settled = await waitForJob(jobs, job.id)
    // No change size is readable, so no tier is chosen and the default stands.
    expect(settled.verification?.stages.map(stage => stage.id)).toEqual(['scope'])
    expect(settled.summary).not.toContain('verification (scope')
    jobs.close()
  })

  it('does not run the stages when the caller is already cancelled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-precancelled-'))
    directories.push(directory)
    // A stage that would take five seconds if it were allowed to run: an
    // already-aborted caller must not pay for it.
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "setTimeout(() => {}, 5_000)"' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const result = await jobs.run(directory, ['build'], controller.signal)
    expect(result.stages[0]?.state).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(3_000)
    jobs.close()
  })

  it('survives a registry that refuses the registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-refused-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const registry: NativeJobRegistry = { start() { throw new Error('no controller attached') } }
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'), registry)
    await jobs.open()
    const result = await jobs.run(directory, ['build'])
    expect(result.stages[0]).toMatchObject({ id: 'build', state: 'pass' })
    jobs.close()
  })

  it('names a kind this build cannot write instead of renaming it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-kind-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const started = jobs.start(directory, ['build'])
    // The table has no CHECK constraint on `kind` and the file outlives the build
    // that wrote it, so a row can name a kind this build has no producer for. A
    // second connection is how such a row arrives in practice.
    const side = new DatabaseSync(join(directory, 'jobs', 'engineering-jobs.sqlite'))
    const setKind = (kind: string): void => { side.prepare('UPDATE engineering_jobs SET kind = ? WHERE id = ?').run(kind, started.id) }
    setKind('council')
    // A kind the type declares but nothing writes keeps its own name: folding it
    // into `verification` would not lose the name, it would assert a different
    // and more specific one — that is the kind whose rows carry a verdict.
    expect(jobs.get(started.id).kind).toBe('council')
    // A value outside the type is a different question, and still falls back.
    setKind('nonsense')
    expect(jobs.get(started.id).kind).toBe('verification')
    side.close()
    jobs.close()
  })

  it('prunes the audit table on a new run, not only when the Host restarts', async () => {
    // Pruning only at open meant the retention window and the row ceiling applied
    // once per process lifetime: a Host that stayed up for weeks never pruned
    // while each run kept adding a row that can carry a ~16KB evidence blob.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-jobs-prune-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }))
    const jobs = new EngineeringVerificationJobs(join(directory, 'jobs'))
    await jobs.open()
    const side = new DatabaseSync(join(directory, 'jobs', 'engineering-jobs.sqlite'))
    const count = (): number => (side.prepare('SELECT COUNT(*) AS n FROM engineering_jobs').get() as { readonly n: number }).n
    // A row older than the window, written the way only another connection can
    // write one — this store opened a moment ago.
    const stale = `job_${'a'.repeat(32)}`
    side.prepare('INSERT INTO engineering_jobs(id, project_id, kind, state, created_at) VALUES (?, ?, ?, ?, ?)').run(stale, 'project', 'verification', 'completed', Date.now() - JOB_RETENTION_MS - 60_000)
    jobs.start(directory, ['build'])
    expect(count()).toBe(1)
    expect(side.prepare('SELECT COUNT(*) AS n FROM engineering_jobs WHERE id = ?').get(stale)).toEqual({ n: 0 })

    // The ceiling too: rows *inside* the window, more than the cap allows. Every
    // one of them is newer than the stale row above, so only the cap can decide.
    const insert = side.prepare('INSERT INTO engineering_jobs(id, project_id, kind, state, created_at) VALUES (?, ?, ?, ?, ?)')
    for (let index = 0; index < MAX_RETAINED_JOBS; index += 1) {
      insert.run(`job_${index.toString(16).padStart(32, '0')}`, 'project', 'verification', 'completed', Date.now() - index)
    }
    expect(count()).toBe(MAX_RETAINED_JOBS + 1)
    jobs.start(directory, ['build'])
    expect(count()).toBe(MAX_RETAINED_JOBS)
    side.close()
    jobs.close()
  })
})
