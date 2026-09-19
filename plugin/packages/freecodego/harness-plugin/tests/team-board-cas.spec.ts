import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamBoard } from '../src/team/board.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function board(): Promise<TeamBoard> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-board-cas-'))
  directories.push(directory)
  return new TeamBoard('team1', join(directory, 'board.json'))
}

async function boardPair(): Promise<readonly [TeamBoard, TeamBoard]> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-board-cas-'))
  directories.push(directory)
  const file = join(directory, 'board.json')
  return [new TeamBoard('team1', file), new TeamBoard('team1', file)]
}

/**
 * Pin a value the fixture knows is present.
 *
 * `exactOptionalPropertyTypes` refuses `expectedVersion: undefined` for an
 * optional `expectedVersion?: number`, and spreading the key away instead would
 * leave the test asserting nothing about the version it just read. Throwing
 * states the precondition the test depends on.
 */
function pin<K extends string, T>(key: K, value: T | undefined): { [P in K]: T } {
  if (value === undefined) throw new Error(`test precondition: ${key} must be present`)
  return { [key]: value } as { [P in K]: T }
}

describe('task revisions', () => {
  it('starts at zero and advances on every mutation', async () => {
    const subject = await board()
    const [task] = await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    expect(task?.version).toBe(0)
    const claimed = await subject.claim('t1', 'm1')
    expect(claimed.version).toBe(1)
    await subject.approve('t1', 'reviewer', 'approved', 'looks right')
    expect((await subject.get('t1'))?.version).toBe(2)
  })

  it('lets the loser of a race fail cleanly instead of overwriting a decision', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const read = (await subject.get('t1'))?.version
    await subject.claim('t1', 'm1', pin('expectedVersion', read))
    await expect(subject.claim('t1', 'm2', pin('expectedVersion', read))).rejects.toThrow(/moved to version 1 \(expected 0\)/u)
  })

  it('names the current version so the loser can retry', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await expect(subject.claim('t1', 'm2', { expectedVersion: 0 })).rejects.toThrow(/re-read it and retry/u)
  })

  it('lets exactly one of two claims that read the same version win', async () => {
    // The sequential case above passes even when the version is checked before
    // the write. Two claims started together are the case that does not: both
    // read version 0, and a check performed outside the serialized update admits
    // both, so the second silently takes the task while the first is told it won.
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const read = (await subject.get('t1'))?.version
    const outcomes = await Promise.allSettled([
      subject.claim('t1', 'm1', pin('expectedVersion', read)),
      subject.claim('t1', 'm2', pin('expectedVersion', read)),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const loser = outcomes.find(outcome => outcome.status === 'rejected')
    expect(String((loser as PromiseRejectedResult).reason)).toMatch(/moved to version 1 \(expected 0\)/u)
    const persisted = await subject.get('t1')
    expect(persisted?.version).toBe(1)
    // The board and the winner agree on who owns the task.
    const winner = outcomes.findIndex(outcome => outcome.status === 'fulfilled')
    expect(persisted?.owner).toBe(winner === 0 ? 'm1' : 'm2')
  })

  it('keeps exclusive ownership when two members claim without a version', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const outcomes = await Promise.allSettled([subject.claim('t1', 'm1'), subject.claim('t1', 'm2')])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(String((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/is claimed by/u)
    expect((await subject.get('t1'))?.version).toBe(1)
  })

  it('keeps exclusive ownership when two live board instances claim concurrently', async () => {
    // A plugin reload can leave two callers with separate board wrappers over
    // one durable file. Per-instance serialization alone lets both read `open`
    // and each publish a successful claim, losing the first owner on disk.
    const [first, second] = await boardPair()
    await first.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const outcomes = await Promise.allSettled([
      first.claim('t1', 'm1'),
      second.claim('t1', 'm2'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect((await first.get('t1'))?.version).toBe(1)
  })

  it('refuses a close from a member that no longer owns the task, even when the check races the claim', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    // m1 releases and m2 claims in the same tick; m1's close must not land.
    const claimed = (await subject.get('t1'))?.claimToken
    const [released] = await Promise.all([subject.release('t1', 'm1', claimed), subject.claim('t1', 'm2')])
    expect(released.status).toBe('open')
    expect((await subject.get('t1'))?.owner).toBe('m2')
    await expect(subject.complete('t1', 'm1')).rejects.toThrow(/owned by "m2"/u)
  })
})

describe('task id reservation', () => {
  it('reserves an id for a dropped entry so the next create cannot reuse it', async () => {
    // A dropped entry (empty title) used to leave the counter behind by one, so
    // the next call handed its neighbour's id to a new task and the board ended
    // up with two tasks sharing one id — which `mutate` then rewrote together.
    const subject = await board()
    const first = await subject.create({ createdBy: 'parent', tasks: [{ title: '' }, { title: 'kept' }] })
    expect(first.map(task => task.id)).toEqual(['t2'])
    const second = await subject.create({ createdBy: 'parent', tasks: [{ title: 'next' }] })
    expect(second.map(task => task.id)).toEqual(['t3'])
    const ids = (await subject.list()).map(task => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never writes a second task under an id the board already has', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    // A board file whose counter was stale (written by the old reservation bug).
    const stale = await subject.create({ createdBy: 'parent', tasks: [{ title: 'b' }] })
    expect(stale.map(task => task.id)).toEqual(['t2'])
    const ids = (await subject.list()).map(task => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('claim tokens', () => {
  it('mints a token on claim and clears it when the claim is released', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const claimed = await subject.claim('t1', 'm1')
    expect(claimed.claimToken).toMatch(/^c_[0-9a-f]{32}$/u)
    const released = await subject.release('t1', 'm1', claimed.claimToken)
    expect(released.claimToken).toBeUndefined()
    expect(released.status).toBe('open')
  })

  it('refuses a release that does not present the live token', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const first = await subject.claim('t1', 'm1')
    await subject.claim('t1', 'm1')
    await expect(subject.release('t1', 'm1', first.claimToken)).rejects.toThrow(/no longer holds that claim token/u)
  })

  it('requires the token to close a task through the strict door', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await expect(subject.transition('t1', 'm1', { status: 'done' })).rejects.toThrow(/must present it/u)
    await expect(subject.transition('t1', 'm1', { status: 'done', claimToken: 'c_wrong' })).rejects.toThrow(/no longer holds that claim token/u)
  })

  it('checks a presented token without demanding one, which only a legacy row can show', async () => {
    // The board file predates claim tokens: it has an owner and no token. A caller
    // that kept a token from an older process must still be able to release, because
    // the rule is that a token is *checked when presented*, not demanded — and this is
    // the one row on which that can be observed, since every row this build writes
    // carries a token for as long as it is claimed.
    //
    // The case that used to sit here asserted the same token fact, but it reached it
    // by closing a task and then releasing it, which meant the assertion also pinned
    // the *side effect* — a `done` task becoming `open` again — as if it were the
    // expectation. That side effect is a defect (see the next case), so the token fact
    // had to be separated from the row it used to be observed on.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-board-cas-'))
    directories.push(directory)
    const file = join(directory, 'board.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 1,
      tasks: [{ id: 't1', title: 'legacy claim', detail: '', status: 'claimed', owner: 'm1', createdBy: 'parent', createdAt: 1, updatedAt: 1, dependsOn: [], artifacts: [], attempts: 1 }],
    }))
    const subject = new TeamBoard('team1', file)
    const released = await subject.release('t1', 'm1', 'c_from_an_older_process')
    expect(released.status).toBe('open')
    expect(released.owner).toBeUndefined()
  })

  it('refuses to release a closed task, and names the door that reopens one', async () => {
    // Closing a task deliberately leaves the owner on the row — that is the record of
    // who did the work — so the ownership fence alone let the member that had just
    // finished the task hand it back to the pool: `done` became `open`, the owner was
    // cleared, and a task depending on it silently became claimable again. The refusal
    // points at `rerun`, which is the door that reopens a failed or cancelled task, and
    // it runs before the ownership check because an outcome is more fundamental than a
    // name. `done` is not rerunable, which is why the message names the door rather
    // than offering it.
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const claimed = await subject.claim('t1', 'm1')
    const done = await subject.transition('t1', 'm1', { status: 'done', ...pin('claimToken', claimed.claimToken), note: 'finished', artifacts: ['src/a.ts'] })
    expect(done.status).toBe('done')
    expect(done.artifacts).toEqual(['src/a.ts'])
    expect(done.claimToken).toBeUndefined()
    await expect(subject.release('t1', 'm1', claimed.claimToken)).rejects.toThrow(/a closed task has no claim to release/u)
    expect((await subject.get('t1'))?.status).toBe('done')
  })

  it('still refuses a foreign owner even with a token', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    const claimed = await subject.claim('t1', 'm1')
    await expect(subject.transition('t1', 'm2', { status: 'done', ...pin('claimToken', claimed.claimToken) })).rejects.toThrow(/owned by "m1"/u)
  })

  it('keeps the ownership-only door working for a single-process team', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.claim('t1', 'm1')
    await expect(subject.complete('t1', 'm1', { note: 'done' })).resolves.toMatchObject({ status: 'done' })
  })

  it('keeps the token out of the dependency path: a failed transition still frees nothing', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }, { title: 'b', dependsOn: ['$1'] }] })
    const claimed = await subject.claim('t1', 'm1')
    await subject.transition('t1', 'm1', { status: 'failed', ...pin('claimToken', claimed.claimToken), note: 'nope' })
    await expect(subject.claim('t2', 'm2')).rejects.toThrow(/blocked by t1/u)
  })
})

describe('task approvals', () => {
  it('records decisions on the task so the board is the audit record', async () => {
    const subject = await board()
    await subject.create({ createdBy: 'parent', tasks: [{ title: 'a' }] })
    await subject.approve('t1', 'reviewer', 'rejected', 'missing a rollback step')
    await subject.approve('t1', 'reviewer', 'approved', 'addressed')
    const approvals = (await subject.get('t1'))?.approvals ?? []
    expect(approvals.map(entry => entry.decision)).toEqual(['rejected', 'approved'])
    expect(approvals[0]?.note).toBe('missing a rollback step')
  })

  it('refuses an approval for a task that does not exist', async () => {
    const subject = await board()
    await expect(subject.approve('t9', 'reviewer', 'approved')).rejects.toThrow(/does not exist/u)
  })

  it('reads a board written before these fields existed', async () => {
    // A missing version must not mean "any version": that would defeat the check
    // exactly once, on the upgrade turn.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-board-cas-'))
    directories.push(directory)
    const file = join(directory, 'board.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      teamId: 'team1',
      counter: 1,
      tasks: [{ id: 't1', title: 'legacy', detail: '', status: 'open', createdBy: 'parent', createdAt: 1, updatedAt: 1, dependsOn: [], artifacts: [], attempts: 0 }],
    }))
    const subject = new TeamBoard('team1', file)
    const legacy = await subject.get('t1')
    expect(legacy?.version).toBe(0)
    expect(legacy?.approvals).toEqual([])
    expect(legacy?.claimToken).toBeUndefined()
    // The version is real from the first write onwards.
    expect((await subject.claim('t1', 'm1')).version).toBe(1)
  })
})
