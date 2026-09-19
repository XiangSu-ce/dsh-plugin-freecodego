/**
 * The team member registry: who is on the team, what they were asked to do, and
 * whether they are still running.
 *
 * Deliberately small. Membership is durable because the task board records an
 * owner by member id and a writer's worktree is registered against one: after a
 * restart, an orphaned claim has to be traceable back to the member that took
 * it. Everything else about a member is read live from the child Agent, not
 * mirrored here — a mirrored copy of another process's state can only be wrong.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/members
 */

import { TeamJsonStore, boundedTeamText, teamId } from './state.ts'

export interface TeamMember {
  readonly id: string
  readonly label: string
  /** Role id from the role library, which is what scopes its tools. */
  readonly role: string
  readonly engine?: string | undefined
  readonly model?: string | undefined
  /** Isolated worktree this member writes in, when it is a writer. */
  readonly worktree?: string | undefined
  readonly sessionId?: string | undefined
  /**
   * `waiting` is a member that is alive and holds a task it cannot continue until
   * a person answers. Not `working` (nobody is working) and not `idle` (it is not
   * available for other work): the whole reason the board has a waiting state is
   * that this distinction was being lost.
   */
  readonly state: 'starting' | 'working' | 'waiting' | 'idle' | 'stopped' | 'failed'
  /** The board task this member is accountable for, when it holds one. */
  readonly taskId?: string | undefined
  readonly startedAt: number
  readonly stoppedAt?: number | undefined
  readonly error?: string | undefined
}

interface TeamMembersDocument {
  readonly version: 1
  readonly teamId: string
  readonly members: readonly TeamMember[]
}

function parseMembers(teamIdValue: string): (input: unknown) => TeamMembersDocument | undefined {
  return (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
    const document = input as Partial<TeamMembersDocument>
    if (!Array.isArray(document.members)) return undefined
    return {
      version: 1,
      teamId: typeof document.teamId === 'string' ? document.teamId : teamIdValue,
      members: document.members.filter(entry => entry !== null && typeof entry === 'object' && typeof (entry as TeamMember).id === 'string'),
    }
  }
}

export class TeamMembers {
  private readonly store: TeamJsonStore<TeamMembersDocument>

  constructor(teamIdValue: string, filePath: string) {
    this.store = new TeamJsonStore<TeamMembersDocument>(filePath, () => ({ version: 1, teamId: teamIdValue, members: [] }), parseMembers(teamIdValue))
  }

  async register(input: {
    readonly label: string
    readonly role: string
    readonly engine?: string
    readonly model?: string
    readonly worktree?: string
    readonly sessionId?: string
  }): Promise<TeamMember> {
    const member: TeamMember = {
      id: teamId('m'),
      label: boundedTeamText(input.label, 120) || 'member',
      role: boundedTeamText(input.role, 80),
      ...(input.engine === undefined ? {} : { engine: input.engine }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      state: 'starting',
      startedAt: Date.now(),
    }
    await this.store.update(current => ({ ...current, members: [...current.members, member] }))
    return member
  }

  async list(): Promise<readonly TeamMember[]> {
    return (await this.store.read()).members
  }

  /**
   * Resolve a member by id, then by label.
   *
   * Order matters: an id is exact identity, while a label is a convenience key
   * that comes from the model. Matching both keys in one pass let a label that
   * happens to equal another member's id retarget the write onto the wrong
   * member — the id is therefore tried on its own, and the label only decides a
   * lookup the ids did not.
   */
  private resolve(members: readonly TeamMember[], idOrLabel: string): TeamMember | undefined {
    return members.find(member => member.id === idOrLabel) ?? members.find(member => member.label === idOrLabel)
  }

  /** Look up by id or by label, since a caller usually knows the label. */
  async member(idOrLabel: string): Promise<TeamMember | undefined> {
    return this.resolve((await this.store.read()).members, idOrLabel)
  }

  async update(id: string, patch: {
    readonly state?: TeamMember['state']
    readonly taskId?: string
    /** Attach the worktree allocated after this member received its durable id. */
    readonly worktree?: string
    /**
     * Drop the recorded task instead of replacing it.
     *
     * An omitted `taskId` deliberately leaves the stored one alone, so ending a
     * hold needs its own instruction: without it a member that completed or
     * released a task stayed labelled with that task, and the board — which
     * reports "the task each member holds" — kept naming work the member no
     * longer owned.
     */
    readonly clearTask?: boolean
    readonly error?: string
  }): Promise<TeamMember | undefined> {
    let updated: TeamMember | undefined
    await this.store.update((current) => {
      const target = this.resolve(current.members, id)
      if (target === undefined) return current
      const next: TeamMember = {
        ...target,
        state: patch.state ?? target.state,
        ...(patch.taskId === undefined ? {} : { taskId: patch.taskId }),
        ...(patch.worktree === undefined ? {} : { worktree: patch.worktree }),
        ...(patch.clearTask === true ? { taskId: undefined } : {}),
        ...(patch.error === undefined ? {} : { error: boundedTeamText(patch.error, 500) }),
      }
      updated = next
      // Keyed on the resolved member's own id, so only that one record moves.
      return { ...current, members: current.members.map(member => member.id === target.id ? next : member) }
    })
    return updated
  }

  async markStopped(id: string, state: 'stopped' | 'failed', error?: string): Promise<void> {
    await this.store.update((current) => {
      const target = this.resolve(current.members, id)
      if (target === undefined) return current
      return {
        ...current,
        members: current.members.map(member => member.id === target.id
          ? { ...member, state, stoppedAt: Date.now(), ...(error === undefined ? {} : { error: boundedTeamText(error, 500) }) }
          : member),
      }
    })
  }
}
