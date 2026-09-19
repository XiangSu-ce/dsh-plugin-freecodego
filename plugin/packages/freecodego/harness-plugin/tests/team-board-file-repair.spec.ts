/**
 * What a board *file* can hold that this build never writes.
 *
 * `parseBoard` is the one place a board is turned from untyped input into a
 * `TeamTask`, and each field it repairs is a defect that used to reach the model
 * as a plain fact. The four here are the ones it did not repair, and they are one
 * defect class rather than four: the boundary repaired a field's *type* and left
 * its *meaning* unverified, so a foreign or older file loaded as a board that
 * answered confidently and wrongly.
 *
 * - **One id, two rows.** Board ids come from a counter, and the build before
 *   `create`'s reservation fix advanced it by the number of *kept* tasks, so a
 *   dropped entry re-issued an id on the next call. That board is on disk. Every
 *   door but `create` matches rows by id, so one claim moved both rows, one
 *   transition closed both, and `byOwner` reported a member holding two tasks
 *   after a single claim.
 * - **A counter behind its rows.** `create` mints `counter + n`, and an id
 *   already in use is dropped *silently* while the counter still advances — the
 *   caller asks for two tasks, gets none, and the next call skips the ids.
 * - **A dependency that cannot be satisfied.** `create` refuses one (see
 *   `team-board.spec.ts`), which a file cannot do without losing the task. Left
 *   in place the task is in neither report: `nextFor` never offers it and
 *   `blocked()` never names it, because its cause is not a failure.
 * - **An approval that is not an approval.** `approvals` was the one declared
 *   field that passed through with only an `Array.isArray` check, so a number or
 *   a `null` loaded as a `TeamTaskApproval` and travelled back out through
 *   `engineering_team_board` and `engineering_team_recover`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamBoard } from '../src/team/board.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function board(): Promise<{ board: TeamBoard; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-board-repair-'))
  directories.push(directory)
  const file = join(directory, 'board.json')
  return { board: new TeamBoard('team1', file), file }
}

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 't1', title: 'task', detail: '', status: 'open', createdBy: 'parent',
    createdAt: 1, updatedAt: 1, version: 0, approvals: [], dependsOn: [],
    artifacts: [], attempts: 0, history: [], ...over,
  }
}

async function seed(file: string, tasks: readonly Record<string, unknown>[], counter?: number): Promise<void> {
  await writeFile(file, JSON.stringify({
    version: 1,
    teamId: 'team1',
    ...(counter === undefined ? {} : { counter }),
    tasks,
  }), 'utf8')
}

describe('a board file this build would not have written', () => {
  it('gives two rows that share an id their own, keeping both and recording the move', async () => {
    // The shape the pre-reservation `create` produced: `[{title: ''}, {title:
    // 'kept'}]` wrote `t2` for the kept entry and advanced the counter by one, so
    // the *next* call wrote `t2` again. `create` refuses to add a third row with
    // the id; this is the pair already on disk, and dropping either row loses a
    // task, so the repair is to make identity unique instead.
    const { board: subject, file } = await board()
    await seed(file, [
      row({ id: 't2', title: 'kept from the first call' }),
      row({ id: 't2', title: 'kept from the second call' }),
    ], 2)

    const listed = await subject.list()
    expect(listed.map(task => task.id)).toEqual(['t2', 't3'])
    // Both tasks survive: the titles are the work, and neither is damage.
    expect(listed.map(task => task.title)).toEqual(['kept from the first call', 'kept from the second call'])
    // The first row keeps the id, because `find` already resolved references to
    // `t2` that way — so a dependency naming `t2` still names the same task.
    expect(listed[1]?.history.at(-1)).toMatchObject({ by: 'board' })
    expect(listed[1]?.history.at(-1)?.note).toContain('t2')

    // One claim, one row: this is the defect the reassignment removes.
    const claimed = await subject.claim('t2', 'm1')
    expect(claimed.title).toBe('kept from the first call')
    const afterClaim = await subject.list()
    expect(afterClaim.map(task => task.status)).toEqual(['claimed', 'open'])
    expect((await subject.summary()).byOwner).toEqual({ m1: { claimed: 1, done: 0 } })
  })

  it('does not hand a later create an id the repair just minted', async () => {
    const { board: subject, file } = await board()
    await seed(file, [row({ id: 't2' }), row({ id: 't2' })], 2)
    const created = await subject.create({ createdBy: 'parent', tasks: [{ title: 'new' }] })
    // Not `t3`: that id is now a row.
    expect(created.map(task => task.id)).toEqual(['t4'])
    expect((await subject.list()).map(task => task.id)).toEqual(['t2', 't3', 't4'])
  })

  it('raises a counter that fell behind its rows instead of letting create drop the entry', async () => {
    // A hand-edited file, or one written by a build that lost the counter. The old
    // repair fell back to `tasks.length`, which is only right while ids are
    // contiguous and start at one — and when it is wrong, `create` mints an id
    // that is in use, silently `continue`s past the entry, and still advances the
    // counter, so the caller's plan is reordered with no error anywhere.
    const { board: subject, file } = await board()
    await seed(file, [row({ id: 't1' }), row({ id: 't2' }), row({ id: 't3' })], 0)
    const created = await subject.create({ createdBy: 'parent', tasks: [{ title: 'first' }, { title: 'second' }] })
    expect(created.map(task => task.id)).toEqual(['t4', 't5'])
    expect((await subject.list()).map(task => task.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('raises a missing counter to the ids the file already holds', async () => {
    const { board: subject, file } = await board()
    await seed(file, [row({ id: 't7' })])
    const created = await subject.create({ createdBy: 'parent', tasks: [{ title: 'after' }] })
    expect(created.map(task => task.id)).toEqual(['t8'])
  })

  it('drops a dependency no row on the board can satisfy, so the task is offered instead of never running', async () => {
    // `create` refuses this (`depends on "t9"`), and a file cannot be refused
    // without losing the task. Left in place the task is in no report at all:
    // `nextFor` never offers it, `blocked()` reports only a *failed* dependency,
    // and the panel counts it as available work nobody can start.
    const { board: subject, file } = await board()
    await seed(file, [
      row({ id: 't1', title: 'real' }),
      row({ id: 't2', title: 'waiting on a row that is gone', dependsOn: ['t1', 't9'] }),
      row({ id: 't3', title: 'waiting on itself', dependsOn: ['t3'] }),
    ], 3)

    expect((await subject.get('t2'))?.dependsOn).toEqual(['t1'])
    expect((await subject.get('t2'))?.history.at(-1)?.note).toContain('t9')
    expect((await subject.get('t3'))?.dependsOn).toEqual([])
    // The satisfiable half of the same list is left alone: this is a repair, not a
    // rewrite of the caller's plan, so `t2` still waits for the real `t1`.
    expect((await subject.claim('t1', 'm1')).id).toBe('t1')
    await subject.complete('t1', 'm1')
    expect((await subject.claim('t2', 'm1')).owner).toBe('m1')
    await subject.complete('t2', 'm1')
    expect((await subject.nextFor('m2'))?.id).toBe('t3')
  })

  it('keeps r1 dependency gating when the row it names was dropped as malformed', async () => {
    // `isTask` drops a row that is not a row, which the old reader turned into a
    // dependency on an id that is no longer there — the same permanent block,
    // reached through the one filter that legitimately removes a row.
    const { board: subject, file } = await board()
    await seed(file, [row({ id: 't1', title: 42 }), row({ id: 't2', dependsOn: ['t1'] })], 2)
    expect((await subject.get('t2'))?.dependsOn).toEqual([])
    expect((await subject.nextFor('m1'))?.id).toBe('t2')
  })

  it('filters approvals to the shape the writer writes, and bounds the fields beside them', async () => {
    const { board: subject, file } = await board()
    await seed(file, [row({
      approvals: [7, 'nope', null, [], { by: 'm1', decision: 'shrugged', note: 'x', at: 1 }, { by: 'm2', decision: 'approved', note: 'looks right', at: 5 }],
      artifacts: ['src/a.ts', '', 3, 'x'.repeat(600)],
    })], 1)

    const task = await subject.get('t1')
    // Only the entry the write path could have produced: the rest are not
    // decisions, and they were reaching the model as `TeamTaskApproval`s.
    expect(task?.approvals).toEqual([{ by: 'm2', decision: 'approved', note: 'looks right', at: 5 }])
    // A later decision is appended beside it rather than to it.
    expect((await subject.approve('t1', 'm3', 'rejected', 'no')).approvals).toHaveLength(2)
    // Artifacts carry the same bound `transition` applies on the way in.
    expect(task?.artifacts).toEqual(['src/a.ts', `${'x'.repeat(499)}…`])
  })
})
