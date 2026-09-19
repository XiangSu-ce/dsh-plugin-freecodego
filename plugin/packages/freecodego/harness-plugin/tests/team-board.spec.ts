import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TEAM_DERIVED_TASK_STATUSES, TEAM_STORED_TASK_STATUSES, TEAM_TASK_STATUSES, TeamBoard, compareTeamTaskIds } from '../src/team/board.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function board(): Promise<{ board: TeamBoard; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-board-'))
  directories.push(directory)
  const file = join(directory, 'board.json')
  return { board: new TeamBoard('team1', file), file }
}

describe('team task board', () => {
  it('orders tasks by id numerically, not as strings', () => {
    // `t10` after `t2` is the whole reason availability is deterministic.
    expect(['t10', 't2', 't1'].sort(compareTeamTaskIds)).toEqual(['t1', 't2', 't10'])
  })

  it('creates tasks in the order given and resolves positional dependencies', async () => {
    const { board: subject } = await board()
    const created = await subject.create({ createdBy: 'parent', tasks: [
      { title: 'write the parser' },
      { title: 'test the parser', dependsOn: ['$1'] },
    ] })
    expect(created.map(task => task.id)).toEqual(['t1', 't2'])
    expect(created[1]?.dependsOn).toEqual(['t1'])
    expect(await subject.list()).toHaveLength(2)
  })

  it('refuses to hand out a task whose dependency is not done, and names it', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }, { title: 'b', dependsOn: ['$1'] }] })
    await expect(subject.claim('t2', 'm1')).rejects.toThrow(/blocked by t1/u)
    // t1 is available; t2 is not offered even though it is the second task.
    expect((await subject.nextFor('m1'))?.id).toBe('t1')
    await subject.claim('t1', 'm1')
    await subject.complete('t1', 'm1')
    expect((await subject.nextFor('m2'))?.id).toBe('t2')
  })

  it('keeps a claim exclusive and says who holds it', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'only one' }] })
    await subject.claim('t1', 'm1')
    await expect(subject.claim('t1', 'm2')).rejects.toThrow(/claimed by "m1"/u)
    // The same member may re-claim, which makes a retry idempotent.
    await expect(subject.claim('t1', 'm1')).resolves.toMatchObject({ owner: 'm1' })
  })

  it('lets only the owner close a task', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await expect(subject.complete('t1', 'm2')).rejects.toThrow(/owned by "m1"/u)
    await expect(subject.fail('t1', 'm2', 'nope')).rejects.toThrow(/owned by "m1"/u)
    await expect(subject.complete('t1', 'm1', { note: 'done', artifacts: ['src/a.ts'] })).resolves.toMatchObject({ status: 'done', artifacts: ['src/a.ts'] })
  })

  it('reports a task blocked by a failed dependency without storing a status for it', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }, { title: 'b', dependsOn: ['$1'] }] })
    await subject.claim('t1', 'm1')
    await subject.fail('t1', 'm1', 'the interface does not exist yet')
    const blocked = await subject.blocked()
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.task.id).toBe('t2')
    expect(blocked[0]?.cause).toBe('t1')
    // Still `open` on the row itself: the blocked view is derived, so retrying
    // t1 clears it without a status migration.
    expect((await subject.get('t2'))?.status).toBe('open')
    expect((await subject.summary()).blocked).toBe(1)
  })

  it('counts claims and completions per owner', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    await subject.claim('t1', 'm1')
    await subject.claim('t2', 'm1')
    await subject.claim('t3', 'm2')
    await subject.complete('t1', 'm1')
    const summary = await subject.summary()
    expect(summary).toMatchObject({ total: 3, claimed: 2, done: 1 })
    expect(summary.byOwner.m1).toEqual({ claimed: 1, done: 1 })
    expect(summary.byOwner.m2).toEqual({ claimed: 1, done: 0 })
  })

  it('returns a released task to the available pool without closing it', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.release('t1', 'm1')
    expect(await subject.get('t1')).toMatchObject({ status: 'open', owner: undefined })
    expect((await subject.nextFor('m2'))?.id).toBe('t1')
  })

  it('survives a new instance reading the same file', async () => {
    const { board: subject, file } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    const reopened = new TeamBoard('team1', file)
    expect(await reopened.get('t1')).toMatchObject({ status: 'claimed', owner: 'm1', attempts: 1 })
  })

  it('degrades to an empty board on a malformed file instead of throwing', async () => {
    // A hand-edited or half-written document must not take a session down; the
    // next update rewrites it.
    const { board: subject, file } = await board()
    await writeFile(file, '{ this is not json', 'utf8')
    expect(await subject.list()).toEqual([])
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('bounds a task title and detail before persisting them', async () => {
    const { board: subject } = await board()
    const created = await subject.create({ createdBy: 'parent', tasks: [{ title: 'x'.repeat(500), detail: 'y'.repeat(9_000) }] })
    expect(created[0]?.title.length).toBeLessThanOrEqual(300)
    expect((created[0]?.detail.length ?? 0)).toBeLessThanOrEqual(4_000)
  })
})

describe('waiting for a person', () => {
  it('parks a claimed task without calling it a failure or progress', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const claimed = await subject.claim('t1', 'm1')
    const parked = await subject.requestReview('t1', 'm1', {
      note: 'the retry policy is a product decision',
      waitingOn: 'the user',
      // Spread rather than pass-and-hope: `claim()` types its token as optional,
      // and the guard below is *presented* when there is one, so sending
      // `undefined` would test a different call than the one a member makes.
      ...(claimed.claimToken === undefined ? {} : { claimToken: claimed.claimToken }),
    })
    expect(parked).toMatchObject({ status: 'needs-review', owner: 'm1', waitingOn: 'the user' })
    expect(parked.waitingSince).toBeTypeOf('number')
    // The claim and its token stay with the owner: the member that asked the
    // question is the one that picks the answer up.
    expect(parked.claimToken).toBe(claimed.claimToken)
  })

  it('counts a parked task as its own bucket, in every direction', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }, { title: 'b' }] })
    await subject.claim('t1', 'm1')
    await subject.requestReview('t1', 'm1', { note: 'needs a decision', waitingOn: 'the user' })
    const summary = await subject.summary()
    expect(summary.needsReview).toBe(1)
    expect(summary.claimed).toBe(0)
    expect(summary.done).toBe(0)
    expect(summary.failed).toBe(0)
    // Folded into `claimed`, a stalled team looks busy; folded into `failed`, work
    // that is not broken looks broken.
    expect(summary.waiting).toHaveLength(1)
    expect(summary.waiting[0]).toMatchObject({ id: 't1', on: 'the user' })
  })

  it('does not offer a parked task to anyone, its own owner included', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.requestReview('t1', 'm1', { note: 'ask a human' })
    // A decision is a decision, not an availability.
    expect(await subject.nextFor('m1')).toBeUndefined()
  })

  it('refuses a re-claim that would hide the wait, and names what is waited on', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.requestReview('t1', 'm1', { note: 'ask a human', waitingOn: 'the user' })
    await expect(subject.claim('t1', 'm1')).rejects.toThrow(/waiting on the user/u)
  })

  it('puts the task back in the owner\'s hands on resume, clearing the wait', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.requestReview('t1', 'm1', { note: 'ask a human', waitingOn: 'the user' })
    const resumed = await subject.resume('t1', 'm1', { note: 'the user said retry' })
    expect(resumed).toMatchObject({ status: 'claimed', owner: 'm1', note: 'the user said retry' })
    // A finished task must not still claim it is waiting on somebody.
    expect(resumed.waitingOn).toBeUndefined()
    expect(resumed.waitingSince).toBeUndefined()
    expect(await subject.nextFor('m1')).toMatchObject({ id: 't1' })
  })

  it('parks and resumes only through the owner', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await expect(subject.requestReview('t1', 'm2', { note: 'x' })).rejects.toThrow(/owned by "m1"/u)
    await subject.requestReview('t1', 'm1', { note: 'x' })
    await expect(subject.resume('t1', 'm2')).rejects.toThrow(/owned by "m1"/u)
  })

  it('parks only a claimed task, and resumes only a parked one', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await expect(subject.requestReview('t1', 'm1', { note: 'x' })).rejects.toThrow(/only a claimed task/u)
    await subject.claim('t1', 'm1')
    await expect(subject.resume('t1', 'm1')).rejects.toThrow(/only a task waiting for a review/u)
  })

  it('does not treat a wait as a blocked dependency', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }, { title: 'b', dependsOn: ['$1'] }] })
    await subject.claim('t1', 'm1')
    await subject.requestReview('t1', 'm1', { note: 'ask a human' })
    // t2 cannot run yet, but nothing has failed, so claiming it must still be a
    // dependency refusal rather than a report of a permanent block.
    await expect(subject.claim('t2', 'm2')).rejects.toThrow(/blocked by t1/u)
    expect(await subject.blocked()).toEqual([])
  })
})

describe('reopening a failure', () => {
  it('reruns a failed task under the same id, keeping the attempt count', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.fail('t1', 'm1', 'the parser hung')
    const reopened = await subject.rerun('t1', 'parent', 'the hang was a fixture bug')
    expect(reopened).toMatchObject({ id: 't1', status: 'open', attempts: 1 })
    expect(reopened.owner).toBeUndefined()
    // `create` was the only way back before, and it lost this link.
    expect(reopened.history.map(entry => `${entry.from}->${entry.to}`)).toEqual([
      'open->claimed',
      'claimed->failed',
      'failed->open',
    ])
  })

  it('reruns only what failed or was cancelled', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await expect(subject.rerun('t1', 'parent')).rejects.toThrow(/only a failed or cancelled task/u)
    await subject.claim('t1', 'm1')
    await expect(subject.rerun('t1', 'parent')).rejects.toThrow(/only a failed or cancelled task/u)
  })
})

describe('the transition ledger', () => {
  it('records who moved the task, from what to what, and why', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.requestReview('t1', 'm1', { note: 'the retry policy is a product decision' })
    await subject.resume('t1', 'm1')
    await subject.fail('t1', 'm1', 'still wrong')
    const task = await subject.get('t1')
    expect(task?.history.map(entry => `${entry.by}:${entry.from}->${entry.to}`)).toEqual([
      'm1:open->claimed',
      'm1:claimed->needs-review',
      'm1:needs-review->claimed',
      'm1:claimed->failed',
    ])
    // The reason the human was asked survives the answer — the latest `note` no
    // longer holds it.
    expect(task?.history.find(entry => entry.to === 'needs-review')?.note).toBe('the retry policy is a product decision')
  })

  it('does not log a mutation that leaves the status alone', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await subject.approve('t1', 'reviewer', 'approved', 'looks right')
    const task = await subject.get('t1')
    expect(task?.history).toHaveLength(1)
    expect(task?.approvals).toHaveLength(1)
  })

  it('bounds the ledger, like the approval list', async () => {
    const { board: subject } = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    for (let index = 0; index < 25; index += 1) {
      await subject.claim('t1', 'm1')
      await subject.release('t1', 'm1')
    }
    const task = await subject.get('t1')
    expect(task?.history.length).toBe(20)
    // The oldest entries are the ones dropped, so the newest transition is intact.
    expect(task?.history.at(-1)?.to).toBe('open')
  })

  it('refuses a second close through every door, whatever the outcome was spelled', async () => {
    // One shared predicate, so the doors cannot disagree about what "already
    // closed" means. Narrowing it to `done` would leave `failed` and `cancelled`
    // reopenable by a stray call — which is exactly what the probe on it mutates.
    for (const outcome of ['done', 'failed', 'cancelled'] as const) {
      const { board: subject } = await board()
      await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
      await subject.claim('t1', 'm1')
      if (outcome === 'done') await subject.complete('t1', 'm1', { note: 'finished' })
      else if (outcome === 'failed') await subject.fail('t1', 'm1', 'nope')
      else await subject.cancel('t1', 'parent')
      await expect(subject.complete('t1', 'm1', { note: 'again' }), outcome).rejects.toThrow(/a closed task/u)
      await expect(subject.fail('t1', 'm1', 'again'), outcome).rejects.toThrow(/a closed task/u)
      // The row is a record, so a refused write leaves it exactly where it was.
      expect(await subject.get('t1'), outcome).toMatchObject({ status: outcome })
    }
  })

  it('reads a board written before the ledger existed as having none', async () => {
    const { board: subject, file } = await board()
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 1,
      tasks: [{ id: 't1', title: 'a', status: 'claimed', owner: 'm1', createdBy: 'parent', createdAt: 1, updatedAt: 1 }],
    }), 'utf8')
    const task = await subject.get('t1')
    expect(task?.history).toEqual([])
    expect(task?.status).toBe('claimed')
  })

  it('repairs an unrecognised stored status into the open pool and records the spelling', async () => {
    const { board: subject, file } = await board()
    // The American spelling is the realistic trigger: both spellings living in one
    // repository is ordinary, and a status the build does not know used to load as
    // a real task belonging to no bucket.
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 2,
      tasks: [
        { id: 't1', title: 'typed the American spelling', detail: '', status: 'canceled', createdBy: 'parent', createdAt: 1, updatedAt: 1 },
        { id: 't2', title: 'an ordinary row', detail: '', status: 'claimed', owner: 'm1', createdBy: 'parent', createdAt: 1, updatedAt: 1 },
      ],
    }), 'utf8')
    const repaired = await subject.get('t1')
    // Kept rather than dropped: losing a whole task is not a recoverable outcome,
    // and the title is the work.
    expect(repaired?.title).toBe('typed the American spelling')
    expect(repaired?.status).toBe('open')
    // Repaired rather than silently fixed, and the record names what was there.
    expect(repaired?.history.at(-1)).toMatchObject({ by: 'board', from: 'canceled', to: 'open' })
    expect(repaired?.history.at(-1)?.note).toContain('canceled')
    // Back in the pool, so it can actually be picked up again.
    expect((await subject.nextFor('m2'))?.id).toBe('t1')
    // The panel's one self-check: the buckets partition `total`.
    const summary = await subject.summary()
    expect(summary.open + summary.claimed + summary.needsReview + summary.blocked + summary.done + summary.failed + summary.cancelled)
      .toBe(summary.total)
  })

  it('builds every declared field at the boundary instead of trusting the file', async () => {
    const { board: subject, file } = await board()
    // Only the three fields a row needs in order to be a row.
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 1,
      tasks: [{ id: 't1', title: 'a', status: 'open' }],
    }), 'utf8')
    const task = await subject.get('t1')
    // `undefined` for any of these would be a lie the type tells: it declares all
    // of them, and a reader cannot tell "the file said nothing" from "this build
    // has no such field".
    expect(task?.detail).toBe('')
    expect(task?.createdBy).toBe('board')
    expect(task?.createdAt).toBe(0)
    expect(task?.updatedAt).toBe(0)
    expect(task?.version).toBe(0)
    expect(task?.attempts).toBe(0)
    expect(task?.dependsOn).toEqual([])
    expect(task?.artifacts).toEqual([])
    expect(task?.approvals).toEqual([])
    expect(task?.history).toEqual([])
    expect(task?.note).toBeUndefined()
    expect(task?.claimToken).toBeUndefined()
  })

  it('drops a token the file stored as a number, so the task can still be closed', async () => {
    const { board: subject, file } = await board()
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 1,
      tasks: [{
        id: 't1', title: 'a', detail: '', status: 'claimed', owner: 'm1',
        createdBy: 'parent', createdAt: 1, updatedAt: 1, claimToken: 12345,
      }],
    }), 'utf8')
    // Kept, the row pins itself: the tool surface asks the member for the string
    // `12345` and the token door compares it against the number, so no spelling of
    // that token closes the task. Dropped, the owner can still finish the work —
    // the recoverable direction, and the same one `status` is repaired toward.
    expect((await subject.get('t1'))?.claimToken).toBeUndefined()
    const closed = await subject.complete('t1', 'm1', { note: 'finished' })
    expect(closed.status).toBe('done')
  })

  it('reports a parked row with no recorded date as a number, not as a missing field', async () => {
    const { board: subject, file } = await board()
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 1,
      tasks: [{
        id: 't1', title: 'a', detail: '', status: 'needs-review', owner: 'm1',
        createdBy: 'parent', createdAt: 1, waitingOn: 'a human reviewer',
      }],
    }), 'utf8')
    const waiting = (await subject.summary()).waiting
    expect(waiting).toHaveLength(1)
    // `since` is declared `number`. While the timestamp passed through as
    // `undefined`, JSON dropped the key entirely, so a reader got "no such field"
    // rather than an age — and epoch is a visible "unknown", not a false "just now".
    expect(waiting[0]?.since).toBe(0)
  })

  it('refuses a dependency that names nothing, and creates none of the batch', async () => {
    const { board: subject } = await board()
    // A task waiting on an id no row has is not waiting — it never runs. The panel
    // counts it as available, `nextFor` never offers it, and only a direct claim
    // ever says why, because `blocked()` reports a *failed* dependency and a
    // missing one never fails.
    await expect(subject.create({ createdBy: 'parent', tasks: [
      { title: 'a' },
      { title: 'b', dependsOn: ['t9'] },
    ] })).rejects.toThrow(/depends on "t9"/u)
    // Atomic: the refusal happens inside the update, which writes only after the
    // mutation returns, so the batch is not half-created with the caller's plan
    // silently reordered.
    expect(await subject.list()).toHaveLength(0)
  })
})

describe('the status vocabularies partition one another', () => {
  // `TEAM_STORED_TASK_STATUSES` is written by hand rather than derived from
  // `TEAM_TASK_STATUSES` minus `blocked`, and its own comment gives the reason:
  // a computed list cannot disagree, and disagreement is the only thing that list
  // is there to detect. Nothing detected it. So the two could have drifted in
  // exactly the way the comment says they must not, and the drift is the quiet
  // kind: a status added to the full list becomes settable on a task in memory,
  // and `parseBoard` repairs it to `open` on the next read, because `isStoredStatus`
  // does not know it. The task then comes back in a bucket nobody chose, and the
  // ledger records the repair as if the file had been foreign.
  //
  // Pinning the partition turns that addition into a red test. The two halves are
  // asserted separately because they fail differently: an overlap means a status
  // that is both stored and computed, which makes `blocked()` and the file
  // disagree about what a task's status is; a gap means a status no bucket holds.
  it('covers every status exactly once across the stored and derived halves', () => {
    const stored = new Set<string>(TEAM_STORED_TASK_STATUSES)
    const derived = new Set<string>(TEAM_DERIVED_TASK_STATUSES)
    const all = new Set<string>(TEAM_TASK_STATUSES)
    expect([...stored].filter(status => derived.has(status))).toEqual([])
    expect([...new Set([...stored, ...derived])].sort()).toEqual([...all].sort())
  })
})
