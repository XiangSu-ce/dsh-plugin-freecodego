/**
 * Coverage for reading the official Team board out of the Harness's own session
 * events, and for the evidence it hands the stop-time gate.
 *
 * The reader is deliberately dull: it folds four event types, reports what
 * changed, and never invents a fact about a payload this version does not
 * recognise. Most of what is pinned here is that refusal to guess, because a board
 * that reports a task the Harness did not record is worse than a board that
 * reports nothing.
 */

import { describe, expect, it } from 'vitest'
import {
  FreeCodeGoTeamBoard,
  TEAM_EVENT_TYPES,
  memberFactOf,
  taskFactOf,
  teamIdOf,
} from '../src/team-workflow.ts'

const TEAM = 'session-lead-1'

function taskEvent(teamId: string, task: Record<string, unknown>): { readonly type: string; readonly data: unknown } {
  return { type: 'team/task', data: { version: 2, teamId, task } }
}

function memberEvent(teamId: string, member: Record<string, unknown>): { readonly type: string; readonly data: unknown } {
  return { type: 'team/member', data: { version: 2, teamId, member } }
}

function task(id: string, revision: number, status: string, subject = `task ${id}`): Record<string, unknown> {
  return { id, revision, subject, description: `${subject} description`, status, blockedBy: [], writeScopes: ['src'] }
}

describe('the event vocabulary this reader depends on', () => {
  it('is exactly the Team vocabulary the Harness records', () => {
    expect([...TEAM_EVENT_TYPES].sort()).toEqual([
      'team/member',
      'team/message/delivered',
      'team/message/queued',
      'team/task',
    ])
  })
})

describe('reading one event payload', () => {
  it('accepts a task the Harness would accept', () => {
    expect(taskFactOf({ task: task('task-1', 1, 'pending') })).toEqual({
      id: 'task-1',
      revision: 1,
      subject: 'task task-1',
      description: 'task task-1 description',
      status: 'pending',
      writeScopes: ['src'],
    })
  })

  it('refuses a payload it cannot read rather than inventing fields', () => {
    expect(taskFactOf(undefined)).toBeUndefined()
    expect(taskFactOf({})).toBeUndefined()
    expect(taskFactOf({ task: { id: 'task-1' } })).toBeUndefined()
    // A status this version does not know is not folded: the board is evidence,
    // so an unrecognised state must not be reported as one it understands.
    expect(taskFactOf({ task: { ...task('task-1', 1, 'pending'), status: 'paused' } })).toBeUndefined()
  })

  it('reads a member phase, including its failure reason', () => {
    expect(memberFactOf({ member: { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'active' } }))
      .toEqual({ id: 'm1', name: 'codex-1', provider: 'codex', phase: 'active' })
    expect(memberFactOf({ member: { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'failed', error: 'no auth' } }))
      .toEqual({ id: 'm1', name: 'codex-1', provider: 'codex', phase: 'failed', error: 'no auth' })
    expect(memberFactOf({ member: { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'halfway' } })).toBeUndefined()
  })

  it('takes the team id from the event, because a team id is its Lead session', () => {
    expect(teamIdOf({ teamId: TEAM })).toBe(TEAM)
    expect(teamIdOf({ teamId: '' })).toBeUndefined()
    expect(teamIdOf({})).toBeUndefined()
  })
})

describe('FreeCodeGoTeamBoard.observe', () => {
  it('reports a task creation and then a status change, in revision order', () => {
    const board = new FreeCodeGoTeamBoard()
    expect(board.observe(taskEvent(TEAM, task('task-1', 1, 'pending', 'port the reviewer'))))
      .toBe(`freecodego: team board ${TEAM}: task task-1 created (pending) — port the reviewer`)
    expect(board.observe(taskEvent(TEAM, task('task-1', 2, 'in_progress', 'port the reviewer'))))
      .toContain('task task-1 is now in_progress (revision 2)')
    expect(board.observe(taskEvent(TEAM, task('task-1', 3, 'completed', 'port the reviewer'))))
      .toContain('task task-1 is now completed (revision 3)')
    expect(board.board(TEAM).tasks.map(entry => entry.status)).toEqual(['completed'])
  })

  it('ignores a revision it has already folded, which is a replayed event', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(taskEvent(TEAM, task('task-1', 2, 'in_progress')))
    expect(board.observe(taskEvent(TEAM, task('task-1', 1, 'pending')))).toBeUndefined()
    expect(board.observe(taskEvent(TEAM, task('task-1', 2, 'in_progress')))).toBeUndefined()
    expect(board.board(TEAM).tasks[0]?.status).toBe('in_progress')
  })

  it('reports member phases once each, and never repeats a settled one', () => {
    const board = new FreeCodeGoTeamBoard()
    const created = board.observe(memberEvent(TEAM, { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'provisioning' }))
    expect(created).toBe(`freecodego: team board ${TEAM}: teammate codex-1 created through provider "codex" (provisioning)`)
    expect(board.observe(memberEvent(TEAM, { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'active' })))
      .toBe(`freecodego: team board ${TEAM}: teammate codex-1 is now active`)
    expect(board.observe(memberEvent(TEAM, { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'active' }))).toBeUndefined()
  })

  it('ignores every event that is not Team state, and any team it cannot name', () => {
    const board = new FreeCodeGoTeamBoard()
    expect(board.observe({ type: 'user/message', data: { teamId: TEAM } })).toBeUndefined()
    expect(board.observe({ type: 'team/message/queued', data: { version: 2, teamId: TEAM, message: { id: 'msg-1' } } })).toBeUndefined()
    expect(board.observe({ type: 'team/task', data: { version: 2, task: task('task-1', 1, 'pending') } })).toBeUndefined()
    expect(board.board(TEAM).tasks).toEqual([])
  })

  it('keeps two conversations apart', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(taskEvent('team-a', task('task-1', 1, 'completed')))
    expect(board.board('team-b').tasks).toEqual([])
    expect(board.board('team-a').tasks).toHaveLength(1)
  })

  it('retires one board on forget and every board on clear', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(taskEvent('team-a', task('task-1', 1, 'completed')))
    board.forget('team-a')
    expect(board.board('team-a').tasks).toEqual([])
    board.observe(taskEvent('team-a', task('task-1', 1, 'completed')))
    board.clear()
    expect(board.board('team-a').tasks).toEqual([])
  })
})

describe('FreeCodeGoTeamBoard.boardEvidence', () => {
  it('says nothing about a conversation with no team', () => {
    expect(new FreeCodeGoTeamBoard().boardEvidence(TEAM)).toBeUndefined()
  })

  it('says nothing while no task is completed', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(memberEvent(TEAM, { id: 'm1', name: 'codex-1', provider: 'codex', phase: 'active' }))
    board.observe(taskEvent(TEAM, task('task-1', 1, 'in_progress')))
    expect(board.boardEvidence(TEAM)).toBeUndefined()
  })

  it('names the completed work, and says the board presents it as finished', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(taskEvent(TEAM, task('task-1', 1, 'completed', 'port the reviewer')))
    board.observe(taskEvent(TEAM, task('task-2', 1, 'completed', 'run the checks')))
    const line = board.boardEvidence(TEAM)
    expect(line).toContain('2 completed task(s)')
    expect(line).toContain('task-1 (port the reviewer)')
    expect(line).toContain('task-2 (run the checks)')
    expect(line).toContain('No task is left open')
    // The sentence that keeps the evidence from reading as a verdict of its own.
    expect(line).toContain('not a verification of this workspace')
  })

  it('says the board does not present the work as finished while a task is open', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(taskEvent(TEAM, task('task-1', 1, 'completed')))
    board.observe(taskEvent(TEAM, task('task-2', 1, 'pending')))
    const line = board.boardEvidence(TEAM) ?? ''
    expect(line).toContain('1 task(s) are still open')
    expect(line).not.toContain('No task is left open')
  })

  it('names the teammates that ended in a failed phase', () => {
    const board = new FreeCodeGoTeamBoard()
    board.observe(taskEvent(TEAM, task('task-1', 1, 'completed')))
    board.observe(memberEvent(TEAM, { id: 'm1', name: 'claude-1', provider: 'claude-code', phase: 'provisioning' }))
    board.observe(memberEvent(TEAM, { id: 'm1', name: 'claude-1', provider: 'claude-code', phase: 'failed', error: 'no auth' }))
    expect(board.boardEvidence(TEAM)).toContain('1 teammate(s) ended in a failed phase: claude-1')
  })

  it('bounds the list it names rather than pasting a whole board into a nudge', () => {
    const board = new FreeCodeGoTeamBoard()
    for (let index = 0; index < 8; index += 1) {
      board.observe(taskEvent(TEAM, task(`task-${String(index)}`, 1, 'completed')))
    }
    const line = board.boardEvidence(TEAM) ?? ''
    expect(line).toContain('8 completed task(s)')
    expect(line).toContain('and 3 more')
  })
})
