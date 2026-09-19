import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamMembers } from '../src/team/members.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function registry(): Promise<{ members: TeamMembers; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-team-members-'))
  directories.push(directory)
  const file = join(directory, 'members.json')
  return { members: new TeamMembers('team1', file), file }
}

describe('team member registry', () => {
  it('registers a member with a minted id and the starting state', async () => {
    const { members } = await registry()
    const member = await members.register({ label: 'impl-1', role: 'implementer', engine: 'deepseek', model: 'deepseek-v4', worktree: '/tmp/wt-1' })
    expect(member.id).toMatch(/^m_[0-9a-f]{32}$/u)
    expect(member.state).toBe('starting')
    expect(member.worktree).toBe('/tmp/wt-1')
    expect(await members.list()).toHaveLength(1)
  })

  it('bounds a long label and a long error instead of persisting them whole', async () => {
    const { members } = await registry()
    const member = await members.register({ label: 'x'.repeat(400), role: 'implementer' })
    expect(member.label).toHaveLength(120)
    const updated = await members.update(member.id, { state: 'failed', error: 'y'.repeat(2_000) })
    expect(updated?.error?.length).toBe(500)
  })

  it('looks a member up by id and by label, since a caller usually knows the label', async () => {
    const { members } = await registry()
    const member = await members.register({ label: 'impl-1', role: 'implementer' })
    expect((await members.member(member.id))?.id).toBe(member.id)
    expect((await members.member('impl-1'))?.id).toBe(member.id)
    expect(await members.member('missing')).toBeUndefined()
  })

  it('records the task a member is accountable for, and clears it back to idle', async () => {
    const { members } = await registry()
    const member = await members.register({ label: 'impl-1', role: 'implementer' })
    expect((await members.update(member.id, { state: 'working', taskId: 't1' }))?.taskId).toBe('t1')
    const idled = await members.update(member.id, { state: 'idle', taskId: 't1' })
    expect(idled?.state).toBe('idle')
    // A patch that omits a field leaves the stored one alone rather than erasing it.
    expect(idled?.taskId).toBe('t1')
  })

  it('drops the recorded task only when the patch says to', async () => {
    const { members } = await registry()
    const member = await members.register({ label: 'impl-1', role: 'implementer' })
    await members.update(member.id, { state: 'working', taskId: 't1' })
    // A hand-back is not a replacement: the task is gone, not swapped.
    const released = await members.update(member.id, { state: 'idle', clearTask: true })
    expect(released?.state).toBe('idle')
    expect(released?.taskId).toBeUndefined()
    // Omission still means "leave it alone", which is what makes the pair safe.
    const reheld = await members.update(member.id, { state: 'working', taskId: 't2' })
    expect(reheld?.taskId).toBe('t2')
    expect((await members.update(member.id, { state: 'idle' }))?.taskId).toBe('t2')
  })

  it('resolves an id before a label, so a colliding label cannot retarget a write', async () => {
    const { members } = await registry()
    const first = await members.register({ label: 'impl-1', role: 'implementer' })
    // A member whose label is literally another member's id. Labels come from the
    // model; a rewrite that maps over every record matching either key updated
    // both members, so the bystander silently inherited the other's task.
    const decoy = await members.register({ label: first.id, role: 'implementer' })
    await members.update(first.id, { state: 'working', taskId: 't1' })
    expect((await members.member(first.id))?.taskId).toBe('t1')
    expect((await members.member(decoy.id))?.taskId).toBeUndefined()
    await members.markStopped(first.id, 'failed', 'engine crashed')
    expect((await members.member(first.id))?.state).toBe('failed')
    expect((await members.member(decoy.id))?.state).toBe('starting')
  })

  it('ignores an update for a member that is not registered', async () => {
    const { members } = await registry()
    await members.register({ label: 'impl-1', role: 'implementer' })
    await expect(members.update('m_nobody', { state: 'working' })).resolves.toBeUndefined()
    expect(await members.list()).toHaveLength(1)
  })

  it('marks a member stopped with a timestamp, so an orphaned claim is traceable', async () => {
    const { members } = await registry()
    const member = await members.register({ label: 'impl-1', role: 'implementer' })
    await members.update(member.id, { state: 'working', taskId: 't1' })
    await members.markStopped(member.id, 'failed', 'engine crashed')
    const stopped = await members.member(member.id)
    expect(stopped?.state).toBe('failed')
    expect(stopped?.error).toBe('engine crashed')
    expect(stopped?.taskId).toBe('t1')
    expect(stopped?.stoppedAt).toBeTypeOf('number')
  })

  it('survives a restart: a fresh instance reads who held which task and which worktree', async () => {
    const { members, file } = await registry()
    const member = await members.register({ label: 'impl-1', role: 'implementer', worktree: '/tmp/wt-1' })
    await members.update(member.id, { state: 'working', taskId: 't1' })
    // Standing in for a restart: the registry is on disk, not in the old instance.
    const reopened = new TeamMembers('team1', file)
    const found = await reopened.member('impl-1')
    expect(found).toMatchObject({ id: member.id, state: 'working', taskId: 't1', worktree: '/tmp/wt-1' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, teamId: 'team1' })
  })

  it('serializes concurrent registrations so neither is lost', async () => {
    const { members, file } = await registry()
    await Promise.all([
      members.register({ label: 'impl-1', role: 'implementer' }),
      members.register({ label: 'impl-2', role: 'implementer' }),
      members.register({ label: 'verifier-1', role: 'verifier' }),
    ])
    const reopened = new TeamMembers('team1', file)
    expect((await reopened.list()).map(member => member.label).sort()).toEqual(['impl-1', 'impl-2', 'verifier-1'])
  })

  it('degrades a malformed document to an empty registry instead of throwing', async () => {
    const { members, file } = await registry()
    await members.register({ label: 'impl-1', role: 'implementer' })
    await writeFile(file, '{ not json')
    const reopened = new TeamMembers('team1', file)
    await expect(reopened.list()).resolves.toEqual([])
    // The next write repairs the file rather than leaving it broken.
    await reopened.register({ label: 'impl-2', role: 'implementer' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ members: [{ label: 'impl-2' }] })
  })

  it('drops entries that are not member records', async () => {
    const { members, file } = await registry()
    await members.register({ label: 'impl-1', role: 'implementer' })
    await writeFile(file, JSON.stringify({ version: 1, teamId: 'team1', members: [{ label: 'no id' }, 7, null, { id: 'm_kept', label: 'kept', role: 'implementer', state: 'idle', startedAt: 1 }] }))
    const reopened = new TeamMembers('team1', file)
    expect((await reopened.list()).map(member => member.id)).toEqual(['m_kept'])
  })
})
