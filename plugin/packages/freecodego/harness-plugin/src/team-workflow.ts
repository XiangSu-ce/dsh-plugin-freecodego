/**
 * The official Team board, read as evidence for this plugin's stop-time gate —
 * and written down, because the Harness's own team runtime reports its state to
 * the client and to nobody else.
 *
 * What the upstream team already has, and what it does not
 * -------------------------------------------------------
 * `@deepseek-ai/dsh-experimental-agent-team` (mounted by the optional
 * `-agent-team-profile` bundle, and by this bundle's own stand-in row when that
 * bundle is not selected) owns the roster, the mailbox and the task board, and it
 * has one durable vocabulary for all of it: the `team/member`, `team/task`,
 * `team/message/queued`, and `team/message/delivered` **session events**. Those are
 * recorded on the Team Lead's session log — `teamId` is the lead's own session id
 * — which is what this module reads. Nothing here calls a Team method, registers a
 * service, or names a tool of its own: the module is a reader of a vocabulary the
 * Harness owns, which is why an upstream change to the team implementation cannot
 * collide with it.
 *
 * What the upstream team does *not* have is any notion of the work being
 * *finished*. A teammate can mark every task `completed`, and the lead can end the
 * turn with nothing verified, nothing reviewed and no user decision anywhere in
 * the log — the board is a status board, not a gate. This plugin's stop-time gate
 * (`verify-on-stop.ts`) already refuses to let a turn that changed the workspace
 * end silently, and delegation through `spawn_teammate` is one of the ways it
 * knows the workspace may have moved. What it could not say before is *what the
 * team reported*: a nudge that names the tasks the team closed, and the ones that
 * closed with no verification of this workspace, is the difference between "you
 * changed something" and "your team says it is done".
 *
 * Read-only is not re-implemented here
 * ------------------------------------
 * Plan Mode's enforcement is keyed by `planModeSessionKey` (`plan-mode.ts`), which
 * resolves a team member's call to the *root conversation* rather than to the
 * member's own session — so a member of a team whose lead is planning is already
 * refused the mutating tools, through the same guard the lead is refused them by.
 * A second read-only layer here would be a copy of that rule, not an enhancement of
 * it, which is why this module only reads and reports.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team-workflow
 */

import { isRecord } from './untrusted-json.ts'

/**
 * The upstream session-event types that carry Team state, which is the entire
 * vocabulary this module depends on.
 *
 * Held as a set so the fold can reject anything else without a string comparison
 * per event, and so `tests/team-workflow.spec.ts` can pin the list against the
 * Harness's own `TeamSessionEvent` union.
 */
export const TEAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  'team/member',
  'team/task',
  'team/message/queued',
  'team/message/delivered',
])

/** One Team task, as the `team/task` event carries it. */
export interface TeamTaskFact {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  readonly writeScopes: readonly string[]
}

/** One Team member, as the `team/member` event carries it. */
export interface TeamMemberFact {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly phase: 'provisioning' | 'active' | 'failed'
  readonly error?: string | undefined
}

/** The board state one conversation's Team has reported. */
export interface TeamBoardFacts {
  readonly members: readonly TeamMemberFact[]
  readonly tasks: readonly TeamTaskFact[]
}

/** A session event, as this module reads it. */
export interface TeamEventLike {
  readonly type: string
  readonly data: unknown
}

/** A root conversation's accumulated board, and the reason it changed last. */
interface BoardEntry {
  members: TeamMemberFact[]
  tasks: TeamTaskFact[]
}

/**
 * The task one `team/task` event carries, or `undefined` when it is not readable.
 *
 * Structural rather than validated by the Harness's own schema: this module is a
 * reader on another package's vocabulary, and refusing to fold an event this
 * version does not recognise is the behavior that keeps an upstream field addition
 * from breaking the board. `undefined` means "not folded", never "invent something".
 * @param data - the event's data payload.
 * @returns the task fact, when the payload carries one.
 */
export function taskFactOf(data: unknown): TeamTaskFact | undefined {
  if (!isRecord(data)) return undefined
  const task = data['task']
  if (!isRecord(task)) return undefined
  const { id, revision, subject, description, status } = task
  if (typeof id !== 'string' || typeof revision !== 'number' || typeof subject !== 'string') return undefined
  if (typeof description !== 'string' || typeof status !== 'string') return undefined
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' && status !== 'deleted') return undefined
  const scopes = task['writeScopes']
  return {
    id,
    revision,
    subject,
    description,
    status,
    writeScopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [],
  }
}

/**
 * The member one `team/member` event carries, or `undefined` when it is not readable.
 * @param data - the event's data payload.
 * @returns the member fact, when the payload carries one.
 */
export function memberFactOf(data: unknown): TeamMemberFact | undefined {
  if (!isRecord(data)) return undefined
  const member = data['member']
  if (!isRecord(member)) return undefined
  const { id, name, provider, phase, error } = member
  if (typeof id !== 'string' || typeof name !== 'string' || typeof provider !== 'string') return undefined
  if (phase !== 'provisioning' && phase !== 'active' && phase !== 'failed') return undefined
  return { id, name, provider, phase, ...(typeof error === 'string' ? { error } : {}) }
}

/**
 * The Team a `team/*` event belongs to, which is the id of the conversation whose
 * log carries it.
 * @param data - the event's data payload.
 * @returns the team id, when the payload names one.
 */
export function teamIdOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const teamId = data['teamId']
  return typeof teamId === 'string' && teamId !== '' ? teamId : undefined
}

/**
 * This plugin's read of the official Team board.
 *
 * One instance serves every conversation; state is keyed by the team id the
 * events carry, and retired when the caller says the conversation is gone — an
 * entry that outlived its team would report the next team's tasks as this one's.
 */
export class FreeCodeGoTeamBoard {
  private readonly boards = new Map<string, BoardEntry>()

  /**
   * Fold one session event, and describe what changed.
   *
   * The returned line is the audit trail: the Harness's team runtime reports its
   * state to the client's member list and task board, so a deployment that reads
   * only logs cannot tell whether a teammate was created, failed, or closed its
   * work. `undefined` means nothing this module reports changed, which includes
   * every event that is not Team state at all.
   * @param event - the session event to fold.
   * @returns a line describing the change, or `undefined` when there is none.
   */
  observe(event: TeamEventLike): string | undefined {
    if (!TEAM_EVENT_TYPES.has(event.type)) return undefined
    const teamId = teamIdOf(event.data)
    if (teamId === undefined) return undefined
    const board = this.boards.get(teamId) ?? { members: [], tasks: [] }
    if (event.type === 'team/task') {
      const task = taskFactOf(event.data)
      if (task === undefined) return undefined
      const index = board.tasks.findIndex(candidate => candidate.id === task.id)
      const prior = board.tasks[index]
      // Revisions arrive in order (`projection.ts` enforces contiguity), so an
      // older one is an event replayed out of order rather than news.
      if (prior !== undefined && task.revision <= prior.revision) return undefined
      if (prior === undefined) board.tasks.push(task)
      else board.tasks[index] = task
      this.boards.set(teamId, board)
      return prior === undefined
        ? `freecodego: team board ${teamId}: task ${task.id} created (${task.status}) — ${task.subject}`
        : `freecodego: team board ${teamId}: task ${task.id} is now ${task.status} (revision ${String(task.revision)}) — ${task.subject}`
    }
    if (event.type === 'team/member') {
      const member = memberFactOf(event.data)
      if (member === undefined) return undefined
      const index = board.members.findIndex(candidate => candidate.id === member.id)
      const prior = board.members[index]
      if (prior !== undefined && prior.phase === member.phase) return undefined
      if (prior === undefined) board.members.push(member)
      else board.members[index] = member
      this.boards.set(teamId, board)
      return prior === undefined
        ? `freecodego: team board ${teamId}: teammate ${member.name} created through provider "${member.provider}" (${member.phase})`
        : `freecodego: team board ${teamId}: teammate ${member.name} is now ${member.phase}${member.error === undefined ? '' : ` — ${member.error}`}`
    }
    // A message event changes nothing this module reports: the mailbox is the
    // Harness's, and the count of messages is not evidence about the work.
    return undefined
  }

  /** The board one conversation's Team reported, or empty arrays when it has none.
   * @param teamId - the conversation whose team is asked about.
   * @returns the reported members and tasks.
   */
  board(teamId: string): TeamBoardFacts {
    const board = this.boards.get(teamId)
    return board === undefined ? { members: [], tasks: [] } : { members: board.members, tasks: board.tasks }
  }

  /**
   * What the board says about work that is finished, as a line for the stop-time gate.
   *
   * Deliberately not a verdict: it reports counts and the tasks that closed with
   * nothing pointing at this workspace, and the gate decides what to say about
   * them. A board with no team, or with no completed task, produces `undefined`
   * rather than an empty statement — a gate line that always appears is a line the
   * reader learns to skip.
   * @param teamId - the conversation whose team is asked about.
   * @returns the evidence line, or `undefined` when the board has nothing to add.
   */
  boardEvidence(teamId: string): string | undefined {
    const { members, tasks } = this.board(teamId)
    if (tasks.length === 0 && members.length === 0) return undefined
    const completed = tasks.filter(task => task.status === 'completed')
    if (completed.length === 0) return undefined
    const open = tasks.filter(task => task.status === 'pending' || task.status === 'in_progress')
    const failed = members.filter(member => member.phase === 'failed')
    const named = completed.slice(0, 5).map(task => `${task.id} (${task.subject})`)
    const rest = completed.length - named.length
    return [
      `The Team on this conversation reports ${String(completed.length)} completed task(s): ${named.join('; ')}${rest > 0 ? ` and ${String(rest)} more` : ''}.`,
      open.length === 0
        ? 'No task is left open, so the board presents this work as finished.'
        : `${String(open.length)} task(s) are still open, so the board does not present the work as finished.`,
      failed.length === 0
        ? ''
        : `${String(failed.length)} teammate(s) ended in a failed phase: ${failed.map(member => member.name).join(', ')}.`,
      'A task the team marked completed is the team\'s own claim, not a verification of this workspace.',
    ].filter(line => line !== '').join(' ')
  }

  /**
   * Retire one conversation's board.
   *
   * Called when the session is gone: a team id is a session id, and an entry that
   * outlived it would report a later conversation's team as this one's.
   * @param teamId - the conversation whose board to drop.
   */
  forget(teamId: string): void {
    this.boards.delete(teamId)
  }

  /** Drop every board; used when the plugin is disposed. */
  clear(): void {
    this.boards.clear()
  }
}
