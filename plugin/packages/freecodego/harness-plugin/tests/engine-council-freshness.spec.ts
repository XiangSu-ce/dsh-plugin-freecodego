/**
 * Which revision each council phase is judged against.
 *
 * Three phases ask "is this still valid": the approval decision, the
 * implementation marker, and the start of verification. Only the first may
 * demand the revision the *reviewers* saw — the other two run after the
 * implementation has changed the workspace, so binding them to the review
 * revision refuses the very work the approval authorized. The defect these pin:
 * all three used the review revision, which made `engineering_team_mark_implemented`
 * and `engineering_team_verify` fail with "workspace changed since council
 * review" for every implementation that touched a tracked file.
 *
 * The digest fields are left absent on the seeded reports so the comparison
 * under test is exactly the workspace revision, and the reviewed revision is
 * obtained from the module itself: an implementation marker reports the hash it
 * computed, so no expectation re-implements the hash.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FreeCodeGoEngineCouncil } from '../src/engine-council.ts'
import type { FreeCodeGoEngineeringCouncilReport } from '../src/types.ts'

const run = promisify(execFile)
const directories: string[] = []

interface SessionEventLike { readonly type: string; readonly data: unknown }

let workspace = ''
let events: SessionEventLike[] = []
let counter = 0
let council: FreeCodeGoEngineCouncil

// One council task is the whole budget: a start that spent its slot without
// running anything is exactly what the bookkeeping test below has to catch.
const settings = { get: () => ({ engineeringEnabled: true, engineeringCouncilEnabled: true, engineeringCouncilMaxConcurrent: 1 }) }

async function git(args: readonly string[]): Promise<string> {
  const result = await run('git', ['-C', workspace, ...args], { windowsHide: true })
  return result.stdout
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-council-freshness-'))
  directories.push(root)
  workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'council@example.test'])
  await git(['config', 'user.name', 'Council'])
  await writeFile(join(workspace, 'app.ts'), 'export const version = 1\n', 'utf8')
  await git(['add', '.'])
  await git(['commit', '-m', 'base'])
  events = []
  counter = 0
  council = new FreeCodeGoEngineCouncil(settings, () => ({ engine: 'deepseek', provider: 'freecodego' }))
})

afterEach(async () => {
  // Council work runs against this workspace, so a cancelled task still has to
  // settle before the directory can be removed on Windows.
  council.dispose()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Minimal parent Agent: the council reads durable events and appends new ones. */
function parent(): Agent {
  return {
    id: 'parent-agent',
    session: {
      id: 'session-1',
      header: { cwd: workspace, parentSession: undefined },
      seq: events.length,
      snapshotEvents: () => events,
      append: (type: string, data: unknown) => {
        const event = { type, data }
        events.push(event)
        return event
      },
    },
  } as unknown as Agent
}

function newId(): string {
  counter += 1
  return `council_${counter.toString(16).padStart(32, '0')}`
}

function seed(workspaceRevision: string | undefined, approved: boolean): string {
  const id = newId()
  const report: FreeCodeGoEngineeringCouncilReport = {
    id,
    sessionId: 'session-1',
    projectId: 'project-1',
    state: 'completed',
    createdAt: Date.now() - 60_000,
    completedAt: Date.now() - 30_000,
    objective: 'Ship the reviewed change',
    plan: 'Edit app.ts to bump the version.',
    rounds: 1,
    quorum: 2,
    participants: [],
    consensus: 'Two reviewers completed.',
    dissent: 'No participant failure was recorded.',
    finalRecommendation: 'Implement after user approval.',
    reportVersion: 2,
    riskGate: 'clear',
    findings: [],
    ...(workspaceRevision === undefined ? {} : { workspaceRevision }),
    ...(approved ? { decision: { id, state: 'approved' as const, decidedAt: Date.now() - 20_000, expiresAt: Date.now() + 600_000 } } : {}),
  }
  events.push({ type: 'freecodego/council', data: report })
  return id
}

/** The revision the module computes for the workspace as it is right now. */
async function currentRevision(): Promise<string | undefined> {
  const id = seed(undefined, true)
  return (await council.recordImplementation(parent(), id, 'revision probe')).workspaceRevision
}

async function settle(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('engineering council freshness baselines', () => {
  it('refuses approval when the workspace moved since the review', async () => {
    const reviewed = await currentRevision()
    await writeFile(join(workspace, 'app.ts'), 'export const version = 2\n', 'utf8')
    const id = seed(reviewed, false)
    expect(await settle(() => council.recordDecision(parent(), id, 'approved'))).toMatch(/workspace changed since council review/u)
  })

  it('approves a review of the revision that is current', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, false)
    expect(await settle(() => council.recordDecision(parent(), id, 'approved'))).toBe('accepted')
    expect(council.report(parent(), id).decision?.state).toBe('approved')
  })

  it('takes the implementation marker after the implementation changed the workspace', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, true)
    // The implementation the review authorized, applied to the tracked file.
    await writeFile(join(workspace, 'app.ts'), 'export const version = 2\n', 'utf8')
    const implementation = await council.recordImplementation(parent(), id, 'bumped app.ts to version 2')
    const revision = implementation.workspaceRevision
    expect(revision).toBeTypeOf('string')
    // The marker records the revision it produced, which is what verification is
    // judged against — not the revision the reviewers saw.
    expect(revision).not.toBe(reviewed)
    expect(council.report(parent(), id).implementation?.summary).toBe('bumped app.ts to version 2')
  })

  it('starts verification for the revision the implementation declared', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, true)
    await writeFile(join(workspace, 'app.ts'), 'export const version = 2\n', 'utf8')
    await council.recordImplementation(parent(), id, 'implemented')
    expect(await settle(() => council.beginVerification(parent(), id))).toBe('accepted')
  })

  it('refuses verification when the workspace moved after the implementation marker', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, true)
    await writeFile(join(workspace, 'app.ts'), 'export const version = 2\n', 'utf8')
    await council.recordImplementation(parent(), id, 'implemented')
    await writeFile(join(workspace, 'app.ts'), 'export const version = 3\n', 'utf8')
    expect(await settle(() => council.beginVerification(parent(), id)))
      .toMatch(/workspace changed after the implementation was marked complete/u)
  })

  it('requires an implementation marker before verification, and says so', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, true)
    // No workspace change and no marker: the refusal names the missing marker
    // rather than a staleness verdict about a revision that does not exist.
    expect(await settle(() => council.beginVerification(parent(), id)))
      .toMatch(/requires an implementation completion marker/u)
  })

  it('does not spend a concurrency slot on a council a closed session refuses to record', async () => {
    // The durable task event is what restart recovery projects 'stale' from; a
    // session that cannot accept it must not leave the council counted as active
    // with nothing running behind it, or every later council in the process is
    // refused by the concurrency limit.
    let refuse = true
    const session = {
      id: 'session-1',
      header: { cwd: workspace, parentSession: undefined },
      seq: 0,
      snapshotEvents: () => events,
      append: (type: string, data: unknown) => {
        if (refuse) throw new Error('session is closed')
        const event = { type, data }
        events.push(event)
        return event
      },
    }
    const closed = { id: 'parent-agent', session } as unknown as Agent
    const request = { objective: 'Ship it', plan: 'Edit app.ts.' }
    // The start itself must surface the refusal rather than swallowing it.
    expect(() => council.start(closed, request)).toThrow(/session is closed/u)
    refuse = false
    // And the budget must be intact: with one slot, a start that had leaked its
    // entry would now be refused by the concurrency limit.
    const job = council.start(closed, request, new AbortController().signal)
    expect(job.id).toMatch(/^council_/u)
    council.cancel(job.id)
    for (let attempt = 0; attempt < 100 && council.job(job.id).state !== 'cancelled'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(council.job(job.id).state).toBe('cancelled')
  })

  it('refuses the implementation marker without an approval', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, false)
    expect(await settle(() => council.recordImplementation(parent(), id, 'implemented'))).toMatch(/requires approval before implementation/u)
  })

  it('refuses the implementation marker once the approval has expired', async () => {
    const reviewed = await currentRevision()
    const id = seed(reviewed, true)
    const report = council.report(parent(), id)
    // Rewrite the decision with a past expiry, standing in for a plan approved
    // long ago and implemented only now.
    const expired: FreeCodeGoEngineeringCouncilReport = {
      ...report,
      decision: { ...report.decision!, expiresAt: Date.now() - 1_000 },
    }
    events[events.length - 1] = { type: 'freecodego/council', data: expired }
    expect(await settle(() => council.recordImplementation(parent(), id, 'implemented'))).toMatch(/approval has expired/u)
  })
})
